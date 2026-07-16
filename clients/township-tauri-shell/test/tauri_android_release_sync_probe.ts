import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX } from "../src/township_release_sync_probe";
import {
  assertApkNetworkSecurityConfig,
  assertApkPackage,
  assertApkUsesCleartextTraffic,
} from "./support/android_apk_manifest";
import {
  appId,
  cleanupAndroid,
  clearAppData,
  defaultDebugApkPath,
  ensureAndroidDevice,
  forceStopApp,
  launchApp,
  runAdb,
  shellRoot,
  type ManagedProcess,
} from "./support/android_cdp";
import { spawnTownshipPeer, type TownshipPeerProcess } from "./support/beam_peer";

interface ReleaseSyncProbeBuildConfig {
  url: string;
  port: number;
  localRealm: string;
  peerRealm: string;
  peerPubkey: string;
  storageNamespace: string;
}

interface CarrierVector {
  clientBaseCarrierOps: CarrierOpFrame[];
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseSyncProbeConfigFromBuildScript();
const expectedBaseOpIds = carrierVector().clientBaseCarrierOps.map((frame) => frame.id).sort();

console.log("\n▸ tauri:android:release:sync:smoke");
console.log("  Android release APK pulls Township frames and reloads persisted KV without CDP");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let peer: TownshipPeerProcess | null = null;
let wrongPeer: TownshipPeerProcess | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installReleaseApk(serial, releaseApkPath);
  await assertReleasePackageIsNotDebuggable(serial);
  await assertAndroidApiLevelSupportsNetworkSecurityConfig(serial);

  await runWrongPeerNegative(serial);
  await runPullAndColdReloadProof(serial);
} finally {
  wrongPeer?.kill();
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release sync/reload smoke passed\x1b[0m");
process.exit(0);

async function runWrongPeerNegative(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleaseSyncProbeLog(serial, "native_key");
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  await assertReloadIds(serial, [], "wrong-peer initial reload");

  wrongPeer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    identitySeed: "wrong-township-release-sync-peer",
  });
  assert.notEqual(wrongPeer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${wrongPeer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, wrongPeer.port);

  const syncLine = await waitForReleaseSyncProbeLog(serial, "sync", (line) => !line.includes("outcome=synced"));
  assert.match(syncLine, /outcome=(?:error|timeout)/);
  assert.doesNotMatch(syncLine, forbiddenLogTerms());
  console.log(`  wrong peer sync terminal ${syncLine.trim()}`);

  wrongPeer.kill();
  wrongPeer = null;
  await removeReverseMapping(serial, buildConfig.port);
  await forceStopApp(serial);
  await clearLogcat(serial);
  await launchApp(serial);
  await assertReloadIds(serial, [], "wrong-peer offline reload");
  await forceStopApp(serial);
}

async function runPullAndColdReloadProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleaseSyncProbeLog(serial, "native_key");
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  await assertReloadIds(serial, [], "success initial reload");
  console.log(`  observed native key ${nativeKeyLine.trim()}`);

  peer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
  });
  assert.equal(peer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);

  const syncLine = await waitForReleaseSyncProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(syncLine, /outcome=synced/);
  assert.deepEqual(fieldIds(syncLine, "pulled_op_ids"), expectedBaseOpIds);
  assert.deepEqual(fieldIds(syncLine, "local_op_ids"), expectedBaseOpIds);
  assert.deepEqual(fieldIds(syncLine, "delegation_frame_ids"), expectedBaseOpIds);
  assert.match(syncLine, /carrier_frame_count=0/);
  assert.match(syncLine, /pushed_frame_count=0/);
  assert.match(syncLine, /accepted_count=0/);
  assert.doesNotMatch(syncLine, forbiddenLogTerms());
  console.log(`  observed sync ${syncLine.trim()}`);

  peer.kill();
  peer = null;
  await removeReverseMapping(serial, buildConfig.port);
  await forceStopApp(serial);
  await clearLogcat(serial);
  await launchApp(serial);
  const reloadLine = await assertReloadIds(serial, expectedBaseOpIds, "success offline cold reload");
  console.log(`  observed reload ${reloadLine.trim()}`);
}

function defaultReleaseApkPath(): string {
  return resolve(
    process.env.TOWNSHIP_ANDROID_RELEASE_APK ??
      join(
        shellRoot,
        "src-tauri",
        "gen",
        "android",
        "app",
        "build",
        "outputs",
        "apk",
        "universal",
        "release",
        "app-universal-release.apk",
      ),
  );
}

function releaseSyncProbeConfigFromBuildScript(): ReleaseSyncProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:sync-probe"] ?? "";
  const url = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL");
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM");
  const peerRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM");
  const peerPubkey = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE");
  assert.equal(url, "ws://127.0.0.1:43191/carrier");
  assert.equal(localRealm, "resident");
  assert.equal(peerRealm, "clerk");
  assert.equal(peerPubkey, "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=");
  assert.equal(storageNamespace, "township:release-sync-probe");
  return { url, port: Number(new URL(url).port), localRealm, peerRealm, peerPubkey, storageNamespace };
}

function carrierVector(): CarrierVector {
  return JSON.parse(
    readFileSync(join(shellRoot, "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
  ) as CarrierVector;
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:sync-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release sync smoke must not install the debug APK");
  assert.match(apkPath, /app-universal-release\.apk$/);
  await assertApkPackage(apkPath, appId);
  await assertApkUsesCleartextTraffic(apkPath, false);
  await assertApkNetworkSecurityConfig(apkPath, {
    baseCleartextTrafficPermitted: false,
    cleartextDomains: ["127.0.0.1", "localhost"],
  });
  await runAdb(serial, ["uninstall", appId], 30_000).catch(() => undefined);
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
}

async function assertReleasePackageIsNotDebuggable(serial: string): Promise<void> {
  const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", appId], 30_000);
  assert.match(packageDump, new RegExp(`Package \\[${escapeRegExp(appId)}\\]`), `expected package dump for ${appId}:\n${packageDump}`);
  assert.match(packageDump, /version(?:Code|Name)=/, `expected package version metadata before debuggable assertion:\n${packageDump}`);
  assert.doesNotMatch(packageDump, /\bDEBUGGABLE\b/, `expected installed release package to be non-debuggable:\n${packageDump}`);
}

async function assertAndroidApiLevelSupportsNetworkSecurityConfig(serial: string): Promise<void> {
  const output = await runAdb(serial, ["shell", "getprop", "ro.build.version.sdk"], 10_000);
  const apiLevel = Number(output.trim());
  assert.ok(Number.isInteger(apiLevel), `expected numeric Android API level, got ${JSON.stringify(output)}`);
  assert.ok(apiLevel >= 26, `release scoped network-security config WebView proof requires Android API >= 26, got ${apiLevel}`);
  console.log(`  Android API level ${apiLevel} is within the WebView network-security config support boundary`);
}

async function assertReloadIds(serial: string, expectedIds: string[], label: string): Promise<string> {
  const line = await waitForReleaseSyncProbeLog(serial, "reload");
  assert.match(line, /outcome=loaded/);
  assert.deepEqual(fieldIds(line, "local_op_ids"), expectedIds, `${label} local_op_ids`);
  assert.deepEqual(fieldIds(line, "delegation_frame_ids"), expectedIds, `${label} delegation_frame_ids`);
  assert.match(line, /carrier_frame_count=0/);
  assert.doesNotMatch(line, forbiddenLogTerms());
  return line;
}

async function waitForReleaseSyncProbeLog(
  serial: string,
  phase: "native_key" | "reload" | "sync",
  predicate: (line: string) => boolean = () => true,
): Promise<string> {
  const deadline = Date.now() + 90_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    lastOutput = output;
    const line = output
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX) &&
          candidate.includes(`phase=${phase}`) &&
          predicate(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX} phase=${phase}; last logcat:\n${lastOutput}`);
}

function devicePublicKeyFromNativeKeyLine(line: string): string {
  const match = /public_key_b64url=([A-Za-z0-9_-]+)/.exec(line);
  assert.ok(match?.[1], `expected native key log line to include public_key_b64url:\n${line}`);
  return base64UrlToBase64(match[1]);
}

async function clearLogcat(serial: string): Promise<void> {
  await runAdb(serial, ["logcat", "-c"], 10_000);
}

async function assertReverseMapping(serial: string, devicePort: number, hostPort: number): Promise<void> {
  const output = await runAdb(serial, ["reverse", "--list"], 10_000);
  assert.match(
    output,
    new RegExp(`tcp:${devicePort}\\s+tcp:${hostPort}`),
    `expected adb reverse mapping tcp:${devicePort} -> tcp:${hostPort}; got:\n${output}`,
  );
}

async function removeReverseMapping(serial: string, devicePort: number): Promise<void> {
  await runAdb(serial, ["reverse", "--remove", `tcp:${devicePort}`], 10_000).catch(() => undefined);
}

function fieldIds(line: string, field: string): string[] {
  const match = new RegExp(`${field}=([^\\s]+)`).exec(line);
  assert.ok(match?.[1], `expected ${field} in log line:\n${line}`);
  return match[1] === "none" ? [] : match[1].split(",").filter(Boolean).sort();
}

function scriptEnv(script: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}=(?:'([^']+)'|(\\S+))`).exec(script);
  assert.ok(match?.[1] ?? match?.[2], `release sync build script must bake ${name}`);
  return match[1] ?? match[2] ?? "";
}

function base64UrlToBase64(value: string): string {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function forbiddenLogTerms(): RegExp {
  return new RegExp(
    [
      ["Sync", "outbox"].join(" "),
      ["webview", "devtools", "remote"].join("_"),
      ["connect", "To", "App", "Web", "View"].join(""),
      ["sig"].join(""),
      ["body"].join(""),
      ["cap"].join(""),
      ["seed"].join(""),
      ["private"].join(""),
      ["secret"].join(""),
    ].join("|"),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
