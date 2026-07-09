import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
  type Op,
  type ReplicaSchema,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import { TOWNSHIP_CARRIER_PAIRING_KEY, type TownshipCarrierPeerConfig } from "../src/township_carrier_peer";
import {
  cleanupAndroid,
  clearAppData,
  clickButtonByText,
  connectToAppWebView,
  defaultDebugApkPath,
  ensureAndroidDevice,
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
  client: { realm: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  expectAfterSync: {
    stateB64: string;
    opIds: string[];
    authorityQuarantine: [string, string][];
  };
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
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

console.log(`\n▸ ${vector.scenario} tauri:android:beam:smoke`);
console.log("  Android debug APK BEAM convergence with pre-signed carrier frames");

assert.equal(TOWNSHIP_CARRIER_PAIRING_KEY, "carrier_peer_config");

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

  const bootstrapCdp = await connectReadyCdp(serial);
  const devicePublicKeyBase64 = await tauriInvoke<string>(bootstrapCdp, "lattice_ensure_carrier_key", { keyId });
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);

  peer = await spawnTownshipPeer({
    peerRealm: vector.peer.realm,
    trustedPeerRealm: vector.client.realm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
  });
  await closeAuthenticatedSessionAndWaitForDivergence(bootstrapCdp, peer, devicePublicKeyBase64);

  await seedNativeTownshipState(bootstrapCdp, peer, devicePublicKeyBase64);
  bootstrapCdp.close();

  await forceStopApp(serial);
  await launchApp(serial);
  const firstSyncCdp = await connectReadyCdp(serial);
  await waitForDocumentText(firstSyncCdp, "Ready to sync outbox.", 60_000);
  await clickButtonByText(firstSyncCdp, "Sync outbox");
  await waitForDocumentText(firstSyncCdp, "Pushed 2, pulled 5, accepted 2.", 90_000);
  await assertNativeConvergence(firstSyncCdp);
  await assertPeerConvergence(firstSyncCdp, peer, devicePublicKeyBase64);
  firstSyncCdp.close();

  await forceStopApp(serial);
  await launchApp(serial);
  const secondSyncCdp = await connectReadyCdp(serial);
  await waitForDocumentText(secondSyncCdp, "Ready to sync outbox.", 60_000);
  await clickButtonByText(secondSyncCdp, "Sync outbox");
  await waitForDocumentText(secondSyncCdp, "Pushed 0, pulled 0, accepted 0.", 90_000);
  await assertNativeConvergence(secondSyncCdp);
  await shutdownPeer(secondSyncCdp, peer, devicePublicKeyBase64);
  secondSyncCdp.close();
  await peer.awaitExit();
} finally {
  peer?.kill();
  if (serial) await forceStopApp(serial).catch(() => undefined);
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android debug APK BEAM convergence smoke passed\x1b[0m");
process.exit(0);

async function connectReadyCdp(serial: string): Promise<CdpClient> {
  const cdp = await connectToAppWebView(serial);
  await cdp.send("Runtime.enable");
  await waitForTauriInvoke(cdp);
  return cdp;
}

async function seedNativeTownshipState(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
): Promise<void> {
  const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
  const peerConfig: TownshipCarrierPeerConfig = {
    url: peerUrl(peer.port, "10.0.2.2"),
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: vector.peer.sessionPubkey,
    replica: vector.replica,
    keyId,
  };

  assert.equal(devicePublicKeyBase64.length > 0, true);
  await kvSet(cdp, TOWNSHIP_LOCAL_OP_LOG_KEY, JSON.stringify(localOps));
  await kvSet(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY, JSON.stringify(vector.clientDivergedCarrierOps));
  await kvSet(cdp, TOWNSHIP_DELEGATION_FRAMES_KEY, "[]");
  await kvSet(cdp, TOWNSHIP_CARRIER_PAIRING_KEY, JSON.stringify(peerConfig));
}

async function assertNativeConvergence(cdp: CdpClient): Promise<void> {
  const localOps = await kvJson<Array<Op & { id: string }>>(cdp, TOWNSHIP_LOCAL_OP_LOG_KEY);
  const outboxFrames = await kvJson<CarrierOpFrame[]>(cdp, TOWNSHIP_CARRIER_OUTBOX_KEY);
  const delegationFrames = await kvJson<CarrierOpFrame[]>(cdp, TOWNSHIP_DELEGATION_FRAMES_KEY);

  assert.deepEqual(localOps.map((op) => op.id).sort(), vector.expectAfterSync.opIds);
  assert.deepEqual(outboxFrames, []);
  assert.deepEqual(frameIds(delegationFrames), vector.expectAfterSync.opIds);
}

async function assertPeerConvergence(
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
  const report = await conn.stateReport();
  assert.equal(report.state_b64, vector.expectAfterSync.stateB64);
  assert.deepEqual(report.op_ids, vector.expectAfterSync.opIds);
  assert.deepEqual(report.authority_quarantine, vector.expectAfterSync.authorityQuarantine);
  conn.close();
}

async function closeAuthenticatedSessionAndWaitForDivergence(
  cdp: CdpClient,
  peer: TownshipPeerProcess,
  devicePublicKeyBase64: string,
): Promise<void> {
  const warmup = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: cdpNativeIdentity(cdp, devicePublicKeyBase64),
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  assert.equal(await warmup.status(), "base");
  warmup.close();

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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("BEAM Township peer never diverged after authenticated Android session close");
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
  const report = await conn.stateReport();
  assert.equal(report.state_b64, vector.expectAfterSync.stateB64);
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

async function kvSet(cdp: CdpClient, key: string, value: string): Promise<void> {
  await tauriInvoke<void>(cdp, "lattice_kv_set", { key: storageKey(key), value });
}

async function kvJson<T>(cdp: CdpClient, key: string): Promise<T> {
  const raw = await tauriInvoke<string | null>(cdp, "lattice_kv_get", { key: storageKey(key) });
  assert.ok(raw, `missing native KV value for ${key}`);
  return JSON.parse(raw) as T;
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function frameIds(frames: CarrierOpFrame[]): string[] {
  return frames.map((frame) => frame.id).sort();
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
