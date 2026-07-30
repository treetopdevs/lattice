import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  type CarrierAvailability,
  type CarrierAvailabilitySubscription,
  type CarrierFrameStore,
  type CarrierOpFrame,
  type CarrierStateReport,
  type LocalOpLogStore,
  type Op,
  type Verifier,
} from "@treetopdevs/lattice-client";
import {
  type TownshipNativeWorkflow,
  withTownshipPersistenceWrite,
} from "../src/native_workflow";
import {
  createTownshipFeedController,
  refreshTownshipFromCarrier,
  type TownshipFeedClient,
  type TownshipFeedSession,
  type TownshipFeedState,
} from "../src/township_feed";
import type { TownshipCarrierPeerConfig } from "../src/township_carrier_peer";

interface TownshipCarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  clientDivergedCarrierOps: CarrierOpFrame[];
  peerDivergedCarrierOps: CarrierOpFrame[];
  oracleCarrierOps: CarrierOpFrame[];
  expectAfterSync: {
    state: { posts: string[] };
    authorityQuarantine: [string, string][];
    stateB64: string;
    opIds: string[];
  };
  authorityRevocation: {
    revokeOp: CarrierOpFrame;
    revokedCommandOp: CarrierOpFrame;
    authorityQuarantine: [string, string][];
    stateB64: string;
    opIds: string[];
  };
}

interface ForeignReplicaVector {
  capabilityCase: { foreignCarrierOp: CarrierOpFrame };
}

class MemoryOpLog implements LocalOpLogStore {
  saveCount = 0;

  constructor(public ops: Op[]) {}

  async load(): Promise<Op[]> {
    return structuredClone(this.ops);
  }

  async save(ops: Op[]): Promise<void> {
    this.saveCount++;
    this.ops = structuredClone(ops);
  }

  async append(op: Op): Promise<Op[]> {
    this.ops = [...this.ops, structuredClone(op)];
    return this.load();
  }
}

class MemoryFrameStore implements CarrierFrameStore {
  saveCount = 0;

  constructor(public frames: CarrierOpFrame[]) {}

  async load(): Promise<CarrierOpFrame[]> {
    return structuredClone(this.frames);
  }

  async save(frames: CarrierOpFrame[]): Promise<void> {
    this.saveCount++;
    this.frames = structuredClone(frames);
  }

  async append(frame: CarrierOpFrame): Promise<CarrierOpFrame[]> {
    this.frames = [...this.frames, structuredClone(frame)];
    return this.load();
  }
}

class ForbiddenOutboxStore implements CarrierFrameStore {
  accessCount = 0;

  async load(): Promise<never> {
    this.accessCount++;
    throw new Error("reactive refresh read the authored outbox");
  }

  async save(): Promise<never> {
    this.accessCount++;
    throw new Error("reactive refresh wrote the authored outbox");
  }

  async append(): Promise<never> {
    this.accessCount++;
    throw new Error("reactive refresh appended to the authored outbox");
  }
}

class ReadOnlyPullClient {
  pullHave: string[] = [];
  forbiddenCallCount = 0;

  constructor(
    private readonly frames: CarrierOpFrame[],
    private readonly report: CarrierStateReport = baselineStateReport(),
  ) {}

  async pull(have: string[]): Promise<unknown[]> {
    this.pullHave = [...have];
    return structuredClone(this.frames);
  }

  async stateReport(): Promise<CarrierStateReport> {
    return structuredClone(this.report);
  }

  async advertise(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("reactive refresh advertised");
  }

  async push(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("reactive refresh pushed");
  }

  async relay(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("reactive refresh relayed");
  }
}

class StateReportingPullClient extends ReadOnlyPullClient {
  constructor(frames: CarrierOpFrame[], report: CarrierStateReport) {
    super(frames, report);
  }
}

class InterposingPullClient {
  pullHave: string[] = [];

  constructor(
    private readonly frames: CarrierOpFrame[],
    private readonly interpose: () => Promise<void>,
  ) {}

  async pull(have: string[]): Promise<unknown[]> {
    this.pullHave = [...have];
    await this.interpose();
    return structuredClone(this.frames);
  }

  async stateReport(): Promise<CarrierStateReport> {
    return baselineStateReport();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

class ControlledAvailabilitySubscription implements CarrierAvailabilitySubscription {
  private queued: CarrierAvailability[] = [];
  private waiter: Deferred<CarrierAvailability> | null = null;
  private closedReason: unknown | null = null;

  constructor(readonly baseline: CarrierAvailability = availability(1)) {}

  next(): Promise<CarrierAvailability> {
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiter) return Promise.reject(new Error("availability receive already in flight"));
    this.waiter = deferred<CarrierAvailability>();
    return this.waiter.promise;
  }

  async unsubscribe(): Promise<void> {
    throw new Error("controller sent an unsubscribe control request");
  }

  offer(value: CarrierAvailability): void {
    if (this.closedReason !== null) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(value);
    } else {
      this.queued.push(value);
    }
  }

  close(reason: unknown): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(reason);
  }
}

class ControlledFeedClient implements TownshipFeedClient {
  readonly subscription: ControlledAvailabilitySubscription;
  readonly pullGates: Deferred<void>[] = [];
  forbiddenCallCount = 0;
  subscribeCalls = 0;
  closed = false;

  constructor(
    private readonly frames: CarrierOpFrame[],
    baselineGeneration = 1,
    private readonly pullScripts: CarrierOpFrame[][] = [],
    private readonly rejectPullsOnClose = true,
  ) {
    this.subscription = new ControlledAvailabilitySubscription(availability(baselineGeneration));
  }

  async subscribeAvailability(): Promise<CarrierAvailabilitySubscription> {
    this.subscribeCalls++;
    return this.subscription;
  }

  async pull(have: string[]): Promise<unknown[]> {
    const gate = deferred<void>();
    this.pullGates.push(gate);
    await gate.promise;
    const scripted = this.pullScripts.shift();
    if (scripted) return structuredClone(scripted);
    const haveIds = new Set(have);
    return structuredClone(this.frames.filter((frame) => !haveIds.has(frame.id)));
  }

  async stateReport(): Promise<CarrierStateReport> {
    return baselineStateReport();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscription.close(new Error("controlled feed client closed"));
    if (this.rejectPullsOnClose) {
      for (const gate of this.pullGates) gate.reject(new Error("controlled feed client closed"));
    }
  }

  async advertise(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("controller advertised");
  }

  async push(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("controller pushed");
  }

  async relay(): Promise<never> {
    this.forbiddenCallCount++;
    throw new Error("controller relayed");
  }
}

console.log("\n▸ Reactive Township carrier refresh");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const foreignReplicaVector = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "lattice-client",
      "test",
      "vectors",
      "township_foreign_replica_injection.json",
    ),
    "utf8",
  ),
) as ForeignReplicaVector;
const verifier: Verifier = { verify: verifyEd25519 };
const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);

const validLocalLog = new MemoryOpLog(localOps);
const validDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const validOutbox = new ForbiddenOutboxStore();
const validWorkflow = workflow(validLocalLog, validDelegations, validOutbox);
const validClient = new ReadOnlyPullClient(vector.peerDivergedCarrierOps);

const projection = await refreshTownshipFromCarrier({
  client: validClient,
  workflow: validWorkflow,
  verifier,
  realmByPubkey: vector.realmByPubkey,
  expectedReplica: vector.replica,
  generation: 7,
});

assert.equal(projection.generation, 7);
assert.deepEqual(projection.opIds, vector.expectAfterSync.opIds);
assert.deepEqual(projection.matter.posts, vector.expectAfterSync.state.posts);
assert.equal(projection.matter.opCount, vector.expectAfterSync.opIds.length);
assert.deepEqual(validClient.pullHave.sort(), localOps.map((op) => op.id).sort());
assert.deepEqual(validLocalLog.ops.map((op) => op.id).sort(), vector.expectAfterSync.opIds);
assert.deepEqual(validDelegations.frames.map((frame) => frame.id).sort(), vector.oracleCarrierOps.map((frame) => frame.id).sort());
assert.equal(validLocalLog.saveCount, 1);
assert.equal(validDelegations.saveCount, 1);
assert.equal(validOutbox.accessCount, 0);
assert.equal(validClient.forbiddenCallCount, 0);

const foreignReplicaLocalLog = new MemoryOpLog(localOps);
const foreignReplicaDelegations = new MemoryFrameStore(
  vector.clientDivergedCarrierOps,
);
const foreignReplicaOutbox = new ForbiddenOutboxStore();
const foreignReplicaWorkflow = workflow(
  foreignReplicaLocalLog,
  foreignReplicaDelegations,
  foreignReplicaOutbox,
);
await assert.rejects(
  refreshTownshipFromCarrier({
    client: new ReadOnlyPullClient([
      foreignReplicaVector.capabilityCase.foreignCarrierOp,
    ]),
    workflow: foreignReplicaWorkflow,
    verifier,
    realmByPubkey: vector.realmByPubkey,
    expectedReplica: vector.replica,
    generation: 8,
  }),
  /carrier served foreign replica/,
);
assert.equal(foreignReplicaLocalLog.saveCount, 0);
assert.equal(foreignReplicaDelegations.saveCount, 0);
assert.equal(foreignReplicaOutbox.accessCount, 0);

const revocationFrames = [
  ...vector.oracleCarrierOps,
  vector.authorityRevocation.revokeOp,
  vector.authorityRevocation.revokedCommandOp,
];
const revocationLocalLog = new MemoryOpLog(
  carrierOpsToSemanticOps(vector.oracleCarrierOps, vector.realmByPubkey),
);
const revocationDelegations = new MemoryFrameStore(vector.oracleCarrierOps);
const revocationOutbox = new ForbiddenOutboxStore();
const revocationWorkflow = workflow(revocationLocalLog, revocationDelegations, revocationOutbox);
const revocationClient = new StateReportingPullClient(
  [vector.authorityRevocation.revokeOp, vector.authorityRevocation.revokedCommandOp],
  {
    state_b64: vector.authorityRevocation.stateB64,
    op_ids: vector.authorityRevocation.opIds,
    frontier: [vector.authorityRevocation.revokedCommandOp.id],
    structural_quarantine: [],
    authority_quarantine: vector.authorityRevocation.authorityQuarantine,
    log_size: vector.authorityRevocation.opIds.length,
  },
);

const revocationProjection = await refreshTownshipFromCarrier({
  client: revocationClient,
  workflow: revocationWorkflow,
  verifier,
  realmByPubkey: vector.realmByPubkey,
  expectedReplica: vector.replica,
  generation: 8,
});

assert.deepEqual(revocationProjection.opIds, vector.authorityRevocation.opIds);
assert.deepEqual(revocationProjection.matter.posts, vector.expectAfterSync.state.posts);
assert.equal(revocationProjection.matter.opCount, vector.authorityRevocation.opIds.length);
assert.equal(revocationProjection.matter.appliedCount, vector.authorityRevocation.opIds.length - 2);
assert.equal(revocationProjection.matter.quarantineCount, 2);
assert.deepEqual(
  revocationLocalLog.ops.map((op) => op.id).sort(),
  vector.authorityRevocation.opIds,
);
assert.deepEqual(
  revocationDelegations.frames.map((frame) => frame.id).sort(),
  revocationFrames.map((frame) => frame.id).sort(),
);
assert.equal(revocationOutbox.accessCount, 0);

const interleavedLocalFrame = vector.clientDivergedCarrierOps.at(-1);
if (!interleavedLocalFrame) throw new Error("missing interleaved local frame fixture");
const framesBeforeInterleavedLocal = vector.clientDivergedCarrierOps.filter(
  (frame) => frame.id !== interleavedLocalFrame.id,
);
const interleavedLocalLog = new MemoryOpLog(
  carrierOpsToSemanticOps(framesBeforeInterleavedLocal, vector.realmByPubkey),
);
const interleavedDelegations = new MemoryFrameStore(framesBeforeInterleavedLocal);
const interleavedOutbox = new ForbiddenOutboxStore();
const interleavedWorkflow = workflow(interleavedLocalLog, interleavedDelegations, interleavedOutbox);
const interleavedClient = new InterposingPullClient(vector.peerDivergedCarrierOps, async () => {
  await withTownshipPersistenceWrite(interleavedWorkflow, async () => {
    const interleavedOp = carrierOpsToSemanticOps([interleavedLocalFrame], vector.realmByPubkey)[0];
    if (!interleavedOp) throw new Error("interleaved frame did not produce a semantic op");
    await interleavedWorkflow.localLog.append(interleavedOp);
    await interleavedWorkflow.delegationFrames.append(interleavedLocalFrame);
  });
});

const interleavedProjection = await refreshTownshipFromCarrier({
  client: interleavedClient,
  workflow: interleavedWorkflow,
  verifier,
  realmByPubkey: vector.realmByPubkey,
  expectedReplica: vector.replica,
  generation: 8,
});

assert.deepEqual(interleavedProjection.opIds, vector.expectAfterSync.opIds);
assert.deepEqual(interleavedLocalLog.ops.map((op) => op.id).sort(), vector.expectAfterSync.opIds);
assert.deepEqual(
  interleavedDelegations.frames.map((frame) => frame.id).sort(),
  vector.oracleCarrierOps.map((frame) => frame.id).sort(),
);
assert.equal(interleavedOutbox.accessCount, 0);

const [firstPeerFrame] = vector.peerDivergedCarrierOps;
if (!firstPeerFrame) throw new Error("missing peer frame fixture");
const invalidLocalLog = new MemoryOpLog(localOps);
const invalidDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const invalidOutbox = new ForbiddenOutboxStore();
const invalidWorkflow = workflow(invalidLocalLog, invalidDelegations, invalidOutbox);
const invalidClient = new ReadOnlyPullClient([
  { ...firstPeerFrame, sig: tamperBase64(firstPeerFrame.sig) },
]);
const beforeLocal = JSON.stringify(invalidLocalLog.ops);
const beforeDelegations = JSON.stringify(invalidDelegations.frames);

await assert.rejects(
  refreshTownshipFromCarrier({
    client: invalidClient,
    workflow: invalidWorkflow,
    verifier,
    realmByPubkey: vector.realmByPubkey,
    expectedReplica: vector.replica,
    generation: 8,
  }),
  /verification failed/,
);
assert.equal(JSON.stringify(invalidLocalLog.ops), beforeLocal);
assert.equal(JSON.stringify(invalidDelegations.frames), beforeDelegations);
assert.equal(invalidLocalLog.saveCount, 0);
assert.equal(invalidDelegations.saveCount, 0);
assert.equal(invalidOutbox.accessCount, 0);
assert.equal(invalidClient.forbiddenCallCount, 0);

const structuralAttemptId = "structurally-rejected-carrier-attempt";
const structuralReportLocalLog = new MemoryOpLog(localOps);
const structuralReportDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const structuralReportOutbox = new ForbiddenOutboxStore();
const structuralReportWorkflow = workflow(
  structuralReportLocalLog,
  structuralReportDelegations,
  structuralReportOutbox,
);
const structuralReportClient = new ReadOnlyPullClient(vector.peerDivergedCarrierOps, {
  ...baselineStateReport(),
  structural_quarantine: [[structuralAttemptId, "bad_signature"]],
});

const structuralReportProjection = await refreshTownshipFromCarrier({
  client: structuralReportClient,
  workflow: structuralReportWorkflow,
  verifier,
  realmByPubkey: vector.realmByPubkey,
  expectedReplica: vector.replica,
  generation: 9,
});

assert.deepEqual(structuralReportProjection.opIds, vector.expectAfterSync.opIds);
assert.deepEqual(structuralReportProjection.matter.posts, vector.expectAfterSync.state.posts);
assert.equal(structuralReportProjection.matter.opCount, vector.expectAfterSync.opIds.length);
assert.equal(structuralReportProjection.matter.quarantineCount, 1);
assert.equal(structuralReportLocalLog.saveCount, 1);
assert.equal(structuralReportDelegations.saveCount, 1);
assert.equal(structuralReportOutbox.accessCount, 0);

const mismatchedReportLocalLog = new MemoryOpLog(localOps);
const mismatchedReportDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const mismatchedReportOutbox = new ForbiddenOutboxStore();
const mismatchedReportWorkflow = workflow(
  mismatchedReportLocalLog,
  mismatchedReportDelegations,
  mismatchedReportOutbox,
);
const unknownReportOpId = "unknown-carrier-state-report-op";
const mismatchedReportClient = new ReadOnlyPullClient(vector.peerDivergedCarrierOps, {
  ...baselineStateReport(),
  op_ids: [...vector.expectAfterSync.opIds, unknownReportOpId],
  authority_quarantine: [[unknownReportOpId, "revoked_capability"]],
  log_size: vector.expectAfterSync.opIds.length + 1,
});
const beforeMismatchedReportLocal = JSON.stringify(mismatchedReportLocalLog.ops);
const beforeMismatchedReportDelegations = JSON.stringify(mismatchedReportDelegations.frames);

await assert.rejects(
  refreshTownshipFromCarrier({
    client: mismatchedReportClient,
    workflow: mismatchedReportWorkflow,
    verifier,
    realmByPubkey: vector.realmByPubkey,
    expectedReplica: vector.replica,
    generation: 9,
  }),
  /carrier state report does not match verified frames/,
);
assert.equal(JSON.stringify(mismatchedReportLocalLog.ops), beforeMismatchedReportLocal);
assert.equal(JSON.stringify(mismatchedReportDelegations.frames), beforeMismatchedReportDelegations);
assert.equal(mismatchedReportLocalLog.saveCount, 0);
assert.equal(mismatchedReportDelegations.saveCount, 0);
assert.equal(mismatchedReportOutbox.accessCount, 0);

const evidenceFreeAuthorityOp: Op = {
  id: "evidence-free-authority-write",
  deps: [vector.expectAfterSync.opIds.at(-1) ?? "missing-dependency"],
  kind: "authority",
  author: "resident",
  field: "clerk",
  mutation: "write",
  value: "resident",
  hash: "evidence-free-authority-write",
  command: "unvalidated clerk write",
};
const refusedLocalLog = new MemoryOpLog([
  ...carrierOpsToSemanticOps(vector.oracleCarrierOps, vector.realmByPubkey),
  evidenceFreeAuthorityOp,
]);
const refusedDelegations = new MemoryFrameStore(vector.oracleCarrierOps);
const refusedOutbox = new ForbiddenOutboxStore();
const refusedWorkflow = workflow(refusedLocalLog, refusedDelegations, refusedOutbox);
const refusedClient = new ReadOnlyPullClient([]);
const beforeRefusedLocal = JSON.stringify(refusedLocalLog.ops);
const beforeRefusedDelegations = JSON.stringify(refusedDelegations.frames);

await assert.rejects(
  refreshTownshipFromCarrier({
    client: refusedClient,
    workflow: refusedWorkflow,
    verifier,
    realmByPubkey: vector.realmByPubkey,
    expectedReplica: vector.replica,
    generation: 9,
  }),
  /V-01 fail-closed/,
);
assert.equal(JSON.stringify(refusedLocalLog.ops), beforeRefusedLocal);
assert.equal(JSON.stringify(refusedDelegations.frames), beforeRefusedDelegations);
assert.equal(refusedLocalLog.saveCount, 0);
assert.equal(refusedDelegations.saveCount, 0);
assert.equal(refusedOutbox.accessCount, 0);
assert.equal(refusedClient.forbiddenCallCount, 0);

const controllerLocalLog = new MemoryOpLog(localOps);
const controllerDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const controllerOutbox = new ForbiddenOutboxStore();
const controllerWorkflow = workflow(controllerLocalLog, controllerDelegations, controllerOutbox);
const controllerClient = new ControlledFeedClient(vector.peerDivergedCarrierOps);
const controllerStates: TownshipFeedState[] = [];
const controller = createTownshipFeedController({
  connect: async () => ({
    client: controllerClient,
    workflow: controllerWorkflow,
    verifier,
  }),
  onState(state) {
    controllerStates.push(structuredClone(state));
  },
  realmByPubkey: vector.realmByPubkey,
});

await controller.replacePeer(testPeer());
await waitFor(() => controllerClient.pullGates.length === 1);
controllerClient.subscription.offer(availability(2));
controllerClient.subscription.offer(availability(3));
controllerClient.subscription.offer(availability(4));
controllerClient.pullGates[0]?.resolve();

await waitFor(() => controllerClient.pullGates.length === 2);
controllerClient.pullGates[1]?.resolve();
await waitFor(() => freshGenerations(controllerStates).at(-1) === 4);

assert.equal(controllerClient.pullGates.length, 2);
assert.deepEqual(freshGenerations(controllerStates), [1, 4]);
assert.deepEqual(
  controllerStates
    .filter((state) => state.phase === "refreshing")
    .map((state) => state.projection?.generation ?? null),
  [null, 1],
);
assert.equal(controllerStates[0]?.phase, "connecting");
assert.equal(controllerOutbox.accessCount, 0);
assert.equal(controllerClient.forbiddenCallCount, 0);

await controller.stop();
const stateCountAfterStop = controllerStates.length;
controllerClient.subscription.offer(availability(5));
await tick();
assert.equal(controllerStates.length, stateCountAfterStop);
assert.equal(controllerClient.closed, true);

const reconnectLocalLog = new MemoryOpLog(localOps);
const reconnectDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const reconnectOutbox = new ForbiddenOutboxStore();
const reconnectWorkflow = workflow(reconnectLocalLog, reconnectDelegations, reconnectOutbox);
const firstReconnectClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 10);
const secondReconnectClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 11);
const reconnectStates: TownshipFeedState[] = [];
const reconnectDelays: number[] = [];
let reconnectCalls = 0;
const reconnectController = createTownshipFeedController({
  async connect() {
    reconnectCalls++;
    if (reconnectCalls === 1) {
      return { client: firstReconnectClient, workflow: reconnectWorkflow, verifier };
    }
    if (reconnectCalls < 9) throw new Error(`scripted reconnect failure ${reconnectCalls}`);
    return { client: secondReconnectClient, workflow: reconnectWorkflow, verifier };
  },
  async sleep(delay, signal) {
    assert.equal(signal.aborted, false);
    reconnectDelays.push(delay);
  },
  onState(state) {
    reconnectStates.push(structuredClone(state));
  },
  realmByPubkey: vector.realmByPubkey,
});

await reconnectController.replacePeer(testPeer());
await waitFor(() => firstReconnectClient.pullGates.length === 1);
firstReconnectClient.pullGates[0]?.resolve();
await waitFor(() => freshGenerations(reconnectStates).includes(10));
firstReconnectClient.subscription.close(new Error("stable carrier restarted"));

await waitFor(() => secondReconnectClient.pullGates.length === 1);
secondReconnectClient.pullGates[0]?.resolve();
await waitFor(() => freshGenerations(reconnectStates).at(-1) === 11);

assert.deepEqual(reconnectDelays, [100, 250, 500, 1_000, 2_000, 5_000, 5_000, 5_000]);
assert.equal(firstReconnectClient.closed, true);
assert.equal(reconnectCalls, 9);
assert.ok(
  reconnectStates.some(
    (state) => state.phase === "reconnecting" && state.projection?.generation === 10,
  ),
);
assert.equal(
  reconnectStates
    .filter((state) => state.phase === "reconnecting" || state.phase === "unavailable")
    .every((state) => state.projection?.generation === 10),
  true,
);
assert.equal(reconnectOutbox.accessCount, 0);
await reconnectController.stop();

const replacementLocalLog = new MemoryOpLog(localOps);
const replacementDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const replacementOutbox = new ForbiddenOutboxStore();
const replacementWorkflow = workflow(replacementLocalLog, replacementDelegations, replacementOutbox);
const lateClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 20);
const finalClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 30);
const lateSession = deferred<TownshipFeedSession>();
const replacementConnects: string[] = [];
const replacementStates: TownshipFeedState[] = [];
const replacementController = createTownshipFeedController({
  async connect(peer) {
    replacementConnects.push(peer.url);
    if (peer.url.endsWith("/a")) return lateSession.promise;
    if (peer.url.endsWith("/c")) {
      return { client: finalClient, workflow: replacementWorkflow, verifier };
    }
    throw new Error(`obsolete pairing connected: ${peer.url}`);
  },
  onState(state) {
    replacementStates.push(structuredClone(state));
  },
  realmByPubkey: vector.realmByPubkey,
});

await replacementController.replacePeer(testPeerAt("a"));
await waitFor(() => replacementConnects.length === 1);
const replaceWithB = replacementController.replacePeer(testPeerAt("b"));
const replaceWithC = replacementController.replacePeer(testPeerAt("c"));
await tick();
assert.deepEqual(replacementConnects, ["ws://127.0.0.1:4111/a"]);

lateSession.resolve({ client: lateClient, workflow: replacementWorkflow, verifier });
await Promise.all([replaceWithB, replaceWithC]);
await waitFor(() => finalClient.pullGates.length === 1);
finalClient.pullGates[0]?.resolve();
await waitFor(() => freshGenerations(replacementStates).at(-1) === 30);

assert.deepEqual(replacementConnects, [
  "ws://127.0.0.1:4111/a",
  "ws://127.0.0.1:4111/c",
]);
assert.equal(lateClient.closed, true);
assert.equal(lateClient.subscribeCalls, 0);
assert.equal(finalClient.subscribeCalls, 1);
assert.equal(replacementOutbox.accessCount, 0);
await replacementController.stop();

const failureLocalLog = new MemoryOpLog(localOps);
const failureDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const failureOutbox = new ForbiddenOutboxStore();
const failureWorkflow = workflow(failureLocalLog, failureDelegations, failureOutbox);
const tamperedPeerFrame = { ...firstPeerFrame, sig: tamperBase64(firstPeerFrame.sig) };
const failingRefreshClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 40, [
  vector.peerDivergedCarrierOps,
  [tamperedPeerFrame],
]);
const recoveredRefreshClient = new ControlledFeedClient([], 42, [[]]);
const failureStates: TownshipFeedState[] = [];
let failureConnects = 0;
const failureController = createTownshipFeedController({
  async connect() {
    failureConnects++;
    return {
      client: failureConnects === 1 ? failingRefreshClient : recoveredRefreshClient,
      workflow: failureWorkflow,
      verifier,
    };
  },
  async sleep() {},
  onState(state) {
    failureStates.push(structuredClone(state));
  },
  realmByPubkey: vector.realmByPubkey,
});

await failureController.replacePeer(testPeer());
await waitFor(() => failingRefreshClient.pullGates.length === 1);
failingRefreshClient.pullGates[0]?.resolve();
await waitFor(() => freshGenerations(failureStates).includes(40));
assert.equal(failureLocalLog.saveCount, 1);
assert.equal(failureDelegations.saveCount, 1);

failingRefreshClient.subscription.offer(availability(41));
await waitFor(() => failingRefreshClient.pullGates.length === 2);
failingRefreshClient.pullGates[1]?.resolve();
await waitFor(() => recoveredRefreshClient.pullGates.length === 1);
assert.equal(failureLocalLog.saveCount, 1);
assert.equal(failureDelegations.saveCount, 1);
assert.equal(failingRefreshClient.closed, true);
assert.ok(
  failureStates.some(
    (state) => state.phase === "reconnecting" && state.projection?.generation === 40,
  ),
);

recoveredRefreshClient.pullGates[0]?.resolve();
await waitFor(() => freshGenerations(failureStates).at(-1) === 42);
assert.equal(failureLocalLog.saveCount, 2);
assert.equal(failureDelegations.saveCount, 2);
assert.equal(failureOutbox.accessCount, 0);
await failureController.stop();

const stopLocalLog = new MemoryOpLog(localOps);
const stopDelegations = new MemoryFrameStore(vector.clientDivergedCarrierOps);
const stopOutbox = new ForbiddenOutboxStore();
const stopWorkflow = workflow(stopLocalLog, stopDelegations, stopOutbox);
const stopClient = new ControlledFeedClient(vector.peerDivergedCarrierOps, 50, [], false);
const stopStates: TownshipFeedState[] = [];
const inFlightStopController = createTownshipFeedController({
  connect: async () => ({ client: stopClient, workflow: stopWorkflow, verifier }),
  onState(state) {
    stopStates.push(structuredClone(state));
  },
  realmByPubkey: vector.realmByPubkey,
});

await inFlightStopController.replacePeer(testPeer());
await waitFor(() => stopClient.pullGates.length === 1);
stopClient.subscription.offer(availability(51));
await tick();
let stopResolved = false;
const stopping = inFlightStopController.stop().then(() => {
  stopResolved = true;
});
await tick();
assert.equal(stopResolved, false);
stopClient.pullGates[0]?.resolve();
await stopping;
const stoppedStateCount = stopStates.length;
await tick();
assert.equal(stopClient.closed, true);
assert.equal(stopClient.pullGates.length, 1);
assert.equal(stopLocalLog.saveCount, 0);
assert.equal(stopDelegations.saveCount, 0);
assert.equal(stopOutbox.accessCount, 0);
assert.equal(stopStates.length, stoppedStateCount);

const appSource = readFileSync(join(here, "..", "src", "App.vue"), "utf8");
assert.match(appSource, /createTownshipFeedController/);
assert.match(appSource, /townshipPreviewFromOps/);
assert.match(appSource, /carrier-feed-status/);
assert.match(appSource, /carrier-sync-status/);
assert.match(appSource, /data-phase/);
assert.match(appSource, /data-generation/);
assert.match(appSource, /data-op-count/);
assert.match(appSource, /data-post-count/);
assert.match(appSource, /await nextTick\(\)/);
assert.match(appSource, /document\.querySelector/);
assert.match(appSource, /document\.querySelectorAll/);
assert.match(appSource, /getAttribute/);
assert.match(appSource, /textContent/);
assert.match(appSource, /crypto\.subtle\.digest/);
assert.match(appSource, /postDigests/);
assert.match(appSource, /TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR/);
assert.doesNotMatch(appSource, /posts:\s*Array\.from\(/);
assert.match(appSource, /matter-render-status/);
assert.match(appSource, /township-proceedings/);
assert.match(appSource, /replacePeer\(saved\.config\)/);
assert.match(appSource, /townshipFeedController\?\.stop\(\)/);

console.log("\x1b[32m✓ Reactive Township refresh and controller checks passed\x1b[0m");

function workflow(
  localLog: LocalOpLogStore,
  delegationFrames: CarrierFrameStore,
  carrierFrames: CarrierFrameStore,
): TownshipNativeWorkflow {
  return {
    keyId: "test",
    storageNamespace: "test",
    storage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    localLog,
    carrierFrames,
    delegationFrames,
    signer: {
      publicKey: new Uint8Array(32),
      sign: () => {
        throw new Error("reactive refresh invoked the native signer");
      },
    },
  };
}

function testPeer(): TownshipCarrierPeerConfig {
  return {
    url: "ws://127.0.0.1:4111/carrier",
    localRealm: "resident",
    expectedPeerRealm: "clerk",
    expectedPeerPubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    replica: vector.replica,
  };
}

function testPeerAt(label: string): TownshipCarrierPeerConfig {
  return {
    ...testPeer(),
    url: `ws://127.0.0.1:4111/${label}`,
  };
}

function baselineStateReport(): CarrierStateReport {
  return {
    state_b64: vector.expectAfterSync.stateB64,
    state: structuredClone(vector.expectAfterSync.state),
    op_ids: [...vector.expectAfterSync.opIds],
    frontier: [],
    structural_quarantine: [],
    authority_quarantine: structuredClone(vector.expectAfterSync.authorityQuarantine),
    log_size: vector.expectAfterSync.opIds.length,
  };
}

function availability(generation: number): CarrierAvailability {
  return {
    generation,
    frontier: [`diagnostic-${generation}`],
    frontierTruncated: true,
  };
}

function freshGenerations(states: TownshipFeedState[]): number[] {
  return states.flatMap((state) =>
    state.phase === "fresh" ? [state.projection.generation] : [],
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("timed out waiting for controller state");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function tamperBase64(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

async function verifyEd25519(author: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(author, "base64")]),
    format: "der",
    type: "spki",
  });

  return edVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
}
