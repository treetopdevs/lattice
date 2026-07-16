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
  verifyCarrierOp,
  type CarrierOpFrame,
  type CarrierVerifier,
  type CarrierWebSocketClient,
  type Verifier,
} from "@treetopdevs/lattice-client";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  stableCarrierUrl,
  type StableCarrierServerProcess,
} from "./support/beam_peer";

interface StableFeedOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  baseOpIds: string[];
  base: {
    opIds: string[];
    readModel: { threads: { posts: string[] } };
    causalReplay: unknown;
  };
  expectedPost: CarrierOpFrame;
  expectedRestartPost: CarrierOpFrame;
  afterPost: { opIds: string[] };
  afterRestartPost: { opIds: string[] };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ Direct TypeScript carrier availability feed");

const tempRoot = mkdtempSync(join(tmpdir(), "township-carrier-feed-ts-"));
const serverRealm = "town-node";
const serverSeed = "township-carrier-feed-ts-server";
const observerRealm = "instrument";
const observerSeed = "township-carrier-feed-ts-observer";
const relaySeed = "township-g1:resident";
const observerIdentity = seededEd25519Identity(observerSeed);
const relayIdentity = seededEd25519Identity(relaySeed);
const sessionVerifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};
const operationVerifier: Verifier = {
  async verify(author, bytes, signature) {
    return edVerify(
      null,
      Buffer.from(bytes),
      publicKeyObject(Buffer.from(author, "base64")),
      Buffer.from(signature),
    );
  },
};

let server: StableCarrierServerProcess | null = null;
let observer: CarrierWebSocketClient | null = null;
let relay: CarrierWebSocketClient | null = null;

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
    [tempRoot],
    "FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(join(tempRoot, "oracle.json"), "utf8")) as StableFeedOracle;
  assert.equal(oracle.relayRealm, "resident");
  assert.equal(oracle.relayPubkey, relayIdentity.publicKeyBase64);
  assert.deepEqual(oracle.base.opIds, oracle.baseOpIds);

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
      sourcePath: join(tempRoot, "matter.log"),
    });

  server = await spawnServer();
  observer = await connect(observerRealm, observerIdentity, server, oracle.replica);
  relay = await connect(oracle.relayRealm, relayIdentity, server, oracle.replica);

  const firstSubscription = await observer.subscribeAvailability();
  assert.equal(firstSubscription.baseline.generation, oracle.baseOpIds.length);

  const firstHintPromise = withTimeout(firstSubscription.next(), 5_000, "first availability hint");
  const firstReport = await relay.relay(oracle.expectedPost);
  assert.deepEqual(firstReport.accepted, [oracle.expectedPost.id]);

  const firstHint = await firstHintPromise;
  assert.ok(firstHint.generation > firstSubscription.baseline.generation);
  assert.equal(firstHint.generation, oracle.afterPost.opIds.length);

  const firstPulledFrames = await pullVerified(observer);
  assert.deepEqual(sortedFrameIds(firstPulledFrames), [...oracle.afterPost.opIds].sort());

  const duplicateHint = firstSubscription.next();
  let duplicateSettled = false;
  void duplicateHint.then(
    () => {
      duplicateSettled = true;
    },
    () => {
      duplicateSettled = true;
    },
  );
  assert.deepEqual(await relay.relay(oracle.expectedPost), {
    accepted: [],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  await delay(250);
  assert.equal(duplicateSettled, false, "a duplicate relay must not emit an availability hint");

  relay.close();
  relay = null;
  await server.kill();
  server = null;
  await assert.rejects(
    withTimeout(duplicateHint, 5_000, "old subscription close"),
    /carrier websocket (?:closed|error)/,
  );

  server = await spawnServer();
  observer = await connect(observerRealm, observerIdentity, server, oracle.replica);
  relay = await connect(oracle.relayRealm, relayIdentity, server, oracle.replica);

  const restartedSubscription = await observer.subscribeAvailability();
  assert.equal(restartedSubscription.baseline.generation, firstHint.generation);

  const secondHintPromise = withTimeout(
    restartedSubscription.next(),
    5_000,
    "post-restart availability hint",
  );
  const advertised = observer.advertise();
  const secondReport = await relay.relay(oracle.expectedRestartPost);
  const advertisedIds = await advertised;
  assert.ok(advertisedIds.includes(oracle.expectedPost.id));
  assert.deepEqual(secondReport.accepted, [oracle.expectedRestartPost.id]);

  const secondHint = await secondHintPromise;
  assert.ok(secondHint.generation > restartedSubscription.baseline.generation);
  assert.equal(secondHint.generation, oracle.afterRestartPost.opIds.length);

  const restartedFrames = await pullVerified(observer);
  assert.deepEqual(sortedFrameIds(restartedFrames), [...oracle.afterRestartPost.opIds].sort());

  const unsubscribed = restartedSubscription.unsubscribe();
  await unsubscribed;
  await assert.rejects(restartedSubscription.next(), /carrier availability subscription closed/);

  observer.close();
  observer = null;
  relay.close();
  relay = null;
  await server.stop();
  server = null;
} finally {
  observer?.close();
  relay?.close();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Direct TypeScript carrier availability feed checks passed\x1b[0m");

async function connect(
  realm: string,
  identity: NativeIdentity,
  peer: StableCarrierServerProcess,
  replica: string,
): Promise<CarrierWebSocketClient> {
  return connectCarrierWebSocket({
    url: stableCarrierUrl(peer.port),
    localRealm: realm,
    replica,
    signer: identity,
    expectedPeerRealm: peer.realm,
    expectedPeerPubkey: Buffer.from(peer.publicKeyBase64, "base64"),
    verifier: sessionVerifier,
  });
}

async function pullVerified(client: CarrierWebSocketClient): Promise<CarrierOpFrame[]> {
  const frames = (await client.pull([])).map(assertCarrierOpFrame);

  for (const frame of frames) {
    assert.deepEqual(await verifyCarrierOp(frame, operationVerifier), {
      hash: true,
      signature: true,
      valid: true,
    });
  }

  return frames;
}

function assertCarrierOpFrame(value: unknown): CarrierOpFrame {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const frame = value as Partial<CarrierOpFrame>;
  assert.equal(typeof frame.id, "string");
  assert.equal(typeof frame.author, "string");
  assert.equal(typeof frame.sig, "string");
  assert.ok(Array.isArray(frame.deps));
  return value as CarrierOpFrame;
}

function sortedFrameIds(frames: readonly CarrierOpFrame[]): string[] {
  return frames.map((frame) => frame.id).sort();
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
