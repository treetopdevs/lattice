import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX } from "../src/township_release_beam_probe";
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

interface ReleaseBeamProbeBuildConfig {
  url: string;
  port: number;
  localRealm: string;
  peerRealm: string;
  peerPubkey: string;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseBeamProbeConfigFromBuildScript();

console.log("\n▸ tauri:android:release:beam:smoke");
console.log("  Android release APK real BEAM carrier handshake without CDP, Sync, or KV inspection");
console.log("  waiting for native key announcement, then starting trusted BEAM peer");

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
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleaseBeamProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  console.log(`  observed native key ${nativeKeyLine.trim()}`);

  wrongPeer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    identitySeed: "wrong-township-release-beam-peer",
  });
  assert.notEqual(wrongPeer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${wrongPeer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, wrongPeer.port);
  await assertNoConnectedReleaseBeamCarrierLog(serial, 2_000);
  console.log("  wrong peer public key produced no connected carrier log");
  wrongPeer.kill();
  wrongPeer = null;
  await removeReverseMapping(serial, buildConfig.port);

  peer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
  });
  assert.equal(peer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);

  const carrierLine = await waitForReleaseBeamProbeLog(serial, "carrier");
  assert.match(carrierLine, /phase=carrier/);
  assert.match(carrierLine, /url_scheme=ws/);
  assert.match(carrierLine, /host_class=loopback/);
  assert.match(carrierLine, /outcome=connected/);
  assert.match(carrierLine, /status=base/);
  assert.match(carrierLine, /op_count=\d+/);
  assert.match(carrierLine, /authority_quarantine_count=\d+/);
  assert.doesNotMatch(carrierLine, forbiddenCarrierLineTerms());
  console.log(`  observed carrier ${carrierLine.trim()}`);
} finally {
  wrongPeer?.kill();
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release BEAM carrier handshake smoke passed\x1b[0m");
process.exit(0);

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

function releaseBeamProbeConfigFromBuildScript(): ReleaseBeamProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:beam-probe"] ?? "";
  const url = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL");
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM");
  const peerRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM");
  const peerPubkey = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY");
  assert.equal(url, "ws://127.0.0.1:43190/carrier");
  assert.equal(localRealm, "resident");
  assert.equal(peerRealm, "clerk");
  assert.equal(peerPubkey, "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=");
  return { url, port: Number(new URL(url).port), localRealm, peerRealm, peerPubkey };
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:beam-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release BEAM smoke must not install the debug APK");
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

async function clearLogcat(serial: string): Promise<void> {
  await runAdb(serial, ["logcat", "-c"], 10_000);
}

async function waitForReleaseBeamProbeLog(serial: string, phase: "carrier" | "native_key"): Promise<string> {
  const deadline = Date.now() + 90_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    lastOutput = output;
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.includes(TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX) && candidate.includes(`phase=${phase}`));
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX} phase=${phase}; last logcat:\n${lastOutput}`);
}

function devicePublicKeyFromNativeKeyLine(line: string): string {
  const match = /public_key_b64url=([A-Za-z0-9_-]+)/.exec(line);
  assert.ok(match?.[1], `expected native key log line to include public_key_b64url:\n${line}`);
  return base64UrlToBase64(match[1]);
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

async function assertNoConnectedReleaseBeamCarrierLog(serial: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    const connectedLine = output
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX) &&
          candidate.includes("phase=carrier") &&
          candidate.includes("outcome=connected"),
      );
    assert.equal(connectedLine, undefined, `wrong peer must not produce connected carrier log:\n${connectedLine}`);
    await delay(250);
  }
}

function scriptEnv(script: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}=(?:'([^']+)'|(\\S+))`).exec(script);
  assert.ok(match?.[1] ?? match?.[2], `release BEAM build script must bake ${name}`);
  return match[1] ?? match[2] ?? "";
}

function base64UrlToBase64(value: string): string {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function forbiddenCarrierLineTerms(): RegExp {
  return new RegExp(
    [
      ["Sync", "outbox"].join(" "),
      ["webview", "devtools", "remote"].join("_"),
      ["connect", "To", "App", "Web", "View"].join(""),
      ["kv", "Json"].join(""),
      ["click", "Button", "By", "Text"].join(""),
    ].join("|"),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
