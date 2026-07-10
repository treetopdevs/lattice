import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  armState?: string;
  stateExchangeUrl?: string;
  stateExchangePort?: number;
  timeoutMs: string;
}

interface BrowserPairingPageServer {
  port: number;
  server: Server;
  waitForPath(path: string): Promise<void>;
}

interface PairingStateExchangeServer {
  port: number;
  server: Server;
  waitForState(): Promise<string>;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releasePairingProbeConfigFromBuildScript();
const peerRealm = "clerk";
const expectedPeerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const expectedPeerFingerprint = townshipCarrierPeerFingerprint(expectedPeerPubkey);
const resolveActivityCommand = ["cmd", "package", "resolve-activity"];

console.log("\n▸ tauri:android:release:browser-pairing:smoke");
console.log("  Android release APK accepts browser-backed release pairing delivery, persists peer config, and syncs");

let serial: string | null = null;
let spawnedEmulator: ManagedProcess | null = null;
let peer: TownshipPeerProcess | null = null;
let stateExchangeServer: PairingStateExchangeServer | null = null;

try {
  const android = await ensureAndroidDevice();
  serial = android.serial;
  spawnedEmulator = android.spawnedEmulator;

  await installReleaseApk(serial, releaseApkPath);
  await assertReleasePackageIsNotDebuggable(serial);
  await assertAndroidApiLevelSupportsNetworkSecurityConfig(serial);
  await runReleaseBrowserPairingDeliveryProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    if (buildConfig.stateExchangePort !== undefined) {
      await removeReverseMapping(serial, buildConfig.stateExchangePort).catch(() => undefined);
    }
    await forceStopApp(serial).catch(() => undefined);
  }
  if (stateExchangeServer) await closeServer(stateExchangeServer.server).catch(() => undefined);
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release browser pairing smoke passed\x1b[0m");
process.exit(0);

async function runReleaseBrowserPairingDeliveryProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);

  if (buildConfig.stateExchangeUrl !== undefined) {
    stateExchangeServer = await startPairingStateExchangeServer(buildConfig.stateExchangeUrl);
    await runAdb(serial, ["reverse", `tcp:${stateExchangeServer.port}`, `tcp:${stateExchangeServer.port}`], 30_000);
    await assertReverseMapping(serial, stateExchangeServer.port, stateExchangeServer.port);
  }

  const browserPackage = await resolveBrowserPackage(serial);
  console.log(`  resolved Android browser package ${browserPackage}`);
  await prepareBrowserPackageForSmoke(serial, browserPackage);
  await clearLogcat(serial);

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
  console.log(`  observed browser-pairing unpaired reload ${initialReloadLine.trim()}`);

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

  const armingLine = await waitForReleasePairingProbeLog(serial, "arming", (line) => line.includes("outcome=armed"));
  assert.match(armingLine, /phase=arming/);
  assert.match(armingLine, /state_required=true/);
  if (buildConfig.armState !== undefined) {
    assert.doesNotMatch(armingLine, new RegExp(escapeRegExp(buildConfig.armState)));
  }
  assert.doesNotMatch(armingLine, forbiddenLogTerms());
  console.log(`  observed browser-pairing arm ${armingLine.trim()}`);

  const runtimeArmState = stateExchangeServer ? await stateExchangeServer.waitForState() : buildConfig.armState;
  assert.ok(runtimeArmState, "browser pairing smoke requires either a fixed arm state or a runtime state exchange");
  assert.match(runtimeArmState, /^[A-Za-z0-9_.:-]{8,128}$/);
  if (buildConfig.armState === undefined) {
    assert.match(runtimeArmState, /^[0-9a-f]{32}$/);
    assert.notEqual(runtimeArmState, "release-pairing-state-103");
  }
  assert.doesNotMatch(armingLine, new RegExp(escapeRegExp(runtimeArmState)));

  const handoff = exportTownshipCarrierPairingHandoff(pairingPeerConfig());
  const noStateLink = `township://pairing/${encodeURIComponent(handoff)}`;
  const stateLink = `township://pairing/${encodeURIComponent(handoff)}?state=${encodeURIComponent(runtimeArmState)}`;
  const pageServer = await startBrowserPairingPageServer({
    "/no-state": noStateLink,
    "/state": stateLink,
  });
  const pageBaseUrl = await browserPageBaseUrl(serial, pageServer.port);

  try {
    await openBrowserPairingPageAndTap(serial, browserPackage, pageServer, pageBaseUrl, "/no-state");
    const blockedLine = await waitForReleasePairingProbeLog(
      serial,
      "deeplink",
      (line) => line.includes("outcome=blocked") && line.includes("blocked_reason=state_mismatch"),
    );
    assert.match(blockedLine, /phase=deeplink/);
    assert.match(blockedLine, /outcome=blocked/);
    assert.match(blockedLine, /blocked_reason=state_mismatch/);
    assert.match(blockedLine, /pairing_url_count=1/);
    assert.doesNotMatch(blockedLine, new RegExp(escapeRegExp(runtimeArmState)));
    assert.doesNotMatch(blockedLine, forbiddenLogTerms());
    await assertNoPairingSavedYet(serial);
    console.log(`  observed browser-delivered no-state block ${blockedLine.trim()}`);

    await openBrowserPairingPageAndTap(serial, browserPackage, pageServer, pageBaseUrl, "/state");
    const pairingLine = await waitForReleasePairingProbeLog(serial, "pairing", (line) => line.includes("outcome=saved"));
    assert.match(pairingLine, /phase=pairing/);
    assert.match(pairingLine, /outcome=saved/);
    assert.match(pairingLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
    assert.match(pairingLine, /host_class=loopback/);
    assert.match(pairingLine, new RegExp(`url_port=${buildConfig.port}`));
    assert.doesNotMatch(pairingLine, forbiddenLogTerms());
    console.log(`  observed browser-delivered pairing save ${pairingLine.trim()}`);
  } finally {
    await removeReverseMapping(serial, pageServer.port).catch(() => undefined);
    await closeServer(pageServer.server);
  }

  await forceStopApp(serial);
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
  console.log(`  observed browser-pairing persisted reload ${reloadLine.trim()}`);

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
  console.log(`  observed browser-pairing sync ${syncLine.trim()}`);

  if (buildConfig.armState === undefined) {
    await assertLogcatDoesNotContain(serial, runtimeArmState);
  }
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
  const buildScriptName = process.env.TOWNSHIP_RELEASE_PAIRING_BUILD_SCRIPT ?? "tauri:android:build:release:pairing-probe";
  const normalRelease = packageJson.scripts?.["tauri:android:build:release"] ?? "";
  const script = packageJson.scripts?.[buildScriptName] ?? "";
  assert.ok(script, `missing release browser pairing build script ${buildScriptName}`);
  assert.doesNotMatch(normalRelease, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE/);
  assert.doesNotMatch(
    script,
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "release browser pairing probe must not bake peer endpoint or identity env",
  );
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM");
  const keyId = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE");
  const armState = optionalScriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE");
  const stateExchangeUrl = optionalScriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL");
  const timeoutMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS");
  assert.equal(localRealm, "resident");
  assert.equal(timeoutMs, "120000");
  if (buildScriptName === "tauri:android:build:release:pairing-state-probe") {
    assert.equal(keyId, "township-release-pairing-state-resident");
    assert.equal(storageNamespace, "township:release-pairing-state-probe");
    assert.equal(armState, undefined);
    assert.equal(stateExchangeUrl, "http://127.0.0.1:43196/pairing-state");
    return {
      port: 43193,
      localRealm,
      keyId,
      storageNamespace,
      stateExchangeUrl,
      stateExchangePort: 43196,
      timeoutMs,
    };
  }

  assert.equal(buildScriptName, "tauri:android:build:release:pairing-probe");
  assert.equal(keyId, "township-release-pairing-resident");
  assert.equal(storageNamespace, "township:release-pairing-probe");
  assert.equal(armState, "release-pairing-state-103");
  assert.equal(stateExchangeUrl, undefined);
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

async function startBrowserPairingPageServer(routes: Record<string, string>): Promise<BrowserPairingPageServer> {
  const seenPaths = new Set<string>();
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    seenPaths.add(path);
    const link = routes[path] ?? routes["/state"];
    if (!link) {
      response.writeHead(404).end("missing pairing link");
      return;
    }
    const html = browserPairingPageHtml(link);
    assert.ok(html.includes('data-township-href="township://pairing'));
    assert.ok(html.includes(`Intent;scheme=township;package=${appId};component=${appActivity};end`));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  assert.ok(address?.port, "browser pairing page server should bind a TCP port");

  return {
    port: address.port,
    server,
    async waitForPath(path: string): Promise<void> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (seenPaths.has(path)) return;
        await delay(250);
      }
      throw new Error(`timed out waiting for browser request to ${path}; saw ${Array.from(seenPaths).join(", ") || "none"}`);
    },
  };
}

async function startPairingStateExchangeServer(exchangeUrl: string): Promise<PairingStateExchangeServer> {
  const parsed = new URL(exchangeUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/pairing-state");
  const port = Number(parsed.port);
  assert.equal(port, 43196);
  let observedState: string | null = null;

  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("cache-control", "no-store");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    if (request.method !== "POST" || request.url?.split("?")[0] !== "/pairing-state") {
      response.writeHead(404).end("missing state exchange route");
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 256) request.destroy(new Error("state exchange body too large"));
    });
    request.on("end", () => {
      const state = body.trim();
      if (!/^[0-9a-f]{32}$/.test(state)) {
        response.writeHead(400).end("invalid state");
        return;
      }
      observedState = state;
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  return {
    port,
    server,
    async waitForState(): Promise<string> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (observedState) return observedState;
        await delay(250);
      }
      throw new Error("timed out waiting for app-minted browser pairing state exchange");
    },
  };
}

function browserPairingPageHtml(link: string): string {
  const browserHref = androidIntentHrefForTownshipLink(link);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Township Pairing</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; }
      a { align-items: center; background: #0f766e; color: white; display: flex; font: 700 32px sans-serif; height: 100vh; justify-content: center; text-decoration: none; width: 100vw; }
    </style>
  </head>
  <body>
    <a id="pairing-link" href="${escapeHtml(browserHref)}" data-township-href="${escapeHtml(link)}">Pair Township</a>
  </body>
</html>`;
}

function androidIntentHrefForTownshipLink(link: string): string {
  assert.ok(link.startsWith("township://pairing"));
  const url = new URL(link);
  const canonicalHandoff = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  assert.equal(canonicalHandoff, link, "browser intent wrapper must preserve the canonical Township pairing handoff");
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=township;package=${appId};component=${appActivity};end`;
}

async function resolveBrowserPackage(serial: string): Promise<string> {
  const resolved = await runAdb(
    serial,
    [
      "shell",
      ...resolveActivityCommand,
      "--brief",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "http://127.0.0.1/",
    ],
    30_000,
  );
  const resolvedPackage = parseResolvedPackage(resolved);
  if (resolvedPackage && resolvedPackage !== appId && !(await isResolverActivity(serial, resolvedPackage))) {
    return resolvedPackage;
  }

  for (const candidate of [
    "com.android.chrome",
    "com.google.android.apps.chrome",
    "org.chromium.chrome",
    "com.chrome.beta",
    "com.android.browser",
    "org.lineageos.jelly",
  ]) {
    if (await packageExists(serial, candidate)) return candidate;
  }

  throw new Error(`expected an installed Android browser package; resolve-activity output:\n${resolved}`);
}

async function prepareBrowserPackageForSmoke(serial: string, browserPackage: string): Promise<void> {
  await runAdb(serial, ["shell", "am", "force-stop", browserPackage], 30_000).catch(() => undefined);
  if (browserPackage.includes("chrome")) {
    await runAdb(
      serial,
      [
        "shell",
        "sh",
        "-c",
        "echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line",
      ],
      10_000,
    ).catch(() => undefined);
  }

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
      "about:blank",
      "-p",
      browserPackage,
    ],
    30_000,
  ).catch(() => undefined);

  await tapFirstVisibleText(serial, ["Use without an account", "Accept & continue"]);
  await delay(3_000);
  await tapFirstVisibleText(serial, ["No thanks"]);
  await delay(1_000);

  await runAdb(serial, ["shell", "am", "force-stop", browserPackage], 30_000).catch(() => undefined);
}

async function tapFirstVisibleText(serial: string, labels: string[]): Promise<boolean> {
  const xml = await windowHierarchyXml(serial).catch(() => "");
  if (!xml) return false;
  for (const label of labels) {
    const bounds = boundsForVisibleText(xml, label);
    if (!bounds) continue;
    await runAdb(serial, ["shell", "input", "tap", String(bounds.x), String(bounds.y)], 10_000);
    return true;
  }
  return false;
}

async function windowHierarchyXml(serial: string): Promise<string> {
  await runAdb(serial, ["shell", "uiautomator", "dump", "/sdcard/township-window.xml"], 10_000);
  return runAdb(serial, ["shell", "cat", "/sdcard/township-window.xml"], 10_000);
}

function boundsForVisibleText(xml: string, label: string): { x: number; y: number } | null {
  const escaped = escapeRegExp(escapeXmlAttribute(label));
  const pattern = new RegExp(`<(?:node)\\b[^>]*text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const match = pattern.exec(xml);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
}

function parseResolvedPackage(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((value) => value.includes("/"));
  const packageName = line?.split("/")[0] ?? null;
  return packageName && !packageName.includes("ResolverActivity") ? packageName : null;
}

async function isResolverActivity(serial: string, packageName: string): Promise<boolean> {
  const output = await runAdb(serial, ["shell", "dumpsys", "package", packageName], 30_000).catch(() => "");
  return /ResolverActivity/.test(output);
}

async function packageExists(serial: string, packageName: string): Promise<boolean> {
  const output = await runAdb(serial, ["shell", "pm", "path", packageName], 30_000).catch(() => "");
  return output.trim().startsWith("package:");
}

async function openBrowserPairingPageAndTap(
  serial: string,
  browserPackage: string,
  pageServer: BrowserPairingPageServer,
  pageBaseUrl: string,
  path: "/no-state" | "/state",
): Promise<void> {
  const pageUrl = `${pageBaseUrl}${path}`;
  for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1) {
    await tapFirstVisibleText(serial, ["Close app"]);
    await runAdb(serial, ["shell", "am", "force-stop", browserPackage], 30_000).catch(() => undefined);
    const startOutput = await runAdb(
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
        pageUrl,
        "-p",
        browserPackage,
      ],
      30_000,
    );
    console.log(`  opened browser pairing page ${pageUrl} with ${browserPackage}${startOutput.trim() ? ` (${startOutput.trim()})` : ""}`);
    await pageServer.waitForPath(path);
    await delay(1_500);
    if (await tapFirstVisibleText(serial, ["Close app"])) {
      await delay(500);
      continue;
    }

    for (let tapAttempt = 0; tapAttempt < 3; tapAttempt += 1) {
      await tapFirstVisibleText(serial, ["Wait"]);
      await delay(300);
      if (await tapFirstVisibleText(serial, ["Close app"])) break;
      await tapBrowserPairingLink(serial);
      await delay(1_000);
      if (await tapFirstVisibleText(serial, ["Close app"])) break;
      const dismissedLateDialog = await tapFirstVisibleText(serial, ["Wait"]);
      if (!dismissedLateDialog) return;
      await delay(500);
    }
  }
  throw new Error(`browser pairing page ${path} could not be tapped without Chrome crash UI`);
}

async function browserPageBaseUrl(serial: string, pagePort: number): Promise<string> {
  if (serial.startsWith("emulator-")) {
    return `http://10.0.2.2:${pagePort}`;
  }
  await runAdb(serial, ["reverse", `tcp:${pagePort}`, `tcp:${pagePort}`], 30_000);
  return `http://127.0.0.1:${pagePort}`;
}

async function tapBrowserPairingLink(serial: string): Promise<void> {
  const { width, height } = await screenSize(serial);
  await runAdb(serial, ["shell", "input", "tap", String(Math.floor(width / 2)), String(Math.floor(height / 2))], 10_000);
}

async function screenSize(serial: string): Promise<{ width: number; height: number }> {
  const output = await runAdb(serial, ["shell", "wm", "size"], 10_000);
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(output);
  assert.ok(match?.[1] && match[2], `expected wm size output to include physical dimensions:\n${output}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:pairing-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release browser pairing smoke must not install the debug APK");
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
  const configuredTimeoutMs = Number(buildConfig.timeoutMs);
  const deadline = Date.now() + Math.max(90_000, configuredTimeoutMs + 30_000);
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
  assert.equal(savedLine, undefined, `no-state browser pairing link should not save peer config before armed delivery:\n${savedLine ?? output}`);
}

async function assertLogcatDoesNotContain(serial: string, value: string): Promise<void> {
  const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  assert.doesNotMatch(output, new RegExp(escapeRegExp(value)), "runtime pairing state must not be emitted to probe logs");
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function devicePublicKeyFromNativeKeyLine(line: string): string {
  const match = /public_key_b64url=([A-Za-z0-9_-]+)/.exec(line);
  assert.ok(match?.[1], `expected native key log line to include public_key_b64url:\n${line}`);
  return base64UrlToBase64(match[1]);
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
  assert.ok(match?.[1] ?? match?.[2], `release browser pairing build script must bake ${name}`);
  return match[1] ?? match[2] ?? "";
}

function optionalScriptEnv(script: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=(?:'([^']+)'|(\\S+))`).exec(script);
  return match?.[1] ?? match?.[2];
}

function base64UrlToBase64(value: string): string {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
