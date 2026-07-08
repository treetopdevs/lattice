import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  carrierOpsToSemanticOps,
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
  type Op,
  type ReplicaSchema,
  type TauriInvoke,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  syncTownshipOutbox,
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "../src/township_sync";
import type { TownshipCarrierPeerConfig } from "../src/township_carrier_peer";

interface CarrierVector {
  scenario: string;
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  expectAfterSync: {
    stateB64: string;
    opIds: string[];
    authorityQuarantine: [string, string][];
  };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;

console.log(`\n▸ ${vector.scenario} Tauri shell live peer sync`);

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.deepEqual(TOWNSHIP_REALM_BY_PUBKEY, vector.realmByPubkey);

const sessionIdentity = seededEd25519Identity(vector.client.sessionSeed);
assert.equal(sessionIdentity.publicKeyBase64, vector.client.sessionPubkey);

const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

const peer = await spawnTownshipPeer(vector);

try {
  const warmup = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: sessionIdentity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  assert.equal(await warmup.status(), "base");
  warmup.close();

  const diverged = await reconnectWhenDiverged(peer.port, vector, sessionIdentity, verifier);
  diverged.close();

  const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
  const values = new Map<string, string>([
    [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(localOps)],
    [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
  ]);
  const calls: string[] = [];

  const synced = await syncTownshipOutbox({
    invoke: nativeInvoke(values, sessionIdentity, calls, "session"),
    peer: {
      url: peerUrl(peer.port),
      localRealm: vector.client.realm,
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: vector.peer.sessionPubkey,
      replica: vector.replica,
      keyId: "session",
    } satisfies TownshipCarrierPeerConfig,
  });

  assert.equal(synced.ok, true);
  if (!synced.ok) throw new Error(synced.message);
  assert.equal(synced.pulledFrameCount, 5);
  assert.equal(synced.pulledOpCount, 5);
  assert.equal(synced.pushedFrameCount, 2);
  assert.equal(synced.acceptedCount, 2);
  assert.equal(synced.quarantinedCount, 0);
  assert.equal(synced.rejectedCount, 0);
  assert.equal(synced.pendingCount, 0);
  assert.deepEqual(
    JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: Op) => op.id).sort(),
    vector.expectAfterSync.opIds,
  );
  assert.deepEqual(JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]"), vector.clientDivergedCarrierOps);
  assert.deepEqual(calls, [
    "lattice_ensure_carrier_key",
    "lattice_sign_carrier",
    "lattice_kv_get",
    "lattice_kv_get",
    "lattice_kv_set",
  ]);

  const reportConn = await connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: sessionIdentity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });
  const peerReport = await reportConn.stateReport();
  assert.equal(peerReport.state_b64, vector.expectAfterSync.stateB64);
  assert.deepEqual(peerReport.op_ids, vector.expectAfterSync.opIds);
  assert.deepEqual(peerReport.authority_quarantine, vector.expectAfterSync.authorityQuarantine);

  await reportConn.shutdown();
  await peer.awaitExit();
} finally {
  peer.kill();
}

console.log("\x1b[32m✓ Township Tauri shell live peer sync checks passed\x1b[0m");

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function nativeInvoke(
  values: Map<string, string>,
  identity: NativeIdentity,
  calls: string[],
  expectedKeyId: string,
): TauriInvoke {
  return async <T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push(command);

    let result: unknown;
    switch (command) {
      case "lattice_ensure_carrier_key":
        assert.equal(args.keyId, expectedKeyId);
        result = identity.publicKeyBase64;
        break;
      case "lattice_sign_carrier":
        assert.equal(args.keyId, expectedKeyId);
        result = bytesBase64(identity.sign(base64Bytes(String(args.bytes))));
        break;
      case "lattice_kv_get":
        result = values.get(String(args.key)) ?? null;
        break;
      case "lattice_kv_set":
        values.set(String(args.key), String(args.value));
        result = null;
        break;
      default:
        throw new Error(`unexpected command ${command}`);
    }

    return result as T;
  };
}

async function reconnectWhenDiverged(
  port: number,
  vector: CarrierVector,
  identity: NativeIdentity,
  verifier: CarrierVerifier,
) {
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
    awaitExit: () => awaitExit(child, lines),
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    },
  };
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

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
