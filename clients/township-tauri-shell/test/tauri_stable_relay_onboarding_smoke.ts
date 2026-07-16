import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  exportTownshipCarrierPairingHandoff,
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  stableCarrierUrl,
  type StableCarrierServerProcess,
} from "./support/beam_peer";

interface StableRelayOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  expectedPost: CarrierOpFrame;
  afterPost: { opIds: string[] };
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

console.log("\n▸ Packaged Tauri onboarding through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged stable-relay onboarding smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const relaySeed = "township-g1:resident";
const relayIdentity = seededEd25519Identity(relaySeed);
const observerRealm = "instrument";
const observerSeed = "township-packaged-stable-relay-observer";
const observerIdentity = seededEd25519Identity(observerSeed);
const serverRealm = "town-node";
const serverSeed = "township-packaged-stable-relay-server";
const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-stable-relay-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
let server: StableCarrierServerProcess | null = null;
let app: ManagedProcess | null = null;

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
    [tempRoot],
    "FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as StableRelayOracle;
  assert.equal(oracle.relayRealm, "resident");
  assert.equal(oracle.relayPubkey, relayIdentity.publicKeyBase64);

  const port = await freeTcpPort();
  const spawnServer = () =>
    spawnStableCarrierServer({
      port,
      serverRealm,
      identitySeed: serverSeed,
      trustedPeerRealm: observerRealm,
      trustedPeerPubkey: observerIdentity.publicKeyBase64,
      relayRealm: oracle.relayRealm,
      relayPubkey: oracle.relayPubkey,
      sourcePath,
    });
  server = await spawnServer();

  const pairing: TownshipCarrierPeerConfig = {
    url: stableCarrierUrl(server.port),
    localRealm: oracle.relayRealm,
    expectedPeerRealm: server.realm,
    expectedPeerPubkey: server.publicKeyBase64,
    replica: oracle.replica,
    submission: "relay",
  };
  await buildDevTraceApp(exportTownshipCarrierPairingHandoff(pairing));
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  await quitTownshipApp();

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

  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine(`township-onboarding-drained:${oracle.expectedPost.id}`, 90_000);
  assertTraceCountAtLeast("lattice_sign_carrier", 3);
  assert.equal(app.child.exitCode, null, `packaged app exited; output chars: ${app.lines.join("").length}`);

  const values = readKvValues(kvPath);
  assert.deepEqual(JSON.parse(requiredValue(values, storageKey(TOWNSHIP_CARRIER_PAIRING_KEY))), pairing);
  assert.deepEqual(storedIds(values, TOWNSHIP_LOCAL_OP_LOG_KEY), [...oracle.afterPost.opIds].sort());
  const delegationFrames = storedFrames(values, TOWNSHIP_DELEGATION_FRAMES_KEY);
  assert.deepEqual(delegationFrames.map((frame) => frame.id).sort(), [...oracle.afterPost.opIds].sort());
  assert.deepEqual(
    delegationFrames.find((frame) => frame.id === oracle.expectedPost.id),
    oracle.expectedPost,
  );
  assert.deepEqual(storedFrames(values, TOWNSHIP_CARRIER_OUTBOX_KEY), []);

  const secretNeedles = [
    relaySeed,
    relayIdentity.privateSeedBase64,
    relayIdentity.privateSeedBytesJson,
    relayIdentity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, secretNeedles));
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles));

  await quitTownshipApp();
  await app.stop();
  app = null;
  await server.kill();
  server = await spawnServer();

  const verifyOutput = await runBeamSupport(
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
  assert.match(verifyOutput, /VERIFY_READY post/);
  await server.stop();
  server = null;
} finally {
  await quitTownshipApp();
  await app?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m\u2713 Packaged Tauri stable-relay onboarding smoke passed\x1b[0m");

async function buildDevTraceApp(pairingHandoff: string): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "0",
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF: pairingHandoff,
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT: "resident: posted while offline",
  });
}

function readKvValues(path: string): Map<string, string> {
  assert.ok(existsSync(path), `expected isolated native KV file at ${path}`);
  const values = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map(Object.entries(values));
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storedFrames(values: Map<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

function storedIds(values: Map<string, string>, key: string): string[] {
  const raw = requiredValue(values, storageKey(key));
  return (JSON.parse(raw) as { id: string }[]).map((entry) => entry.id).sort();
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
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
      PATH: `${join(process.env.HOME ?? "", ".asdf/shims")}:${process.env.PATH ?? ""}`,
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

async function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const process = spawnManaged(command, args, cwd, env);
  const code = await waitForExit(process.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${process.lines.join("")}`);
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "<empty>";
  return readFileSync(tracePath, "utf8").trim() || "<empty>";
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const traceLines = readTrace().split(/\r?\n/);
    if (traceLines.includes(line)) return;
    const onboardingFailure = traceLines.find((entry) => entry.startsWith("township-onboarding-failed:"));
    if (onboardingFailure) {
      throw new Error(
        [
          `packaged onboarding reported ${onboardingFailure}`,
          `native trace summary:\n${readTraceDiagnostics()}`,
          `native KV:\n${readKvDiagnostics()}`,
          `app output chars: ${app?.lines.join("").length ?? 0}`,
        ].join("\n\n"),
      );
    }
    if (app?.child.exitCode !== null) break;
    await delay(250);
  }
  throw new Error(
    [
      `timed out waiting for trace line ${line}`,
      `native trace summary:\n${readTraceDiagnostics()}`,
      `app output chars: ${app?.lines.join("").length ?? 0}`,
    ].join("\n\n"),
  );
}

function readTraceDiagnostics(): string {
  const counts = new Map<string, number>();
  for (const line of readTrace().split(/\r?\n/)) {
    const category =
      line.startsWith("lattice_") ||
      line.startsWith("township-onboarding-") ||
      line === "dev-trace-runtime-ready" ||
      line === "deep-link-listener-mounted" ||
      line === "township-native-hydration-settled"
        ? line
        : "other";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(counts));
}

function readKvDiagnostics(): string {
  if (!existsSync(kvPath)) return "<missing>";
  const values = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, string>;
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { valueChars: value.length }])),
  );
}

function assertTraceCountAtLeast(command: string, expected: number): void {
  const count = readTrace().split(/\r?\n/).filter((line) => line === command).length;
  assert.ok(count >= expected, `expected at least ${expected} ${command} traces, saw ${count}`);
}

async function quitTownshipApp(): Promise<void> {
  const process = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  const code = await Promise.race([waitForExit(process.child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    process.child.kill("SIGKILL");
    await waitForExit(process.child);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
