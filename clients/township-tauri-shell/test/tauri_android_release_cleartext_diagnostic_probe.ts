import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX } from "../src/township_release_transport_probe";
import { assertApkPackage, assertApkUsesCleartextTraffic } from "./support/android_apk_manifest";
import {
  appId,
  cleanupAndroid,
  ensureAndroidDevice,
  runAdb,
  shellRoot,
  type ManagedProcess,
} from "./support/android_cdp";
import { assertAndroidDeviceWebSocketEndpoint, waitForProbeStats } from "./support/android_websocket_control";
import {
  assertHostWebSocketEndpoint,
  closeProbeServer,
  startWebSocketProbeServer,
  statsDelta,
  type WebSocketProbeServer,
} from "./support/websocket_probe_server";

const diagnosticAppId = "dev.treetop.lattice.township.cleartextdiag";
assert.equal(diagnosticAppId, `${appId}.cleartextdiag`);
const diagnosticApkPath = defaultReleaseCleartextDiagnosticApkPath();
const probePort = releaseCleartextDiagnosticProbePortFromBuildScript();

console.log("\n▸ tauri:android:release:cleartext-diagnostic:smoke");
console.log("  Android release-shaped cleartext diagnostic APK WebView transport proof without BEAM convergence");
console.log("  waiting for township-release-transport-probe logcat outcome");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let probeServer: WebSocketProbeServer | null = null;

try {
  probeServer = await startWebSocketProbeServer(probePort);
  await assertHostWebSocketEndpoint(probePort);
  let controlStats = probeServer.stats();
  assert.equal(controlStats.accepts, 1, "expected exactly one host control TCP accept before app launch");
  assert.equal(controlStats.upgrades, 1, "expected exactly one host control WebSocket upgrade before app launch");

  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installDiagnosticApk(serial, diagnosticApkPath);
  await assertReleasePackageIsNotDebuggable(serial, diagnosticAppId);
  await clearPackageData(serial, diagnosticAppId);
  await clearLogcat(serial);
  await runAdb(serial, ["reverse", `tcp:${probePort}`, `tcp:${probePort}`], 30_000);
  await assertReverseMapping(serial, probePort);
  await assertAndroidDeviceWebSocketEndpoint(serial, probePort);
  controlStats = await waitForProbeStats(probeServer, { accepts: 2, upgrades: 2 }, "host and device shell controls");
  assert.equal(controlStats.accepts, 2, "expected host and device shell controls before app launch");
  assert.equal(controlStats.upgrades, 2, "expected host and device shell WebSocket upgrades before app launch");

  await forceStopPackage(serial, diagnosticAppId);
  await launchPackage(serial, diagnosticAppId);
  const line = await waitForTransportProbeLog(serial);
  await delay(250);
  const webViewStats = statsDelta(probeServer.stats(), controlStats);

  assert.match(line, new RegExp(`^.*${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} `));
  assert.match(line, /surface=webview-websocket/);
  assert.match(line, /url_scheme=ws/);
  assert.match(line, /host_class=loopback/);
  assert.match(line, /outcome=connected/);
  assert.match(line, /message=frame_roundtrip/);
  assert.ok(webViewStats.accepts >= 1, `expected diagnostic WebView TCP accept, got ${JSON.stringify(webViewStats)}`);
  assert.ok(webViewStats.upgrades >= 1, `expected diagnostic WebView WebSocket upgrade, got ${JSON.stringify(webViewStats)}`);
  assert.ok(webViewStats.framesEchoed >= 1, `expected diagnostic WebView frame roundtrip, got ${JSON.stringify(webViewStats)}`);
  console.log(`  observed ${line.trim()}`);
  console.log(
    `  server diagnostic webview stats after controls accepts=${webViewStats.accepts} upgrades=${webViewStats.upgrades} framesEchoed=${webViewStats.framesEchoed}`,
  );
} finally {
  if (serial) {
    await runAdb(serial, ["reverse", "--remove", `tcp:${probePort}`], 10_000).catch(() => undefined);
    await forceStopPackage(serial, diagnosticAppId).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
  await closeProbeServer(probeServer);
}

console.log("\x1b[32m✓ Township Android release-shaped cleartext diagnostic smoke passed\x1b[0m");
process.exit(0);

function defaultReleaseCleartextDiagnosticApkPath(): string {
  return resolve(
    process.env.TOWNSHIP_ANDROID_RELEASE_CLEARTEXT_DIAGNOSTIC_APK ??
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
        "app-universal-release-cleartextdiag.apk",
      ),
  );
}

function releaseCleartextDiagnosticProbePortFromBuildScript(): number {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:cleartext-diagnostic:transport-probe"] ?? "";
  const match =
    /(?:^|\s)TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC=1\s+VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=([^\s]+)/.exec(
      script,
    );
  assert.ok(match?.[1], "diagnostic transport build script must bake VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL");
  const probeUrl = match[1];
  assert.equal(probeUrl, "ws://127.0.0.1:43188/carrier");
  const port = Number(new URL(probeUrl).port);
  assert.equal(port, 43188, `diagnostic transport probe URL must include the baked port: ${probeUrl}`);
  return port;
}

async function installDiagnosticApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release-shaped diagnostic APK at ${apkPath}; run npm run tauri:android:build:release:cleartext-diagnostic:transport-probe before this smoke`,
  );
  assert.match(apkPath, /app-universal-release-cleartextdiag\.apk$/);
  await assertApkPackage(apkPath, diagnosticAppId);
  await assertApkUsesCleartextTraffic(apkPath, true);
  await runAdb(serial, ["uninstall", diagnosticAppId], 30_000).catch(() => undefined);
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
}

async function assertReleasePackageIsNotDebuggable(serial: string, packageId: string): Promise<void> {
  const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", packageId], 30_000);
  const packageSectionPattern = new RegExp(`Package \\[${packageId}\\][\\s\\S]*?flags=\\[`);
  assert.match(packageDump, packageSectionPattern, `expected dumpsys package output for installed package:\n${packageDump}`);
  assert.doesNotMatch(packageDump, /\bDEBUGGABLE\b/, `expected installed diagnostic package to be non-debuggable:\n${packageDump}`);
}

async function clearPackageData(serial: string, packageId: string): Promise<void> {
  await runAdb(serial, ["shell", "pm", "clear", packageId], 30_000);
}

async function clearLogcat(serial: string): Promise<void> {
  await runAdb(serial, ["logcat", "-c"], 10_000);
}

async function forceStopPackage(serial: string, packageId: string): Promise<void> {
  await runAdb(serial, ["shell", "am", "force-stop", packageId], 10_000);
}

async function launchPackage(serial: string, packageId: string): Promise<void> {
  await runAdb(serial, ["shell", "monkey", "-p", packageId, "-c", "android.intent.category.LAUNCHER", "1"], 30_000);
}

async function assertReverseMapping(serial: string, port: number): Promise<void> {
  const output = await runAdb(serial, ["reverse", "--list"], 10_000);
  assert.match(
    output,
    new RegExp(`tcp:${port}\\s+tcp:${port}`),
    `expected adb reverse mapping for tcp:${port}; got:\n${output}`,
  );
}

async function waitForTransportProbeLog(serial: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    lastOutput = output;
    const line = output
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX) &&
          candidate.includes("surface=webview-websocket") &&
          candidate.includes("host_class=loopback") &&
          /(?:^|\s)outcome=/.test(candidate),
      );
    if (line) return line;
    await delay(500);
  }
  throw new Error(
    `timed out waiting for ${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} log line; last logcat:\n${lastOutput.trim()}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
