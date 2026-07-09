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
import { TOWNSHIP_NATIVE_KEY_ID, TOWNSHIP_TRACE_DEV_RUNTIME_READY } from "../src/native_workflow";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const tracePath = join(tmpdir(), `township-tauri-installed-cold-deeplink-${process.pid}.log`);
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appProcessPattern = "[T]ownship.app/Contents/MacOS/township-tauri-shell";
const appIdentifier = "dev.treetop.lattice.township";
const devTraceDefaultsKey = "TownshipDevTraceFile";
const launchServicesRegister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
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

console.log("\n▸ Township installed-app cold-start deep-link smoke");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- cold-start deep-link smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

rmSync(tracePath, { force: true });
await run("npm", ["run", "tauri:build:dev-trace"], shellRoot);
assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
assertAppBundleRegistersTownshipScheme(appBundlePath);
await registerLaunchServicesHandler();
await assertLaunchServicesRoutesTownshipSchemeToBundle();
await quitTownshipApp();
await waitForTownshipAppNotRunning();
await clearDevTraceDefaults();
await setDevTraceDefaults(tracePath);

try {
  await deliverDeepLink();
  await waitForTraceLine("deep-link-listener-mounted", 60_000);
  await waitForTraceLine(TOWNSHIP_TRACE_DEV_RUNTIME_READY, 60_000);
  await waitForTracePrefix("deep-link:township://pairing", 60_000);
  await waitForTraceLine("pairing-link-blocked:not-armed", 60_000);
  assert.doesNotMatch(readTrace(), new RegExp(`pairing-link-loaded:${peerFingerprint}`));
} finally {
  await clearDevTraceDefaults();
  await quitTownshipApp();
}

console.log("\x1b[32m✓ Township installed-app cold-start deep-link smoke passed\x1b[0m");

function assertAppBundleRegistersTownshipScheme(appPath: string): void {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  assert.ok(existsSync(infoPlist), `expected Info.plist at ${infoPlist}`);
  const plist = readFileSync(infoPlist, "utf8");

  assert.match(plist, /CFBundleIdentifier/);
  assert.match(plist, new RegExp(appIdentifier.replaceAll(".", "\\.")));
  assert.match(plist, /CFBundleURLSchemes/);
  assert.match(plist, /township/);
}

function spawnManaged(command: string, args: string[], cwd: string): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  return { child, lines };
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const proc = spawnManaged(command, args, cwd);
  const code = await waitForExit(proc.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${proc.lines.join("")}`);
}

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
  const proc = spawnManaged(command, args, cwd);
  const code = await waitForExit(proc.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${proc.lines.join("")}`);
  return proc.lines.join("");
}

async function quitTownshipApp(): Promise<void> {
  const proc = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  const code = await Promise.race([waitForExit(proc.child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    proc.child.kill("SIGKILL");
    await waitForExit(proc.child);
  }

  for (const pid of await townshipAppProcessIds()) {
    await run("kill", [String(pid)], shellRoot).catch(() => {});
  }
}

async function waitForTownshipAppNotRunning(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await townshipAppProcessIds()).length === 0) return;
    await delay(250);
  }
  throw new Error("timed out waiting for Township app process to exit");
}

async function townshipAppProcessIds(): Promise<number[]> {
  const proc = spawnManaged("pgrep", ["-f", appProcessPattern], shellRoot);
  const code = await waitForExit(proc.child);
  if (code !== 0) return [];
  return proc.lines
    .join("")
    .split(/\s+/)
    .map((entry) => Number(entry))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function deliverDeepLink(): Promise<void> {
  await run("open", [deepLinkUrl], shellRoot);
}

async function setDevTraceDefaults(path: string): Promise<void> {
  await run("defaults", ["write", appIdentifier, devTraceDefaultsKey, path], shellRoot);
}

async function clearDevTraceDefaults(): Promise<void> {
  const proc = spawnManaged("defaults", ["delete", appIdentifier, devTraceDefaultsKey], shellRoot);
  await waitForExit(proc.child);
}

async function registerLaunchServicesHandler(): Promise<void> {
  assert.ok(existsSync(launchServicesRegister), `expected lsregister at ${launchServicesRegister}`);
  await run(launchServicesRegister, ["-f", appBundlePath], shellRoot);
}

async function assertLaunchServicesRoutesTownshipSchemeToBundle(): Promise<void> {
  const resolvedPath = await resolvedLaunchServicesTownshipHandlerPath();
  assert.equal(
    normalizeAppPath(resolvedPath),
    normalizeAppPath(appBundlePath),
    [
      "expected LaunchServices to route township:// URLs to the freshly built app bundle",
      `resolved handler: ${resolvedPath}`,
      `expected handler: ${appBundlePath}`,
    ].join("\n"),
  );
}

async function resolvedLaunchServicesTownshipHandlerPath(): Promise<string> {
  const script = [
    "import AppKit",
    'if let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "township://pairing")!) {',
    "  print(url.path)",
    "}",
  ].join("\n");
  return (await runCapture("swift", ["-e", script], shellRoot)).trim();
}

function normalizeAppPath(path: string): string {
  return path.replace(/\/+$/, "");
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
  throw new Error(`timed out waiting for ${label} trace entry in ${tracePath}:\n${readTrace()}`);
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "";
  return readFileSync(tracePath, "utf8").trim();
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
