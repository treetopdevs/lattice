import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  TOWNSHIP_STORAGE_NAMESPACE,
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

interface FieldProjection {
  opIds: string[];
  readModel: { threads: { title: string; summary: string } };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface FieldActionOracle {
  replica: string;
  participantRealm: string;
  participantPubkey: string;
  peerRealm: string;
  peerPubkey: string;
  summaryText: string;
  peerSummaryText: string;
  titleText: string;
  base: FieldProjection;
  expectedSummary: CarrierOpFrame;
  expectedPeerSummary: CarrierOpFrame;
  afterPeer: FieldProjection;
  afterSummary: FieldProjection;
  expectedTitle: CarrierOpFrame;
  afterTitle: FieldProjection;
}

interface NativeIdentity {
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

interface FeedDomTrace {
  phase: string | null;
  generation: string | null;
  opCount: string | null;
  matterOpCount: string | null;
  titleDigest: string | null;
  summaryDigest: string | null;
}

interface FieldHandoff {
  url: string;
  id: string;
  command: "set_title" | "set_summary";
  text: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const launchServicesRegister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const participantSeed = "township-g1:resident";
const peerSeed = "township-g1:clerk";
const observerRealm = "instrument";
const observerSeed = "township-packaged-field-action-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-field-action-server";
const useControlUrl = "township://dev/action-field/use";
const signControlUrl = "township://dev/action-field/sign";
const syncControlUrl = "township://dev/carrier/sync";

console.log("\n▸ Packaged Tauri title/summary handoff through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged field action-handoff smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-field-action-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const participantIdentity = seededEd25519Identity(participantSeed);
const peerIdentity = seededEd25519Identity(peerSeed);
const observerIdentity = seededEd25519Identity(observerSeed);
let server: StableCarrierServerProcess | null = null;
let liveServer: TownshipActionLiveProjectionProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let app: ManagedProcess | null = null;

try {
  await prepareBeamAndAssets();
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_field_action_fixture.exs",
    [tempRoot],
    "FIELD_FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as FieldActionOracle;
  assert.equal(oracle.participantRealm, "resident");
  assert.equal(oracle.participantPubkey, participantIdentity.publicKeyBase64);
  assert.equal(oracle.peerRealm, "clerk");
  assert.equal(oracle.peerPubkey, peerIdentity.publicKeyBase64);
  assert.deepEqual(oracle.expectedSummary.deps, oracle.expectedPeerSummary.deps);
  assert.notEqual(oracle.expectedSummary.id, oracle.expectedPeerSummary.id);

  if (process.env.TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD !== "1") await buildDevTraceApp();
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assertAppBundleRegistersTownshipScheme(appBundlePath);
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
    relayPeers: [
      { realm: oracle.participantRealm, pubkey: oracle.participantPubkey },
      { realm: oracle.peerRealm, pubkey: oracle.peerPubkey },
    ],
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
  await waitForLiveViewProjection(page, oracle.base);

  const pairing: TownshipCarrierPeerConfig = {
    url: stableCarrierUrl(carrierPort),
    localRealm: oracle.participantRealm,
    expectedPeerRealm: server.realm,
    expectedPeerPubkey: server.publicKeyBase64,
    replica: oracle.replica,
    keyId: TOWNSHIP_NATIVE_KEY_ID,
    submission: "relay",
  };
  writeNativeKv(kvPath, new Map([[storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairing)]]));

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
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${participantSeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceLine("deep-link-listener-mounted", 60_000);
  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine("township-native-hydration-settled", 60_000);
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.base.opIds, 60_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  await waitForAppProjection(oracle.base, 30_000);

  const summaryHandoff = await prepareFieldHandoff(page, oracle.replica, "set_summary", oracle.summaryText);
  await driveFieldToPending(summaryHandoff, oracle.expectedSummary, oracle, "base");

  const peerGeneration = await carrierFeedGeneration(page);
  assert.match(await relayPeerSummary(server, oracle), /FIELD_PEER_RELAY_READY/);
  await waitForLiveViewPush(page, oracle.afterPeer, peerGeneration);
  assert.match(await verifyStableRelay(server, oracle, "peer"), /VERIFY_READY peer/);
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.afterSummary.opIds, 30_000);
  await waitForAppProjection(oracle.afterSummary, 30_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), [oracle.expectedSummary]);

  const summaryGeneration = await carrierFeedGeneration(page);
  await syncPendingField(summaryHandoff.command, oracle.expectedSummary, oracle.afterSummary);
  await waitForLiveViewPush(page, oracle.afterSummary, summaryGeneration);
  await waitForAppProjection(oracle.afterSummary, 30_000);
  assert.match(await verifyStableRelay(server, oracle, "summary"), /VERIFY_READY summary/);

  const titleHandoff = await prepareFieldHandoff(page, oracle.replica, "set_title", oracle.titleText);
  await driveFieldToPending(titleHandoff, oracle.expectedTitle, oracle, "summary");
  const titleGeneration = await carrierFeedGeneration(page);
  await syncPendingField(titleHandoff.command, oracle.expectedTitle, oracle.afterTitle);
  await waitForLiveViewPush(page, oracle.afterTitle, titleGeneration);
  await waitForAppProjection(oracle.afterTitle, 30_000);
  assert.match(await verifyStableRelay(server, oracle, "title"), /VERIFY_READY title/);

  const values = readKvValues();
  assert.deepEqual(storedFrames(values, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  assert.deepEqual(storedIds(values, TOWNSHIP_LOCAL_OP_LOG_KEY), [...oracle.afterTitle.opIds].sort());
  assert.deepEqual(storedIds(values, TOWNSHIP_DELEGATION_FRAMES_KEY), [...oracle.afterTitle.opIds].sort());
  assert.equal(
    storedFrames(values, TOWNSHIP_DELEGATION_FRAMES_KEY).some(
      (frame) => frame.author === server.publicKeyBase64,
    ),
    false,
  );

  const secretNeedles = [
    participantSeed,
    participantIdentity.privateSeedBase64,
    participantIdentity.privateSeedBytesJson,
    participantIdentity.privateSeedHex,
    peerSeed,
    peerIdentity.privateSeedBase64,
    peerIdentity.privateSeedBytesJson,
    peerIdentity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, secretNeedles));
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles));
  for (const secret of secretNeedles) {
    assert.doesNotMatch(liveServer.output.join(""), new RegExp(escapeRegex(secret)));
  }
  for (const text of [oracle.summaryText, oracle.peerSummaryText, oracle.titleText]) {
    assert.doesNotMatch(readTrace(), new RegExp(escapeRegex(text)));
  }
} finally {
  await quitTownshipApp();
  await app?.stop();
  await browser?.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri field action-handoff smoke passed\x1b[0m");

async function driveFieldToPending(
  handoff: FieldHandoff,
  expectedFrame: CarrierOpFrame,
  oracle: FieldActionOracle,
  beforeMode: "base" | "summary",
): Promise<void> {
  assert.ok(server);
  const kvBeforeIngress = sortedEntries(readKvValues());
  const signCountBeforeIngress = traceLineCount("lattice_sign_carrier");
  const syncCountBeforeIngress = traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const useCount = traceLineCount("action-field-dev-use:accepted");
  const signCount = traceLineCount("action-field-dev-sign:signed");
  const traceStart = traceLines().length;

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(`action-intent:staged:${handoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues()), kvBeforeIngress);
  assert.equal(traceLineCount("lattice_sign_carrier"), signCountBeforeIngress);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);
  assertNoIngressSideEffects(traceLines().slice(traceStart));
  assertTraceRedacted(handoff.url, handoff.text, handoff.command);

  await deliverDeepLink(useControlUrl);
  await waitFor(
    () => traceLineCount("action-field-dev-use:accepted") > useCount,
    `${handoff.command} Use accepted`,
    10_000,
  );
  assert.deepEqual(sortedEntries(readKvValues()), kvBeforeIngress);
  assert.equal(traceLineCount("lattice_sign_carrier"), signCountBeforeIngress);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);

  await deliverDeepLink(signControlUrl);
  await waitFor(
    () => traceLineCount("action-field-dev-sign:signed") > signCount,
    `${handoff.command} Sign completed`,
    20_000,
  );
  await waitForOutboxFrame(expectedFrame, 20_000);
  assert.equal(traceLineCount(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeIngress);
  assert.ok(traceLineCount("lattice_sign_carrier") > signCountBeforeIngress);
  assert.match(await verifyStableRelay(server, oracle, beforeMode), /VERIFY_READY/);
}

async function syncPendingField(
  command: FieldHandoff["command"],
  expectedFrame: CarrierOpFrame,
  after: FieldProjection,
): Promise<void> {
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), [expectedFrame]);
  const syncCount = traceLineCount("action-field-dev-sync:synced");
  await deliverDeepLink(syncControlUrl);
  await waitFor(
    () => traceLineCount("action-field-dev-sync:synced") > syncCount,
    `${command} Sync completed`,
    30_000,
  );
  await waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, after.opIds, 30_000);
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 0;
    } catch {
      return false;
    }
  }, `${command} outbox drained`, 30_000);
  assert.deepEqual(storedFrames(readKvValues(), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
}

async function prepareFieldHandoff(
  target: Page,
  replica: string,
  command: FieldHandoff["command"],
  text: string,
): Promise<FieldHandoff> {
  const prefix = command === "set_summary" ? "summary" : "title";
  await target.locator(`#participant-${prefix}-form textarea`).fill(text);
  await target.locator(`#participant-${prefix}-form button[type='submit']`).click();
  const url = await target.locator(`#participant-${prefix}-handoff`).getAttribute("href");
  assert.ok(url, `expected ${command} handoff`);
  const payload = decodeFieldIntent(url);
  assert.equal(payload.v, 3);
  assert.equal(payload.replica, replica);
  assert.deepEqual(payload.command, { command, text });
  assert.match(payload.id, /^[0-9a-f]{32}$/);
  return { url, id: payload.id, command, text };
}

function decodeFieldIntent(url: string): {
  v: 3;
  id: string;
  replica: string;
  command: { command: FieldHandoff["command"]; text: string };
} {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "township:");
  assert.equal(parsed.hostname, "action");
  assert.deepEqual([...parsed.searchParams.keys()], ["intent"]);
  const encoded = parsed.searchParams.get("intent");
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["v", "id", "replica", "command"]);
  assert.deepEqual(Object.keys(payload.command as Record<string, unknown>), ["command", "text"]);
  return payload as unknown as {
    v: 3;
    id: string;
    replica: string;
    command: { command: FieldHandoff["command"]; text: string };
  };
}

async function relayPeerSummary(
  stableServer: StableCarrierServerProcess,
  oracle: FieldActionOracle,
): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_field_action_peer_relay.exs",
    [
      String(stableServer.port),
      stableServer.realm,
      stableServer.publicKeyBase64,
      oracle.peerRealm,
      peerSeed,
      oracle.replica,
      oraclePath,
    ],
    "FIELD_PEER_RELAY_READY",
  );
}

async function verifyStableRelay(
  stableServer: StableCarrierServerProcess,
  oracle: FieldActionOracle,
  mode: "base" | "peer" | "summary" | "title",
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

async function waitForLiveViewPush(
  target: Page,
  expected: FieldProjection,
  baselineGeneration: number,
): Promise<void> {
  await waitFor(async () => {
    const status = target.locator("#source-status[data-source='carrier']");
    const trigger = await status.getAttribute("data-refresh-trigger");
    const generationText = await status.getAttribute("data-feed-generation");
    if (trigger !== "server_push" || generationText === null) return false;
    const generation = Number(generationText);
    return Number.isSafeInteger(generation) && generation > baselineGeneration;
  }, "LiveView field server-push generation", 20_000);
  await waitForLiveViewProjection(target, expected);
}

async function waitForLiveViewProjection(target: Page, expected: FieldProjection): Promise<void> {
  await waitForAttribute(
    target,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(expected.opIds.length),
    20_000,
  );
  await waitFor(
    async () =>
      (await target.locator("#threads-panel .panel-header h2").textContent())?.trim() ===
      expected.readModel.threads.title,
    "LiveView title",
    20_000,
  );
  await waitFor(
    async () =>
      (await target.locator("#threads-panel .summary-field p").textContent())?.trim() ===
      expected.readModel.threads.summary,
    "LiveView summary",
    20_000,
  );
  await waitFor(async () => {
    const encoded = await target.locator("#causal-replay-island").getAttribute("data-replay");
    return encoded !== null && JSON.stringify(JSON.parse(encoded)) === JSON.stringify(expected.causalReplay);
  }, "LiveView field replay", 20_000);
}

async function waitForAppProjection(expected: FieldProjection, timeoutMs: number): Promise<void> {
  const expectedTitleDigest = digestText(expected.readModel.threads.title);
  const expectedSummaryDigest = digestText(expected.readModel.threads.summary);
  await waitFor(() => {
    const trace = latestFeedDomTrace();
    return (
      trace?.phase === "fresh" &&
      trace.opCount === String(expected.opIds.length) &&
      trace.matterOpCount === String(expected.opIds.length) &&
      trace.titleDigest === expectedTitleDigest &&
      trace.summaryDigest === expectedSummaryDigest
    );
  }, "packaged app field projection", timeoutMs);
}

function latestFeedDomTrace(): FeedDomTrace | null {
  const line = traceLines().findLast((entry) => entry.startsWith(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX));
  if (!line) return null;
  return JSON.parse(line.slice(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX.length)) as FeedDomTrace;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function assertTraceRedacted(url: string, text: string, command: string): void {
  const trace = readTrace();
  assert.doesNotMatch(trace, new RegExp(escapeRegex(url)));
  assert.doesNotMatch(trace, new RegExp(escapeRegex(text)));
  assert.doesNotMatch(trace, new RegExp(escapeRegex(command)));
}

async function prepareBeamAndAssets(): Promise<void> {
  await run(mixBin(), ["compile"], repoRoot, { MIX_ENV: "test", PATH: pinnedToolPath() });
  await run(mixBin(), ["assets.build"], join(repoRoot, "apps", "township_web"), {
    MIX_ENV: "test",
    PATH: pinnedToolPath(),
  });
}

async function buildDevTraceApp(): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1",
  });
}

function writeNativeKv(path: string, values: Map<string, string>): void {
  writeFileSync(path, JSON.stringify(Object.fromEntries(values), null, 2), "utf8");
}

function readKvValues(): Map<string, string> {
  assert.ok(existsSync(kvPath), `expected isolated native KV file at ${kvPath}`);
  return new Map(Object.entries(JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, string>));
}

function storedFrames(values: Map<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

function storedIds(values: Map<string, string>, key: string): string[] {
  return (JSON.parse(requiredValue(values, storageKey(key))) as { id: string }[])
    .map((entry) => entry.id)
    .sort();
}

async function waitForStoredIds(key: string, expected: string[], timeoutMs: number): Promise<void> {
  const sortedExpected = [...expected].sort();
  await waitFor(() => {
    try {
      return JSON.stringify(storedIds(readKvValues(), key)) === JSON.stringify(sortedExpected);
    } catch {
      return false;
    }
  }, `${key} ids`, timeoutMs);
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function sortedEntries(values: Map<string, string>): [string, string][] {
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function assertAppBundleRegistersTownshipScheme(appPath: string): void {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  assert.ok(existsSync(infoPlist), `expected Info.plist at ${infoPlist}`);
  const plist = readFileSync(infoPlist, "utf8");
  assert.match(plist, /CFBundleIdentifier/);
  assert.match(plist, new RegExp(appIdentifier.replaceAll(".", "\\.")));
  assert.match(plist, /CFBundleURLSchemes/);
  assert.match(plist, /township/);
}

async function registerLaunchServicesHandler(): Promise<void> {
  assert.ok(existsSync(launchServicesRegister));
  await run(launchServicesRegister, ["-f", appBundlePath], shellRoot);
}

async function assertLaunchServicesRoutesTownshipSchemeToBundle(): Promise<void> {
  const script = [
    "import AppKit",
    'if let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "township://action")!) {',
    "  print(url.path)",
    "}",
  ].join("\n");
  const resolvedPath = (await runCapture("swift", ["-e", script], shellRoot)).trim().replace(/\/+$/, "");
  assert.equal(resolvedPath, appBundlePath.replace(/\/+$/, ""));
}

async function deliverDeepLink(url: string): Promise<void> {
  await run("open", [url], shellRoot);
}

function spawnManaged(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedToolPath(), ...env },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  return {
    child,
    lines,
    async stop() {
      await stopProcess(child);
    },
  };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const process = spawnManaged(command, args, cwd, env);
  const code = await waitForExit(process.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${process.lines.join("")}`);
}

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
  const process = spawnManaged(command, args, cwd);
  const code = await waitForExit(process.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${process.lines.join("")}`);
  return process.lines.join("");
}

async function quitTownshipApp(): Promise<void> {
  const process = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  if (!(await exitsWithin(process.child, 2_000))) process.child.kill("SIGKILL");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await exitsWithin(child, 2_000)) && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitsWithin(child, 2_000);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

async function exitsWithin(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  await waitFor(() => traceLines().includes(line), `trace ${line}`, timeoutMs);
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "";
  return readFileSync(tracePath, "utf8").trim();
}

function traceLines(): string[] {
  return readTrace().split(/\r?\n/).filter(Boolean);
}

function traceLineCount(line: string): number {
  return traceLines().filter((entry) => entry === line).length;
}

async function waitForAttribute(
  target: Page,
  selector: string,
  name: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => (await target.locator(selector).getAttribute(name)) === expected,
    `${selector} ${name}`,
    timeoutMs,
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(
    [
      `timed out waiting for ${label}`,
      `trace:\n${readTrace() || "<empty>"}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
      `stable carrier output:\n${server?.output.join("") || "<empty>"}`,
      `LiveView output:\n${liveServer?.output.join("") || "<empty>"}`,
    ].join("\n\n"),
  );
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(publicKeyDer).subarray(12);
  return {
    publicKeyBase64: publicKey.toString("base64"),
    privateSeedBase64: privateSeed.toString("base64"),
    privateSeedBytesJson: JSON.stringify([...privateSeed]),
    privateSeedHex: privateSeed.toString("hex"),
  };
}

function mixBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf", "shims", "mix");
  return existsSync(asdf) ? asdf : "mix";
}

function pinnedToolPath(): string {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".asdf", "installs", "erlang", "28.3.1", "bin"),
    join(home, ".asdf", "installs", "erlang", "28.3.1", "erts-16.2", "bin"),
    join(home, ".asdf", "installs", "elixir", "1.19.5-otp-28", "bin"),
    "/opt/homebrew/opt/rustup/bin",
    join(shellRoot, "node_modules", ".bin"),
    process.env.PATH ?? "",
  ]
    .filter((path) => path.length > 0 && (path === process.env.PATH || existsSync(path)))
    .join(":");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
