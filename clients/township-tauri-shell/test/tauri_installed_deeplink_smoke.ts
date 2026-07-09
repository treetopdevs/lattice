import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportTownshipCarrierPairingHandoff,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import {
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED,
  TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX,
  TOWNSHIP_TRACE_DEV_RUNTIME_READY,
  TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED,
  TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const tracePath = join(tmpdir(), `township-tauri-installed-deeplink-${process.pid}.log`);
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const smokeKeySeed = "township-installed-deeplink-smoke";
const config: TownshipCarrierPeerConfig = {
  url: "wss://carrier.example/township",
  localRealm: "resident-device-local",
  expectedPeerRealm: "township-carrier",
  expectedPeerPubkey: Buffer.from(new Uint8Array(32).fill(21)).toString("base64"),
  replica: TOWNSHIP_REPLICA,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
};
const handoff = exportTownshipCarrierPairingHandoff(config);
const peerFingerprint = townshipCarrierPeerFingerprint(config.expectedPeerPubkey);
const deepLinkUrl = `township://pairing?handoff=${encodeURIComponent(handoff)}`;

console.log("\n▸ Township installed-app deep-link smoke");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- installed-app deep-link smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

rmSync(tracePath, { force: true });
await run("npm", ["run", "tauri:build:dev-trace"], shellRoot);
assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
assertAppBundleRegistersTownshipScheme(appBundlePath);
await quitTownshipApp();

let app: ManagedProcess | null = null;
try {
  app = spawnManaged(
    "open",
    [
      "-n",
      "-W",
      "-j",
      "--env",
      `TOWNSHIP_DEV_TRACE_FILE=${tracePath}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_ID=${TOWNSHIP_NATIVE_KEY_ID}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${smokeKeySeed}`,
      appBundlePath,
    ],
    shellRoot,
  );
  try {
    await waitForTraceLine("deep-link-listener-mounted", 60_000);
    await waitForTraceLine(TOWNSHIP_TRACE_DEV_RUNTIME_READY, 60_000);
    await waitForTraceLine("lattice_ensure_carrier_key", 60_000);
  } catch (error) {
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `app exit code: ${String(app.child.exitCode)}`,
        `app output:\n${app.lines.join("")}`,
      ].join("\n\n"),
    );
  }

  await deliverDeepLink();
  await waitForTracePrefix("deep-link:township://pairing", 30_000);
  await waitForTraceLine("pairing-link-blocked:not-armed", 30_000);
  assert.doesNotMatch(readTrace(), new RegExp(`pairing-link-loaded:${peerFingerprint}`));

  await pressTownshipPairingImportShortcut();
  await waitForTraceLine(`${TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX}l`, 30_000);
  await waitForTraceLine("pairing-link-import-armed", 30_000);
  await deliverDeepLink();
  await waitForTraceLine(`pairing-link-loaded:${peerFingerprint}`, 30_000);
  await waitForTraceLine(TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED, 30_000);
  const loadedIndex = lastTraceLineIndex(`pairing-link-loaded:${peerFingerprint}`);
  const settledIndex = lastTraceLineIndex(TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED);
  assert.notEqual(loadedIndex, -1, "expected the loaded trace line to be present");
  assert.ok(settledIndex > loadedIndex, "expected the settled trace to follow the loaded trace");
  assertNoSideEffectTraceBetween(loadedIndex, settledIndex);
  assertAllowedDraftLoadTraceWindow(loadedIndex, settledIndex);

  const blockedBeforeThirdDelivery = traceLineCount("pairing-link-blocked:not-armed");
  await deliverDeepLink();
  await waitForTraceCount("pairing-link-blocked:not-armed", blockedBeforeThirdDelivery + 1, 30_000);
  const thirdBlockedIndex = lastTraceLineIndex("pairing-link-blocked:not-armed");
  assert.ok(
    thirdBlockedIndex > loadedIndex,
    "expected the post-consume blocked trace to appear after the loaded trace",
  );
  assertNoSideEffectTraceBetween(loadedIndex, thirdBlockedIndex);
  assertAllowedDraftLoadTraceWindow(loadedIndex, thirdBlockedIndex);

  await pressTownshipDevTraceShortcut("h");
  await waitForTraceLine(TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED, 30_000);
} finally {
  await quitTownshipApp();
  await app?.stop();
}

console.log("\x1b[32m✓ Township installed-app deep-link smoke passed\x1b[0m");

function assertAppBundleRegistersTownshipScheme(appPath: string): void {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  assert.ok(existsSync(infoPlist), `expected Info.plist at ${infoPlist}`);
  const plist = readFileSync(infoPlist, "utf8");

  assert.match(plist, /CFBundleIdentifier/);
  assert.match(plist, new RegExp(appIdentifier.replaceAll(".", "\\.")));
  assert.match(plist, /CFBundleURLSchemes/);
  assert.match(plist, /township/);
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
    env: {
      ...process.env,
      ...env,
    },
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

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const proc = spawnManaged(command, args, cwd);
  const code = await waitForExit(proc.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${proc.lines.join("")}`);
}

async function quitTownshipApp(): Promise<void> {
  const proc = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  await waitForExit(proc.child);
}

async function deliverDeepLink(): Promise<void> {
  await run("open", ["-a", appBundlePath, deepLinkUrl], shellRoot);
}

async function pressTownshipPairingImportShortcut(): Promise<void> {
  await pressTownshipDevTraceShortcut("l");
}

async function pressTownshipDevTraceShortcut(key: string): Promise<void> {
  await run("open", ["-a", appBundlePath], shellRoot);
  const script = `
tell application "System Events"
  tell process "Township"
    repeat until exists window 1
      delay 0.1
    end repeat
    set frontmost to true
    delay 0.2
    keystroke "${key}" using {command down, shift down}
  end tell
end tell
`;
  await run("osascript", ["-e", script], shellRoot);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGINT");
  const code = await Promise.race([waitForExit(child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout" && !child.killed && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  await waitForTrace((trace) => trace.split(/\r?\n/).includes(line), line, timeoutMs);
}

async function waitForTracePrefix(prefix: string, timeoutMs: number): Promise<void> {
  await waitForTrace((trace) => trace.split(/\r?\n/).some((line) => line.startsWith(prefix)), prefix, timeoutMs);
}

async function waitForTraceCount(line: string, count: number, timeoutMs: number): Promise<void> {
  await waitForTrace((trace) => trace.split(/\r?\n/).filter((entry) => entry === line).length >= count, line, timeoutMs);
}

async function waitForTrace(
  predicate: (trace: string) => boolean,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trace = readTrace();
    if (predicate(trace)) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label} trace entry:\n${readTrace()}`);
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

function lastTraceLineIndex(line: string): number {
  return traceLines().lastIndexOf(line);
}

function assertNoSideEffectTraceBetween(startLineIndex: number, endLineIndex: number): void {
  assert.ok(endLineIndex > startLineIndex, "expected a non-empty trace assertion window");
  const lines = traceLines().slice(startLineIndex + 1, endLineIndex + 1);
  assert.ok(!lines.includes(TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED));
  assert.ok(!lines.includes("lattice_kv_set"));
}

function assertAllowedDraftLoadTraceWindow(startLineIndex: number, endLineIndex: number): void {
  const allowedExact = new Set([
    TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED,
    "lattice_android_current_pairing_handoff_b64",
    "pairing-link-blocked:not-armed",
  ]);
  const unexpected = traceLines()
    .slice(startLineIndex + 1, endLineIndex + 1)
    .filter((line) => !allowedExact.has(line) && !line.startsWith("deep-link:township://pairing?"));

  assert.deepEqual(unexpected, []);
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
