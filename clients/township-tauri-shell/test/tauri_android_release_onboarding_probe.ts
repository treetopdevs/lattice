import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  exportTownshipCarrierPairingHandoff,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX } from "../src/township_release_author_probe";
import { TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX } from "../src/township_release_onboarding_probe";
import { TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX } from "../src/township_release_pairing_probe";
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

interface ReleaseOnboardingProbeBuildConfig {
  port: number;
  localRealm: string;
  keyId: string;
  storageNamespace: string;
  armState: string;
  postText: string;
  badSummaryText: string;
  pauseAfterAuthorMs: string;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseOnboardingProbeConfigFromBuildScript();
const peerRealm = "clerk";
const expectedPeerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const expectedPeerFingerprint = townshipCarrierPeerFingerprint(expectedPeerPubkey);

console.log("\n▸ tauri:android:release:onboarding:smoke");
console.log("  Android release APK pairs, pulls caps, authors, pushes, and reloads in one probe namespace");

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
  await runReleaseOnboardingConvergenceProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release onboarding convergence smoke passed\x1b[0m");
process.exit(0);

async function runReleaseOnboardingConvergenceProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await launchApp(serial);

  const nativeKeyLine = await waitForOnboardingProbeLog(serial, "native_key");
  assert.match(nativeKeyLine, /phase=native_key/);
  assert.match(nativeKeyLine, new RegExp(`storage_namespace=${escapeRegExp(buildConfig.storageNamespace)}`));
  const devicePublicKeyBase64 = devicePublicKeyFromNativeKeyLine(nativeKeyLine);
  assert.equal(Buffer.from(devicePublicKeyBase64, "base64").length, 32);
  assert.doesNotMatch(nativeKeyLine, forbiddenLogTerms());

  const armingLine = await waitForPairingProbeLog(serial, "arming", (line) => line.includes("outcome=armed"));
  assert.match(armingLine, /phase=arming/);
  assert.match(armingLine, /state_required=true/);
  assert.doesNotMatch(armingLine, new RegExp(escapeRegExp(buildConfig.armState)));
  assert.doesNotMatch(armingLine, forbiddenLogTerms());
  console.log(`  observed onboarding arm ${armingLine.trim()}`);

  peer = await spawnTownshipPeer({
    peerRealm,
    trustedPeerRealm: buildConfig.localRealm,
    trustedPeerPubkey: devicePublicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipScenario",
    bootstrapAudiencePubkey: devicePublicKeyBase64,
  });
  assert.equal(peer.publicKeyBase64, expectedPeerPubkey);
  await runAdb(serial, ["reverse", `tcp:${buildConfig.port}`, `tcp:${peer.port}`], 30_000);
  await assertReverseMapping(serial, buildConfig.port, peer.port);

  await openPairingDeepLink(serial, pairingPeerConfig(), buildConfig.armState);

  const pairingLine = await waitForPairingProbeLog(serial, "pairing", (line) => line.includes("outcome=saved"));
  assert.match(pairingLine, /phase=pairing/);
  assert.match(pairingLine, /outcome=saved/);
  assert.match(pairingLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(pairingLine, /host_class=loopback/);
  assert.match(pairingLine, new RegExp(`url_port=${buildConfig.port}`));
  assert.doesNotMatch(pairingLine, forbiddenLogTerms());
  console.log(`  observed onboarding pairing save ${pairingLine.trim()}`);

  const pairingSyncLine = await waitForPairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(pairingSyncLine, /phase=sync/);
  assert.match(pairingSyncLine, /outcome=synced/);
  assert.notDeepEqual(fieldIds(pairingSyncLine, "local_op_ids"), []);
  assert.notDeepEqual(fieldIds(pairingSyncLine, "delegation_frame_ids"), []);
  assert.match(pairingSyncLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pairingSyncLine, forbiddenLogTerms());
  console.log(`  observed onboarding pairing-derived sync ${pairingSyncLine.trim()}`);

  const pullLine = await waitForAuthorProbeLog(serial, "pull", (line) => line.includes("outcome=synced"));
  assert.match(pullLine, /phase=pull/);
  assert.match(pullLine, /outcome=synced/);
  assert.notDeepEqual(fieldIds(pullLine, "local_op_ids"), []);
  assert.notDeepEqual(fieldIds(pullLine, "delegation_frame_ids"), []);
  assert.match(pullLine, /outbox_frame_count=0/);
  const grantDelegationId = fieldValue(pullLine, "grant_delegation_id");
  assert.notEqual(grantDelegationId, "none");
  assert.doesNotMatch(pullLine, forbiddenLogTerms());
  console.log(`  observed onboarding pull ${pullLine.trim()}`);

  const authorLine = await waitForAuthorProbeLog(serial, "author", (line) => line.includes("outcome=authored"));
  assert.match(authorLine, /phase=author/);
  assert.match(authorLine, /outcome=authored/);
  const postFrameId = fieldValue(authorLine, "post_frame_id");
  const badFrameId = fieldValue(authorLine, "bad_frame_id");
  assert.notEqual(postFrameId, badFrameId);
  assert.equal(fieldValue(authorLine, "cap_id"), grantDelegationId);
  assert.match(authorLine, /outbox_frame_count=2/);
  assert.doesNotMatch(authorLine, forbiddenLogTerms());
  console.log(`  observed onboarding author ${authorLine.trim()}`);

  await forceStopApp(serial);
  await clearLogcat(serial);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await launchApp(serial);

  const pendingReloadLine = await waitForPairingProbeLog(serial, "reload", (line) => line.includes("paired=true"));
  assert.match(pendingReloadLine, /paired=true/);
  assert.ok(
    fieldIds(pendingReloadLine, "local_op_ids").includes(postFrameId),
    "pre-push relaunch should retain the post op",
  );
  assert.ok(
    fieldIds(pendingReloadLine, "local_op_ids").includes(badFrameId),
    "pre-push relaunch should retain the rejected op",
  );
  assert.match(pendingReloadLine, /outbox_frame_count=2/);
  assert.match(pendingReloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.doesNotMatch(pendingReloadLine, forbiddenLogTerms());
  console.log(`  observed onboarding pending reload ${pendingReloadLine.trim()}`);

  const pushLine = await waitForAuthorProbeLog(serial, "push", (line) => line.includes("outcome=synced"));
  assert.match(pushLine, /phase=push/);
  assert.match(pushLine, /outcome=synced/);
  assert.deepEqual(fieldIds(pushLine, "pushed_frame_ids"), [badFrameId, postFrameId].sort());
  assert.match(pushLine, /accepted_count=2/);
  assert.match(pushLine, /pending_count=0/);
  assert.match(pushLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pushLine, forbiddenLogTerms());
  console.log(`  observed onboarding push ${pushLine.trim()}`);

  const peerLine = await waitForAuthorProbeLog(serial, "peer", (line) => line.includes("outcome=reported"));
  assert.match(peerLine, /phase=peer/);
  assert.match(peerLine, /outcome=reported/);
  assert.equal(fieldValue(peerLine, "post_frame_id"), postFrameId);
  assert.equal(fieldValue(peerLine, "bad_frame_id"), badFrameId);
  assert.match(peerLine, /post_materialized=true/);
  assert.match(peerLine, /bad_authority_reason=operation_not_granted/);
  assert.match(peerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(peerLine, forbiddenLogTerms());
  console.log(`  observed onboarding peer report ${peerLine.trim()}`);

  const completeLine = await waitForOnboardingProbeLog(serial, "complete", (line) => line.includes("outcome=reported"));
  assert.match(completeLine, /phase=complete/);
  assert.match(completeLine, /outcome=reported/);
  assert.match(completeLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(completeLine, /post_materialized=true/);
  assert.match(completeLine, /bad_authority_reason=operation_not_granted/);
  assert.doesNotMatch(completeLine, forbiddenLogTerms());
  console.log(`  observed onboarding complete ${completeLine.trim()}`);

  await forceStopApp(serial);
  await clearLogcat(serial);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await launchApp(serial);

  const pairedReloadLine = await waitForPairingProbeLog(serial, "reload", (line) => line.includes("paired=true"));
  assert.match(pairedReloadLine, /paired=true/);
  assert.match(pairedReloadLine, /outbox_frame_count=0/);
  assert.match(pairedReloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.doesNotMatch(pairedReloadLine, forbiddenLogTerms());
  console.log(`  observed onboarding paired reload ${pairedReloadLine.trim()}`);

  const relaunchSyncLine = await waitForPairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(relaunchSyncLine, /phase=sync/);
  assert.match(relaunchSyncLine, /outcome=synced/);
  assert.ok(fieldIds(relaunchSyncLine, "local_op_ids").includes(postFrameId), "relaunch sync should retain the post op");
  assert.ok(fieldIds(relaunchSyncLine, "local_op_ids").includes(badFrameId), "relaunch sync should retain the rejected op");
  assert.match(relaunchSyncLine, /outbox_frame_count=0/);
  assert.doesNotMatch(relaunchSyncLine, forbiddenLogTerms());
  console.log(`  observed onboarding relaunch sync ${relaunchSyncLine.trim()}`);

  const finalPeerLine = await waitForAuthorProbeLog(
    serial,
    "peer",
    (line) =>
      line.includes("outcome=reported") &&
      fieldValue(line, "post_frame_id") === postFrameId &&
      fieldValue(line, "bad_frame_id") === badFrameId,
  );
  assert.match(finalPeerLine, /post_materialized=true/);
  assert.match(finalPeerLine, /bad_authority_reason=operation_not_granted/);
  assert.match(finalPeerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(finalPeerLine, forbiddenLogTerms());
  const finalLogcat = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  assert.doesNotMatch(finalLogcat, /township-release-author-probe phase=author outcome=authored/);
  console.log(`  observed onboarding final peer report ${finalPeerLine.trim()}`);
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

function releaseOnboardingProbeConfigFromBuildScript(): ReleaseOnboardingProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const normalRelease = packageJson.scripts?.["tauri:android:build:release"] ?? "";
  const script = packageJson.scripts?.["tauri:android:build:release:onboarding-probe"] ?? "";
  assert.doesNotMatch(normalRelease, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE/);
  assert.doesNotMatch(
    script,
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "single-APK onboarding probe must receive peer config from the OS-delivered pairing handoff",
  );
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM");
  const keyId = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE");
  const armState = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE");
  const postText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT");
  const badSummaryText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT");
  const pauseAfterAuthorMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_PAUSE_AFTER_AUTHOR_MS");
  assert.equal(localRealm, "resident");
  assert.equal(keyId, "township-release-onboarding-resident");
  assert.equal(storageNamespace, "township:release-onboarding-probe");
  assert.equal(armState, "release-onboarding-state-106");
  assert.equal(postText, "release-onboarding-post");
  assert.equal(badSummaryText, "release-onboarding-unauthorized-summary");
  assert.equal(pauseAfterAuthorMs, "30000");
  return { port: 43194, localRealm, keyId, storageNamespace, armState, postText, badSummaryText, pauseAfterAuthorMs };
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
  state: string,
): Promise<void> {
  const handoff = exportTownshipCarrierPairingHandoff(config);
  const link = `township://pairing/${encodeURIComponent(handoff)}?state=${encodeURIComponent(state)}`;
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
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:onboarding-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release onboarding smoke must not install the debug APK");
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

async function waitForOnboardingProbeLog(
  serial: string,
  phase: "native_key" | "complete",
  predicate: (line: string) => boolean = () => true,
): Promise<string> {
  return waitForProbeLog(serial, TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX, phase, predicate);
}

async function waitForPairingProbeLog(
  serial: string,
  phase: "reload" | "arming" | "pairing" | "sync",
  predicate: (line: string) => boolean = () => true,
): Promise<string> {
  return waitForProbeLog(serial, TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX, phase, predicate);
}

async function waitForAuthorProbeLog(
  serial: string,
  phase: "pull" | "author" | "push" | "peer",
  predicate: (line: string) => boolean = () => true,
): Promise<string> {
  return waitForProbeLog(serial, TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX, phase, predicate);
}

async function waitForProbeLog(
  serial: string,
  prefix: string,
  phase: string,
  predicate: (line: string) => boolean,
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
      .find((candidate) => candidate.includes(prefix) && candidate.includes(`phase=${phase}`) && predicate(candidate));
    if (line) return line;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${prefix} phase=${phase}; last logcat:\n${lastOutput}`);
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
  assert.ok(match?.[1] ?? match?.[2], `release onboarding build script must bake ${name}`);
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
