import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  spawnTownshipActionLiveProjection,
  stableCarrierUrl,
  type StableCarrierServerProcess,
  type TownshipActionLiveProjectionProcess,
} from "./support/beam_peer";
import {
  createPackagedActionHandoffHarness,
  delay,
  escapeRegex,
  mixBin,
  pinnedToolPath,
  seededEd25519Identity,
  sortedEntries,
  storageKey,
  type ManagedProcess,
} from "./support/packaged_action_handoff";

interface ClerkActionProjection {
  opIds: string[];
  readModel: { threads: { "clerk_locked?": boolean } };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface ClerkActionOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  base: ClerkActionProjection;
  expectedClose: CarrierOpFrame;
  afterClose: ClerkActionProjection;
  expectedReopen: CarrierOpFrame;
  afterReopen: ClerkActionProjection;
}

interface FeedDomTrace {
  phase: string | null;
  generation: string | null;
  opCount: string | null;
  matterOpCount: string | null;
  matterState: string | null;
}

interface StatusHandoff {
  url: string;
  id: string;
  command: "close_matter" | "reopen_matter";
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const clerkSeed = "township-g1:clerk";
const observerRealm = "instrument";
const observerSeed = "township-packaged-clerk-action-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-clerk-action-server";
const useControlUrl = "township://dev/action-status/use";
const signControlUrl = "township://dev/action-status/sign";
const syncControlUrl = "township://dev/carrier/sync";

console.log("\n▸ Packaged Tauri clerk close/reopen handoff through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged clerk action-handoff smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-clerk-action-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const clerkIdentity = seededEd25519Identity(clerkSeed);
const observerIdentity = seededEd25519Identity(observerSeed);
let server: StableCarrierServerProcess | null = null;
let liveServer: TownshipActionLiveProjectionProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let app: ManagedProcess | null = null;
const toolPath = pinnedToolPath(shellRoot);
const harness = createPackagedActionHandoffHarness({
  shellRoot,
  appBundlePath,
  appIdentifier,
  tracePath,
  kvPath,
  toolPath,
  diagnostics: () =>
    [
      `trace:\n${harness.readTrace() || "<empty>"}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
      `stable carrier output:\n${server?.output.join("") || "<empty>"}`,
      `LiveView output:\n${liveServer?.output.join("") || "<empty>"}`,
    ].join("\n\n"),
});
const {
  assertAppBundleRegistersTownshipScheme,
  assertLaunchServicesRoutesTownshipSchemeToBundle,
  deliverDeepLink,
  quitTownshipApp,
  readKvValues,
  readTrace,
  registerLaunchServicesHandler,
  run,
  spawnManaged,
  storedFrames,
  storedIds,
  traceLineCount,
  traceLines,
  waitFor,
  waitForAttribute,
  waitForStoredIds,
  waitForTraceLine,
  writeNativeKv,
} = harness;

try {
  await prepareBeamAndAssets();
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_clerk_action_fixture.exs",
    [tempRoot],
    "CLERK_FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as ClerkActionOracle;
  assert.equal(oracle.relayRealm, "clerk");
  assert.equal(oracle.relayPubkey, clerkIdentity.publicKeyBase64);
  assert.equal(oracle.base.readModel.threads["clerk_locked?"], false);
  assert.equal(oracle.afterClose.readModel.threads["clerk_locked?"], true);
  assert.equal(oracle.afterReopen.readModel.threads["clerk_locked?"], false);

  if (process.env.TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD !== "1") await buildDevTraceApp();
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assertAppBundleRegistersTownshipScheme();
  await registerLaunchServicesHandler();
  await assertLaunchServicesRoutesTownshipSchemeToBundle();
  await quitTownshipApp();

  const carrierPort = await freeTcpPort();
  const webPort = await freeTcpPort();
  server = await spawnStableCarrierServer({
    port: carrierPort,
    serverRealm,
    identitySeed: serverSeed,
    trustedPeerRealm: observerRealm,
    trustedPeerPubkey: observerIdentity.publicKeyBase64,
    relayRealm: oracle.relayRealm,
    relayPubkey: oracle.relayPubkey,
    sourcePath,
  });
  liveServer = await spawnTownshipActionLiveProjection({
    webPort,
    carrierPort,
    serverRealm,
    serverPubkey: server.publicKeyBase64,
    observerRealm,
    observerSeed,
    replica: oracle.replica,
  });

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${webPort}/township`, { waitUntil: "domcontentloaded" });
  await waitForAttribute(page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
  await waitForLiveViewState(page, oracle.base, "open");

  const pairing: TownshipCarrierPeerConfig = {
    url: stableCarrierUrl(carrierPort),
    localRealm: oracle.relayRealm,
    expectedPeerRealm: server.realm,
    expectedPeerPubkey: server.publicKeyBase64,
    replica: oracle.replica,
    keyId: TOWNSHIP_NATIVE_KEY_ID,
    submission: "relay",
  };
  writeNativeKv(new Map([[storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairing)]]));

  app = spawnManaged(
    "open",
    [
      "-n",
      "-W",
      "--env",
      `TOWNSHIP_DEV_TRACE_FILE=${tracePath}`,
      "--env",
      `TOWNSHIP_NATIVE_KV_FILE=${kvPath}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_ID=${TOWNSHIP_NATIVE_KEY_ID}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${clerkSeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceLine("deep-link-listener-mounted", 60_000);
  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine("township-native-hydration-settled", 60_000);
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.base.opIds, 60_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  await waitForAppProjection(oracle.base, "open", 30_000);

  const closeGeneration = await carrierFeedGeneration(page);
  const closeHandoff = await prepareStatusHandoff(page, oracle.replica, "close_matter");
  await driveStatusAction(closeHandoff, oracle.expectedClose, oracle.afterClose, oracle, "base");
  await waitForLiveViewPush(page, oracle.afterClose, "closed", closeGeneration);
  await waitForAppProjection(oracle.afterClose, "locked", 30_000);
  assert.match(await verifyStableRelay(server, oracle, "close"), /VERIFY_READY close/);

  const reopenGeneration = await carrierFeedGeneration(page);
  const reopenHandoff = await prepareStatusHandoff(page, oracle.replica, "reopen_matter");
  await driveStatusAction(reopenHandoff, oracle.expectedReopen, oracle.afterReopen, oracle, "close");
  await waitForLiveViewPush(page, oracle.afterReopen, "open", reopenGeneration);
  await waitForAppProjection(oracle.afterReopen, "open", 30_000);
  assert.match(await verifyStableRelay(server, oracle, "reopen"), /VERIFY_READY reopen/);

  const values = readKvValues();
  assert.ok(server);
  const serverPubkey = server.publicKeyBase64;
  assert.deepEqual(storedFrames(values, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  assert.deepEqual(storedIds(values, TOWNSHIP_LOCAL_OP_LOG_KEY), [...oracle.afterReopen.opIds].sort());
  assert.deepEqual(storedIds(values, TOWNSHIP_DELEGATION_FRAMES_KEY), [...oracle.afterReopen.opIds].sort());
  assert.equal(
    storedFrames(values, TOWNSHIP_DELEGATION_FRAMES_KEY).some(
      (frame) => frame.author === serverPubkey,
    ),
    false,
  );

  const secretNeedles = [
    clerkSeed,
    clerkIdentity.privateSeedBase64,
    clerkIdentity.privateSeedBytesJson,
    clerkIdentity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, secretNeedles));
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles));
  for (const secret of secretNeedles) {
    assert.doesNotMatch(liveServer.output.join(""), new RegExp(escapeRegex(secret)));
  }
} finally {
  await quitTownshipApp();
  await app?.stop();
  await browser?.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri clerk action-handoff smoke passed\x1b[0m");

async function driveStatusAction(
  handoff: StatusHandoff,
  expectedFrame: CarrierOpFrame,
  after: ClerkActionProjection,
  oracle: ClerkActionOracle,
  beforeMode: "base" | "close",
): Promise<void> {
  assert.ok(server);
  const kvBeforeIngress = sortedEntries(readKvValues());
  const signCountBeforeIngress = traceLineCount("lattice_sign_carrier");
  const syncCountBeforeIngress = traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const useAcceptedCountBeforeIngress = traceLineCount("action-status-dev-use:accepted");
  const signAcceptedCountBeforeIngress = traceLineCount("action-status-dev-sign:signed");
  const syncAcceptedCountBeforeIngress = traceLineCount("action-status-dev-sync:synced");
  const traceStart = traceLines().length;

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(`action-intent:staged:${handoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues()), kvBeforeIngress);
  assert.equal(traceLineCount("lattice_sign_carrier"), signCountBeforeIngress);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);
  assertNoIngressSideEffects(traceLines().slice(traceStart));
  assertTraceRedacted(handoff.url, handoff.command);

  await deliverDeepLink(useControlUrl);
  await waitFor(
    () => traceLineCount("action-status-dev-use:accepted") > useAcceptedCountBeforeIngress,
    `${handoff.command} Use accepted`,
    10_000,
  );
  assert.deepEqual(sortedEntries(readKvValues()), kvBeforeIngress);
  assert.equal(traceLineCount("lattice_sign_carrier"), signCountBeforeIngress);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);

  await deliverDeepLink(signControlUrl);
  await waitFor(
    () => traceLineCount("action-status-dev-sign:signed") > signAcceptedCountBeforeIngress,
    `${handoff.command} Sign completed`,
    20_000,
  );
  await waitForOutboxFrame(expectedFrame, 20_000);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);
  assert.ok(traceLineCount("lattice_sign_carrier") > signCountBeforeIngress);
  assert.match(await verifyStableRelay(server, oracle, beforeMode), /VERIFY_READY/);

  await deliverDeepLink(syncControlUrl);
  await waitFor(
    () => traceLineCount("action-status-dev-sync:synced") > syncAcceptedCountBeforeIngress,
    `${handoff.command} Sync completed`,
    30_000,
  );
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, after.opIds, 30_000);
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 0;
    } catch {
      return false;
    }
  }, `${handoff.command} outbox drained`, 30_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
}

async function prepareStatusHandoff(
  target: Page,
  replica: string,
  command: "close_matter" | "reopen_matter",
): Promise<StatusHandoff> {
  const label = command === "close_matter" ? "Prepare close in app" : "Prepare reopen in app";
  await target.getByRole("button", { name: label }).click();
  const url = await target.locator("#participant-status-handoff").getAttribute("href");
  assert.ok(url, `expected ${command} handoff`);
  const payload = decodeStatusIntent(url);
  assert.equal(payload.v, 2);
  assert.equal(payload.replica, replica);
  assert.deepEqual(payload.command, { command });
  assert.match(payload.id, /^[0-9a-f]{32}$/);
  return { url, id: payload.id, command };
}

function decodeStatusIntent(url: string): {
  v: 2;
  id: string;
  replica: string;
  command: { command: "close_matter" | "reopen_matter" };
} {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "township:");
  assert.equal(parsed.hostname, "action");
  assert.deepEqual([...parsed.searchParams.keys()], ["intent"]);
  const encoded = parsed.searchParams.get("intent");
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["v", "id", "replica", "command"]);
  assert.deepEqual(Object.keys(payload.command as Record<string, unknown>), ["command"]);
  return payload as unknown as {
    v: 2;
    id: string;
    replica: string;
    command: { command: "close_matter" | "reopen_matter" };
  };
}

async function waitForLiveViewPush(
  target: Page,
  expected: ClerkActionProjection,
  statusText: "open" | "closed",
  baselineGeneration: number,
): Promise<void> {
  await waitFor(async () => {
    const status = target.locator("#source-status[data-source='carrier']");
    const trigger = await status.getAttribute("data-refresh-trigger");
    const generationText = await status.getAttribute("data-feed-generation");
    if (trigger !== "server_push" || generationText === null) return false;
    const generation = Number(generationText);
    return Number.isSafeInteger(generation) && generation > baselineGeneration;
  }, `LiveView server-push generation after ${statusText}`, 20_000);
  await waitForLiveViewState(target, expected, statusText);
}

async function waitForLiveViewState(
  target: Page,
  expected: ClerkActionProjection,
  statusText: "open" | "closed",
): Promise<void> {
  await waitForAttribute(
    target,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(expected.opIds.length),
    20_000,
  );
  await waitFor(async () => (await target.locator("#threads-panel .status-mark").textContent())?.trim() === statusText,
    `LiveView ${statusText} status`, 20_000);
  await waitFor(async () => {
    const encoded = await target.locator("#causal-replay-island").getAttribute("data-replay");
    return encoded !== null && JSON.stringify(JSON.parse(encoded)) === JSON.stringify(expected.causalReplay);
  }, `LiveView ${statusText} replay`, 20_000);
}

async function waitForAppProjection(
  expected: ClerkActionProjection,
  matterState: "open" | "locked",
  timeoutMs: number,
): Promise<void> {
  await waitFor(() => {
    const trace = latestFeedDomTrace();
    return (
      trace?.phase === "fresh" &&
      trace.opCount === String(expected.opIds.length) &&
      trace.matterOpCount === String(expected.opIds.length) &&
      trace.matterState === matterState
    );
  }, `packaged app ${matterState} projection`, timeoutMs);
}

function latestFeedDomTrace(): FeedDomTrace | null {
  const line = traceLines().findLast((entry) => entry.startsWith(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX));
  if (!line) return null;
  return JSON.parse(line.slice(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX.length)) as FeedDomTrace;
}

async function waitForOutboxFrame(expected: CarrierOpFrame, timeoutMs: number): Promise<void> {
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 1;
    } catch {
      return false;
    }
  }, `pending outbox frame ${expected.id}`, timeoutMs);

  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), [expected]);
}

async function verifyStableRelay(
  stableServer: StableCarrierServerProcess,
  oracle: ClerkActionOracle,
  mode: "base" | "close" | "reopen",
): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_verify.exs",
    [
      String(stableServer.port),
      stableServer.realm,
      stableServer.publicKeyBase64,
      observerRealm,
      observerSeed,
      oracle.replica,
      oraclePath,
      mode,
    ],
    `VERIFY_READY ${mode}`,
  );
}

async function carrierFeedGeneration(target: Page): Promise<number> {
  const text = await target.locator("#source-status[data-source='carrier']").getAttribute("data-feed-generation");
  assert.ok(text);
  const generation = Number(text);
  assert.ok(Number.isSafeInteger(generation) && generation >= 0);
  return generation;
}

function assertNoIngressSideEffects(lines: string[]): void {
  assert.ok(lines.some((line) => /^action-intent:staged:[0-9a-f]{32}$/.test(line)));
  assert.ok(!lines.includes("lattice_sign_carrier"));
  assert.ok(!lines.includes("lattice_kv_set"));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED));
}

function assertTraceRedacted(url: string, command: string): void {
  const trace = readTrace();
  assert.doesNotMatch(trace, new RegExp(escapeRegex(url)));
  assert.doesNotMatch(trace, new RegExp(escapeRegex(command)));
}

async function prepareBeamAndAssets(): Promise<void> {
  await run(mixBin(), ["compile"], repoRoot, { MIX_ENV: "test", PATH: toolPath });
  await run(mixBin(), ["assets.build"], join(repoRoot, "apps", "township_web"), {
    MIX_ENV: "test",
    PATH: toolPath,
  });
}

async function buildDevTraceApp(): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1",
  });
}
