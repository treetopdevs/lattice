import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  syncCarrierOnce,
  type CarrierOpFrame,
  type CarrierPushReport,
  type CarrierRelayClient,
  type CarrierSyncClient,
  type Verifier,
} from "../src/index";

interface CarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  clientDivergedCarrierOps: CarrierOpFrame[];
}

type RelayOutcome = CarrierPushReport | Error;

class ScriptedRelaySyncClient implements CarrierSyncClient, CarrierRelayClient {
  readonly relayedIds: string[] = [];
  advertiseCalls = 0;
  pushCalls = 0;

  constructor(
    private readonly advertisements: string[][],
    private readonly outcomes: ReadonlyMap<string, RelayOutcome>,
  ) {}

  async advertise(): Promise<string[]> {
    const index = Math.min(this.advertiseCalls, this.advertisements.length - 1);
    this.advertiseCalls++;
    return [...(this.advertisements[index] ?? [])];
  }

  async pull(): Promise<unknown[]> {
    return [];
  }

  async push(): Promise<CarrierPushReport> {
    this.pushCalls++;
    throw new Error("generic push fallback called");
  }

  async relay(op: CarrierOpFrame): Promise<CarrierPushReport> {
    this.relayedIds.push(op.id);
    const outcome = this.outcomes.get(op.id);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? emptyReport();
  }
}

class PushRecordingClient implements CarrierSyncClient {
  readonly pushedIds: string[] = [];

  constructor(private readonly pulledFrames: unknown[] = []) {}

  async advertise(): Promise<string[]> {
    return [];
  }

  async pull(): Promise<unknown[]> {
    return [...this.pulledFrames];
  }

  async push(ops: unknown[]): Promise<CarrierPushReport> {
    this.pushedIds.push(...(ops as CarrierOpFrame[]).map((op) => op.id));
    return { ...emptyReport(), accepted: [...this.pushedIds] };
  }
}

console.log("\n▸ Relay-aware carrier sync");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const [genesis, grant, , , summary, post] = vector.clientDivergedCarrierOps;
if (!genesis || !grant || !summary || !post) throw new Error("missing relay sync fixtures");
const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
const operationVerifier: Verifier = { verify: verifyEd25519 };

for (const { label, frame } of [
  { label: "tampered signature", frame: { ...genesis, sig: tamperBase64(genesis.sig) } },
  { label: "tampered id", frame: { ...genesis, id: `${genesis.id}x` } },
]) {
  const invalidPullClient = new PushRecordingClient([frame]);
  let invalidPullError: unknown;

  try {
    await syncCarrierOnce(invalidPullClient, [], [post], vector.realmByPubkey, {
      verifier: operationVerifier,
      expectedReplica: vector.replica,
    });
  } catch (error) {
    invalidPullError = error;
  }

  assert.equal(invalidPullClient.pushedIds.length, 0, `${label} must fail before push`);
  assert.ok(invalidPullError instanceof Error, `${label} must reject the sync`);
}

const defaultPush = new PushRecordingClient();
const defaultFrames = [post, summary];
const defaultSynced = await syncCarrierOnce(defaultPush, localOps, defaultFrames, vector.realmByPubkey, {
  verifier: operationVerifier,
  expectedReplica: vector.replica,
});
assert.deepEqual(defaultPush.pushedIds, defaultFrames.map((frame) => frame.id));
assert.deepEqual(defaultSynced.pushedFrames, defaultFrames);

const shallowRelayFrame = structuredClone(post);
Reflect.set(
  shallowRelayFrame.body,
  shallowRelayFrame.body.length,
  "relay-preserves-authored-frame",
);
const shallowRelayClient = new ScriptedRelaySyncClient(
  [[]],
  new Map([
    [
      shallowRelayFrame.id,
      { ...emptyReport(), accepted: [shallowRelayFrame.id] },
    ],
  ]),
);
const shallowRelaySynced = await syncCarrierOnce(
  shallowRelayClient,
  localOps,
  [shallowRelayFrame],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(shallowRelayClient.relayedIds, []);
assert.deepEqual(shallowRelaySynced.pushedFrames, []);
assert.deepEqual(shallowRelaySynced.peerReportedFrameIds, []);
assert.deepEqual(shallowRelaySynced.unverifiableFrameIds, [shallowRelayFrame.id]);

const anonymousMalformedFrame = structuredClone(post);
Reflect.deleteProperty(anonymousMalformedFrame, "id");
const anonymousMalformedClient = new ScriptedRelaySyncClient([[]], new Map());
const anonymousMalformedSynced = await syncCarrierOnce(
  anonymousMalformedClient,
  localOps,
  [anonymousMalformedFrame],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(anonymousMalformedClient.relayedIds, []);
assert.deepEqual(anonymousMalformedSynced.pushedFrames, []);
assert.deepEqual(anonymousMalformedSynced.unverifiableFrameIds, []);

const relayFrames = [post, grant, genesis, summary];
const relayReports = new Map<string, RelayOutcome>([
  [genesis.id, { ...emptyReport(), accepted: [genesis.id] }],
  [grant.id, { ...emptyReport(), quarantined: [[grant.id, "authority"]] }],
  [summary.id, { ...emptyReport(), rejected: [[summary.id, "invalid"]] }],
  [post.id, { ...emptyReport(), pending: [post.id] }],
]);
const relayClient = new ScriptedRelaySyncClient([[]], relayReports);
const relaySynced = await syncCarrierOnce(
  relayClient,
  localOps,
  relayFrames,
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
const causalOrder = [genesis.id, grant.id, summary.id, post.id];
assert.deepEqual(relayClient.relayedIds, causalOrder);
assert.equal(relayClient.pushCalls, 0);
assert.deepEqual(relaySynced.pushedFrames.map(frameId), causalOrder);
assert.deepEqual(relaySynced.pushReport, {
  accepted: [genesis.id],
  quarantined: [[grant.id, "authority"]],
  rejected: [[summary.id, "invalid"]],
  pending: [post.id],
});
assert.deepEqual(relaySynced.peerReportedFrameIds, [genesis.id]);

// A malicious carrier naming ids it never received must not make them
// compactable: accepted ids are trusted only for frames submitted this call.
const forgedAcceptClient = new ScriptedRelaySyncClient(
  [[]],
  new Map<string, RelayOutcome>([
    [genesis.id, { ...emptyReport(), accepted: [genesis.id, post.id, grant.id] }],
  ]),
);
const forgedAcceptSynced = await syncCarrierOnce(
  forgedAcceptClient,
  localOps,
  [genesis],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(forgedAcceptClient.relayedIds, [genesis.id]);
assert.deepEqual(forgedAcceptSynced.peerReportedFrameIds, [genesis.id]);

// Same forgery naming a locally unverifiable frame filtered from egress:
// the corrupt frame must stay out of the compactable set and remain flagged.
const forgedUnverifiableFrame = structuredClone(post);
Reflect.set(
  forgedUnverifiableFrame.body,
  forgedUnverifiableFrame.body.length,
  "forged-accept-preserves-warning",
);
const forgedUnverifiableClient = new ScriptedRelaySyncClient(
  [[]],
  new Map<string, RelayOutcome>([
    [
      genesis.id,
      { ...emptyReport(), accepted: [genesis.id, forgedUnverifiableFrame.id] },
    ],
  ]),
);
const forgedUnverifiableSynced = await syncCarrierOnce(
  forgedUnverifiableClient,
  localOps,
  [forgedUnverifiableFrame, genesis],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(forgedUnverifiableClient.relayedIds, [genesis.id]);
assert.deepEqual(forgedUnverifiableSynced.peerReportedFrameIds, [genesis.id]);
assert.deepEqual(forgedUnverifiableSynced.unverifiableFrameIds, [
  forgedUnverifiableFrame.id,
]);

// Push mode: a forged accepted id outside the pushed set is discarded too.
const forgedWithheldId = grant.id;
class ForgedPushClient extends PushRecordingClient {
  override async push(ops: unknown[]): Promise<CarrierPushReport> {
    const report = await super.push(ops);
    return {
      ...report,
      accepted: [...report.accepted, forgedWithheldId, "carrier-invented-id"],
    };
  }
}
const forgedPushClient = new ForgedPushClient();
const forgedPushSynced = await syncCarrierOnce(
  forgedPushClient,
  localOps,
  [post],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(forgedPushClient.pushedIds, [post.id]);
assert.deepEqual(forgedPushSynced.peerReportedFrameIds, [post.id]);

const rateLimitedClient = new ScriptedRelaySyncClient(
  [[]],
  new Map<string, RelayOutcome>([
    [genesis.id, { ...emptyReport(), accepted: [genesis.id] }],
    [grant.id, new Error("carrier peer error: rate_limited")],
  ]),
);
const partiallySynced = await syncCarrierOnce(
  rateLimitedClient,
  localOps,
  [grant, genesis],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.deepEqual(rateLimitedClient.relayedIds, [genesis.id, grant.id]);
assert.deepEqual(partiallySynced.pushedFrames.map(frameId), [genesis.id]);
assert.deepEqual(partiallySynced.pushReport, {
  ...emptyReport(),
  accepted: [genesis.id],
});
assert.deepEqual(partiallySynced.peerReportedFrameIds, [genesis.id]);

const unavailableClient = new ScriptedRelaySyncClient(
  [[]],
  new Map([[genesis.id, new Error("carrier peer error: unavailable")]]),
);
await assert.rejects(
  () =>
    syncCarrierOnce(unavailableClient, localOps, [genesis], vector.realmByPubkey, {
      verifier: operationVerifier,
      submission: "relay",
      expectedReplica: vector.replica,
    }),
  /carrier peer error: unavailable/,
);

const confirmedDuplicateClient = new ScriptedRelaySyncClient([[], [post.id]], new Map());
const confirmedDuplicate = await syncCarrierOnce(
  confirmedDuplicateClient,
  localOps,
  [post],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.equal(confirmedDuplicateClient.advertiseCalls, 2);
assert.deepEqual(confirmedDuplicateClient.relayedIds, [post.id]);
assert.deepEqual(confirmedDuplicate.pushReport, emptyReport());
assert.deepEqual(confirmedDuplicate.peerReportedFrameIds, [post.id]);

const unconfirmedDuplicateClient = new ScriptedRelaySyncClient([[], []], new Map());
const unconfirmedDuplicate = await syncCarrierOnce(
  unconfirmedDuplicateClient,
  localOps,
  [post],
  vector.realmByPubkey,
  {
    verifier: operationVerifier,
    submission: "relay",
    expectedReplica: vector.replica,
  },
);
assert.equal(unconfirmedDuplicateClient.advertiseCalls, 2);
assert.deepEqual(unconfirmedDuplicate.peerReportedFrameIds, []);

let pushFallbackCalls = 0;
const pushOnlyClient: CarrierSyncClient = {
  async advertise() {
    return [];
  },
  async pull() {
    return [];
  },
  async push() {
    pushFallbackCalls++;
    return { ...emptyReport(), accepted: [post.id] };
  },
};
await assert.rejects(
  () =>
    syncCarrierOnce(pushOnlyClient, localOps, [post], vector.realmByPubkey, {
      verifier: operationVerifier,
      submission: "relay",
      expectedReplica: vector.replica,
    }),
  /does not support relay/,
);
assert.equal(pushFallbackCalls, 0);

console.log("\x1b[32m✓ Relay-aware carrier sync checks passed\x1b[0m");

function emptyReport(): CarrierPushReport {
  return { accepted: [], quarantined: [], rejected: [], pending: [] };
}

function frameId(frame: unknown): string {
  if (frame && typeof frame === "object" && typeof (frame as { id?: unknown }).id === "string") {
    return (frame as { id: string }).id;
  }
  throw new Error("carrier frame missing id");
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
