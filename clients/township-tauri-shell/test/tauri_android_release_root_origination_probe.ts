import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindTownshipReplica } from "@treetopdevs/lattice-client";
import { TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX } from "../src/township_release_root_origination_probe";
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

interface ReleaseRootOriginationProbeBuildConfig {
  url: string;
  port: number;
  localRealm: string;
  peerRealm: string;
  peerPubkey: string;
  replicaName: string;
  storageNamespace: string;
  pauseAfterGenesisMs: string;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseRootOriginationProbeConfigFromBuildScript();

console.log("\n▸ tauri:android:release:root-origination:smoke");
console.log("  Android release APK originates root authority with native key and BEAM report");

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
  await runReleaseRootOriginationProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release root-origination smoke passed\x1b[0m");
process.exit(0);

async function runReleaseRootOriginationProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleaseRootOriginationProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  const rootReplica = await bindTownshipReplica(buildConfig.replicaName, devicePublicKeyBase64);
  assert.match(rootReplica, /^replica:matter:township-root-origination#root:/);
  assert.doesNotMatch(nativeKeyLine, forbiddenLogTerms());
  console.log(`  observed native key ${nativeKeyLine.trim()}`);

  peer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipRootOriginationScenario",
    replica: rootReplica,
  });
  assert.equal(peer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);

  const genesisLine = await waitForReleaseRootOriginationProbeLog(
    serial,
    "genesis",
    (line) => line.includes("outcome=authored"),
  );
  assert.match(genesisLine, /phase=genesis/);
  assert.match(genesisLine, /root_replica=/);
  assert.equal(fieldValue(genesisLine, "root_replica"), rootReplica);
  const genesisFrameId = fieldValue(genesisLine, "genesis_frame_id");
  assert.notEqual(genesisFrameId, "none");
  assert.match(genesisLine, /outbox_frame_count=1/);
  assert.doesNotMatch(genesisLine, forbiddenLogTerms());
  console.log(`  observed genesis ${genesisLine.trim()}`);

  await forceStopApp(serial);
  await clearLogcat(serial);
  await launchApp(serial);
  const reloadLine = await waitForReleaseRootOriginationProbeLog(serial, "reload");
  assert.match(reloadLine, /phase=reload/);
  assert.match(reloadLine, /outcome=loaded/);
  assert.equal(fieldValue(reloadLine, "root_replica"), rootReplica);
  assert.ok(fieldIds(reloadLine, "local_op_ids").includes(genesisFrameId));
  assert.match(reloadLine, /outbox_frame_count=1/);
  assert.doesNotMatch(reloadLine, forbiddenLogTerms());
  console.log(`  observed pre-push cold reload ${reloadLine.trim()}`);

  const pushLine = await waitForReleaseRootOriginationProbeLog(
    serial,
    "push",
    (line) => line.includes("outcome=synced") && fieldIds(line, "pushed_frame_ids").includes(genesisFrameId),
  );
  assert.match(pushLine, /phase=push/);
  assert.equal(fieldValue(pushLine, "root_replica"), rootReplica);
  assert.match(pushLine, /accepted_count=1/);
  assert.match(pushLine, /pending_count=0/);
  assert.match(pushLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pushLine, forbiddenLogTerms());
  console.log(`  observed push ${pushLine.trim()}`);

  const peerLine = await waitForReleaseRootOriginationProbeLog(
    serial,
    "peer",
    (line) => line.includes("outcome=reported"),
  );
  assert.match(peerLine, /phase=peer/);
  assert.equal(fieldValue(peerLine, "root_replica"), rootReplica);
  assert.equal(fieldValue(peerLine, "genesis_frame_id"), genesisFrameId);
  assert.match(peerLine, /root_authority_accepted=true/);
  assert.match(peerLine, /forged_authority_reason=impostor_genesis/);
  assert.match(peerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(peerLine, forbiddenLogTerms());
  console.log(`  observed peer ${peerLine.trim()}`);
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

function releaseRootOriginationProbeConfigFromBuildScript(): ReleaseRootOriginationProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:root-origination-probe"] ?? "";
  const url = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL");
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM");
  const peerRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM");
  const peerPubkey = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY");
  const replicaName = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE");
  const pauseAfterGenesisMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PAUSE_AFTER_GENESIS_MS");
  assert.equal(url, "ws://127.0.0.1:43199/carrier");
  assert.equal(localRealm, "founder");
  assert.equal(peerRealm, "clerk");
  assert.equal(peerPubkey, "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=");
  assert.equal(replicaName, "replica:matter:township-root-origination");
  assert.equal(storageNamespace, "township:release-root-origination-probe");
  assert.equal(pauseAfterGenesisMs, "30000");
  return {
    url,
    port: Number(new URL(url).port),
    localRealm,
    peerRealm,
    peerPubkey,
    replicaName,
    storageNamespace,
    pauseAfterGenesisMs,
  };
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:root-origination-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release root-origination smoke must not install the debug APK");
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

async function waitForReleaseRootOriginationProbeLog(
  serial: string,
  phase: "native_key" | "reload" | "genesis" | "push" | "peer",
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
          candidate.includes(TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX) &&
          candidate.includes(`phase=${phase}`) &&
          predicate(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX} phase=${phase}; last logcat:\n${lastOutput}`);
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
  assert.ok(match?.[1] ?? match?.[2], `release root-origination build script must bake ${name}`);
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
  return /sig|body|cap:|seed|private|secret/;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
