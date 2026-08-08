import assert from "node:assert/strict";
import {
  carrierPeerFingerprint,
  exportCarrierPairingHandoff,
  importCarrierPairingHandoff,
  normalizeCarrierPeerConfig,
  type CarrierPeerConfig,
  type PairingHandoffOptions,
} from "../src/pairing_handoff";

console.log("\n▸ Product-neutral pairing handoff codec");

const townshipOptions: PairingHandoffOptions = {
  handoffPrefix: "township-pairing:v1:",
  legacyHandoffPrefix: "township-pairing:",
  defaultReplica: "replica:matter:township-demo#root:AAA",
};
const toolshedOptions: PairingHandoffOptions = {
  handoffPrefix: "toolshed-pairing:v1:",
  legacyHandoffPrefix: "toolshed-pairing:",
  defaultReplica: "replica:shed:toolshed-demo#root:BBB",
};

const pubkey = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const config: CarrierPeerConfig = {
  url: "wss://carrier.example/pilot",
  localRealm: "device-local",
  expectedPeerRealm: "carrier",
  expectedPeerPubkey: pubkey,
  replica: "replica:matter:township-demo#root:AAA",
};

// ── Round trip per product prefix ────────────────────────────────────────────
for (const options of [townshipOptions, toolshedOptions]) {
  const handoff = exportCarrierPairingHandoff(config, options);
  assert.ok(handoff.startsWith(options.handoffPrefix), `handoff carries ${options.handoffPrefix}`);
  const imported = importCarrierPairingHandoff(handoff, options);
  assert.equal(imported.ok, true);
  if (imported.ok) {
    assert.equal(imported.draft.url, config.url);
    assert.equal(imported.draft.expectedPeerPubkey, pubkey);
    assert.equal(imported.peerFingerprint, carrierPeerFingerprint(pubkey));
  }
}

// ── Cross-product handoffs refuse ────────────────────────────────────────────
const townshipHandoff = exportCarrierPairingHandoff(config, townshipOptions);
const crossImport = importCarrierPairingHandoff(townshipHandoff, toolshedOptions);
assert.equal(crossImport.ok, false);
if (!crossImport.ok) {
  assert.deepEqual(crossImport.errors, ["invalid_pairing_format"]);
  assert.equal(crossImport.message, "Pairing handoff invalid: expected toolshed-pairing:v1 payload.");
}

// ── Unsupported versions refuse within the product family ────────────────────
const versionBump = importCarrierPairingHandoff("township-pairing:v2:AAAA", townshipOptions);
assert.equal(versionBump.ok, false);
if (!versionBump.ok) assert.deepEqual(versionBump.errors, ["unsupported_pairing_version"]);

// ── Validation matches the Township wording exactly ──────────────────────────
const invalid = normalizeCarrierPeerConfig(
  { url: "http://not-ws", localRealm: null, expectedPeerRealm: "x", expectedPeerPubkey: "short" },
  townshipOptions,
);
assert.equal(invalid.ok, false);
if (!invalid.ok) {
  assert.deepEqual(invalid.errors, [
    "invalid_url",
    "missing_local_realm",
    "invalid_expected_peer_pubkey",
  ]);
  assert.equal(
    invalid.message,
    "Pairing config invalid: Carrier URL must start with ws:// or wss://; local realm is required; peer public key must be 32-byte base64.",
  );
}

const defaulted = normalizeCarrierPeerConfig(
  { url: "wss://x", localRealm: "l", expectedPeerRealm: "r", expectedPeerPubkey: pubkey },
  toolshedOptions,
);
assert.equal(defaulted.ok, true);
if (defaulted.ok) assert.equal(defaulted.config.replica, toolshedOptions.defaultReplica);

console.log("  ✓ handoff codec is product-neutral and refuses cross-product payloads");
