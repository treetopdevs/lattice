import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX,
  TOWNSHIP_CANONICAL_PROBE_VECTOR_ID,
  expectedTownshipCanonicalProbeDigest,
} from "../src/township_canonical_probe";
import {
  appActivity,
  appId,
  cleanupAndroid,
  clearAppData,
  defaultDebugApkPath,
  ensureAndroidDevice,
  forceStopApp,
  runAdb,
  shellRoot,
  type ManagedProcess,
} from "./support/android_cdp";

const releaseApkPath = defaultReleaseApkPath();
const debugApkPath = defaultDebugApkPath();
const probeUrl = `township://probe/canonical?vector=${TOWNSHIP_CANONICAL_PROBE_VECTOR_ID}`;

console.log("\n▸ tauri:android:release:canonical:smoke");
console.log("  Android debug/release APK canonical probe without WebView CDP or carrier networking");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  const expectedDigest = await expectedTownshipCanonicalProbeDigest();
  await installAndProbe(serial, "debug", debugApkPath, expectedDigest);
  await installAndProbe(serial, "release", releaseApkPath, expectedDigest);

} finally {
  if (serial) await forceStopApp(serial).catch(() => undefined);
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release canonical probe smoke passed\x1b[0m");
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

async function installAndProbe(
  serial: string,
  variant: "debug" | "release",
  apkPath: string,
  expectedDigest: string,
): Promise<string> {
  assert.ok(existsSync(apkPath), `missing ${variant} APK at ${apkPath}; build it before this smoke`);
  assert.match(apkPath, variant === "debug" ? /app-universal-debug\.apk$/ : /app-universal-release\.apk$/);

  await runAdb(serial, ["install", "-r", apkPath], 120_000);
  if (variant === "release") await assertReleasePackageIsNotDebuggable(serial);
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);
  await openProbeDeepLink(serial);
  await waitForAppPid(serial);
  await delay(8_000);
  await openProbeDeepLink(serial);

  const line = await waitForProbeLog(serial);
  const actualDigest = probeDigest(line);
  assert.match(line, new RegExp(`${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} .*variant=android`));
  assert.match(line, new RegExp(`vector=${TOWNSHIP_CANONICAL_PROBE_VECTOR_ID}`));
  assert.equal(actualDigest, expectedDigest, `${variant} canonical digest mismatch in logcat line: ${line}`);
  assert.match(line, /mismatches=0/);
  return line;
}

async function assertReleasePackageIsNotDebuggable(serial: string): Promise<void> {
  const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", appId], 30_000);
  const packageSectionPattern = new RegExp(`Package \\[${appId}\\][\\s\\S]*?flags=\\[`);
  assert.match(
    packageDump,
    packageSectionPattern,
    `expected dumpsys package output for installed release package:\n${packageDump}`,
  );
  assert.doesNotMatch(packageDump, /\bDEBUGGABLE\b/, `expected installed release package to be non-debuggable:\n${packageDump}`);
}

async function clearLogcat(serial: string): Promise<void> {
  await runAdb(serial, ["logcat", "-c"], 10_000);
}

async function openProbeDeepLink(serial: string): Promise<void> {
  await runAdb(
    serial,
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      probeUrl,
      "-n",
      appActivity,
    ],
    30_000,
  );
}

async function waitForAppPid(serial: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim().split(/\s+/)[0];
    if (pid) return pid;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${appId} process`);
}

async function waitForProbeLog(serial: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    lastOutput = output;
    const line = output
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX) &&
          candidate.includes("variant=android") &&
          /(?:^|\s)digest=/.test(candidate) &&
          /(?:^|\s)expected=/.test(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(
    `timed out waiting for final ${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} log line; last logcat:\n${lastOutput.trim()}`,
  );
}

function probeDigest(line: string): string | null {
  return /(?:^|\s)digest=([A-Za-z0-9_-]+)/.exec(line)?.[1] ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
