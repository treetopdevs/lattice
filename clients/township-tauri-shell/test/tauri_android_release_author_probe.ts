import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX } from "../src/township_release_author_probe";
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

interface ReleaseAuthorProbeBuildConfig {
  url: string;
  port: number;
  localRealm: string;
  peerRealm: string;
  peerPubkey: string;
  storageNamespace: string;
  postText: string;
  badSummaryText: string;
  pauseAfterAuthorMs: string;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseAuthorProbeConfigFromBuildScript();

console.log("\n▸ tauri:android:release:author:smoke");
console.log("  Android release APK authors, pushes, drains outbox, and reloads without CDP");

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

  await runFreshInstallKeyChange(serial);
  await runReleaseAuthorPushProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release author/push smoke passed\x1b[0m");
process.exit(0);

async function runFreshInstallKeyChange(serial: string): Promise<void> {
  const firstKey = await launchFreshNativeKey(serial);
  await forceStopApp(serial);
  const secondKey = await launchFreshNativeKey(serial);
  await forceStopApp(serial);

  assert.equal(Buffer.from(firstKey, "base64").length, 32);
  assert.equal(Buffer.from(secondKey, "base64").length, 32);
  assert.notEqual(firstKey, secondKey, "fresh install keys differ");
  console.log("  fresh install keys differ");
}

async function launchFreshNativeKey(serial: string): Promise<string> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);
  const nativeKeyLine = await waitForReleaseAuthorProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  assert.doesNotMatch(nativeKeyLine, forbiddenLogTerms());
  const reloadLine = await waitForReleaseAuthorProbeLog(serial, "reload");
  assert.match(reloadLine, /phase=reload/);
  assert.match(reloadLine, /outcome=loaded/);
  assert.match(reloadLine, /local_op_ids=none/);
  assert.match(reloadLine, /delegation_frame_ids=none/);
  assert.match(reloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(reloadLine, forbiddenLogTerms());
  return devicePublicKeyFromNativeKeyLine(nativeKeyLine);
}

async function runReleaseAuthorPushProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForReleaseAuthorProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  const initialReloadLine = await waitForReleaseAuthorProbeLog(serial, "reload");
  assert.match(initialReloadLine, /phase=reload/);
  assert.match(initialReloadLine, /outcome=loaded/);
  assert.match(initialReloadLine, /local_op_ids=none/);
  assert.match(initialReloadLine, /delegation_frame_ids=none/);
  assert.match(initialReloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(initialReloadLine, forbiddenLogTerms());
  console.log(`  observed native key ${nativeKeyLine.trim()}`);

  peer = await spawnTownshipPeer({
    peerRealm: buildConfig.peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    bootstrapAudiencePubkey: devicePublicKeyBase64,
  });
  assert.equal(peer.publicKeyBase64, buildConfig.peerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);

  const pullLine = await waitForReleaseAuthorProbeLog(
    serial,
    "pull",
    (line) => line.includes("outcome=synced"),
  );
  assert.match(pullLine, /phase=pull/);
  assert.match(pullLine, /outcome=synced/);
  assert.notDeepEqual(fieldIds(pullLine, "pulled_op_ids"), []);
  assert.notDeepEqual(fieldIds(pullLine, "local_op_ids"), []);
  const pulledDelegationFrameIds = fieldIds(pullLine, "delegation_frame_ids");
  assert.notDeepEqual(pulledDelegationFrameIds, []);
  assert.match(pullLine, /outbox_frame_count=0/);
  assert.match(pullLine, /pushed_frame_count=0/);
  assert.match(pullLine, /accepted_count=0/);
  const grantDelegationId = fieldValue(pullLine, "grant_delegation_id");
  assert.notEqual(grantDelegationId, "none");
  assert.doesNotMatch(pullLine, forbiddenLogTerms());
  console.log(`  observed pull ${pullLine.trim()}`);

  const authorLine = await waitForReleaseAuthorProbeLog(
    serial,
    "author",
    (line) => line.includes("outcome=authored"),
  );
  assert.match(authorLine, /phase=author/);
  assert.match(authorLine, /outcome=authored/);
  const postFrameId = fieldValue(authorLine, "post_frame_id");
  const badFrameId = fieldValue(authorLine, "bad_frame_id");
  assert.notEqual(postFrameId, badFrameId);
  assert.equal(fieldValue(authorLine, "cap_id"), grantDelegationId);
  assert.match(authorLine, /outbox_frame_count=2/);
  assert.doesNotMatch(authorLine, forbiddenLogTerms());
  console.log(`  observed author ${authorLine.trim()}`);

  await forceStopApp(serial);
  await clearLogcat(serial);
  await launchApp(serial);
  const pendingReloadLine = await waitForReleaseAuthorProbeLog(serial, "reload");
  assert.match(pendingReloadLine, /phase=reload/);
  assert.match(pendingReloadLine, /outcome=loaded/);
  assert.ok(
    fieldIds(pendingReloadLine, "local_op_ids").includes(postFrameId),
    "pre-push cold reload should retain the post op",
  );
  assert.ok(
    fieldIds(pendingReloadLine, "local_op_ids").includes(badFrameId),
    "pre-push cold reload should retain the bad op",
  );
  assert.deepEqual(
    fieldIds(pendingReloadLine, "delegation_frame_ids"),
    pulledDelegationFrameIds,
    "pre-push cold reload should retain the pulled delegation frames",
  );
  assert.match(pendingReloadLine, /outbox_frame_count=2/);
  assert.doesNotMatch(pendingReloadLine, forbiddenLogTerms());
  console.log(`  observed pre-push cold reload ${pendingReloadLine.trim()}`);

  const pushLine = await waitForReleaseAuthorProbeLog(
    serial,
    "push",
    (line) => line.includes("outcome=synced"),
  );
  assert.match(pushLine, /phase=push/);
  assert.match(pushLine, /outcome=synced/);
  assert.deepEqual(fieldIds(pushLine, "pushed_frame_ids"), [badFrameId, postFrameId].sort());
  assert.match(pushLine, /accepted_count=2/);
  assert.match(pushLine, /pending_count=0/);
  assert.match(pushLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pushLine, forbiddenLogTerms());
  console.log(`  observed push ${pushLine.trim()}`);

  const peerLine = await waitForReleaseAuthorProbeLog(
    serial,
    "peer",
    (line) => line.includes("outcome=reported"),
  );
  assert.match(peerLine, /phase=peer/);
  assert.match(peerLine, /outcome=reported/);
  assert.equal(fieldValue(peerLine, "post_frame_id"), postFrameId);
  assert.equal(fieldValue(peerLine, "bad_frame_id"), badFrameId);
  assert.match(peerLine, /post_materialized=true/);
  assert.match(peerLine, /bad_authority_reason=operation_not_granted/);
  assert.match(peerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(peerLine, forbiddenLogTerms());
  console.log(`  observed peer ${peerLine.trim()}`);

  peer.kill();
  peer = null;
  await removeReverseMapping(serial, buildConfig.port);
  await forceStopApp(serial);
  await clearLogcat(serial);
  await launchApp(serial);
  const coldReloadLine = await waitForReleaseAuthorProbeLog(serial, "reload");
  assert.match(coldReloadLine, /phase=reload/);
  assert.match(coldReloadLine, /outcome=loaded/);
  assert.ok(fieldIds(coldReloadLine, "local_op_ids").includes(postFrameId), "cold reload should retain the post op");
  assert.ok(fieldIds(coldReloadLine, "local_op_ids").includes(badFrameId), "cold reload should retain the bad op");
  const coldDelegationFrameIds = fieldIds(coldReloadLine, "delegation_frame_ids");
  for (const id of pulledDelegationFrameIds) {
    assert.ok(coldDelegationFrameIds.includes(id), `cold reload should retain pulled delegation frame ${id}`);
  }
  assert.ok(coldDelegationFrameIds.includes(postFrameId), "cold reload should retain post carrier frame evidence");
  assert.ok(coldDelegationFrameIds.includes(badFrameId), "cold reload should retain bad carrier frame evidence");
  assert.match(coldReloadLine, /outbox_frame_count=0/);
  assert.doesNotMatch(coldReloadLine, forbiddenLogTerms());
  console.log(`  observed offline reload ${coldReloadLine.trim()}`);
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

function releaseAuthorProbeConfigFromBuildScript(): ReleaseAuthorProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:author-probe"] ?? "";
  const url = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL");
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM");
  const peerRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM");
  const peerPubkey = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE");
  const postText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_POST_TEXT");
  const badSummaryText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_BAD_SUMMARY_TEXT");
  const pauseAfterAuthorMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PAUSE_AFTER_AUTHOR_MS");
  assert.equal(url, "ws://127.0.0.1:43192/carrier");
  assert.equal(localRealm, "resident");
  assert.equal(peerRealm, "clerk");
  assert.equal(peerPubkey, "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=");
  assert.equal(storageNamespace, "township:release-author-probe");
  assert.equal(postText, "release-probe-post");
  assert.equal(badSummaryText, "release-probe-unauthorized-summary");
  assert.equal(pauseAfterAuthorMs, "30000");
  return {
    url,
    port: Number(new URL(url).port),
    localRealm,
    peerRealm,
    peerPubkey,
    storageNamespace,
    postText,
    badSummaryText,
    pauseAfterAuthorMs,
  };
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:author-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release author smoke must not install the debug APK");
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

async function waitForReleaseAuthorProbeLog(
  serial: string,
  phase: "native_key" | "reload" | "pull" | "author" | "push" | "peer",
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
          candidate.includes(TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX) &&
          candidate.includes(`phase=${phase}`) &&
          predicate(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX} phase=${phase}; last logcat:\n${lastOutput}`);
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
  assert.ok(match?.[1] ?? match?.[2], `release author build script must bake ${name}`);
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
      ["cap", ":"].join(""),
      ["seed"].join(""),
      ["private"].join(""),
      ["secret"].join(""),
    ].join("|"),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
