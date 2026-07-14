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

interface StableRelayOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  baseOpIds: string[];
  expectedPost: CarrierOpFrame;
  expectedRestartPost: CarrierOpFrame;
  afterPost: StableRelayProjection;
  afterRestartPost: StableRelayProjection;
}

interface StableRelayProjection {
  opIds: string[];
  readModel: { threads: { posts: string[] } };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface LiveViewHandoff {
  browser: Browser;
  page: Page;
  url: string;
  intentId: string;
  baselineFeedGeneration: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const postText = "resident: posted while offline";
const relaySeed = "township-g1:resident";
const observerRealm = "instrument";
const observerSeed = "township-packaged-action-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-action-server";
const submitControlUrl = "township://dev/action-intent/submit";

console.log("\n▸ Packaged Tauri LiveView action handoff through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged action-handoff smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-action-handoff-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const relayIdentity = seededEd25519Identity(relaySeed);
const observerIdentity = seededEd25519Identity(observerSeed);
let server: StableCarrierServerProcess | null = null;
let liveServer: TownshipActionLiveProjectionProcess | null = null;
let handoff: LiveViewHandoff | null = null;
let app: ManagedProcess | null = null;
const toolPath = pinnedToolPath(shellRoot);
const harness = createPackagedActionHandoffHarness({
  shellRoot,
  appBundlePath,
  appIdentifier,
  tracePath,
  kvPath,
  toolPath,
  diagnostics: async () =>
    [
      `source status:\n${await sourceStatusDiagnostics()}`,
      `trace:\n${harness.readTrace() || "<empty>"}`,
      `app exit: ${String(app?.child.exitCode)}`,
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
    "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
    [tempRoot],
    "FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as StableRelayOracle;
  assert.equal(oracle.relayRealm, "resident");
  assert.equal(oracle.relayPubkey, relayIdentity.publicKeyBase64);

  if (process.env.TOWNSHIP_SKIP_ACTION_APP_BUILD !== "1") await buildDevTraceApp();
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assertAppBundleRegistersTownshipScheme();
  await registerLaunchServicesHandler();
  await assertLaunchServicesRoutesTownshipSchemeToBundle();
  await quitTownshipApp();

  const carrierPort = await freeTcpPort();
  const webPort = await freeTcpPort();
  const spawnServer = () =>
    spawnStableCarrierServer({
      port: carrierPort,
      serverRealm,
      identitySeed: serverSeed,
      trustedPeerRealm: observerRealm,
      trustedPeerPubkey: observerIdentity.publicKeyBase64,
      relayRealm: oracle.relayRealm,
      relayPubkey: oracle.relayPubkey,
      sourcePath,
    });
  server = await spawnServer();
  liveServer = await spawnTownshipActionLiveProjection({
    webPort,
    carrierPort,
    serverRealm,
    serverPubkey: server.publicKeyBase64,
    observerRealm,
    observerSeed,
    replica: oracle.replica,
  });
  handoff = await prepareLiveViewHandoff(webPort, oracle.replica);

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
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${relaySeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceLine("deep-link-listener-mounted", 60_000);
  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED, 60_000);
  await waitForTraceLine("township-native-hydration-settled", 60_000);
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.baseOpIds, 60_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), []);

  const kvBeforeIngress = sortedEntries(readKvValues());
  const traceStart = traceLines().length;
  const signCountBeforeIngress = traceLineCount("lattice_sign_carrier");
  await deliverDeepLink(handoff.url);
  await waitForTraceLine(`action-intent:staged:${handoff.intentId}`, 30_000);
  await delay(750);

  assert.equal(app.child.exitCode, null, "packaged app must remain running after action ingress");
  assert.deepEqual(sortedEntries(readKvValues()), kvBeforeIngress, "action ingress must not mutate native KV");
  assert.equal(traceLineCount("lattice_sign_carrier"), signCountBeforeIngress, "action ingress must not sign");
  assertNoActionIngressSideEffects(traceLines().slice(traceStart));
  assertTraceRedacted(handoff.url, postText, oracle.replica);

  await deliverDeepLink(submitControlUrl);
  await waitForTraceLine("action-intent-dev-submit:synced", 60_000);
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.afterPost.opIds, 60_000);

  const convergedKv = readKvValues();
  assert.deepEqual(storedFrames(convergedKv, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  assert.deepEqual(
    storedFrames(convergedKv, TOWNSHIP_DELEGATION_FRAMES_KEY).find(
      (frame) => frame.id === oracle.expectedPost.id,
    ),
    oracle.expectedPost,
  );
  assert.ok(traceLineCount("lattice_sign_carrier") > signCountBeforeIngress);
  await waitForLiveViewConvergence(handoff.page, oracle.afterPost, handoff.baselineFeedGeneration);

  assert.match(await verifyStableRelay(server, oracle), /VERIFY_READY post/);
  await server.kill();
  server = null;
  await waitForAttribute(handoff.page, "#source-status[data-source='carrier']", "data-freshness", "stale", 20_000);
  server = await spawnServer();
  await waitForAttribute(handoff.page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
  assert.match(await verifyStableRelay(server, oracle), /VERIFY_READY post/);
  await waitForLiveViewRestartRecovery(handoff.page, oracle.afterPost, handoff.baselineFeedGeneration);

  const restartBaselineFeedGeneration = await carrierFeedGeneration(handoff.page);
  assert.match(await relayRestartPost(server, oracle), /RELAY_READY restart/);
  await waitForLiveViewConvergence(handoff.page, oracle.afterRestartPost, restartBaselineFeedGeneration);
  assert.match(await verifyStableRelay(server, oracle, "restart"), /VERIFY_READY restart/);

  const secretNeedles = [
    relaySeed,
    relayIdentity.privateSeedBase64,
    relayIdentity.privateSeedBytesJson,
    relayIdentity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(readKvValues(), secretNeedles));
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles));
  for (const secret of secretNeedles) {
    assert.doesNotMatch(liveServer.output.join(""), new RegExp(escapeRegex(secret)));
  }
  assertTraceRedacted(handoff.url, postText, oracle.replica);
  assert.doesNotMatch(liveServer.output.join(""), new RegExp(escapeRegex(handoff.url)));
  assert.doesNotMatch(liveServer.output.join(""), new RegExp(escapeRegex(postText)));
} finally {
  await quitTownshipApp();
  await app?.stop();
  await handoff?.browser.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri action-handoff smoke passed\x1b[0m");

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

async function prepareLiveViewHandoff(webPort: number, replica: string): Promise<LiveViewHandoff> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://localhost:${webPort}/township`, { waitUntil: "domcontentloaded" });
    await waitForAttribute(page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
    await waitForAttribute(
      page,
      "#source-status[data-source='carrier']",
      "data-refresh-trigger",
      "manual",
      20_000,
    );
    const baselineText = await page
      .locator("#source-status[data-source='carrier']")
      .getAttribute("data-feed-generation");
    assert.ok(baselineText, "expected the pre-relay carrier feed generation");
    const baselineFeedGeneration = Number(baselineText);
    assert.ok(
      Number.isSafeInteger(baselineFeedGeneration) && baselineFeedGeneration >= 0,
      `invalid pre-relay feed generation ${baselineText}`,
    );
    await page.getByRole("textbox", { name: "Resident update" }).fill(postText);
    await page.getByRole("button", { name: "Prepare in app" }).click();
    const url = await page.locator("#participant-post-handoff").getAttribute("href");
    assert.ok(url, "expected the real LiveView to render an action handoff");
    const intent = decodeActionIntent(url);
    assert.equal(intent.replica, replica);
    assert.deepEqual(intent.command, { command: "post", text: postText });
    assert.match(intent.id, /^[0-9a-f]{32}$/);
    return { browser, page, url, intentId: intent.id, baselineFeedGeneration };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function waitForLiveViewConvergence(
  page: Page,
  expected: StableRelayProjection,
  baselineFeedGeneration: number,
): Promise<void> {
  await waitFor(
    async () => {
      const status = page.locator("#source-status[data-source='carrier']");
      const trigger = await status.getAttribute("data-refresh-trigger");
      const generationText = await status.getAttribute("data-feed-generation");
      if (trigger !== "server_push" || generationText === null) return false;
      const generation = Number(generationText);
      return Number.isSafeInteger(generation) && generation > baselineFeedGeneration;
    },
    "server-push provenance beyond the pre-relay baseline",
    20_000,
  );

  await waitForLiveViewState(page, expected);
}

async function waitForLiveViewRestartRecovery(
  page: Page,
  expected: StableRelayProjection,
  baselineFeedGeneration: number,
): Promise<void> {
  await waitFor(
    async () => {
      const status = page.locator("#source-status[data-source='carrier']");
      const trigger = await status.getAttribute("data-refresh-trigger");
      const generationText = await status.getAttribute("data-feed-generation");
      if (trigger !== "poll" || generationText === null) return false;
      const generation = Number(generationText);
      return Number.isSafeInteger(generation) && generation > baselineFeedGeneration;
    },
    "verified reconnect recovery after the carrier restart",
    20_000,
  );

  await waitForLiveViewState(page, expected);
}

async function waitForLiveViewState(page: Page, expected: StableRelayProjection): Promise<void> {
  await waitForAttribute(
    page,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(expected.opIds.length),
    20_000,
  );
  await waitFor(
    async () =>
      JSON.stringify(await page.locator("#threads-panel [data-post] > span:last-child").allTextContents()) ===
      JSON.stringify(expected.readModel.threads.posts),
    "LiveView post state",
    20_000,
  );
  await waitFor(
    async () => {
      const encoded = await page.locator("#causal-replay-island").getAttribute("data-replay");
      return encoded !== null && JSON.stringify(JSON.parse(encoded)) === JSON.stringify(expected.causalReplay);
    },
    "Vue causal replay",
    20_000,
  );
}

async function carrierFeedGeneration(page: Page): Promise<number> {
  const generationText = await page
    .locator("#source-status[data-source='carrier']")
    .getAttribute("data-feed-generation");
  assert.ok(generationText, "expected a carrier feed generation");
  const generation = Number(generationText);
  assert.ok(Number.isSafeInteger(generation) && generation >= 0, `invalid carrier feed generation ${generationText}`);
  return generation;
}

async function relayRestartPost(server: StableCarrierServerProcess, oracle: StableRelayOracle): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_relay.exs",
    [
      String(server.port),
      server.realm,
      server.publicKeyBase64,
      oracle.relayRealm,
      relaySeed,
      oracle.replica,
      oraclePath,
      "restart",
    ],
    "RELAY_READY restart",
  );
}

async function verifyStableRelay(
  server: StableCarrierServerProcess,
  oracle: StableRelayOracle,
  mode = "post",
): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_verify.exs",
    [
      String(server.port),
      server.realm,
      server.publicKeyBase64,
      observerRealm,
      observerSeed,
      oracle.replica,
      oraclePath,
      mode,
    ],
    `VERIFY_READY ${mode}`,
  );
}

function decodeActionIntent(url: string): {
  id: string;
  replica: string;
  command: { command: "post"; text: string };
} {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "township:");
  assert.equal(parsed.hostname, "action");
  assert.deepEqual([...parsed.searchParams.keys()], ["intent"]);
  const encoded = parsed.searchParams.get("intent");
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["v", "id", "replica", "command"]);
  assert.equal(payload.v, 1);
  return payload as unknown as {
    id: string;
    replica: string;
    command: { command: "post"; text: string };
  };
}

function assertNoActionIngressSideEffects(lines: string[]): void {
  assert.ok(lines.some((line) => /^action-intent:staged:[0-9a-f]{32}$/.test(line)));
  assert.ok(!lines.includes("lattice_sign_carrier"));
  assert.ok(!lines.includes("lattice_kv_set"));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED));
  assert.ok(!lines.includes("pairing-config-save-submitted"));
  assert.ok(!lines.includes("carrier-health-started"));
}

function assertTraceRedacted(url: string, text: string, replica: string): void {
  const trace = readTrace();
  assert.doesNotMatch(trace, new RegExp(escapeRegex(url)));
  assert.doesNotMatch(trace, new RegExp(escapeRegex(text)));
  assert.doesNotMatch(trace, new RegExp(escapeRegex(replica)));
}

async function sourceStatusDiagnostics(): Promise<string> {
  if (!handoff) return "<handoff unavailable>";
  const status = handoff.page.locator("#source-status[data-source='carrier']");
  if ((await status.count()) === 0) return "<source status absent>";

  return JSON.stringify(
    {
      freshness: await status.getAttribute("data-freshness"),
      refreshTrigger: await status.getAttribute("data-refresh-trigger"),
      feedGeneration: await status.getAttribute("data-feed-generation"),
      html: await status.evaluate((element) => element.outerHTML),
    },
    null,
    2,
  );
}
