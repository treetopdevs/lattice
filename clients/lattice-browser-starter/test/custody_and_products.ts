import assert from "node:assert/strict";
import {
  authorCarrierDelegation,
  authorCarrierOp,
  authorTownshipCommand,
  authorTownshipGenesis,
  type CarrierOpFrame,
} from "@treetopdevs/lattice-client";
import { BrowserEcosystemHost, type DemoEndpoint } from "../src/lib/browser_host";
import {
  createIdentityFromSeedHex,
  MemoryDemoStorage,
  strictCarrierVerifier,
  strictOpVerifier,
  type DemoIdentity,
  type DemoStorage,
  type PersistedDemoSnapshot,
} from "../src/lib/custody";
import {
  authorToolshedBeacon,
  authorToolshedBorrowGrant,
  authorToolshedRequest,
  authorToolshedShedCommand,
  authorToolshedToolCommand,
  frontierIds,
  inspectReplicaLog,
  observeToolshedShed,
  observeToolshedTool,
  observeTownshipMatter,
  pickCapabilityForCommand,
  pickRootDelegationId,
  signToolshedCustodyConsent,
} from "../src/lib/products";

const FOUNDER_SEED = "11".repeat(32);
const NEIGHBOR_SEED = "22".repeat(32);

async function testCustodyAndStorage() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const msg = new TextEncoder().encode("lattice-browser-starter-custody-check");
  const sig = await founder.signer.sign(msg);

  assert.equal(strictCarrierVerifier.verify(founder.publicKey, msg, sig), true);
  assert.equal(await strictOpVerifier.verify(founder.publicKeyBase64, msg, sig), true);

  const tampered = new Uint8Array(msg);
  tampered[0] = tampered[0]! ^ 0xff;
  assert.equal(strictCarrierVerifier.verify(founder.publicKey, tampered, sig), false);
  assert.equal(await strictOpVerifier.verify(founder.publicKeyBase64, tampered, sig), false);

  const storage = new MemoryDemoStorage();
  const initial = await storage.load("ns-1");
  assert.deepEqual(initial.profiles, {});
  await storage.save({
    version: 1,
    namespace: "ns-1",
    profiles: { "replica:test": { frames: [], outbox: ["a"], acked: [] } },
  });
  const loaded = await storage.load("ns-1");
  assert.deepEqual(loaded.profiles["replica:test"]?.outbox, ["a"]);
  await storage.clear("ns-1");
  assert.deepEqual((await storage.load("ns-1")).profiles, {});
}

async function testToolshedDualSignedCustodyAndOverdue() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const neighbor = createIdentityFromSeedHex("demo-neighbor", NEIGHBOR_SEED);
  const realmByPubkey = {
    [founder.publicKeyBase64]: founder.realm,
    [neighbor.publicKeyBase64]: neighbor.realm,
  };

  const replica = "replica:tool:unit-saw";
  const frames: CarrierOpFrame[] = [];

  const genesisDel = await authorCarrierDelegation({
    replica,
    audiencePubkey: founder.publicKeyBase64,
    parentId: null,
    ops: ["describe", "note_condition", "custody_transfer"],
    roles: ["custody"],
    live: true,
    signer: founder.signer,
  });
  frames.push(
    await authorCarrierOp({
      replica,
      deps: [],
      signer: founder.signer,
      kind: "authority",
      cap: ["nil"],
      body: ["tuple", [["atom", "genesis"], ["delegation", genesisDel], ["map", []]]],
    }),
  );

  frames.push(
    await authorToolshedToolCommand({
      replica,
      deps: frontierIds(frames),
      signer: founder.signer,
      capId: genesisDel.id,
      command: { command: "describe", text: "Wet tile saw" },
    }),
  );

  // Neighbor requests borrow via durable :inbox op
  const borrowReq = await authorToolshedRequest({
    replica,
    deps: frontierIds(frames),
    signer: neighbor.signer,
    requestKind: "borrow",
  });
  frames.push(borrowReq);

  // Unconsented transfer MUST quarantine as missing_consent (ADR 0007)
  const unconsented = await authorToolshedToolCommand({
    replica,
    deps: frontierIds(frames),
    signer: founder.signer,
    capId: genesisDel.id,
    command: {
      command: "custody_transfer",
      toPubkeyBase64: neighbor.publicKeyBase64,
      requestOpId: borrowReq.id,
      consentSigBase64: null,
    },
  });
  frames.push(unconsented);

  let view = observeToolshedTool(frames, realmByPubkey);
  assert.equal(view.custody.available, true);
  assert.equal(view.quarantinedCount, 1);
  const inspectedBefore = inspectReplicaLog("Toolshed.Tool", frames, realmByPubkey);
  const badRow = inspectedBefore.ops.find((o) => o.id === unconsented.id);
  assert.equal(badRow?.quarantined, true);
  assert.equal(badRow?.reason, "missing_consent");

  // Neighbor signs ADR 0007 consent; founder transfers custody + issues leased borrow Cap
  const consentSig = await signToolshedCustodyConsent({
    replica,
    requestOpId: borrowReq.id,
    fromPubkeyBase64: founder.publicKeyBase64,
    recipientSigner: neighbor.signer,
  });
  const transfer = await authorToolshedToolCommand({
    replica,
    deps: frontierIds(frames),
    signer: founder.signer,
    capId: genesisDel.id,
    command: {
      command: "custody_transfer",
      toPubkeyBase64: neighbor.publicKeyBase64,
      requestOpId: borrowReq.id,
      consentSigBase64: consentSig,
    },
  });
  frames.push(transfer);

  const borrowGrant = await authorToolshedBorrowGrant({
    replica,
    deps: frontierIds(frames),
    parentDelegationId: genesisDel.id,
    borrowerPubkeyBase64: neighbor.publicKeyBase64,
    expiresEpoch: 4,
    signer: founder.signer,
  });
  frames.push(borrowGrant);

  view = observeToolshedTool(frames, realmByPubkey);
  assert.equal(view.custody.available, false);
  assert.equal(view.custody.holder, "demo-neighbor");
  assert.equal(view.loan?.dueEpoch, 4);
  assert.equal(view.loan?.overdue, false);
  assert.equal(view.requests[0]?.resolved, true);

  // Advance beacon past due epoch 4 -> overdue becomes true
  frames.push(
    await authorToolshedBeacon({
      replica,
      deps: frontierIds(frames),
      epoch: 5,
      signer: founder.signer,
    }),
  );
  view = observeToolshedTool(frames, realmByPubkey);
  assert.equal(view.loan?.overdue, true);
  assert.equal(view.currentEpoch, 5);

  // Neighbor requests return, founder resolves return
  const returnReq = await authorToolshedRequest({
    replica,
    deps: frontierIds(frames),
    signer: neighbor.signer,
    requestKind: "return",
  });
  frames.push(returnReq);

  const returnConsent = await signToolshedCustodyConsent({
    replica,
    requestOpId: returnReq.id,
    fromPubkeyBase64: founder.publicKeyBase64,
    recipientSigner: founder.signer,
  });
  frames.push(
    await authorToolshedToolCommand({
      replica,
      deps: frontierIds(frames),
      signer: founder.signer,
      capId: genesisDel.id,
      command: {
        command: "custody_transfer",
        toPubkeyBase64: founder.publicKeyBase64,
        requestOpId: returnReq.id,
        consentSigBase64: returnConsent,
      },
    }),
  );

  view = observeToolshedTool(frames, realmByPubkey);
  assert.equal(view.custody.available, true);
  assert.equal(view.loan, null);
  assert.equal(view.requests.every((r) => r.resolved), true);
}

async function testShedAndTownshipQuarantine() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const neighbor = createIdentityFromSeedHex("demo-neighbor", NEIGHBOR_SEED);
  const realmByPubkey = {
    [founder.publicKeyBase64]: founder.realm,
    [neighbor.publicKeyBase64]: neighbor.realm,
  };

  // Shed unauthorized steward bulletin quarantines
  const shedReplica = "replica:shed:unit-shed";
  const shedGenesis = await authorCarrierDelegation({
    replica: shedReplica,
    audiencePubkey: founder.publicKeyBase64,
    parentId: null,
    ops: ["set_name", "vouch_in", "list_tool", "post_bulletin"],
    roles: ["steward"],
    live: true,
    signer: founder.signer,
  });
  const shedFrames: CarrierOpFrame[] = [
    await authorCarrierOp({
      replica: shedReplica,
      deps: [],
      signer: founder.signer,
      kind: "authority",
      cap: ["nil"],
      body: ["tuple", [["atom", "genesis"], ["delegation", shedGenesis], ["map", []]]],
    }),
  ];
  shedFrames.push(
    await authorToolshedShedCommand({
      replica: shedReplica,
      deps: frontierIds(shedFrames),
      signer: founder.signer,
      capId: shedGenesis.id,
      command: { command: "set_name", text: "Oak Block Shed" },
    }),
  );
  shedFrames.push(
    await authorToolshedShedCommand({
      replica: shedReplica,
      deps: frontierIds(shedFrames),
      signer: neighbor.signer,
      capId: null,
      command: { command: "post_bulletin", text: "Forged notice" },
    }),
  );
  const shedView = observeToolshedShed(shedFrames, realmByPubkey);
  assert.equal(shedView.name, "Oak Block Shed");
  assert.equal(shedView.bulletin, "");
  assert.equal(shedView.quarantinedCount, 1);

  // Township Matter unauthorized close quarantines
  const matterReplica = "replica:township:unit-matter";
  const genesisFrame = await authorTownshipGenesis({
    replica: matterReplica,
    ops: ["set_title", "post", "close_matter", "reopen_matter"],
    roles: ["clerk"],
    signer: founder.signer,
  });
  const boundReplica = genesisFrame.replica;
  const matterFrames: CarrierOpFrame[] = [genesisFrame];
  const rootCap = pickCapabilityForCommand(
    "Township.Matter",
    matterFrames,
    founder.publicKeyBase64,
    "set_title",
    realmByPubkey,
  );
  assert.ok(rootCap);
  matterFrames.push(
    await authorTownshipCommand({
      replica: boundReplica,
      deps: frontierIds(matterFrames),
      signer: founder.signer,
      capId: rootCap,
      command: { command: "set_title", text: "Unit Bridge Matter" },
    }),
  );
  matterFrames.push(
    await authorTownshipCommand({
      replica: boundReplica,
      deps: frontierIds(matterFrames),
      signer: neighbor.signer,
      capId: null,
      command: { command: "close_matter" },
    }),
  );
  const matterView = observeTownshipMatter(matterFrames, realmByPubkey);
  assert.equal(matterView.title, "Unit Bridge Matter");
  assert.equal(matterView.clerkLocked, false);
  assert.equal(matterView.quarantinedCount, 1);
}

const TOOL_REPLICA = "replica:tool:unit-host-saw";
const SPACE_REPLICA = "replica:treehouse:space:unit-host";

function endpoint(product: DemoEndpoint["product"], replica: string, port: number): DemoEndpoint {
  return {
    name: product,
    product,
    replica,
    ws_url: `ws://127.0.0.1:${port}/carrier`,
    peer_realm: "demo-relay",
    peer_pubkey: createIdentityFromSeedHex("demo-relay", "33".repeat(32)).publicKeyBase64,
    relay_realms: [],
    initial_ops: 0,
  };
}

const HOST_ENDPOINTS = [
  endpoint("Treehouse.Space", SPACE_REPLICA, 4990),
  endpoint("Toolshed.Tool", TOOL_REPLICA, 4991),
];

/** A genesis frame and one command on it: two verifiable frames, the second depending on the first. */
async function toolFrames(owner: DemoIdentity, replica = TOOL_REPLICA): Promise<CarrierOpFrame[]> {
  const genesisDel = await authorCarrierDelegation({
    replica,
    audiencePubkey: owner.publicKeyBase64,
    parentId: null,
    ops: ["describe", "note_condition", "custody_transfer"],
    roles: ["custody"],
    live: true,
    signer: owner.signer,
  });
  const genesis = await authorCarrierOp({
    replica,
    deps: [],
    signer: owner.signer,
    kind: "authority",
    cap: ["nil"],
    body: ["tuple", [["atom", "genesis"], ["delegation", genesisDel], ["map", []]]],
  });
  const describe = await authorToolshedToolCommand({
    replica,
    deps: [genesis.id],
    signer: owner.signer,
    capId: genesisDel.id,
    command: { command: "describe", text: "Wet tile saw" },
  });
  return [genesis, describe];
}

/** Memory storage whose saves can be held open or failed, and whose loads and claims can be refused. */
class ControlledStorage implements DemoStorage {
  readonly inner = new MemoryDemoStorage();
  saves = 0;
  failNextSaves = 0;
  failLoadOf: string | null = null;
  heldBy = new Set<string>();
  claimedElsewhere = new Set<string>();
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  holdSaves(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  releaseSaves(): void {
    this.openGate?.();
    this.gate = null;
  }

  async load(namespace: string): Promise<PersistedDemoSnapshot> {
    if (this.failLoadOf === namespace) throw new Error("load_failed");
    return this.inner.load(namespace);
  }

  async save(snapshot: PersistedDemoSnapshot): Promise<void> {
    await this.gate;
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error("save_failed");
    }
    this.saves++;
    return this.inner.save(snapshot);
  }

  clear(namespace: string): Promise<void> {
    return this.inner.clear(namespace);
  }

  async claim(namespace: string): Promise<() => void> {
    if (this.claimedElsewhere.has(namespace)) throw new Error("namespace_in_use");
    this.heldBy.add(namespace);
    return () => this.heldBy.delete(namespace);
  }
}

async function storedIds(storage: ControlledStorage, namespace: string, replica: string) {
  return (await storage.inner.load(namespace)).profiles[replica]?.frames.map((f) => f.id) ?? [];
}

async function testHostProfileSwitch() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const neighbor = createIdentityFromSeedHex("demo-neighbor", NEIGHBOR_SEED);
  const [genesis, describe] = await toolFrames(founder);

  // An append still waiting on a blocked save lands in the profile it was made for, not in the one
  // a later `configure` switches to.
  const storage = new ControlledStorage();
  const host = new BrowserEcosystemHost({ storage });
  await host.configure(HOST_ENDPOINTS, founder, "ns-founder");
  assert.deepEqual([...storage.heldBy], ["ns-founder"]);
  storage.holdSaves();
  const first = host.appendLocalFrame(TOOL_REPLICA, genesis!);
  const second = host.appendLocalFrame(TOOL_REPLICA, describe!);
  const switched = host.configure(HOST_ENDPOINTS, neighbor, "ns-neighbor");
  storage.releaseSaves();
  await Promise.all([first, second, switched]);
  assert.deepEqual(await storedIds(storage, "ns-founder", TOOL_REPLICA), [genesis!.id, describe!.id]);
  assert.deepEqual(await storedIds(storage, "ns-neighbor", TOOL_REPLICA), []);
  assert.equal(host.getIdentity(), neighbor);
  assert.deepEqual(host.getFrames(TOOL_REPLICA), []);
  assert.deepEqual([...storage.heldBy], ["ns-neighbor"], "the previous namespace is released");

  // A switch whose load fails keeps the previous identity, namespace and snapshot together.
  await host.configure(HOST_ENDPOINTS, founder, "ns-founder");

  // A frame handed over once the switch is already under way was signed for the profile being
  // left: it is refused, not stored under the next identity.
  storage.holdSaves();
  const blocking = host.mergeSync(TOOL_REPLICA, [], ["held-open"]);
  const leaving = host.configure(HOST_ENDPOINTS, neighbor, "ns-neighbor");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const late = host.appendLocalFrame(TOOL_REPLICA, genesis!);
  const lateOutcome = assert.rejects(late, /host_reconfigured/);
  storage.releaseSaves();
  await Promise.all([blocking, leaving, lateOutcome]);
  assert.deepEqual(await storedIds(storage, "ns-neighbor", TOOL_REPLICA), []);
  await host.configure(HOST_ENDPOINTS, founder, "ns-founder");
  storage.failLoadOf = "ns-neighbor";
  await assert.rejects(host.configure(HOST_ENDPOINTS, neighbor, "ns-neighbor"), /load_failed/);
  assert.equal(host.getIdentity(), founder);
  assert.equal(host.isOnline(), false);
  assert.deepEqual(host.getFrames(TOOL_REPLICA).map((f) => f.id), [genesis!.id, describe!.id]);
  assert.deepEqual([...storage.heldBy], ["ns-founder"], "the refused namespace is not kept");
  const note = await authorToolshedToolCommand({
    replica: TOOL_REPLICA,
    deps: [describe!.id],
    signer: founder.signer,
    capId: null,
    command: { command: "note_condition", text: "after the failed switch" },
  });
  await host.appendLocalFrame(TOOL_REPLICA, note);
  assert.equal((await storedIds(storage, "ns-founder", TOOL_REPLICA)).includes(note.id), true);
  assert.deepEqual(await storedIds(storage, "ns-neighbor", TOOL_REPLICA), []);

  // A namespace another tab owns is refused, and the previous profile stays in place.
  storage.failLoadOf = null;
  storage.claimedElsewhere.add("ns-neighbor");
  await assert.rejects(host.configure(HOST_ENDPOINTS, neighbor, "ns-neighbor"), /namespace_in_use/);
  assert.equal(host.getIdentity(), founder);
  await host.dispose();
  assert.deepEqual([...storage.heldBy], []);
}

async function testHostDurability() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const [genesis, describe] = await toolFrames(founder);
  const storage = new ControlledStorage();
  const host = new BrowserEcosystemHost({ storage });
  await host.configure(HOST_ENDPOINTS, founder, "ns");

  // A merge whose save failed is not remembered as done: the retry stores it.
  storage.failNextSaves = 1;
  await assert.rejects(host.mergeSync(TOOL_REPLICA, [genesis!], []), /save_failed/);
  assert.deepEqual(host.getFrames(TOOL_REPLICA), []);
  await host.mergeSync(TOOL_REPLICA, [genesis!], []);
  assert.deepEqual(await storedIds(storage, "ns", TOOL_REPLICA), [genesis!.id]);
  const savesAfterMerge = storage.saves;
  await host.mergeSync(TOOL_REPLICA, [genesis!], []);
  assert.equal(storage.saves, savesAfterMerge, "a duplicate merge after a successful save does not write");

  // Frames appended together are stored together: a failed save keeps neither.
  const note = await authorToolshedToolCommand({
    replica: TOOL_REPLICA,
    deps: [describe!.id],
    signer: founder.signer,
    capId: null,
    command: { command: "note_condition", text: "pair" },
  });
  storage.failNextSaves = 1;
  await assert.rejects(host.appendLocalFrames(TOOL_REPLICA, [describe!, note]), /save_failed/);
  assert.deepEqual(host.getFrames(TOOL_REPLICA).map((f) => f.id), [genesis!.id]);
  assert.equal(host.getPendingCount(TOOL_REPLICA), 0);
  await host.appendLocalFrames(TOOL_REPLICA, [describe!, note]);
  assert.deepEqual(await storedIds(storage, "ns", TOOL_REPLICA), [genesis!.id, describe!.id, note.id]);
  assert.equal(host.getPendingCount(TOOL_REPLICA), 2);

  // The anchor guard reflects what is held: no Space frames, no anchor profile.
  assert.equal(host.holdsAnchorProfile(), false);
  const [spaceGenesis] = await toolFrames(founder, SPACE_REPLICA);
  await host.mergeSync(SPACE_REPLICA, [spaceGenesis!], []);
  assert.equal(host.holdsAnchorProfile(), true);
  await host.clearLocalStorage();
  assert.equal(host.holdsAnchorProfile(), false);
  await host.dispose();
}

async function testStoredFramesAreVerified() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const [genesis, describe] = await toolFrames(founder);
  const [spaceGenesis] = await toolFrames(founder, SPACE_REPLICA);
  const forged = await authorToolshedToolCommand({
    replica: TOOL_REPLICA,
    deps: [genesis!.id],
    signer: founder.signer,
    capId: null,
    command: { command: "describe", text: "Altered after it was stored" },
  });
  const held = (frames: CarrierOpFrame[]) => ({ frames, outbox: [], acked: [] });
  const cases: [string, CarrierOpFrame[]][] = [
    // The body changed and the original id kept: the relay would never send the real frame again.
    ["altered body under the original id", [genesis!, { ...describe!, body: forged.body }]],
    ["signature from another frame", [genesis!, { ...describe!, sig: forged.sig }]],
    ["dependency not held", [describe!]],
    ["frame of another replica", [genesis!, spaceGenesis!]],
  ];
  for (const [label, frames] of cases) {
    const storage = new ControlledStorage();
    await storage.inner.save({
      version: 1,
      namespace: "ns",
      profiles: { [TOOL_REPLICA]: held(frames), [SPACE_REPLICA]: held([spaceGenesis!]) },
    });
    const host = new BrowserEcosystemHost({ storage });
    await host.configure(HOST_ENDPOINTS, founder, "ns");
    assert.deepEqual(host.getFrames(TOOL_REPLICA), [], label);
    assert.deepEqual(await storedIds(storage, "ns", TOOL_REPLICA), [], `${label}: stored record replaced`);
    assert.deepEqual(host.getFrames(SPACE_REPLICA).map((f) => f.id), [spaceGenesis!.id], label);
    await host.dispose();
  }

  const storage = new ControlledStorage();
  await storage.inner.save({
    version: 1,
    namespace: "ns",
    profiles: { [TOOL_REPLICA]: { frames: [genesis!, describe!], outbox: [describe!.id], acked: [] } },
  });
  const host = new BrowserEcosystemHost({ storage });
  await host.configure(HOST_ENDPOINTS, founder, "ns");
  assert.deepEqual(host.getFrames(TOOL_REPLICA).map((f) => f.id), [genesis!.id, describe!.id]);
  assert.equal(host.getPendingCount(TOOL_REPLICA), 1);
  assert.equal(storage.saves, 0, "a profile that verifies is not rewritten");
  await host.dispose();
}

async function testCapabilityAndLeaseSelection() {
  const founder = createIdentityFromSeedHex("demo-founder", FOUNDER_SEED);
  const neighbor = createIdentityFromSeedHex("demo-neighbor", NEIGHBOR_SEED);
  const realmByPubkey = {
    [founder.publicKeyBase64]: founder.realm,
    [neighbor.publicKeyBase64]: neighbor.realm,
  };
  const replica = TOOL_REPLICA;
  const frames = await toolFrames(founder);
  const rootId = pickRootDelegationId("Toolshed.Tool", frames, founder.publicKeyBase64, realmByPubkey);
  assert.ok(rootId, "the genesis delegation is the root capability");
  const cap = (who: DemoIdentity, command: string, held: CarrierOpFrame[] = frames) =>
    pickCapabilityForCommand("Toolshed.Tool", held, who.publicKeyBase64, command, realmByPubkey);
  assert.equal(cap(founder, "custody_transfer"), rootId);
  assert.equal(cap(neighbor, "note_condition"), null);

  // An attenuated grant is picked for its audience.
  const grantDel = await authorCarrierDelegation({
    replica,
    audiencePubkey: neighbor.publicKeyBase64,
    parentId: rootId,
    ops: ["describe"],
    roles: [],
    live: false,
    signer: founder.signer,
  });
  frames.push(
    await authorCarrierOp({
      replica,
      deps: frontierIds(frames),
      signer: founder.signer,
      kind: "authority",
      cap: ["nil"],
      body: ["tuple", [["atom", "grant"], ["delegation", grantDel]]],
    }),
  );
  assert.equal(cap(neighbor, "describe"), grantDel.id);

  // A delegation-shaped term inside a command body is not authority evidence: the neighbor signs a
  // "custody_transfer" delegation to the founder and buries it in a command. Picking it would have
  // the founder cite a capability that does not exist and quarantine every later transfer.
  const planted = await authorCarrierDelegation({
    replica,
    audiencePubkey: founder.publicKeyBase64,
    parentId: null,
    ops: ["describe", "note_condition", "custody_transfer"],
    roles: ["custody"],
    live: true,
    signer: neighbor.signer,
  });
  frames.push(
    await authorCarrierOp({
      replica,
      deps: frontierIds(frames),
      signer: neighbor.signer,
      kind: "command",
      cap: ["nil"],
      body: ["tuple", [["atom", "describe"], ["list", [["delegation", planted]]]]],
    }),
  );
  assert.equal(cap(founder, "custody_transfer"), rootId);
  assert.equal(
    pickRootDelegationId("Toolshed.Tool", frames, founder.publicKeyBase64, realmByPubkey),
    rootId,
  );

  // Hand the tool to the neighbor, then lease twice: due epoch 4, renewed to 8.
  const borrowReq = await authorToolshedRequest({
    replica,
    deps: frontierIds(frames),
    signer: neighbor.signer,
    requestKind: "borrow",
  });
  frames.push(borrowReq);
  frames.push(
    await authorToolshedToolCommand({
      replica,
      deps: frontierIds(frames),
      signer: founder.signer,
      capId: rootId,
      command: {
        command: "custody_transfer",
        toPubkeyBase64: neighbor.publicKeyBase64,
        requestOpId: borrowReq.id,
        consentSigBase64: await signToolshedCustodyConsent({
          replica,
          requestOpId: borrowReq.id,
          fromPubkeyBase64: founder.publicKeyBase64,
          recipientSigner: neighbor.signer,
        }),
      },
    }),
  );
  const lease = async (expiresEpoch: number) => {
    const frame = await authorToolshedBorrowGrant({
      replica,
      deps: frontierIds(frames),
      parentDelegationId: rootId,
      borrowerPubkeyBase64: neighbor.publicKeyBase64,
      expiresEpoch,
      signer: founder.signer,
    });
    frames.push(frame);
    return frame;
  };
  const firstLease = await lease(4);
  const renewal = await lease(8);
  frames.push(
    await authorToolshedBeacon({ replica, deps: frontierIds(frames), epoch: 5, signer: founder.signer }),
  );

  // The same frames in the order another replica might have received them.
  const reordered = [
    ...frames.filter((f) => f.id === renewal.id),
    ...frames.filter((f) => f.id !== renewal.id && f.id !== firstLease.id),
    ...frames.filter((f) => f.id === firstLease.id),
  ];
  for (const held of [frames, reordered, [...frames].reverse()]) {
    const view = observeToolshedTool(held, realmByPubkey);
    assert.equal(view.custody.available, false);
    assert.equal(view.loan?.dueEpoch, 8, "the renewal is the active lease in every frame order");
    assert.equal(view.loan?.overdue, false);
    assert.equal(cap(neighbor, "note_condition", held), cap(neighbor, "note_condition"));
  }
  assert.ok(cap(neighbor, "note_condition"), "an unexpired lease is still picked");
}

await testCustodyAndStorage();
await testToolshedDualSignedCustodyAndOverdue();
await testShedAndTownshipQuarantine();
await testHostProfileSwitch();
await testHostDurability();
await testStoredFramesAreVerified();
await testCapabilityAndLeaseSelection();
console.log("PASS: custody_and_products unit checks green.");
