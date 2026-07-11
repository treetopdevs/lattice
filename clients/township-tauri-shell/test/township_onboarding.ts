import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CarrierOpFrame,
  type CarrierPushReport,
  type CarrierSyncClient,
  type TauriInvoke,
} from "@treetopdevs/lattice-client";
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
import { TOWNSHIP_REALM_BY_PUBKEY, TOWNSHIP_REPLICA } from "../src/township_actions";
import { onboardTownshipDesktop } from "../src/township_onboarding";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";

interface TownshipCarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
}

interface NativeIdentity {
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

class OnboardingCarrierClient implements CarrierSyncClient {
  readonly pullHave: string[][] = [];
  readonly pushedFrames: CarrierOpFrame[] = [];

  constructor(private readonly peerFrames: CarrierOpFrame[]) {}

  async advertise(): Promise<string[]> {
    return [...this.peerFrames, ...this.pushedFrames].map((frame) => frame.id);
  }

  async pull(have: string[]): Promise<unknown[]> {
    this.pullHave.push([...have]);
    const haveSet = new Set(have);
    return this.peerFrames.filter((frame) => !haveSet.has(frame.id));
  }

  async push(ops: unknown[]): Promise<CarrierPushReport> {
    const frames = ops as CarrierOpFrame[];
    this.pushedFrames.push(...frames);
    return {
      accepted: frames.map((frame) => frame.id),
      quarantined: [],
      rejected: [],
      pending: [],
    };
  }
}

console.log("\n▸ Township desktop onboarding ceremony");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const residentIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const postFixture = vector.clientDivergedCarrierOps.find(
  (frame) => frame.id === "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI",
);
if (!postFixture) throw new Error("missing resident post fixture");
const onboardingPeerFrames = vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id);
const carrier = new OnboardingCarrierClient(onboardingPeerFrames);
const values = new Map<string, string>();
const calls: string[] = [];
const pairing: TownshipCarrierPeerConfig = {
  url: "ws://127.0.0.1:4177/carrier",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
};

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.deepEqual(TOWNSHIP_REALM_BY_PUBKEY, vector.realmByPubkey);
assert.equal(TOWNSHIP_REALM_BY_PUBKEY[residentIdentity.publicKeyBase64], vector.client.realm);

const ceremony = await onboardTownshipDesktop({
  invoke: nativeInvoke(values, residentIdentity, calls),
  pairingHandoff: exportTownshipCarrierPairingHandoff(pairing),
  localRealm: vector.client.realm,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
  confirmed: true,
  client: carrier,
  postText: "  resident: posted while offline  ",
});

if (!ceremony.ok) throw new Error(ceremony.message);
assert.equal(ceremony.ok, true);
assert.deepEqual(ceremony.pairing, pairing);
assert.equal(ceremony.initialSync.pulledFrameCount, onboardingPeerFrames.length);
assert.equal(ceremony.initialSync.pushedFrameCount, 0);
assert.equal(ceremony.post.frameId, postFixture.id);
assert.equal(ceremony.post.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.deepEqual(ceremony.finalSync.pushedFrameIds, [postFixture.id]);
assert.equal(ceremony.finalSync.compactedFrameCount, 1);
assert.deepEqual(ceremony.localOpIds, vector.clientDivergedCarrierOps.map((frame) => frame.id));
assert.deepEqual(ceremony.pendingOutboxIds, []);
assert.deepEqual(ceremony.delegationFrameIds, vector.clientDivergedCarrierOps.map((frame) => frame.id));
assert.deepEqual(carrier.pushedFrames.map((frame) => frame.id), [postFixture.id]);
assert.deepEqual(JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_PAIRING_KEY)) ?? "null"), pairing);
assert.deepEqual(storedIds(values, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
assert.deepEqual(storedIds(values, TOWNSHIP_DELEGATION_FRAMES_KEY), vector.clientDivergedCarrierOps.map((frame) => frame.id));
assert.deepEqual(
  (JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]") as { id: string }[]).map((op) => op.id),
  vector.clientDivergedCarrierOps.map((frame) => frame.id),
);
assert.equal(commandCount(calls, "lattice_ensure_carrier_key"), 3);
assert.equal(commandCount(calls, "lattice_sign_carrier"), 1);
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, secretNeedles(residentIdentity)));

console.log("\x1b[32m✓ Township desktop onboarding ceremony checks passed\x1b[0m");

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function storedIds(values: Map<string, string>, key: string): string[] {
  return (JSON.parse(values.get(storageKey(key)) ?? "[]") as CarrierOpFrame[]).map((frame) => frame.id);
}

function commandCount(calls: string[], command: string): number {
  return calls.filter((call) => call === command).length;
}

function secretNeedles(...identities: NativeIdentity[]): string[] {
  return identities.flatMap((identity) => [identity.privateSeedBase64, identity.privateSeedHex]);
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
    publicKeyBase64: bytesBase64(publicKey),
    privateSeedBase64: bytesBase64(privateSeed),
    privateSeedHex: privateSeed.toString("hex"),
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
