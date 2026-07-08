import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierTranscriptBytes,
  carrierOpsToSemanticOps,
  type CarrierChallenge,
  type CarrierOpFrame,
  type CarrierPushReport,
  type CarrierSyncClient,
  type ConnectCarrierWebSocketOptions,
  type TauriInvoke,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  syncTownshipOutbox,
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "../src/township_sync";
import { townshipCarrierPeerFromEnv } from "../src/township_carrier_peer";

interface TownshipCarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionSeed: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  peerDivergedCarrierOps: CarrierOpFrame[];
  expectAfterSync: { opIds: string[] };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

class RecordingCarrierClient implements CarrierSyncClient {
  readonly pushedFrames: string[] = [];
  pullHave: string[] = [];

  constructor(private readonly peerFrames: CarrierOpFrame[]) {}

  async advertise(): Promise<string[]> {
    return this.peerFrames.map((frame) => frame.id);
  }

  async pull(have: string[]): Promise<unknown[]> {
    this.pullHave = [...have];
    const haveSet = new Set(have);
    return this.peerFrames.filter((frame) => !haveSet.has(frame.id));
  }

  async push(ops: unknown[]): Promise<CarrierPushReport> {
    this.pushedFrames.push(...ops.map((op) => (op as CarrierOpFrame).id));
    return {
      accepted: [...this.pushedFrames],
      quarantined: [],
      rejected: [],
      pending: [],
    };
  }
}

type WebSocketConstructor = NonNullable<ConnectCarrierWebSocketOptions["webSocket"]>;

class ScriptedCarrierWebSocket {
  static openedUrl = "";
  static closedCount = 0;
  static pushedFrameIds: string[] = [];

  private readonly listeners = new Map<string, ((event?: { data: string }) => void)[]>();

  constructor(url: string) {
    ScriptedCarrierWebSocket.openedUrl = url;
    queueMicrotask(() => this.emit("open"));
  }

  static reset(): void {
    ScriptedCarrierWebSocket.openedUrl = "";
    ScriptedCarrierWebSocket.closedCount = 0;
    ScriptedCarrierWebSocket.pushedFrameIds = [];
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    let response: unknown;

    switch (envelope.type) {
      case "carrier_challenge": {
        assert.equal(envelope.local_realm, vector.client.realm);
        assert.equal(envelope.replica, vector.replica);
        assert.equal(envelope.pubkey, sessionIdentity.publicKeyBase64);
        response = {
          type: "carrier_hello",
          realm: vector.peer.realm,
          pubkey: peerIdentity.publicKeyBase64,
          signature: bytesBase64(
            peerIdentity.sign(carrierTranscriptBytes(envelope as unknown as CarrierChallenge, vector.peer.realm, peerIdentity.publicKey)),
          ),
        };
        break;
      }
      case "frontier":
        response = { type: "frontier_result", ids: vector.peerDivergedCarrierOps.map((frame) => frame.id) };
        break;
      case "pull": {
        const have = new Set(envelope.have as string[]);
        response = {
          type: "ops",
          ops: vector.peerDivergedCarrierOps.filter((frame) => !have.has(frame.id)),
        };
        break;
      }
      case "push": {
        const ops = envelope.ops as CarrierOpFrame[];
        ScriptedCarrierWebSocket.pushedFrameIds.push(...ops.map((frame) => frame.id));
        response = {
          type: "push_result",
          accepted: ScriptedCarrierWebSocket.pushedFrameIds,
          quarantined: [],
          rejected: [],
          pending: [],
        };
        break;
      }
      default:
        throw new Error(`unexpected carrier envelope ${String(envelope.type)}`);
    }

    queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
  }

  close(): void {
    ScriptedCarrierWebSocket.closedCount++;
    this.emit("close");
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event?: { data: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  private emit(type: string, event?: { data: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

console.log("\n▸ Township Vue carrier sync action");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.deepEqual(TOWNSHIP_REALM_BY_PUBKEY, vector.realmByPubkey);

const sessionIdentity = seededEd25519Identity(vector.client.sessionSeed);
const peerIdentity = seededEd25519Identity(vector.peer.sessionSeed);
assert.equal(sessionIdentity.publicKeyBase64, vector.client.sessionPubkey);
assert.equal(peerIdentity.publicKeyBase64, vector.peer.sessionPubkey);

const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
const values = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(localOps)],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
]);
const calls: string[] = [];
const carrier = new RecordingCarrierClient(vector.peerDivergedCarrierOps);

const synced = await syncTownshipOutbox({
  invoke: nativeInvoke(values, vector.client.sessionPubkey, calls),
  client: carrier,
});

assert.equal(synced.ok, true);
if (!synced.ok) throw new Error(synced.message);
assert.equal(synced.localOpCount, vector.expectAfterSync.opIds.length);
assert.equal(synced.pulledFrameCount, 5);
assert.equal(synced.pulledOpCount, 5);
assert.equal(synced.pushedFrameCount, 2);
assert.deepEqual(synced.pushedFrameIds, [
  "05op_edpvoZmeWwBMx-mTAtBcoqIcWdUcb2gIoX3Iy4",
  "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI",
]);
assert.equal(synced.acceptedCount, 2);
assert.equal(synced.quarantinedCount, 0);
assert.equal(synced.rejectedCount, 0);
assert.equal(synced.pendingCount, 0);
assert.deepEqual(carrier.pullHave.sort(), vector.clientDivergedCarrierOps.map((frame) => frame.id).sort());
assert.deepEqual(carrier.pushedFrames, synced.pushedFrameIds);
assert.deepEqual(
  JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: { id: string }) => op.id).sort(),
  vector.expectAfterSync.opIds,
);
assert.deepEqual(JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]"), vector.clientDivergedCarrierOps);
assert.deepEqual(calls, [
  "lattice_ensure_carrier_key",
  "lattice_kv_get",
  "lattice_kv_get",
  "lattice_kv_set",
]);

const peerValues = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(localOps)],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
]);
const peerCalls: string[] = [];
ScriptedCarrierWebSocket.reset();
const peerSynced = await syncTownshipOutbox({
  invoke: nativeInvoke(peerValues, sessionIdentity, peerCalls, "session"),
  peer: townshipCarrierPeerFromEnv({
    VITE_TOWNSHIP_CARRIER_URL: "ws://127.0.0.1:4111/carrier",
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
    VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
    VITE_TOWNSHIP_CARRIER_KEY_ID: "session",
  }) ?? undefined,
  webSocket: ScriptedCarrierWebSocket as WebSocketConstructor,
});

assert.equal(peerSynced.ok, true);
if (!peerSynced.ok) throw new Error(peerSynced.message);
assert.equal(peerSynced.localOpCount, vector.expectAfterSync.opIds.length);
assert.equal(peerSynced.pulledOpCount, 5);
assert.equal(peerSynced.pushedFrameCount, 2);
assert.equal(ScriptedCarrierWebSocket.openedUrl, "ws://127.0.0.1:4111/carrier");
assert.equal(ScriptedCarrierWebSocket.closedCount, 1);
assert.deepEqual(ScriptedCarrierWebSocket.pushedFrameIds, peerSynced.pushedFrameIds);
assert.deepEqual(
  JSON.parse(peerValues.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: { id: string }) => op.id).sort(),
  vector.expectAfterSync.opIds,
);
assert.deepEqual(peerCalls, [
  "lattice_ensure_carrier_key",
  "lattice_sign_carrier",
  "lattice_kv_get",
  "lattice_kv_get",
  "lattice_kv_set",
]);

const unconfigured = await syncTownshipOutbox({
  invoke: nativeInvoke(new Map(), vector.client.sessionPubkey, []),
});
assert.equal(unconfigured.ok, false);
if (unconfigured.ok) throw new Error("unconfigured sync unexpectedly succeeded");
assert.equal(unconfigured.reason, "carrier_unconfigured");
assert.equal(unconfigured.message, "Connect a carrier peer before syncing.");

const nativeUnavailable = await syncTownshipOutbox({
  client: carrier,
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
});
assert.equal(nativeUnavailable.ok, false);
if (nativeUnavailable.ok) throw new Error("native-unavailable sync unexpectedly succeeded");
assert.equal(nativeUnavailable.reason, "native_unavailable");
assert.equal(nativeUnavailable.message, "Open in the Tauri shell to load local logs before syncing.");

console.log("\x1b[32m✓ Township sync action checks passed\x1b[0m");

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function nativeInvoke(
  values: Map<string, string>,
  identity: NativeIdentity | string,
  calls: string[],
  expectedKeyId = TOWNSHIP_NATIVE_KEY_ID,
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
        result = typeof identity === "string" ? identity : identity.publicKeyBase64;
        break;
      case "lattice_sign_carrier":
        assert.equal(args.keyId, expectedKeyId);
        if (typeof identity === "string") throw new Error("native test identity cannot sign");
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

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
