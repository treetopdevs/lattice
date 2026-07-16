import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX } from "../src/township_release_transport_probe";
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
import { assertAndroidDeviceWebSocketEndpoint, waitForProbeStats } from "./support/android_websocket_control";
import {
  assertHostWebSocketEndpoint,
  closeProbeServer,
  startWebSocketProbeServer,
  statsDelta,
  type WebSocketProbeServer,
} from "./support/websocket_probe_server";

const releaseApkPath = defaultReleaseApkPath();
const probePort = releaseTransportProbePortFromBuildScript();

console.log("\n▸ tauri:android:release:transport:smoke");
console.log("  Android release APK WebView transport characterization without CDP or BEAM convergence");
console.log("  waiting for township-release-transport-probe logcat outcome");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let probeServer: WebSocketProbeServer | null = null;

try {
  probeServer = await startWebSocketProbeServer(probePort, "0.0.0.0");
  await assertHostWebSocketEndpoint(probePort);
  let controlStats = probeServer.stats();
  assert.equal(controlStats.accepts, 1, "expected exactly one host control TCP accept before app launch");
  assert.equal(controlStats.upgrades, 1, "expected exactly one host control WebSocket upgrade before app launch");
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installReleaseApk(serial, releaseApkPath);
  await assertReleasePackageIsNotDebuggable(serial);
  await assertAndroidApiLevelSupportsNetworkSecurityConfig(serial);
  await assertAndroidEmulatorHostAlias(serial);
  await clearAppData(serial);
  await clearLogcat(serial);
  await runAdb(serial, ["reverse", `tcp:${probePort}`, `tcp:${probePort}`], 30_000);
  await assertReverseMapping(serial, probePort);
  await assertAndroidDeviceWebSocketEndpoint(serial, probePort);
  controlStats = await waitForProbeStats(probeServer, { accepts: 2, upgrades: 2 }, "host and device shell controls");
  assert.equal(controlStats.accepts, 2, "expected host and device shell controls before app launch");
  assert.equal(controlStats.upgrades, 2, "expected host and device shell WebSocket upgrades before app launch");
  await assertAndroidDeviceWebSocketEndpoint(serial, probePort, "10.0.2.2");
  controlStats = await waitForProbeStats(
    probeServer,
    { accepts: 3, upgrades: 3 },
    "host, loopback device shell, and android host alias controls",
  );
  assert.equal(controlStats.accepts, 3, "expected host, loopback, and android host alias controls before app launch");
  assert.equal(controlStats.upgrades, 3, "expected host, loopback, and android host alias WebSocket upgrades before app launch");
  await forceStopApp(serial);
  await launchApp(serial);
  const lines = await waitForTransportProbeLogs(serial);
  const diagnosticLogcat = await readRecentTransportDiagnosticLogcat(serial);
  await delay(250);
  const webViewStats = statsDelta(probeServer.stats(), controlStats);
  const loopbackLine = lines.loopback;
  const androidHostLine = lines.androidHost;

  assert.match(loopbackLine, new RegExp(`^.*${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} `));
  assert.match(loopbackLine, /surface=webview-websocket/);
  assert.match(loopbackLine, /url_scheme=ws/);
  assert.match(loopbackLine, /host_class=loopback/);
  assert.match(loopbackLine, /outcome=connected/);
  assert.match(loopbackLine, /message=frame_roundtrip/);
  assert.match(androidHostLine, new RegExp(`^.*${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} `));
  assert.match(androidHostLine, /surface=webview-websocket/);
  assert.match(androidHostLine, /url_scheme=ws/);
  assert.match(androidHostLine, /host_class=android_host/);
  assert.match(androidHostLine, /outcome=error/);
  assert.equal(webViewStats.accepts, 1, "expected scoped release policy to allow only the loopback WebView TCP accept");
  assert.equal(webViewStats.upgrades, 1, "expected scoped release policy to allow only the loopback WebSocket upgrade");
  assert.equal(webViewStats.framesEchoed, 1, "expected scoped release policy to echo only the loopback probe frame");
  console.log(`  observed loopback ${loopbackLine.trim()}`);
  console.log(`  observed android_host negative ${androidHostLine.trim()}`);
  console.log(
    `  server scoped webview stats after controls accepts=${webViewStats.accepts} upgrades=${webViewStats.upgrades} framesEchoed=${webViewStats.framesEchoed}`,
  );
  console.log("  diagnostic logcat slice after release probe:");
  console.log(indentLogcat(diagnosticLogcat));
} finally {
  if (serial) {
    await runAdb(serial, ["reverse", "--remove", `tcp:${probePort}`], 10_000).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
  await closeProbeServer(probeServer);
}

console.log("\x1b[32m✓ Township Android release transport characterization smoke passed\x1b[0m");
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

function releaseTransportProbePortFromBuildScript(): number {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["tauri:android:build:release:transport-probe"] ?? "";
  const match = /(?:^|\s)VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS=([^\s]+)/.exec(script);
  assert.ok(match?.[1], "release transport build script must bake VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS");
  const probeUrls = match[1].split(",");
  assert.deepEqual(probeUrls, ["ws://127.0.0.1:43185/carrier", "ws://10.0.2.2:43185/carrier"]);
  const port = Number(new URL(probeUrls[0] ?? "").port);
  assert.equal(port, 43185, `release transport probe URLs must include the baked port: ${probeUrls.join(",")}`);
  return port;
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:transport-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release transport smoke must not install the debug APK");
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

async function assertAndroidApiLevelSupportsNetworkSecurityConfig(serial: string): Promise<void> {
  const output = await runAdb(serial, ["shell", "getprop", "ro.build.version.sdk"], 10_000);
  const apiLevel = Number(output.trim());
  assert.ok(Number.isInteger(apiLevel), `expected numeric Android API level, got ${JSON.stringify(output)}`);
  assert.ok(apiLevel >= 26, `release scoped network-security config WebView proof requires Android API >= 26, got ${apiLevel}`);
  console.log(`  Android API level ${apiLevel} honors WebView network-security config`);
}

async function assertAndroidEmulatorHostAlias(serial: string): Promise<void> {
  const qemu = (await runAdb(serial, ["shell", "getprop", "ro.kernel.qemu"], 10_000)).trim();
  assert.equal(qemu, "1", `10.0.2.2 host-alias control requires an Android emulator, got ro.kernel.qemu=${qemu}`);
  console.log("  Android emulator host alias 10.0.2.2 is in scope");
}

async function waitForTransportProbeLogs(serial: string): Promise<{ loopback: string; androidHost: string }> {
  const deadline = Date.now() + 60_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
    lastOutput = output;
    const lines = output
      .split(/\r?\n/)
      .filter(
        (candidate) =>
          candidate.includes(TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX) &&
          candidate.includes("surface=webview-websocket") &&
          /(?:^|\s)outcome=/.test(candidate),
      );
    const loopback = lines.find((candidate) => candidate.includes("host_class=loopback"));
    const androidHost = lines.find((candidate) => candidate.includes("host_class=android_host"));
    if (loopback && androidHost) return { loopback, androidHost };
    await delay(500);
  }
  throw new Error(
    `timed out waiting for scoped ${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} log lines; last logcat:\n${lastOutput.trim()}`,
  );
}

async function readRecentTransportDiagnosticLogcat(serial: string): Promise<string> {
  const output = await runAdb(serial, ["logcat", "-d", "-t", "200"], 10_000);
  const diagnosticLines = output
    .split(/\r?\n/)
    .filter((candidate) => /LATTICE_PROBE|chromium|cr_|WebView|Cleartext|ERR_|net::|NetworkSecurityConfig/i.test(candidate));
  return diagnosticLines.slice(-24).join("\n") || "(no chromium/webview/network diagnostics in recent unfiltered logcat slice)";
}

function indentLogcat(logcat: string): string {
  return logcat
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

async function assertReverseMapping(serial: string, port: number): Promise<void> {
  const output = await runAdb(serial, ["reverse", "--list"], 10_000);
  assert.match(
    output,
    new RegExp(`tcp:${port}\\s+tcp:${port}`),
    `expected adb reverse mapping for tcp:${port}; got:\n${output}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
