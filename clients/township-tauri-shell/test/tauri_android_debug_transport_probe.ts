import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX } from "../src/township_release_transport_probe";
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
import { assertAndroidDeviceWebSocketEndpoint, waitForProbeStats } from "./support/android_websocket_control";
import {
  assertHostWebSocketEndpoint,
  closeProbeServer,
  startWebSocketProbeServer,
  statsDelta,
  type WebSocketProbeServer,
} from "./support/websocket_probe_server";

const debugApkPath = defaultDebugApkPath();
const probePort = debugTransportProbePortFromBuildScript();

console.log("\n▸ tauri:android:debug:transport:smoke");
console.log("  Android debug APK WebView positive transport control without CDP or BEAM convergence");
console.log("  waiting for township-release-transport-probe logcat outcome");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let probeServer: WebSocketProbeServer | null = null;

try {
  probeServer = await startWebSocketProbeServer(probePort);
  await assertHostWebSocketEndpoint(probePort);
  let controlStats = probeServer.stats();
  assert.equal(controlStats.accepts, 1, "expected exactly one host control TCP accept before device work");
  assert.equal(controlStats.upgrades, 1, "expected exactly one host control WebSocket upgrade before device work");

  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installDebugTransportApk(serial, debugApkPath);
  await assertDebugPackageIsDebuggable(serial);
  await clearAppData(serial);
  await clearLogcat(serial);
  await runAdb(serial, ["reverse", `tcp:${probePort}`, `tcp:${probePort}`], 30_000); // adb reverse
  await assertReverseMapping(serial, probePort);
  await assertAndroidDeviceWebSocketEndpoint(serial, probePort);
  controlStats = await waitForProbeStats(probeServer, { accepts: 2, upgrades: 2 }, "host and device shell controls");
  assert.equal(controlStats.accepts, 2, "expected host and device shell controls before app launch");
  assert.equal(controlStats.upgrades, 2, "expected host and device shell WebSocket upgrades before app launch");

  await forceStopApp(serial);
  await launchApp(serial);
  const line = await waitForTransportProbeLog(serial);
  await delay(250);
  const webViewStats = statsDelta(probeServer.stats(), controlStats);

  assert.match(line, new RegExp(`^.*${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} `));
  assert.match(line, /surface=webview-websocket/);
  assert.match(line, /url_scheme=ws/);
  assert.match(line, /host_class=loopback/);
  assert.match(line, /outcome=connected/);
  assert.match(line, /message=frame_roundtrip/);
  assert.ok(webViewStats.accepts >= 1, `expected debug WebView TCP accept, got ${JSON.stringify(webViewStats)}`);
  assert.ok(webViewStats.upgrades >= 1, `expected debug WebView WebSocket upgrade, got ${JSON.stringify(webViewStats)}`);
  assert.ok(webViewStats.framesEchoed >= 1, `expected debug WebView frame roundtrip, got ${JSON.stringify(webViewStats)}`);
  console.log(`  observed ${line.trim()}`);
  console.log(
    `  server webview stats after controls accepts=${webViewStats.accepts} upgrades=${webViewStats.upgrades} framesEchoed=${webViewStats.framesEchoed}`,
  );
} finally {
  if (serial) {
    await runAdb(serial, ["reverse", "--remove", `tcp:${probePort}`], 10_000).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
  await closeProbeServer(probeServer);
}

console.log("\x1b[32m✓ Township Android debug transport positive control smoke passed\x1b[0m");
process.exit(0);

function debugTransportProbePortFromBuildScript(): number {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:debug:transport-probe"] ?? "";
  const match = /(?:^|\s)VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=([^\s]+)/.exec(script);
  assert.ok(match?.[1], "debug transport build script must bake VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL");
  const probeUrl = match[1];
  assert.equal(probeUrl, "ws://127.0.0.1:43186/carrier");
  const port = Number(new URL(probeUrl).port);
  assert.equal(port, 43186, `debug transport probe URL must include the baked port: ${probeUrl}`);
  return port;
}

async function installDebugTransportApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing debug APK at ${apkPath}; run npm run tauri:android:build:debug:transport-probe before this smoke`,
  );
  assert.match(apkPath, /app-universal-debug\.apk$/, "debug transport smoke must install app-universal-debug.apk");
  await runAdb(serial, ["uninstall", appId], 30_000).catch(() => undefined);
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
}

async function assertDebugPackageIsDebuggable(serial: string): Promise<void> {
  const packageDump = await runAdb(serial, ["shell", "dumpsys", "package", appId], 30_000);
  const packageSectionPattern = new RegExp(`Package \\[${appId}\\][\\s\\S]*?flags=\\[`);
  assert.match(packageDump, packageSectionPattern, `expected dumpsys package output for installed debug package:\n${packageDump}`);
  assert.match(packageDump, /\bDEBUGGABLE\b/, `expected installed debug package to be debuggable:\n${packageDump}`);
}

async function clearLogcat(serial: string): Promise<void> {
  await runAdb(serial, ["logcat", "-c"], 10_000);
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
