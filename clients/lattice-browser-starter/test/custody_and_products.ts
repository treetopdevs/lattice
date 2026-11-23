import assert from "node:assert/strict";
import {
  authorCarrierDelegation,
  authorCarrierOp,
  authorTownshipCommand,
  authorTownshipGenesis,
  type CarrierOpFrame,
} from "@treetopdevs/lattice-client";
import {
  createIdentityFromSeedHex,
  MemoryDemoStorage,
  strictCarrierVerifier,
  strictOpVerifier,
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

await testCustodyAndStorage();
await testToolshedDualSignedCustodyAndOverdue();
await testShedAndTownshipQuarantine();
console.log("PASS: custody_and_products unit checks green.");
