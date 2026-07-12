import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
} from "@treetopdevs/lattice-client";
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
  authorityInvalidOp: CarrierOpFrame;
  afterAuthorityInvalid: { opIds: string[] };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ TypeScript client against stable relay server");

const tempRoot = mkdtempSync(join(tmpdir(), "township-stable-relay-ts-"));
const serverRealm = "town-node";
const serverSeed = "township-stable-relay-ts-server";
const observerRealm = "instrument";
const observerSeed = "township-stable-relay-ts-observer";
const relaySeed = "township-g1:resident";
const observer = seededEd25519Identity(observerSeed);
const relay = seededEd25519Identity(relaySeed);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};
let server: StableCarrierServerProcess | null = null;

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
    [tempRoot],
    "FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(join(tempRoot, "oracle.json"), "utf8")) as StableRelayOracle;
  assert.equal(oracle.relayRealm, "resident");
  assert.equal(oracle.relayPubkey, relay.publicKeyBase64);

  const port = await freeTcpPort();
  const spawnServer = () =>
    spawnStableCarrierServer({
      port,
      serverRealm,
      identitySeed: serverSeed,
      trustedPeerRealm: observerRealm,
      trustedPeerPubkey: observer.publicKeyBase64,
      relayRealm: oracle.relayRealm,
      relayPubkey: oracle.relayPubkey,
      sourcePath: join(tempRoot, "matter.log"),
    });

  server = await spawnServer();
  const url = stableCarrierUrl(server.port);
  const observerConnection = await connect(url, observerRealm, observer, server, oracle.replica);
  const relayConnection = await connect(url, oracle.relayRealm, relay, server, oracle.replica);

  await assert.rejects(() => observerConnection.relay(oracle.expectedPost), /carrier peer error: read_only/);
  await assert.rejects(() => relayConnection.push([oracle.expectedPost]), /carrier peer error: read_only/);

  assert.deepEqual(await relayConnection.relay(oracle.expectedPost), {
    accepted: [oracle.expectedPost.id],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  assert.deepEqual(await relayConnection.relay(oracle.expectedPost), {
    accepted: [],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  assert.deepEqual(await relayConnection.relay(oracle.authorityInvalidOp), {
    accepted: [oracle.authorityInvalidOp.id],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  assert.deepEqual(
    [...(await observerConnection.advertise())].sort(),
    [...oracle.afterAuthorityInvalid.opIds].sort(),
  );

  relayConnection.close();
  observerConnection.close();
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
      join(tempRoot, "oracle.json"),
      "authority",
    ],
    "VERIFY_READY authority",
  );
  assert.match(verifyOutput, /VERIFY_READY authority/);
  await server.stop();
  server = null;
} finally {
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Stable relay TypeScript socket checks passed\x1b[0m");

async function connect(
  url: string,
  realm: string,
  identity: NativeIdentity,
  peer: StableCarrierServerProcess,
  replica: string,
) {
  return connectCarrierWebSocket({
    url,
    localRealm: realm,
    replica,
    signer: identity,
    expectedPeerRealm: peer.realm,
    expectedPeerPubkey: Buffer.from(peer.publicKeyBase64, "base64"),
    verifier,
  });
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));
  return {
    publicKey,
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
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
