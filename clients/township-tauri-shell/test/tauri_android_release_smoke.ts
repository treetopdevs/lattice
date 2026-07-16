import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

const releaseApkPath = defaultReleaseApkPath();

console.log("\n▸ tauri:android:release:smoke");
console.log("  Android release APK installs and launches without using debug-only WebView CDP");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installReleaseApk(serial, releaseApkPath);
  await clearAppData(serial);
  await forceStopApp(serial);
  await launchApp(serial);
  const pid = await waitForAppPid(serial);
  assert.match(pid, /^\d+$/);
  await delay(2_000);
  assert.equal(await appProcessRunning(serial, pid), true, "release APK process should stay alive after launch");
} finally {
  if (serial) await forceStopApp(serial).catch(() => undefined);
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release APK install/launch smoke passed\x1b[0m");
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

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release smoke must not install the debug APK");
  assert.match(apkPath, /app-universal-release\.apk$/);
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
}

async function waitForAppPid(serial: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim().split(/\s+/)[0];
    if (pid) return pid;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${appId} release process`);
}

async function appProcessRunning(serial: string, expectedPid: string): Promise<boolean> {
  const pid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim().split(/\s+/)[0];
  return pid === expectedPid;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
