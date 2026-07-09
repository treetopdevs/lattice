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
import { TOWNSHIP_NATIVE_KEY_ID } from "../src/native_workflow";
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
await run("npm", ["run", "tauri:build"], shellRoot);
assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
assertAppBundleRegistersTownshipScheme(appBundlePath);

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
  await waitForTraceLine("deep-link-listener-mounted", 60_000);

  await run("open", ["-b", appIdentifier, "-u", deepLinkUrl], shellRoot);
  await waitForTracePrefix("deep-link:township://pairing", 30_000);
  await waitForTraceLine(`pairing-link-loaded:${peerFingerprint}`, 30_000);
  assert.doesNotMatch(readTrace(), /Pairing config saved|Sync outbox|connected to carrier/i);
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
  throw new Error(`timed out waiting for ${label} trace entry:\n${readTrace()}`);
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "";
  return readFileSync(tracePath, "utf8").trim();
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
