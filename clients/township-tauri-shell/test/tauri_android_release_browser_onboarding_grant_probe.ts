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
import { TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX } from "../src/township_release_author_probe";
import { TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX } from "../src/township_release_onboarding_probe";
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

interface ReleaseOnboardingGrantProbeBuildConfig {
  port: number;
  localRealm: string;
  keyId: string;
  storageNamespace: string;
  armState: string;
  grantAudiencePubkey: string;
  postText: string;
  badSummaryText: string;
  pauseAfterAuthorMs: string;
}

interface BrowserPageObservation {
  path: string;
  observedAtMs: number;
}

interface BrowserDeliveryEvidence extends BrowserPageObservation {
  pageUrl: string;
  tapIssuedAtMs: number;
}

interface BrowserPairingPageServer {
  port: number;
  server: Server;
  waitForPath(path: string, afterMs: number): Promise<BrowserPageObservation>;
}

const releaseApkPath = defaultReleaseApkPath();
const buildConfig = releaseOnboardingGrantProbeConfigFromBuildScript();
const peerRealm = "clerk";
const expectedPeerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const expectedPeerFingerprint = townshipCarrierPeerFingerprint(expectedPeerPubkey);
const resolveActivityCommand = ["cmd", "package", "resolve-activity"];

console.log("\n▸ tauri:android:release:browser-onboarding-grant:smoke");
console.log("  Android release APK accepts browser-backed release onboarding child grant and drains outbox");

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
  await runReleaseBrowserOnboardingGrantProof(serial);
} finally {
  peer?.kill();
  if (serial) {
    await removeReverseMapping(serial, buildConfig.port).catch(() => undefined);
    await forceStopApp(serial).catch(() => undefined);
  }
  await cleanupAndroid(serial, spawnedEmulator);
}

console.log("\x1b[32m✓ Township Android release browser onboarding child grant smoke passed\x1b[0m");
process.exit(0);

async function runReleaseBrowserOnboardingGrantProof(serial: string): Promise<void> {
  await clearAppData(serial);
  await clearLogcat(serial);
  await forceStopApp(serial);

  const browserPackage = await resolveBrowserPackage(serial);
  console.log(`  resolved Android browser package ${browserPackage}`);
  await prepareBrowserPackageForSmoke(serial, browserPackage);
  await clearLogcat(serial);

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
  console.log(`  observed browser-onboarding-grant arm ${armingLine.trim()}`);

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

  const handoff = exportTownshipCarrierPairingHandoff(pairingPeerConfig());
  const stateLink = `township://pairing/${encodeURIComponent(handoff)}?state=${encodeURIComponent(buildConfig.armState)}`;
  const pageServer = await startBrowserPairingPageServer({ "/state": stateLink });
  const pageBaseUrl = await browserPageBaseUrl(serial, pageServer.port);

  let browserDelivery: BrowserDeliveryEvidence;
  try {
    await clearLogcat(serial);
    browserDelivery = await openBrowserPairingPageAndTap(serial, browserPackage, pageServer, pageBaseUrl, "/state");

    const pairingLine = await waitForPairingProbeLog(serial, "pairing", (line) => line.includes("outcome=saved"));
    assertBrowserPagePrecededPairingSave(browserDelivery, pairingLine);
    assert.match(pairingLine, /phase=pairing/);
    assert.match(pairingLine, /outcome=saved/);
    assert.match(pairingLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
    assert.match(pairingLine, /host_class=loopback/);
    assert.match(pairingLine, new RegExp(`url_port=${buildConfig.port}`));
    assert.doesNotMatch(pairingLine, forbiddenLogTerms());
    console.log(`  observed browser-delivered onboarding-grant pairing save ${pairingLine.trim()}`);
  } finally {
    await removeReverseMapping(serial, pageServer.port).catch(() => undefined);
    await closeServer(pageServer.server);
  }

  const pairingSyncLine = await waitForPairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(pairingSyncLine, /phase=sync/);
  assert.match(pairingSyncLine, /outcome=synced/);
  assert.notDeepEqual(fieldIds(pairingSyncLine, "local_op_ids"), []);
  assert.notDeepEqual(fieldIds(pairingSyncLine, "delegation_frame_ids"), []);
  assert.match(pairingSyncLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pairingSyncLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant pairing-derived sync ${pairingSyncLine.trim()}`);

  const pullLine = await waitForAuthorProbeLog(serial, "pull", (line) => line.includes("outcome=synced"));
  assert.match(pullLine, /phase=pull/);
  assert.match(pullLine, /outcome=synced/);
  assert.notDeepEqual(fieldIds(pullLine, "local_op_ids"), []);
  const pulledDelegationFrameIds = fieldIds(pullLine, "delegation_frame_ids");
  assert.notDeepEqual(pulledDelegationFrameIds, []);
  assert.match(pullLine, /outbox_frame_count=0/);
  const grantDelegationId = fieldValue(pullLine, "grant_delegation_id");
  assert.notEqual(grantDelegationId, "none");
  assert.doesNotMatch(pullLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant pull ${pullLine.trim()}`);

  const grantLine = await waitForAuthorProbeLog(serial, "grant", (line) => line.includes("outcome=authored"));
  assert.match(grantLine, /phase=grant/);
  assert.match(grantLine, /outcome=authored/);
  const appGrantFrameId = fieldValue(grantLine, "grant_frame_id");
  const appGrantDelegationId = fieldValue(grantLine, "grant_delegation_id");
  assert.notEqual(appGrantFrameId, "none");
  assert.notEqual(appGrantDelegationId, "none");
  assert.equal(base64UrlToBase64(fieldValue(grantLine, "grant_audience_b64url")), buildConfig.grantAudiencePubkey);
  assert.equal(fieldValue(grantLine, "grant_ops"), "post");
  assert.equal(fieldValue(grantLine, "parent_id"), grantDelegationId);
  assert.match(grantLine, /outbox_frame_count=1/);
  assert.ok(
    Number(fieldValue(grantLine, "delegation_frame_count")) >= pulledDelegationFrameIds.length + 1,
    "browser onboarding child grant should be retained with delegation evidence",
  );
  assert.doesNotMatch(grantLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant child grant ${grantLine.trim()}`);

  const authorLine = await waitForAuthorProbeLog(serial, "author", (line) => line.includes("outcome=authored"));
  assert.match(authorLine, /phase=author/);
  assert.match(authorLine, /outcome=authored/);
  const postFrameId = fieldValue(authorLine, "post_frame_id");
  const badFrameId = fieldValue(authorLine, "bad_frame_id");
  assert.notEqual(postFrameId, badFrameId);
  assert.equal(fieldValue(authorLine, "cap_id"), grantDelegationId);
  assert.match(authorLine, /outbox_frame_count=3/);
  assert.doesNotMatch(authorLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant author ${authorLine.trim()}`);

  await forceStopApp(serial);
  await waitForAppNotRunning(serial);
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
    fieldIds(pendingReloadLine, "local_op_ids").includes(appGrantFrameId),
    "pre-push relaunch should retain the app-originated grant op",
  );
  assert.ok(
    fieldIds(pendingReloadLine, "local_op_ids").includes(badFrameId),
    "pre-push relaunch should retain the rejected op",
  );
  assert.deepEqual(
    fieldIds(pendingReloadLine, "delegation_frame_ids").filter((id) => pulledDelegationFrameIds.includes(id)),
    pulledDelegationFrameIds,
    "pre-push relaunch should retain the pulled delegation frames",
  );
  assert.ok(
    fieldIds(pendingReloadLine, "delegation_frame_ids").includes(appGrantFrameId),
    "pre-push relaunch should retain the app-originated grant frame",
  );
  assert.match(pendingReloadLine, /outbox_frame_count=3/);
  assert.match(pendingReloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.doesNotMatch(pendingReloadLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant pending reload ${pendingReloadLine.trim()}`);

  const pushLine = await waitForAuthorProbeLog(serial, "push", (line) => line.includes("outcome=synced"));
  assert.match(pushLine, /phase=push/);
  assert.match(pushLine, /outcome=synced/);
  assert.deepEqual(fieldIds(pushLine, "pushed_frame_ids"), [appGrantFrameId, badFrameId, postFrameId].sort());
  assert.match(pushLine, /accepted_count=3/);
  assert.match(pushLine, /pending_count=0/);
  assert.match(pushLine, /outbox_frame_count=0/);
  assert.doesNotMatch(pushLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant push ${pushLine.trim()}`);

  const peerLine = await waitForAuthorProbeLog(serial, "peer", (line) => line.includes("outcome=reported"));
  assert.match(peerLine, /phase=peer/);
  assert.match(peerLine, /outcome=reported/);
  assert.equal(fieldValue(peerLine, "post_frame_id"), postFrameId);
  assert.equal(fieldValue(peerLine, "bad_frame_id"), badFrameId);
  assert.equal(fieldValue(peerLine, "grant_frame_id"), appGrantFrameId);
  assert.match(peerLine, /post_materialized=true/);
  assert.match(peerLine, /bad_authority_reason=operation_not_granted/);
  assert.match(peerLine, /grant_authority_accepted=true/);
  assert.match(peerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(peerLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant peer report ${peerLine.trim()}`);

  const completeLine = await waitForOnboardingProbeLog(serial, "complete", (line) => line.includes("outcome=reported"));
  assert.match(completeLine, /phase=complete/);
  assert.match(completeLine, /outcome=reported/);
  assert.match(completeLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.match(completeLine, /post_materialized=true/);
  assert.match(completeLine, /bad_authority_reason=operation_not_granted/);
  assert.doesNotMatch(completeLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant complete ${completeLine.trim()}`);

  await forceStopApp(serial);
  await waitForAppNotRunning(serial);
  await clearLogcat(serial);
  await assertReverseMapping(serial, buildConfig.port, peer.port);
  await launchApp(serial);

  const pairedReloadLine = await waitForPairingProbeLog(serial, "reload", (line) => line.includes("paired=true"));
  assert.match(pairedReloadLine, /paired=true/);
  assert.match(pairedReloadLine, /outbox_frame_count=0/);
  assert.match(pairedReloadLine, new RegExp(`peer_fingerprint=${escapeRegExp(expectedPeerFingerprint)}`));
  assert.doesNotMatch(pairedReloadLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant paired reload ${pairedReloadLine.trim()}`);

  const relaunchSyncLine = await waitForPairingProbeLog(serial, "sync", (line) => line.includes("outcome=synced"));
  assert.match(relaunchSyncLine, /phase=sync/);
  assert.match(relaunchSyncLine, /outcome=synced/);
  assert.ok(fieldIds(relaunchSyncLine, "local_op_ids").includes(postFrameId), "relaunch sync should retain the post op");
  assert.ok(
    fieldIds(relaunchSyncLine, "local_op_ids").includes(appGrantFrameId),
    "relaunch sync should retain the app-originated grant op",
  );
  assert.ok(fieldIds(relaunchSyncLine, "local_op_ids").includes(badFrameId), "relaunch sync should retain the rejected op");
  assert.match(relaunchSyncLine, /outbox_frame_count=0/);
  assert.doesNotMatch(relaunchSyncLine, forbiddenLogTerms());
  console.log(`  observed browser-onboarding-grant relaunch sync ${relaunchSyncLine.trim()}`);

  const finalPeerLine = await waitForAuthorProbeLog(
    serial,
    "peer",
    (line) =>
      line.includes("outcome=reported") &&
      fieldValue(line, "post_frame_id") === postFrameId &&
      fieldValue(line, "bad_frame_id") === badFrameId &&
      fieldValue(line, "grant_frame_id") === appGrantFrameId,
  );
  assert.match(finalPeerLine, /post_materialized=true/);
  assert.match(finalPeerLine, /bad_authority_reason=operation_not_granted/);
  assert.match(finalPeerLine, /grant_authority_accepted=true/);
  assert.match(finalPeerLine, /outbox_frame_count=0/);
  assert.doesNotMatch(finalPeerLine, forbiddenLogTerms());
  const finalLogcat = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  const reauthoredLinePattern = new RegExp(
    `${escapeRegExp(TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX)} phase=grant outcome=authored|${escapeRegExp(
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
    )} phase=author outcome=authored`,
  );
  assert.doesNotMatch(finalLogcat, reauthoredLinePattern);
  console.log(`  observed browser-onboarding-grant final peer report ${finalPeerLine.trim()}`);
}

function assertBrowserPagePrecededPairingSave(evidence: BrowserDeliveryEvidence, pairingLine: string): void {
  assert.equal(evidence.path, "/state");
  assert.match(evidence.pageUrl, /\/state$/);
  assert.ok(evidence.observedAtMs <= evidence.tapIssuedAtMs, "browser page request must be observed before the tap");
  assert.match(pairingLine, /phase=pairing/);
  assert.match(pairingLine, /outcome=saved/);
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

function releaseOnboardingGrantProbeConfigFromBuildScript(): ReleaseOnboardingGrantProbeBuildConfig {
  const packageJson = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const normalRelease = packageJson.scripts?.["tauri:android:build:release"] ?? "";
  const script = packageJson.scripts?.["tauri:android:build:release:onboarding-grant-probe"] ?? "";
  assert.doesNotMatch(normalRelease, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE/);
  assert.doesNotMatch(
    script,
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "browser onboarding child-grant probe must receive peer config from the browser-delivered pairing handoff",
  );
  const localRealm = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM");
  const keyId = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID");
  const storageNamespace = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE");
  const armState = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE");
  const grantAudiencePubkey = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY");
  const postText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT");
  const badSummaryText = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT");
  const pauseAfterAuthorMs = scriptEnv(script, "VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_PAUSE_AFTER_AUTHOR_MS");
  assert.equal(localRealm, "resident");
  assert.equal(keyId, "township-release-onboarding-grant-resident");
  assert.equal(storageNamespace, "township:release-onboarding-grant-probe");
  assert.equal(armState, "release-onboarding-grant-state-109");
  assert.equal(grantAudiencePubkey, "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=");
  assert.equal(postText, "release-onboarding-grant-post");
  assert.equal(badSummaryText, "release-onboarding-grant-unauthorized-summary");
  assert.equal(pauseAfterAuthorMs, "30000");
  return {
    port: 43195,
    localRealm,
    keyId,
    storageNamespace,
    armState,
    grantAudiencePubkey,
    postText,
    badSummaryText,
    pauseAfterAuthorMs,
  };
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
  const seenPaths = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    seenPaths.set(path, Date.now());
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
  assert.ok(address?.port, "browser onboarding page server should bind a TCP port");

  return {
    port: address.port,
    server,
    async waitForPath(path: string, afterMs: number): Promise<BrowserPageObservation> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const observedAtMs = seenPaths.get(path);
        if (observedAtMs !== undefined && observedAtMs >= afterMs) return { path, observedAtMs };
        await delay(250);
      }
      throw new Error(`timed out waiting for browser request to ${path}; saw ${Array.from(seenPaths.keys()).join(", ") || "none"}`);
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
  if (serial.startsWith("emulator-")) {
    await runAdb(serial, ["shell", "pm", "clear", browserPackage], 30_000).catch(() => undefined);
  }
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

async function openBrowserPairingPageAndTap(
  serial: string,
  browserPackage: string,
  pageServer: BrowserPairingPageServer,
  pageBaseUrl: string,
  path: "/state",
): Promise<BrowserDeliveryEvidence> {
  const pageUrl = `${pageBaseUrl}${path}`;
  for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1) {
    await tapFirstVisibleText(serial, ["Close app"]);
    await runAdb(serial, ["shell", "am", "force-stop", browserPackage], 30_000).catch(() => undefined);
    const startRequestedAtMs = Date.now();
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
    console.log(`  opened browser onboarding page ${pageUrl} with ${browserPackage}${startOutput.trim() ? ` (${startOutput.trim()})` : ""}`);
    await settleBrowserFirstRun(serial);
    let observed: BrowserPageObservation;
    try {
      observed = await pageServer.waitForPath(path, startRequestedAtMs);
    } catch (error) {
      await settleBrowserFirstRun(serial);
      if (pageAttempt < 2) continue;
      throw error;
    }
    await delay(1_500);
    if (await tapFirstVisibleText(serial, ["Close app"])) {
      await delay(500);
      continue;
    }

    for (let tapAttempt = 0; tapAttempt < 3; tapAttempt += 1) {
      await tapFirstVisibleText(serial, ["Wait"]);
      await delay(300);
      if (await tapFirstVisibleText(serial, ["Close app"])) break;
      const tapIssuedAtMs = Date.now();
      await tapBrowserPairingLink(serial);
      await delay(1_000);
      if (await tapFirstVisibleText(serial, ["Close app"])) break;
      const dismissedLateDialog = await tapFirstVisibleText(serial, ["Wait"]);
      if (!dismissedLateDialog) return { ...observed, pageUrl, tapIssuedAtMs };
      await delay(500);
    }
  }
  throw new Error(`browser onboarding page ${path} could not be tapped without Chrome crash UI`);
}

async function settleBrowserFirstRun(serial: string): Promise<void> {
  await tapFirstVisibleText(serial, ["Use without an account", "Accept & continue"]);
  await delay(1_000);
  await tapFirstVisibleText(serial, ["No thanks"]);
  await delay(500);
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

async function screenSize(serial: string): Promise<{ width: number; height: number }> {
  const output = await runAdb(serial, ["shell", "wm", "size"], 10_000);
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(output);
  assert.ok(match?.[1] && match[2], `expected wm size output to include physical dimensions:\n${output}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function installReleaseApk(serial: string, apkPath: string): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing release APK at ${apkPath}; run npm run tauri:android:build:release:onboarding-grant-probe before this smoke`,
  );
  assert.notEqual(apkPath, defaultDebugApkPath(), "release browser onboarding child-grant smoke must not install the debug APK");
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
  phase: "pull" | "grant" | "author" | "push" | "peer",
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

async function waitForAppNotRunning(serial: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastPid = "";
  while (Date.now() < deadline) {
    lastPid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim();
    if (!lastPid) return;
    await delay(250);
  }
  throw new Error(`expected ${appId} to be stopped before browser onboarding relaunch; pidof returned ${lastPid}`);
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
  assert.ok(match?.[1] ?? match?.[2], `release browser onboarding child-grant build script must bake ${name}`);
  return match[1] ?? match[2] ?? "";
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
