import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const smokeUrl = "http://127.0.0.1:5173/";
const tracePath = join(tmpdir(), `township-tauri-smoke-${process.pid}.log`);

console.log(`\n▸ ${vector.scenario} Tauri live window peer smoke`);

await assertPortFree(5173);
await run("cargo", ["build", "--bin", "township-tauri-shell"], join(shellRoot, "src-tauri"));

const identity = seededEd25519Identity(vector.client.sessionSeed);
assert.equal(identity.publicKeyBase64, vector.client.sessionPubkey);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

const peer = await spawnTownshipPeer(vector);
let vite: ManagedProcess | null = null;
let app: ManagedProcess | null = null;

try {
  vite = await spawnVite(peer.port);
  await waitForHttp(smokeUrl);

  app = spawnManaged(
    binaryPath(),
    [],
    shellRoot,
    {
      TOWNSHIP_DEV_CARRIER_KEY_ID: smokeKeyId,
      TOWNSHIP_DEV_CARRIER_KEY_SEED: vector.client.sessionSeed,
      TOWNSHIP_DEV_TRACE_FILE: tracePath,
    },
  );

  await waitForTraceCount("lattice_kv_set", 2, 20_000);
  await delay(500);
  assert.equal(app.child.exitCode, null, app.lines.join(""));

  const status = await readPeerStatusOnce(peer.port, vector, identity, verifier);
  assert.equal(
    status,
    "diverged",
    [
      "expected launched Tauri app auto-sync to close a carrier session before the smoke probe",
      `native command trace:\n${readTrace()}`,
      `app output:\n${app.lines.join("")}`,
    ].join("\n\n"),
  );

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
  await app?.stop();
  await vite?.stop();
  peer.kill();
}

console.log("\x1b[32m✓ Township Tauri live window peer smoke passed\x1b[0m");

async function spawnVite(peerPort: number): Promise<ManagedProcess> {
  const vite = spawnManaged("npm", ["run", "dev"], shellRoot, {
    VITE_TOWNSHIP_CARRIER_URL: peerUrl(peerPort),
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
    VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
    VITE_TOWNSHIP_CARRIER_KEY_ID: smokeKeyId,
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1",
  });
  return vite;
}

async function readPeerStatusOnce(
  port: number,
  vector: CarrierVector,
  identity: NativeIdentity,
  verifier: CarrierVerifier,
): Promise<string> {
  const conn = await connectCarrierWebSocket({
    url: peerUrl(port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });

  try {
    return await conn.status();
  } finally {
    conn.close();
  }
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

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const proc = spawnManaged(command, args, cwd);
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

async function assertPortFree(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`port ${port} is already serving HTTP; stop the existing Vite dev server before launch smoke`);
}

async function waitForHttp(url: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // keep polling until Vite is ready
    }
    await delay(250);
  }
  throw new Error(`Vite did not become ready at ${url}`);
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

function binaryPath(): string {
  return join(shellRoot, "src-tauri", "target", "debug", "township-tauri-shell");
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "<empty>";
  return readFileSync(tracePath, "utf8").trim() || "<empty>";
}

async function waitForTraceCount(command: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = readTrace()
      .split(/\r?\n/)
      .filter((line) => line === command).length;
    if (seen >= count) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${count} ${command} trace entries:\n${readTrace()}`);
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
