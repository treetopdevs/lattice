import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  exportTownshipCarrierPairingHandoff,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX } from "../src/township_release_pairing_probe";
import {
  assertApkNetworkSecurityConfig,
  assertApkPackage,
  assertApkUsesCleartextTraffic,
} from "./support/android_apk_manifest";
import {
  appActivity,
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

interface ReleasePairingProbeBuildConfig {
  port: number;
  localRealm: string;
  keyId: string;
  storageNamespace: string;
  armState: string;
  timeoutMs: string;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releasePairingProbeConfigFromBuildScript();
const peerRealm = "clerk";
const expectedPeerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const expectedPeerFingerprint = townshipCarrierPeerFingerprint(expectedPeerPubkey);

console.log("\n▸ tauri:android:release:pairing:smoke");
console.log("  Android release APK accepts OS pairing deep link, persists peer config, and syncs after relaunch");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let peer: TownshipPeerProcess | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installReleaseApk(serial, releaseApkPath);
  await assertReleasePackageIsNotDebuggable(serial);
  await assertAndroidApiLevelSupportsNetworkSecurityConfig(serial);
  await runReleaseDeepLinkPairingProof(serial);
  peer?.kill();
  peer = null;
  await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
  await runReleaseColdStartPairingDeliveryProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release pairing smoke passed\x1b[0m");
process.exit(0);

async function runReleaseDeepLinkPairingProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleasePairingProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  assert.match(nativeKeyLine, new RegExp(`storage_namespace=${escapeRegExp(buildConfig.storageNamespace)}`));
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  assert.doesNotMatch(nativeKeyLine, forbiddenLogTerms());

  const initialReloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=false"));
  assert.match(initialReloadLine, /outcome=loaded/);
  assert.match(initialReloadLine, /paired=false/);
  assert.match(initialReloadLine, /outbox_frame_count=0/);
  assert.deepEqual(fieldIds(initialReloadLine, "local_op_ids"), []);
  assert.deepEqual(fieldIds(initialReloadLine, "delegation_frame_ids"), []);
  assert.doesNotMatch(initialReloadLine, forbiddenLogTerms());
  console.log(`  observed unpaired reload ${initialReloadLine.trim()}`);

  peer = await spawnTownshipPeer({
    peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    bootstrapAudiencePubkey: devicePublicKeyBase64,
  });
  assert.equal(peer.publicKeyBase64, expectedPeerPubkey);

  const armingLine = await waitForReleasePairingProbeLog(serial, "arming", (line) => line.includes("outcome=armed"));
  assert.match(armingLine, /phase=arming/);
  assert.match(armingLine, /state_required=true/);
  assert.doesNotMatch(armingLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(armingLine, forbiddenLogTerms());
  console.log(`  observed armed release pairing ${armingLine.trim()}`);

  await openPairingDeepLink(serial, {
    url: `ws://127.0.0.1:${buildConfig.port}/carrier`,
    localRealm: buildConfig.localRealm,
    expectedPeerRealm: peerRealm,
    expectedPeerPubkey,
    replica,
    keyId: buildConfig.keyId,
  });

  const blockedLine = await waitForReleasePairingProbeLog(
    serial,
    "deeplink",
    (line) => line.includes("outcome=blocked") && line.includes("blocked_reason=state_mismatch"),
  );
  assert.match(blockedLine, /phase=deeplink/);
  assert.match(blockedLine, /outcome=blocked/);
  assert.match(blockedLine, /blocked_reason=state_mismatch/);
  assert.match(blockedLine, /pairing_url_count=1/);
  assert.doesNotMatch(blockedLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(blockedLine, forbiddenLogTerms());
  await assertNoPairingSavedYet(serial);
  console.log(`  observed blocked unarmed release pairing ${blockedLine.trim()}`);

  await openPairingDeepLink(
    serial,
    {
      url: `ws://127.0.0.1:${buildConfig.port}/carrier`,
      localRealm: buildConfig.localRealm,
      expectedPeerRealm: peerRealm,
      expectedPeerPubkey,
      replica,
      keyId: buildConfig.keyId,
    },
    buildConfig.armState,
  );

  const pairingLine = await waitForReleasePairingProbeLog(serial, "pairing", (line) => line.includes("outcome=saved"));
  assert.match(pairingLine, /phase=pairing/);
  assert.match(pairingLine, /outcome=saved/);
  assert.match(pairingLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(pairingLine, /host_class=loopback/);
  assert.match(pairingLine, new RegExp(`url_port=${buildConfig.port}`));
  assert.doesNotMatch(pairingLine, forbiddenLogTerms());
  console.log(`  observed pairing save ${pairingLine.trim()}`);

  await forceStopApp(serial);
  await clearLogcat(serial);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await launchApp(serial);

  const reloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=true"));
  assert.match(reloadLine, /outcome=loaded/);
  assert.match(reloadLine, /paired=true/);
  assert.match(reloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(reloadLine, /host_class=loopback/);
  assert.match(reloadLine, new RegExp(`url_port=${buildConfig.port}`));
  assert.match(reloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(reloadLine, forbiddenLogTerms());
  console.log(`  observed paired cold reload ${reloadLine.trim()}`);

  const syncLine = await waitForReleasePairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(syncLine, /phase=sync/);
  assert.match(syncLine, /outcome=synced/);
  assert.match(syncLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.notDeepEqual(fieldIds(syncLine, "pulled_op_ids"), []);
  assert.notDeepEqual(fieldIds(syncLine, "local_op_ids"), []);
  assert.notDeepEqual(fieldIds(syncLine, "delegation_frame_ids"), []);
  assert.match(syncLine, /outbox_frame_count=0/);
  assert.match(syncLine, /pushed_frame_count=0/);
  assert.match(syncLine, /accepted_count=0/);
  assert.doesNotMatch(syncLine, forbiddenLogTerms());
  console.log(`  observed sync from persisted pairing ${syncLine.trim()}`);
}

async function runReleaseColdStartPairingDeliveryProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await waitForAppNotRunning(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleasePairingProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  assert.match(nativeKeyLine, new RegExp(`storage_namespace=${escapeRegExp(buildConfig.storageNamespace)}`));
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  assert.doesNotMatch(nativeKeyLine, forbiddenLogTerms());

  const initialReloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=false"));
  assert.match(initialReloadLine, /outcome=loaded/);
  assert.match(initialReloadLine, /paired=false/);
  assert.match(initialReloadLine, /outbox_frame_count=0/);
  assert.deepEqual(fieldIds(initialReloadLine, "local_op_ids"), []);
  assert.deepEqual(fieldIds(initialReloadLine, "delegation_frame_ids"), []);
  assert.doesNotMatch(initialReloadLine, forbiddenLogTerms());
  console.log(`  observed cold-start key discovery reload ${initialReloadLine.trim()}`);

  await forceStopApp(serial);
  await waitForAppNotRunning(serial);

  peer = await spawnTownshipPeer({
    peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    bootstrapAudiencePubkey: devicePublicKeyBase64,
  });
  assert.equal(peer.publicKeyBase64, expectedPeerPubkey);

  await clearLogcat(serial);
  await openPairingDeepLink(serial, pairingPeerConfig());

  const noStateNativeKeyLine = await waitForReleasePairingProbeLog(serial, "native_key");
  assert.equal(devicePublicKeyFromNativeKeyLine(noStateNativeKeyLine), devicePublicKeyBase64);
  assert.doesNotMatch(noStateNativeKeyLine, forbiddenLogTerms());

  const noStateReloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=false"));
  assert.match(noStateReloadLine, /outcome=loaded/);
  assert.match(noStateReloadLine, /paired=false/);
  assert.match(noStateReloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(noStateReloadLine, forbiddenLogTerms());

  const noStateArmingLine = await waitForReleasePairingProbeLog(serial, "arming", (line) => line.includes("outcome=armed"));
  assert.match(noStateArmingLine, /phase=arming/);
  assert.match(noStateArmingLine, /state_required=true/);
  assert.doesNotMatch(noStateArmingLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(noStateArmingLine, forbiddenLogTerms());

  const noStateBlockedLine = await waitForReleasePairingProbeLog(
    serial,
    "deeplink",
    (line) => line.includes("outcome=blocked") && line.includes("blocked_reason=state_mismatch"),
  );
  assert.match(noStateBlockedLine, /phase=deeplink/);
  assert.match(noStateBlockedLine, /outcome=blocked/);
  assert.match(noStateBlockedLine, /blocked_reason=state_mismatch/);
  assert.match(noStateBlockedLine, /pairing_url_count=1/);
  assert.doesNotMatch(noStateBlockedLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(noStateBlockedLine, forbiddenLogTerms());
  await assertNoPairingSavedYet(serial);
  console.log(`  observed cold-start no-state release pairing block ${noStateBlockedLine.trim()}`);

  await forceStopApp(serial);
  await waitForAppNotRunning(serial);
  await clearLogcat(serial);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await openPairingDeepLink(serial, pairingPeerConfig(), buildConfig.armState);

  const stateNativeKeyLine = await waitForReleasePairingProbeLog(serial, "native_key");
  assert.equal(devicePublicKeyFromNativeKeyLine(stateNativeKeyLine), devicePublicKeyBase64);
  assert.doesNotMatch(stateNativeKeyLine, forbiddenLogTerms());

  const stateReloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=false"));
  assert.match(stateReloadLine, /outcome=loaded/);
  assert.match(stateReloadLine, /paired=false/);
  assert.match(stateReloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(stateReloadLine, forbiddenLogTerms());

  const stateArmingLine = await waitForReleasePairingProbeLog(serial, "arming", (line) => line.includes("outcome=armed"));
  assert.match(stateArmingLine, /phase=arming/);
  assert.match(stateArmingLine, /state_required=true/);
  assert.doesNotMatch(stateArmingLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(stateArmingLine, forbiddenLogTerms());

  const pairingLine = await waitForReleasePairingProbeLog(serial, "pairing", (line) => line.includes("outcome=saved"));
  assert.match(pairingLine, /phase=pairing/);
  assert.match(pairingLine, /outcome=saved/);
  assert.match(pairingLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(pairingLine, /host_class=loopback/);
  assert.match(pairingLine, new RegExp(`url_port=${buildConfig.port}`));
  assert.doesNotMatch(pairingLine, forbiddenLogTerms());
  console.log(`  observed cold-start state-bearing release pairing save ${pairingLine.trim()}`);

  await forceStopApp(serial);
  await waitForAppNotRunning(serial);
  await clearLogcat(serial);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await launchApp(serial);

  const reloadLine = await waitForReleasePairingProbeLog(serial, "reload", (line) => line.includes("paired=true"));
  assert.match(reloadLine, /outcome=loaded/);
  assert.match(reloadLine, /paired=true/);
  assert.match(reloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(reloadLine, /host_class=loopback/);
  assert.match(reloadLine, new RegExp(`url_port=${buildConfig.port}`));
  assert.match(reloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(reloadLine, forbiddenLogTerms());
  console.log(`  observed paired reload after cold-start pairing ${reloadLine.trim()}`);

  const syncLine = await waitForReleasePairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(syncLine, /phase=sync/);
  assert.match(syncLine, /outcome=synced/);
  assert.match(syncLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.notDeepEqual(fieldIds(syncLine, "pulled_op_ids"), []);
  assert.notDeepEqual(fieldIds(syncLine, "local_op_ids"), []);
  assert.notDeepEqual(fieldIds(syncLine, "delegation_frame_ids"), []);
  assert.match(syncLine, /outbox_frame_count=0/);
  assert.match(syncLine, /pushed_frame_count=0/);
  assert.match(syncLine, /accepted_count=0/);
  assert.doesNotMatch(syncLine, forbiddenLogTerms());
  console.log(`  observed cold-start pairing sync ${syncLine.trim()}`);
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

function releasePairingProbeConfigFromBuildScript(): ReleasePairingProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const normalRelease = packageJson.scripts?.["tauri:android:build:release"] ?? "";
  const script = packageJson.scripts?.["tauri:android:build:release:pairing-probe"] ?? "";
  assert.doesNotMatch(normalRelease, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE/);
  assert.doesNotMatch(
    script,
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "release pairing probe must not bake peer endpoint or identity env",
  );
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM");
  const keyId = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE");
  const armState = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE");
  const timeoutMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS");
  assert.equal(localRealm, "resident");
  assert.equal(keyId, "township-release-pairing-resident");
  assert.equal(storageNamespace, "township:release-pairing-probe");
  assert.equal(armState, "release-pairing-state-103");
  assert.equal(timeoutMs, "60000");
  return { port: 43193, localRealm, keyId, storageNamespace, armState, timeoutMs };
}

function pairingPeerConfig(): TownshipCarrierPeerConfig {
  return {
    url: `ws://127.0.0.1:${buildConfig.port}/carrier`,
    localRealm: buildConfig.localRealm,
    expectedPeerRealm: peerRealm,
    expectedPeerPubkey,
    replica,
    keyId: buildConfig.keyId,
  };
}

async function openPairingDeepLink(
  serial: string,
  config: TownshipCarrierPeerConfig,
  state?: string,
): Promise<void> {
  const handoff = exportTownshipCarrierPairingHandoff(config);
  const link = `township://pairing/${encodeURIComponent(handoff)}${state ? `?state=${encodeURIComponent(state)}` : ""}`;
  await runAdb(
    serial,
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.DEFAULT",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      link,
      "-p",
      appId,
    ],
    30_000,
  );
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:pairing-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release pairing smoke must not install the debug APK");
  assert.match(apkPath, /app-universal-release\.apk$/);
  await assertApkPackage(apkPath, appId);
  await assertApkUsesCleartextTraffic(apkPath, false);
  await assertApkNetworkSecurityConfig(apkPath, {
    baseCleartextTrafficPermitted: false,
    cleartextDomains: ["127.0.0.1", "localhost"],
  });
  await runAdb(serial, ["uninstall", appId], 30_000).catch(() => undefined);
  await installApkWithRetry(serial, apkPath);
}

async function installApkWithRetry(serial: string, apkPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runAdb(serial, ["install", "-r", apkPath], 120_000);
      return;
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Broken pipe") || attempt === 2) break;
      await delay(5_000);
    }
  }
  throw lastError;
}

async function assertReleasePackageIsNotDebuggable(serial: string): Promise<void> {
  const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", appId], 30_000);
  assert.match(packageDump, new RegExp(`Package \\[${escapeRegExp(appId)}\\]`), `expected package dump for ${appId}:\n${packageDump}`);
  assert.match(packageDump, /version(?:Code|Name)=/, `expected package version metadata before debuggable assertion:\n${packageDump}`);
  assert.match(packageDump, /pkgFlags=\[/, `expected package flags before debuggable assertion:\n${packageDump}`);
  assert.doesNotMatch(packageDump, /\bDEBUGGABLE\b/, `expected installed release package to be non-debuggable:\n${packageDump}`);
}

async function assertAndroidApiLevelSupportsNetworkSecurityConfig(serial: string): Promise<void> {
  const output = await runAdb(serial, ["shell", "getprop", "ro.build.version.sdk"], 10_000);
  const apiLevel = Number(output.trim());
  assert.ok(Number.isInteger(apiLevel), `expected numeric Android API level, got ${JSON.stringify(output)}`);
  assert.ok(apiLevel >= 26, `release scoped network-security config WebView proof requires Android API >= 26, got ${apiLevel}`);
  console.log(`  Android API level ${apiLevel} is within the WebView network-security config support boundary`);
}

async function waitForReleasePairingProbeLog(
  serial: string,
  phase: "native_key" | "reload" | "arming" | "deeplink" | "pairing" | "sync",
  predicate: (line: string) => boolean = () => true,
): Promise<string> {
  const deadline = Date.now() + 90_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000).catch((error) => {
      lastOutput = errorMessage(error);
      return "";
    });
    if (!output) {
      await delay(1_000);
      continue;
    }
    lastOutput = output;
    const line = output
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX) &&
          candidate.includes(`phase=${phase}`) &&
          predicate(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX} phase=${phase}; last logcat:\n${lastOutput}`);
}

async function assertNoPairingSavedYet(serial: string): Promise<void> {
  const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  const savedLine = output
    .split(/\r?\n/)
    .find(
      (candidate) =>
        candidate.includes(TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX) &&
        candidate.includes("phase=pairing") &&
        candidate.includes("outcome=saved"),
    );
  assert.equal(savedLine, undefined, `no-state release pairing link should not save peer config before armed delivery:\n${savedLine ?? output}`);
}

async function waitForAppNotRunning(serial: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastPid = "";
  while (Date.now() < deadline) {
    lastPid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim();
    if (!lastPid) return;
    await delay(250);
  }
  throw new Error(`expected ${appId} to be stopped before cold-start pairing intent; pidof returned ${lastPid}`);
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
  const value = fieldValue(line, field);
  return value === "none" ? [] : value.split(",").filter(Boolean).sort();
}

function fieldValue(line: string, field: string): string {
  const match = new RegExp(`${field}=([^\\s]+)`).exec(line);
  assert.ok(match?.[1], `expected ${field} in log line:\n${line}`);
  return match[1];
}

function scriptEnv(script: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}=(?:'([^']+)'|(\\S+))`).exec(script);
  assert.ok(match?.[1] ?? match?.[2], `release pairing build script must bake ${name}`);
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
      ["webview", "devtools", "remote"].join("_"),
      ["connect", "To", "App", "Web", "View"].join(""),
      ["run", "as"].join("-"),
      ["kv", "Json"].join(""),
      ["click", "Button", "By", "Text"].join(""),
      ["sig"].join(""),
      ["body"].join(""),
      ["cap", ":"].join(""),
      ["seed"].join(""),
      ["private"].join(""),
      ["secret"].join(""),
      "127\\.0\\.0\\.1",
    ].join("|"),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
