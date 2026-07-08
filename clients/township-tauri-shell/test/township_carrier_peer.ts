import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierChallenge,
  carrierTranscriptBytes,
} from "@treetopdevs/lattice-client";
import {
  createWebCryptoCarrierVerifier,
  townshipCarrierPeerFromEnv,
} from "../src/township_carrier_peer";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

interface TownshipCarrierVector {
  replica: string;
  client: { realm: string };
  peer: { realm: string; sessionSeed: string; sessionPubkey: string };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ Township carrier peer config");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const peerIdentity = seededEd25519Identity(vector.peer.sessionSeed);

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.equal(peerIdentity.publicKeyBase64, vector.peer.sessionPubkey);

assert.deepEqual(
  townshipCarrierPeerFromEnv({
    VITE_TOWNSHIP_CARRIER_URL: " ws://127.0.0.1:4111/carrier ",
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
    VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
    VITE_TOWNSHIP_CARRIER_KEY_ID: "session",
  }),
  {
    url: "ws://127.0.0.1:4111/carrier",
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: vector.peer.sessionPubkey,
    replica: TOWNSHIP_REPLICA,
    keyId: "session",
  },
);
assert.equal(townshipCarrierPeerFromEnv({}), null);
assert.equal(
  townshipCarrierPeerFromEnv({
    VITE_TOWNSHIP_CARRIER_URL: "ws://127.0.0.1:4111/carrier",
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
  }),
  null,
);

const challenge = carrierChallenge(vector.client.realm, vector.replica, {
  nonce: "township-peer-test",
  wireVersion: 1,
});
const transcript = carrierTranscriptBytes(challenge, vector.peer.realm, peerIdentity.publicKey);
const signature = peerIdentity.sign(transcript);
const verifier = createWebCryptoCarrierVerifier();

assert.equal(await verifier.verify(peerIdentity.publicKey, transcript, signature), true);
const tampered = new Uint8Array(signature);
tampered[0] ^= 1;
assert.equal(await verifier.verify(peerIdentity.publicKey, transcript, tampered), false);

console.log("\x1b[32m✓ Township carrier peer config checks passed\x1b[0m");

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

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
