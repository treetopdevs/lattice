import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierTranscriptBytes,
  type CarrierChallenge,
  type CarrierFrameStore,
  type ConnectCarrierWebSocketOptions,
  type LocalOpLogStore,
  carrierChallenge,
  type LocalKeyValueStore,
} from "@treetopdevs/lattice-client";
import {
  checkTownshipCarrierPeerHealth,
  createWebCryptoCarrierVerifier,
  exportTownshipCarrierPairingHandoff,
  importTownshipCarrierPairingHandoff,
  loadTownshipCarrierPeerConfig,
  normalizeTownshipCarrierPeerConfig,
  saveTownshipCarrierPeerConfig,
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
  townshipCarrierPeerFingerprint,
  townshipCarrierPeerFromEnv,
} from "../src/township_carrier_peer";
import { parseTownshipPairingDeepLink } from "../src/township_pairing_deeplink";
import type { TownshipNativeWorkflow } from "../src/native_workflow";
import { TOWNSHIP_REPLICA } from "../src/township_actions";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";

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

type WebSocketConstructor = NonNullable<ConnectCarrierWebSocketOptions["webSocket"]>;

class ScriptedHealthWebSocket {
  static closedCount = 0;
  static mode: "ok" | "status_error" | "wrong_peer" = "ok";
  static openedUrl = "";
  static sentTypes: string[] = [];

  private readonly listeners = new Map<string, ((event?: { data: string }) => void)[]>();

  constructor(url: string) {
    ScriptedHealthWebSocket.openedUrl = url;
    queueMicrotask(() => this.emit("open"));
  }

  static reset(mode: "ok" | "status_error" | "wrong_peer" = "ok"): void {
    ScriptedHealthWebSocket.closedCount = 0;
    ScriptedHealthWebSocket.mode = mode;
    ScriptedHealthWebSocket.openedUrl = "";
    ScriptedHealthWebSocket.sentTypes = [];
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    ScriptedHealthWebSocket.sentTypes.push(String(envelope.type));
    let response: unknown;

    switch (envelope.type) {
      case "carrier_challenge": {
        assert.equal(envelope.local_realm, vector.client.realm);
        assert.equal(envelope.replica, vector.replica);
        assert.equal(envelope.pubkey, sessionIdentity.publicKeyBase64);
        const identity = ScriptedHealthWebSocket.mode === "wrong_peer" ? wrongIdentity : peerIdentity;
        response = {
          type: "carrier_hello",
          realm: vector.peer.realm,
          pubkey: identity.publicKeyBase64,
          signature: bytesBase64(
            identity.sign(
              carrierTranscriptBytes(
                envelope as unknown as CarrierChallenge,
                vector.peer.realm,
                identity.publicKey,
              ),
            ),
          ),
        };
        break;
      }
      case "status":
        response =
          ScriptedHealthWebSocket.mode === "status_error"
            ? { type: "error", reason: "status unavailable" }
            : { type: "status_result", phase: "base" };
        break;
      default:
        throw new Error(`unexpected health envelope ${String(envelope.type)}`);
    }

    queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
  }

  close(): void {
    ScriptedHealthWebSocket.closedCount++;
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

console.log("\n▸ Township carrier peer config");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const peerIdentity = seededEd25519Identity(vector.peer.sessionSeed);
const sessionIdentity = seededEd25519Identity(vector.client.sessionSeed);
const wrongIdentity = seededEd25519Identity("wrong-township-peer");

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.equal(sessionIdentity.publicKeyBase64, vector.client.sessionPubkey);
assert.equal(peerIdentity.publicKeyBase64, vector.peer.sessionPubkey);
assert.notEqual(wrongIdentity.publicKeyBase64, vector.peer.sessionPubkey);

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

const normalized = normalizeTownshipCarrierPeerConfig({
  url: " wss://carrier.township.example/sync ",
  localRealm: ` ${vector.client.realm} `,
  expectedPeerRealm: ` ${vector.peer.realm} `,
  expectedPeerPubkey: ` ${vector.peer.sessionPubkey} `,
  replica: " ",
  keyId: " session ",
});
assert.deepEqual(normalized, {
  ok: true,
  config: {
    url: "wss://carrier.township.example/sync",
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: vector.peer.sessionPubkey,
    replica: TOWNSHIP_REPLICA,
    keyId: "session",
  },
});

const invalid = normalizeTownshipCarrierPeerConfig({
  url: "https://carrier.township.example/sync",
  localRealm: " ",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: "not base64",
});
assert.equal(invalid.ok, false);
if (invalid.ok) throw new Error("invalid pairing config unexpectedly validated");
assert.deepEqual(invalid.errors.sort(), ["invalid_expected_peer_pubkey", "invalid_url", "missing_local_realm"].sort());
assert.match(invalid.message, /Carrier URL/);
assert.match(invalid.message, /peer public key/);

assert.deepEqual(
  townshipCarrierPeerFromEnv({
    VITE_TOWNSHIP_CARRIER_URL: "https://127.0.0.1:4111/carrier",
    VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
    VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
  }),
  null,
);

const persistedStorage = memoryStorage();
const envFallback = {
  VITE_TOWNSHIP_CARRIER_URL: "ws://127.0.0.1:4111/carrier",
  VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
  VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
  VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
  VITE_TOWNSHIP_CARRIER_KEY_ID: "env-session",
};
const envConfig = townshipCarrierPeerFromEnv(envFallback);
assert.ok(envConfig, "env fallback should be valid");
assert.deepEqual(await loadTownshipCarrierPeerConfig(persistedStorage, envFallback), envConfig);

await persistedStorage.setItem(TOWNSHIP_CARRIER_PAIRING_KEY, "{not json");
assert.equal(await loadTownshipCarrierPeerConfig(persistedStorage, envFallback), null);
await persistedStorage.setItem(
  TOWNSHIP_CARRIER_PAIRING_KEY,
  JSON.stringify({
    url: "https://persisted.example/carrier",
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: vector.peer.sessionPubkey,
  }),
);
assert.equal(await loadTownshipCarrierPeerConfig(persistedStorage, envFallback), null);

const saved = await saveTownshipCarrierPeerConfig(persistedStorage, {
  url: " wss://persisted.example/carrier ",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  keyId: "persisted-session",
});
assert.equal(saved.ok, true);
if (!saved.ok) throw new Error(saved.message);
assert.deepEqual(await loadTownshipCarrierPeerConfig(persistedStorage, envFallback), saved.config);
const savedRaw = (await persistedStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY)) ?? "";
assert.deepEqual(JSON.parse(savedRaw), saved.config);
assert.doesNotMatch(savedRaw, /seed|private|secret/i);
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([[TOWNSHIP_CARRIER_PAIRING_KEY, savedRaw]]));

const invalidSaveStorage = memoryStorage();
const invalidSave = await saveTownshipCarrierPeerConfig(invalidSaveStorage, {
  url: "ftp://carrier.example",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: "short",
});
assert.equal(invalidSave.ok, false);
assert.equal(await invalidSaveStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), null);

const importedFirstStorage = memoryStorage();
const importedFirstDraft = {
  url: "wss://imported.example/carrier",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  keyId: "imported-session",
};
const importedFirstBlocked = await saveTownshipCarrierPeerConfig(importedFirstStorage, importedFirstDraft, {
  origin: "deep_link",
});
assert.equal(importedFirstBlocked.ok, false);
if (importedFirstBlocked.ok) throw new Error("unconfirmed imported first pairing unexpectedly saved");
assert.deepEqual(importedFirstBlocked.errors, ["confirmation_required"]);
assert.match(importedFirstBlocked.message, /confirm/i);
assert.equal(await importedFirstStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), null);

const importedFirstSaved = await saveTownshipCarrierPeerConfig(importedFirstStorage, importedFirstDraft, {
  origin: "deep_link",
  confirmed: true,
});
assert.equal(importedFirstSaved.ok, true);
if (!importedFirstSaved.ok) throw new Error(importedFirstSaved.message);
assert.deepEqual(await loadTownshipCarrierPeerConfig(importedFirstStorage, {}), importedFirstSaved.config);

const replaceStorage = memoryStorage();
const originalPairing = {
  url: "wss://paired.example/carrier",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  keyId: "paired-session",
};
const originalPairingSaved = await saveTownshipCarrierPeerConfig(replaceStorage, originalPairing);
assert.equal(originalPairingSaved.ok, true);
if (!originalPairingSaved.ok) throw new Error(originalPairingSaved.message);
const originalPairingRaw = (await replaceStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY)) ?? "";
const sameImported = await saveTownshipCarrierPeerConfig(replaceStorage, originalPairing, { origin: "qr_camera" });
assert.equal(sameImported.ok, true);
assert.equal(await replaceStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), originalPairingRaw);

const replacementPairing = {
  ...originalPairing,
  expectedPeerPubkey: wrongIdentity.publicKeyBase64,
};
const importedReplaceBlocked = await saveTownshipCarrierPeerConfig(replaceStorage, replacementPairing, {
  origin: "handoff",
});
assert.equal(importedReplaceBlocked.ok, false);
if (importedReplaceBlocked.ok) throw new Error("unconfirmed imported replacement unexpectedly saved");
assert.deepEqual(importedReplaceBlocked.errors, ["confirmation_required"]);
assert.equal(await replaceStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), originalPairingRaw);

const manualReplaceBlocked = await saveTownshipCarrierPeerConfig(replaceStorage, replacementPairing);
assert.equal(manualReplaceBlocked.ok, false);
if (manualReplaceBlocked.ok) throw new Error("unconfirmed manual replacement unexpectedly saved");
assert.deepEqual(manualReplaceBlocked.errors, ["confirmation_required"]);
assert.equal(await replaceStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), originalPairingRaw);

const invalidConfirmedReplace = await saveTownshipCarrierPeerConfig(
  replaceStorage,
  {
    ...replacementPairing,
    url: "https://paired.example/carrier",
  },
  { origin: "handoff", confirmed: true },
);
assert.equal(invalidConfirmedReplace.ok, false);
assert.equal(await replaceStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), originalPairingRaw);

const importedReplaceSaved = await saveTownshipCarrierPeerConfig(replaceStorage, replacementPairing, {
  origin: "handoff",
  confirmed: true,
});
assert.equal(importedReplaceSaved.ok, true);
if (!importedReplaceSaved.ok) throw new Error(importedReplaceSaved.message);
assert.deepEqual(await loadTownshipCarrierPeerConfig(replaceStorage, {}), importedReplaceSaved.config);

const handoffConfig: TownshipCarrierPeerConfig = {
  url: " wss://handoff.township.example/carrier ",
  localRealm: "sender-local-realm",
  expectedPeerRealm: "township-peer-東京都",
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
  keyId: "sender-device-key",
};
const handoff = exportTownshipCarrierPairingHandoff(handoffConfig);
assert.match(handoff, /^township-pairing:v1:[A-Za-z0-9_-]+$/);
assert.doesNotMatch(handoff, /sender-local-realm/);
assert.doesNotMatch(handoff, /sender-device-key/);
assert.doesNotMatch(handoff, /keyId/);
assert.doesNotMatch(handoff, /seed|private|secret/i);

const importedHandoff = importTownshipCarrierPairingHandoff(handoff);
assert.equal(importedHandoff.ok, true);
if (!importedHandoff.ok) throw new Error(importedHandoff.message);
assert.deepEqual(importedHandoff.draft, {
  url: "wss://handoff.township.example/carrier",
  expectedPeerRealm: "township-peer-東京都",
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
});
assert.equal("localRealm" in importedHandoff.draft, false);
assert.equal("keyId" in importedHandoff.draft, false);
assert.equal(importedHandoff.peerFingerprint, townshipCarrierPeerFingerprint(vector.peer.sessionPubkey));
assert.match(importedHandoff.peerFingerprint, /^[0-9a-f]{8}\.\.\.[0-9a-f]{8}$/);

const injectedHandoff = encodedHandoff({
  url: "wss://handoff.township.example/carrier",
  localRealm: "attacker-realm",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
  keyId: "attacker-key",
});
const importedInjectedHandoff = importTownshipCarrierPairingHandoff(injectedHandoff);
assert.equal(importedInjectedHandoff.ok, true);
if (!importedInjectedHandoff.ok) throw new Error(importedInjectedHandoff.message);
assert.deepEqual(importedInjectedHandoff.draft, {
  url: "wss://handoff.township.example/carrier",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
});
assert.equal("localRealm" in importedInjectedHandoff.draft, false);
assert.equal("keyId" in importedInjectedHandoff.draft, false);

const confirmParamLink = parseTownshipPairingDeepLink(`township://pairing?handoff=${encodeURIComponent(handoff)}&confirm=1`);
assert.equal(confirmParamLink.ok, true);
if (!confirmParamLink.ok) throw new Error(confirmParamLink.message);
const confirmParamStorage = memoryStorage();
const confirmParamBlocked = await saveTownshipCarrierPeerConfig(
  confirmParamStorage,
  {
    ...confirmParamLink.draft,
    localRealm: vector.client.realm,
    keyId: "confirm-param-session",
  },
  { origin: "deep_link" },
);
assert.equal(confirmParamBlocked.ok, false);
if (confirmParamBlocked.ok) throw new Error("deep-link confirm query unexpectedly bypassed save confirmation");
assert.deepEqual(confirmParamBlocked.errors, ["confirmation_required"]);
assert.equal(await confirmParamStorage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY), null);

assert.deepEqual(importTownshipCarrierPairingHandoff("not-a-handoff"), {
  ok: false,
  errors: ["invalid_pairing_format"],
  message: "Pairing handoff invalid: expected township-pairing:v1 payload.",
});
assert.deepEqual(importTownshipCarrierPairingHandoff("township-pairing:v2:abc"), {
  ok: false,
  errors: ["unsupported_pairing_version"],
  message: "Pairing handoff invalid: unsupported version.",
});
assert.deepEqual(importTownshipCarrierPairingHandoff("township-pairing:v1:not-json"), {
  ok: false,
  errors: ["invalid_pairing_payload"],
  message: "Pairing handoff invalid: payload could not be decoded.",
});
const invalidHandoff = importTownshipCarrierPairingHandoff(
  encodedHandoff({
    url: "https://handoff.example/carrier",
    expectedPeerRealm: " ",
    expectedPeerPubkey: "short",
  }),
);
assert.equal(invalidHandoff.ok, false);
if (invalidHandoff.ok) throw new Error("invalid handoff unexpectedly imported");
assert.deepEqual(
  invalidHandoff.errors.sort(),
  ["invalid_expected_peer_pubkey", "invalid_url", "missing_expected_peer_realm"].sort(),
);
assert.match(invalidHandoff.message, /Carrier URL/);
assert.match(invalidHandoff.message, /peer public key/);

const healthPeer = townshipCarrierPeerFromEnv({
  VITE_TOWNSHIP_CARRIER_URL: "ws://127.0.0.1:4111/carrier",
  VITE_TOWNSHIP_LOCAL_REALM: vector.client.realm,
  VITE_TOWNSHIP_PEER_REALM: vector.peer.realm,
  VITE_TOWNSHIP_PEER_PUBKEY: vector.peer.sessionPubkey,
  VITE_TOWNSHIP_CARRIER_KEY_ID: "session",
});
assert.ok(healthPeer, "health peer should be valid");

const healthCalls: string[] = [];
ScriptedHealthWebSocket.reset();
const healthy = await checkTownshipCarrierPeerHealth({
  workflow: inertWorkflow(sessionIdentity, healthCalls),
  peer: healthPeer,
  webSocket: ScriptedHealthWebSocket as WebSocketConstructor,
});
assert.deepEqual(healthy, {
  ok: true,
  phase: "base",
  peerRealm: vector.peer.realm,
});
assert.equal(ScriptedHealthWebSocket.openedUrl, healthPeer.url);
assert.deepEqual(ScriptedHealthWebSocket.sentTypes, ["carrier_challenge", "status"]);
assert.equal(ScriptedHealthWebSocket.closedCount, 1);
assert.deepEqual(healthCalls, ["sign"]);

ScriptedHealthWebSocket.reset("status_error");
const statusFailed = await checkTownshipCarrierPeerHealth({
  workflow: inertWorkflow(sessionIdentity, []),
  peer: healthPeer,
  webSocket: ScriptedHealthWebSocket as WebSocketConstructor,
});
assert.equal(statusFailed.ok, false);
if (statusFailed.ok) throw new Error("status failure unexpectedly succeeded");
assert.equal(statusFailed.reason, "probe_failed");
assert.match(statusFailed.message, /status unavailable/);
assert.deepEqual(ScriptedHealthWebSocket.sentTypes, ["carrier_challenge", "status"]);
assert.equal(ScriptedHealthWebSocket.closedCount, 1);

ScriptedHealthWebSocket.reset("wrong_peer");
const wrongPeer = await checkTownshipCarrierPeerHealth({
  workflow: inertWorkflow(sessionIdentity, []),
  peer: healthPeer,
  webSocket: ScriptedHealthWebSocket as WebSocketConstructor,
});
assert.equal(wrongPeer.ok, false);
if (wrongPeer.ok) throw new Error("wrong peer unexpectedly succeeded");
assert.equal(wrongPeer.reason, "probe_failed");
assert.match(wrongPeer.message, /pubkey|signature|hello/i);
assert.deepEqual(ScriptedHealthWebSocket.sentTypes, ["carrier_challenge"]);

const unconfiguredHealth = await checkTownshipCarrierPeerHealth({
  workflow: inertWorkflow(sessionIdentity, []),
});
assert.equal(unconfiguredHealth.ok, false);
if (unconfiguredHealth.ok) throw new Error("unconfigured health unexpectedly succeeded");
assert.equal(unconfiguredHealth.reason, "carrier_unconfigured");
assert.equal(unconfiguredHealth.message, "Save a carrier pairing before checking health.");

const nativeUnavailableHealth = await checkTownshipCarrierPeerHealth({
  peer: healthPeer,
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
});
assert.equal(nativeUnavailableHealth.ok, false);
if (nativeUnavailableHealth.ok) throw new Error("native-unavailable health unexpectedly succeeded");
assert.equal(nativeUnavailableHealth.reason, "native_unavailable");
assert.equal(nativeUnavailableHealth.message, "Open in the Tauri shell to check carrier health.");

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

const androidWebViewVerifier = createWebCryptoCarrierVerifier(unsupportedEd25519Subtle());
assert.equal(await androidWebViewVerifier.verify(peerIdentity.publicKey, transcript, signature), true);
assert.equal(await androidWebViewVerifier.verify(peerIdentity.publicKey, transcript, tampered), false);

const unavailableVerifier = createWebCryptoCarrierVerifier(transientUnavailableSubtle());
await assert.rejects(
  unavailableVerifier.verify(peerIdentity.publicKey, transcript, signature),
  /temporarily unavailable/,
);

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

function encodedHandoff(payload: unknown): string {
  return `township-pairing:v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function memoryStorage(): LocalKeyValueStore {
  const values = new Map<string, string>();

  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

function inertWorkflow(identity: NativeIdentity, calls: string[]): TownshipNativeWorkflow {
  return {
    keyId: "session",
    storageNamespace: "township:test",
    storage: {
      getItem(key: string): never {
        calls.push(`storage.getItem:${key}`);
        throw new Error("health probe must not read storage");
      },
      setItem(key: string): never {
        calls.push(`storage.setItem:${key}`);
        throw new Error("health probe must not write storage");
      },
    },
    localLog: inertLocalLog(calls),
    carrierFrames: inertCarrierFrames("carrierFrames", calls),
    delegationFrames: inertCarrierFrames("delegationFrames", calls),
    signer: {
      publicKey: identity.publicKey,
      sign(bytes: Uint8Array): Uint8Array {
        calls.push("sign");
        return identity.sign(bytes);
      },
    },
  };
}

function inertLocalLog(calls: string[]): LocalOpLogStore {
  return {
    async load(): Promise<never> {
      calls.push("localLog.load");
      throw new Error("health probe must not load local ops");
    },
    async save(): Promise<never> {
      calls.push("localLog.save");
      throw new Error("health probe must not save local ops");
    },
    async append(): Promise<never> {
      calls.push("localLog.append");
      throw new Error("health probe must not append local ops");
    },
  };
}

function inertCarrierFrames(name: string, calls: string[]): CarrierFrameStore {
  return {
    async load(): Promise<never> {
      calls.push(`${name}.load`);
      throw new Error("health probe must not load carrier frames");
    },
    async save(): Promise<never> {
      calls.push(`${name}.save`);
      throw new Error("health probe must not save carrier frames");
    },
    async append(): Promise<never> {
      calls.push(`${name}.append`);
      throw new Error("health probe must not append carrier frames");
    },
  };
}

function unsupportedEd25519Subtle(): SubtleCrypto {
  return {
    async importKey(): Promise<CryptoKey> {
      throw new Error("Algorithm: Unrecognized name");
    },
  } as unknown as SubtleCrypto;
}

function transientUnavailableSubtle(): SubtleCrypto {
  return {
    async importKey(): Promise<CryptoKey> {
      throw new Error("Key service temporarily unavailable");
    },
  } as unknown as SubtleCrypto;
}
