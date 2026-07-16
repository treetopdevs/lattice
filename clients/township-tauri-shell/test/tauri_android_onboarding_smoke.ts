import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorTownshipCommand,
  authorTownshipDelegation,
  canonicalBytesForCarrierOp,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  connectCarrierWebSocket,
  frontier,
  type CarrierOpFrame,
  type CarrierVerifier,
  type ReplicaSchema,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  exportTownshipCarrierPairingHandoff,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import {
  cleanupAndroid,
  clearAppData,
  clickButtonByText,
  connectToAppWebView,
  defaultDebugApkPath,
  ensureAndroidDevice,
  fillInputByLabel,
  fillTextareaByLabel,
  forceStopApp,
  installDebugApk,
  launchApp,
  tauriInvoke,
  waitForDocumentText,
  waitForTauriInvoke,
  type CdpClient,
  type ManagedProcess,
} from "./support/android_cdp";
import { peerUrl, spawnTownshipPeer, type TownshipPeerProcess } from "./support/beam_peer";

interface CarrierVector {
  scenario: string;
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientBaseCarrierOps: CarrierOpFrame[];
}

interface LocalIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface CdpNativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const vector = JSON.parse(
  readFileSync(join(shellRoot, "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const keyId = TOWNSHIP_NATIVE_KEY_ID;
const apkPath = defaultDebugApkPath();
const clerkIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:clerk`);
const postText = `android pull-onboarded post ${Date.now()}`;
const rejectedSummaryText = `android pull-onboarded unauthorized summary ${Date.now()}`;
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

console.log(`\n▸ ${vector.scenario} tauri:android:onboarding:smoke`);
console.log("  Android debug APK pull-based cap onboarding through real pairing and sync UI");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let peer: TownshipPeerProcess | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installDebugApk(serial, apkPath);
  await clearAppData(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  let appCdp = await connectReadyCdp(serial);
  const devicePublicKeyBase64 = await tauriInvoke<string>(appCdp, "lattice_ensure_carrier_key", { keyId });
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  await assertNoLocalDelegationEvidence(appCdp);

  peer = await spawnTownshipPeer({
    peerRealm: vector.peer.realm,
    trustedPeerRealm: vector.client.realm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
  });

  const pushedGrant = await pushPostOnlyGrantToPeer(appCdp, peer, devicePublicKeyBase64);
  await waitForPeerDivergence(appCdp, peer, devicePublicKeyBase64);

  const pairingConfig: TownshipCarrierPeerConfig = {
    url: peerUrl(peer.port, "10.0.2.2"),
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: vector.peer.sessionPubkey,
    replica: vector.replica,
    keyId,
  };
  const pairingHandoff = exportTownshipCarrierPairingHandoff(pairingConfig);
  assert.equal(pairingHandoff.includes(devicePublicKeyBase64), false);
  assert.doesNotMatch(pairingHandoff, /seed|private|secret|keyId/i);

  await fillTextareaByLabel(appCdp, "Pairing handoff", pairingHandoff);
  await clickButtonByText(appCdp, "Load handoff");
  await waitForDocumentText(appCdp, "Pairing handoff loaded; save before sync.", 60_000);
  await fillInputByLabel(appCdp, "Local realm", vector.client.realm);
  await fillInputByLabel(appCdp, "Key id", keyId);
  await clickButtonByText(appCdp, "Save pairing");
  await waitForDocumentText(appCdp, "Pairing config saved for future sync.", 60_000);

  await clickButtonByText(appCdp, "Sync outbox");
  await waitForDocumentText(appCdp, "Pushed 0, pulled", 90_000);
  const pulledGrantDelegationId = await assertPulledGrantEvidence(appCdp, pushedGrant.grantFrame.id, pushedGrant.grantDelegationId);

  appCdp.close();
  await forceStopApp(serial);
  await launchApp(serial);
  appCdp = await connectReadyCdp(serial);
  const devicePublicKeyAfterRestart = await tauriInvoke<string>(appCdp, "lattice_ensure_carrier_key", { keyId });
  assert.equal(devicePublicKeyAfterRestart, devicePublicKeyBase64);
  await waitForDocumentText(appCdp, "Ready to sync outbox.", 60_000);
  assert.equal(
    await assertPulledGrantEvidence(appCdp, pushedGrant.grantFrame.id, pushedGrant.grantDelegationId),
    pulledGrantDelegationId,
  );

  await assertNoLocalFrameContains(appCdp, postText, devicePublicKeyBase64);
  await fillTextareaByLabel(appCdp, "Township post update", postText);
  await clickButtonByText(appCdp, "Post update");
  await waitForDocumentText(appCdp, "Saved signed frame", 60_000);
  const authoredPostFrame = await waitForAuthoredPostFrame(appCdp, devicePublicKeyBase64, postText);
  assert.ok(authoredPostFrame.author === devicePublicKeyBase64, "authored post author === devicePublicKeyBase64");
  assert.equal(capIdFromFrame(authoredPostFrame), pulledGrantDelegationId, "capId === pulledGrantDelegationId");
  assertCarrierFrameSignature(authoredPostFrame, devicePublicKeyBase64);

  await clickButtonByText(appCdp, "Sync outbox");
  await waitForDocumentText(appCdp, "Pushed 1, pulled", 90_000);
  await assertNativeOutboxCompacted(appCdp);
  await assertPeerMaterializedAuthoredPost(
    appCdp,
    peer,
    devicePublicKeyBase64,
    pushedGrant.grantFrame.id,
    authoredPostFrame.id,
  );
  await assertPeerRejectsUngrantableSummary(
    appCdp,
    peer,
    devicePublicKeyBase64,
    pulledGrantDelegationId,
    authoredPostFrame.id,
  );
  await shutdownPeer(appCdp, peer, devicePublicKeyBase64);
  appCdp.close();
  await peer.awaitExit();
} finally {
  peer?.kill();
  if (serial) await forceStopApp(serial).catch(() => undefined);
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android debug APK pull-based onboarding smoke passed\x1b[0m");
process.exit(0);

async function connectReadyCdp(serial: string): Promise<CdpClient> {
  const cdp = await connectToAppWebView(serial);
  await cdp.send("Runtime.enable");
  await waitForTauriInvoke(cdp);
  return cdp;
}

async function pushPostOnlyGrantToPeer(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
): Promise<{ grantDelegationId: string; grantFrame: CarrierOpFrame }> {
  const rootDelegation = carrierDelegationsFromFrames(vector.clientBaseCarrierOps).find(
    (delegation) => delegation.audience === clerkIdentity.publicKeyBase64 && delegation.parent_id === null,
  );
  assert.ok(rootDelegation, "missing clerk root delegation in Township base frames");

  const baseOps = carrierOpsToSemanticOps(vector.clientBaseCarrierOps, vector.realmByPubkey);
  const grantFrame = await authorTownshipDelegation({
    replica: vector.replica,
    deps: frontier(baseOps),
    audiencePubkey: devicePublicKeyBase64,
    parentId: rootDelegation.id,
    ops: ["post"],
    roles: [],
    live: false,
    signer: clerkIdentity,
  });
  assertCarrierFrameSignature(grantFrame, clerkIdentity.publicKeyBase64);
  const grantDelegation = carrierDelegationsFromFrames([grantFrame])[0];
  assert.ok(grantDelegation, "host-authored grant frame did not contain a delegation");
  assert.equal(grantDelegation.audience, devicePublicKeyBase64);
  assert.deepEqual(grantDelegation.ops, ["post"]);

  const conn = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  const report = await conn.push([grantFrame]);
  assert.deepEqual(report.accepted, [grantFrame.id]);
  assert.deepEqual(report.quarantined, []);
  assert.deepEqual(report.rejected, []);
  const stateReport = await conn.stateReport();
  assert.ok(stateReport.op_ids.includes(grantFrame.id), "peer stateReport includes pushed onboarding grant");
  assert.equal(stateReport.authority_quarantine.some(([id]) => id === grantFrame.id), false);
  conn.close();
  return { grantDelegationId: grantDelegation.id, grantFrame };
}

async function waitForPeerDivergence(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const conn = await connectCarrierWebSocket({
      url: peerUrl(peer.port),
      localRealm: vector.client.realm,
      replica: vector.replica,
      signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
      verifier,
    });
    const status = await conn.status();
    conn.close();
    if (status === "diverged") return;
    await delay(20);
  }
  throw new Error("BEAM Township peer never diverged after onboarding grant push connection closed");
}

async function assertNoLocalDelegationEvidence(cdp: CdpClient): Promise<void> {
  assert.deepEqual(await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_DELEGATION_FRAMES_KEY), []);
  assert.deepEqual(await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  assert.deepEqual(await kvJsonOrEmpty<unknown[]>(cdp, TOWNSHIP_LOCAL_OP_LOG_KEY), []);
}

async function assertPulledGrantEvidence(
  cdp: CdpClient,
  grantFrameId: string,
  grantDelegationId: string,
): Promise<string> {
  const delegationFrames = await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_DELEGATION_FRAMES_KEY);
  assert.ok(
    delegationFrames.some((frame) => frame.id === grantFrameId),
    "pulled grant frame persisted in delegation evidence after Sync outbox",
  );
  const delegation = carrierDelegationsFromFrames(delegationFrames).find((candidate) => candidate.id === grantDelegationId);
  assert.ok(delegation, "pulled grant delegation persisted in delegation evidence after Sync outbox");
  assert.deepEqual(delegation.ops, ["post"]);
  return delegation.id;
}

async function assertNoLocalFrameContains(
  cdp: CdpClient,
  text: string,
  devicePublicKeyBase64: string,
): Promise<void> {
  const outboxFrames = await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY);
  const semanticOps = carrierOpsToSemanticOps(outboxFrames, {
    ...vector.realmByPubkey,
    [devicePublicKeyBase64]: vector.client.realm,
  });
  assert.equal(semanticOps.some((op) => op.value === text), false);
}

async function waitForAuthoredPostFrame(
  cdp: CdpClient,
  devicePublicKeyBase64: string,
  text: string,
): Promise<CarrierOpFrame> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const outboxFrames = await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY);
    for (const frame of outboxFrames) {
      if (frame.author !== devicePublicKeyBase64) continue;
      const op = carrierOpsToSemanticOps([frame], {
        ...vector.realmByPubkey,
        [devicePublicKeyBase64]: vector.client.realm,
      })[0];
      if (op?.command === "post" && op.value === text) return frame;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for Android-authored post frame: ${text}`);
}

async function assertNativeOutboxCompacted(cdp: CdpClient): Promise<void> {
  const outboxFrames = await kvJsonOrEmpty<CarrierOpFrame[]>(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY);
  assert.deepEqual(outboxFrames, []);
}

async function assertPeerMaterializedAuthoredPost(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
  grantFrameId: string,
  postFrameId: string,
): Promise<void> {
  const conn = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  const report = await conn.stateReport();
  assert.ok(report.op_ids.includes(grantFrameId), "peer stateReport includes pulled onboarding grant");
  assert.ok(report.op_ids.includes(postFrameId), "peer stateReport includes Android-authored post");
  assert.equal(report.authority_quarantine.some(([id]) => id === postFrameId), false);
  assert.ok(Array.isArray(report.state?.posts), "peer stateReport includes materialized posts");
  assert.ok((report.state?.posts as unknown[]).includes(postText), "peer materialized state includes Android-authored post");
  conn.close();
}

async function assertPeerRejectsUngrantableSummary(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
  pulledGrantDelegationId: string,
  postFrameId: string,
): Promise<void> {
  const badFrame = await authorTownshipCommand({
    replica: vector.replica,
    deps: [postFrameId],
    command: { command: "set_summary", text: rejectedSummaryText },
    capId: pulledGrantDelegationId,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
  });
  assertCarrierFrameSignature(badFrame, devicePublicKeyBase64);

  const conn = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  await conn.push([badFrame]);
  const report = await conn.stateReport();
  assert.ok(report.op_ids.includes(badFrame.id), "peer log includes unauthorized negative-control frame");
  assert.ok(
    report.authority_quarantine.some(([id, reason]) => id === badFrame.id && reason === "operation_not_granted"),
    "peer authority_quarantine rejects op outside the pulled post-only grant",
  );
  assert.notEqual(report.state?.summary, rejectedSummaryText);
  conn.close();
}

async function shutdownPeer(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
): Promise<void> {
  const conn = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  await conn.shutdown();
}

function cdpNativeIdentity(cdp: CdpClient, publicKeyBase64: string): CdpNativeIdentity {
  return {
    publicKey: new Uint8Array(Buffer.from(publicKeyBase64, "base64")),
    publicKeyBase64,
    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const signatureBase64 = await tauriInvoke<string>(cdp, "lattice_sign_carrier", {
        keyId,
        bytes: bytesBase64(bytes),
      });
      return base64Bytes(signatureBase64);
    },
  };
}

async function kvJsonOrEmpty<T>(cdp: CdpClient, key: string): Promise<T> {
  const raw = await tauriInvoke<string | null>(cdp, "lattice_kv_get", { key: storageKey(key) });
  if (!raw) return [] as T;
  return JSON.parse(raw) as T;
}

function capIdFromFrame(frame: CarrierOpFrame): string {
  if (!Array.isArray(frame.cap) || frame.cap[0] !== "bin" || typeof frame.cap[1] !== "string") {
    throw new Error(`carrier frame ${frame.id} does not cite a binary cap id`);
  }
  return Buffer.from(frame.cap[1], "base64").toString("utf8");
}

function assertCarrierFrameSignature(frame: CarrierOpFrame, authorPublicKeyBase64: string): void {
  assert.equal(frame.author, authorPublicKeyBase64);
  const canonicalBytes = canonicalBytesForCarrierOp(frame);
  assert.equal(
    edVerify(
      null,
      Buffer.from(canonicalBytes),
      publicKeyObject(base64Bytes(authorPublicKeyBase64)),
      Buffer.from(base64Bytes(frame.sig)),
    ),
    true,
  );
}

function seededEd25519Identity(seed: string): LocalIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));

  return {
    publicKey,
    publicKeyBase64: bytesBase64(publicKey),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function publicKeyObject(pubkey: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey)]),
    format: "der",
    type: "spki",
  });
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
