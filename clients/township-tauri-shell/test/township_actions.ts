import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  carrierOpsToSemanticOps,
  type CarrierOpFrame,
  type TauriInvoke,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  submitTownshipPost,
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "../src/township_actions";

interface TownshipCarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ Township Vue post action");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const residentIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const postFixture = vector.clientDivergedCarrierOps.find(
  (frame) => frame.author === residentIdentity.publicKeyBase64 && frame.id === "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI",
);
if (!postFixture) throw new Error("missing resident post fixture");

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.deepEqual(TOWNSHIP_REALM_BY_PUBKEY, vector.realmByPubkey);

const framesBeforePost = vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id);
const localOpsBeforePost = carrierOpsToSemanticOps(framesBeforePost, vector.realmByPubkey);
const values = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(localOpsBeforePost)],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(framesBeforePost)],
]);
const calls: string[] = [];
const invoke = nativeInvoke(values, residentIdentity, calls);

const submitted = await submitTownshipPost({
  invoke,
  text: "  resident: posted while offline  ",
});

assert.equal(submitted.ok, true);
if (!submitted.ok) throw new Error(submitted.message);
assert.equal(submitted.text, "resident: posted while offline");
assert.equal(submitted.frameId, postFixture.id);
assert.equal(submitted.opId, postFixture.id);
assert.equal(submitted.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.equal(submitted.localOpCount, vector.clientDivergedCarrierOps.length);
assert.equal(submitted.carrierFrameCount, vector.clientDivergedCarrierOps.length);

assert.deepEqual(
  JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: { id: string }) => op.id),
  vector.clientDivergedCarrierOps.map((frame) => frame.id),
);
assert.deepEqual(JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]"), vector.clientDivergedCarrierOps);
assert.deepEqual(calls, [
  "lattice_ensure_carrier_key",
  "lattice_kv_get",
  "lattice_kv_get",
  "lattice_sign_carrier",
  "lattice_kv_get",
  "lattice_kv_set",
  "lattice_kv_get",
  "lattice_kv_set",
  "lattice_kv_get",
  "lattice_kv_get",
]);

const missingCapValues = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), "[]"],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
]);
const missingCap = await submitTownshipPost({
  invoke: nativeInvoke(missingCapValues, residentIdentity, []),
  text: "resident: no cap yet",
});

assert.equal(missingCap.ok, false);
if (missingCap.ok) throw new Error("missing-cap post unexpectedly succeeded");
assert.equal(missingCap.reason, "missing_delegation");
assert.match(missingCap.message, /No local delegation/);

const empty = await submitTownshipPost({
  invoke: nativeInvoke(new Map(), residentIdentity, []),
  text: "   ",
});

assert.equal(empty.ok, false);
if (empty.ok) throw new Error("empty post unexpectedly succeeded");
assert.equal(empty.reason, "empty_post");

const nativeUnavailable = await submitTownshipPost({
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
  text: "resident: from browser",
});

assert.equal(nativeUnavailable.ok, false);
if (nativeUnavailable.ok) throw new Error("native-unavailable post unexpectedly succeeded");
assert.equal(nativeUnavailable.reason, "native_unavailable");
assert.equal(nativeUnavailable.message, "Open in the Tauri shell to sign and save local posts.");

console.log("\x1b[32m✓ Township post action checks passed\x1b[0m");

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function nativeInvoke(
  values: Map<string, string>,
  identity: NativeIdentity,
  calls: string[],
): TauriInvoke {
  return async <T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push(command);

    let result: unknown;
    switch (command) {
      case "lattice_ensure_carrier_key":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = identity.publicKeyBase64;
        break;
      case "lattice_kv_get":
        result = values.get(String(args.key)) ?? null;
        break;
      case "lattice_kv_set":
        values.set(String(args.key), String(args.value));
        result = null;
        break;
      case "lattice_sign_carrier":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = bytesBase64(identity.sign(base64Bytes(String(args.bytes))));
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
