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

interface StableRelayOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  baseOpIds: string[];
  expectedPost: CarrierOpFrame;
  afterPost: {
    opIds: string[];
    readModel: { threads: { posts: string[] } };
    causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
  };
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

interface LiveViewHandoff {
  browser: Browser;
  page: Page;
  url: string;
  intentId: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const launchServicesRegister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
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
  assertAppBundleRegistersTownshipScheme(appBundlePath);
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
  await waitForLiveViewConvergence(handoff.page, oracle);

  assert.match(await verifyStableRelay(server, oracle), /VERIFY_READY post/);
  await server.kill();
  server = null;
  await waitForAttribute(handoff.page, "#source-status[data-source='carrier']", "data-freshness", "stale", 20_000);
  server = await spawnServer();
  await waitForAttribute(handoff.page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
  assert.match(await verifyStableRelay(server, oracle), /VERIFY_READY post/);
  await waitForLiveViewConvergence(handoff.page, oracle);

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

async function prepareLiveViewHandoff(webPort: number, replica: string): Promise<LiveViewHandoff> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://localhost:${webPort}/township`, { waitUntil: "domcontentloaded" });
    await waitForAttribute(page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
    await page.getByRole("textbox", { name: "Resident update" }).fill(postText);
    await page.getByRole("button", { name: "Prepare in app" }).click();
    const url = await page.locator("#participant-post-handoff").getAttribute("href");
    assert.ok(url, "expected the real LiveView to render an action handoff");
    const intent = decodeActionIntent(url);
    assert.equal(intent.replica, replica);
    assert.deepEqual(intent.command, { command: "post", text: postText });
    assert.match(intent.id, /^[0-9a-f]{32}$/);
    return { browser, page, url, intentId: intent.id };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function waitForLiveViewConvergence(page: Page, oracle: StableRelayOracle): Promise<void> {
  await waitForAttribute(
    page,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(oracle.afterPost.opIds.length),
    20_000,
  );
  await waitFor(
    async () =>
      JSON.stringify(await page.locator("#threads-panel [data-post] > span:last-child").allTextContents()) ===
      JSON.stringify(oracle.afterPost.readModel.threads.posts),
    "LiveView post state",
    20_000,
  );
  await waitFor(
    async () => {
      const encoded = await page.locator("#causal-replay-island").getAttribute("data-replay");
      return encoded !== null && JSON.stringify(JSON.parse(encoded)) === JSON.stringify(oracle.afterPost.causalReplay);
    },
    "Vue causal replay",
    20_000,
  );
}

async function verifyStableRelay(server: StableCarrierServerProcess, oracle: StableRelayOracle): Promise<string> {
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
      "post",
    ],
    "VERIFY_READY post",
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
  assert.ok(existsSync(launchServicesRegister), `expected lsregister at ${launchServicesRegister}`);
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
  page: Page,
  selector: string,
  name: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(async () => (await page.locator(selector).getAttribute(name)) === expected, `${selector} ${name}`, timeoutMs);
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
      `app exit: ${String(app?.child.exitCode)}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
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
