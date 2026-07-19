import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
  type ReplicaSchema,
} from "@treetopdevs/lattice-client";

interface CarrierVector {
  scenario: string;
  replica: string;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  schema: ReplicaSchema;
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const vector = JSON.parse(
  readFileSync(join(shellRoot, "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;

const smokeKeyId = "township-resident";
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";

console.log(`\n▸ ${vector.scenario} Tauri live window peer smoke`);

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Tauri live window peer smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-launch-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");

const identity = seededEd25519Identity(vector.client.sessionSeed);
assert.equal(identity.publicKeyBase64, vector.client.sessionPubkey);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

const peer = await spawnTownshipPeer(vector);
let app: ManagedProcess | null = null;

try {
  rmSync(tracePath, { force: true });
  await buildDevTraceApp(peer.port);
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
      `TOWNSHIP_DEV_CARRIER_KEY_ID=${smokeKeyId}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${vector.client.sessionSeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceCount("dev-trace-runtime-ready", 1, 60_000, () => launchDiagnostics(app, peer.output));
  await waitForTraceCount("township-native-hydration-settled", 1, 60_000, () => launchDiagnostics(app, peer.output));
  await waitForTraceCount("lattice_kv_set", 2, 60_000, () => launchDiagnostics(app, peer.output));
  await waitForTraceCount("lattice_ensure_carrier_key", 3, 60_000, () => launchDiagnostics(app, peer.output));
  await delay(500);
  assert.equal(app.child.exitCode, null, app.lines.join(""));

  try {
    const diverged = await reconnectWhenDiverged(peer.port, vector, identity, verifier);
    diverged.close();
  } catch (error) {
    throw new Error(
      [
        "expected launched Tauri app auto-sync to close a carrier session before the smoke probe",
        error instanceof Error ? error.message : String(error),
        `native command trace:\n${readTrace()}`,
        `app output:\n${app.lines.join("")}`,
      ].join("\n\n"),
    );
  }

  const shutdown = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  await shutdown.shutdown();
  await peer.awaitExit();
} finally {
  peer.kill();
  await quitTownshipApp();
  await app?.stop();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Township Tauri live window peer smoke passed\x1b[0m");

async function buildDevTraceApp(peerPort: number): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_CARRIER_URL: peerUrl(peerPort),
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
    VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
    VITE_TOWNSHIP_CARRIER_KEY_ID: smokeKeyId,
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1",
  });
}

async function reconnectWhenDiverged(
  port: number,
  vector: CarrierVector,
  identity: NativeIdentity,
  verifier: CarrierVerifier,
): ReturnType<typeof connectCarrierWebSocket> {
  for (let i = 0; i < 50; i++) {
    const conn = await connectCarrierWebSocket({
      url: peerUrl(port),
      localRealm: vector.client.realm,
      replica: vector.replica,
      signer: identity,
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
      verifier,
    });

    if ((await conn.status()) === "diverged") return conn;
    conn.close();
    await delay(20);
  }

  throw new Error("peer never diverged after socket close");
}

async function spawnTownshipPeer(vector: CarrierVector) {
  const child = spawn(elixirBin(), [
    ...codePathArgs(),
    "apps/lattice_node_spike/priv/peer_node.exs",
    vector.peer.realm,
    vector.client.realm,
    vector.client.sessionPubkey,
    "LatticeNodeSpike.TownshipScenario",
  ], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${join(process.env.HOME ?? "", ".asdf/shims")}:${process.env.PATH ?? ""}`,
    },
  });

  const lines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const port = await awaitReady(child, lines);

  return {
    port,
    output: lines,
    awaitExit: () => awaitExit(child, lines),
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    },
  };
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
  const proc = spawnManaged(command, args, cwd, env);
  const code = await waitForExit(proc.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${proc.lines.join("")}`);
}

function awaitReady(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<number> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`peer OS process never became ready:\n${lines.join("")}`)), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        lines.push(`${line}\n`);
        if (line.startsWith("PEER_READY ")) {
          clearTimeout(timeout);
          resolveReady(Number.parseInt(line.slice("PEER_READY ".length), 10));
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`peer OS process exited (${code}) before READY:\n${lines.join("")}`));
    });
  });
}

function awaitExit(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error(`peer OS process did not exit:\n${lines.join("")}`)), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else rejectExit(new Error(`peer OS process exited with ${code}:\n${lines.join("")}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
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

function codePathArgs(): string[] {
  const libRoot = join(repoRoot, "_build/test/lib");
  if (!existsSync(libRoot)) throw new Error(`missing BEAM test build at ${libRoot}; run mix test first`);

  return readdirSync(libRoot)
    .map((app) => join(libRoot, app, "ebin"))
    .filter(existsSync)
    .flatMap((path) => ["-pa", path]);
}

function elixirBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
  if (existsSync(asdf)) return asdf;
  return "elixir";
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "<empty>";
  return readFileSync(tracePath, "utf8").trim() || "<empty>";
}

async function waitForTraceCount(
  command: string,
  count: number,
  timeoutMs: number,
  diagnostics: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = readTrace()
      .split(/\r?\n/)
      .filter((line) => line === command).length;
    if (seen >= count) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${count} ${command} trace entries:\n${readTrace()}\n\n${diagnostics()}`);
}

function launchDiagnostics(app: ManagedProcess | null, peerOutput: string[]): string {
  return [
    `app exitCode: ${String(app?.child.exitCode ?? null)}`,
    `app output:\n${app?.lines.join("") || "<empty>"}`,
    `peer output:\n${peerOutput.join("") || "<empty>"}`,
  ].join("\n\n");
}

async function quitTownshipApp(): Promise<void> {
  const proc = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  const code = await Promise.race([waitForExit(proc.child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    proc.child.kill("SIGKILL");
    await waitForExit(proc.child);
  }
}

function peerUrl(port: number): string {
  return `ws://127.0.0.1:${port}/carrier`;
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));

  return {
    publicKey,
    publicKeyBase64: bytesBase64(publicKey),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

function publicKeyObject(pubkey: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey)]),
    format: "der",
    type: "spki",
  });
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
