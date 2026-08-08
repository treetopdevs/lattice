import assert from "node:assert/strict";
import { exportCarrierPairingHandoff, type CarrierPeerConfig } from "../src/pairing_handoff";
import { parseCarrierPairingDeepLink, type PairingDeepLinkOptions } from "../src/pairing_deeplink";

console.log("\n▸ Product-neutral pairing deep-link parsing");

const townshipOptions: PairingDeepLinkOptions = {
  scheme: "township",
  handoffPrefix: "township-pairing:v1:",
  legacyHandoffPrefix: "township-pairing:",
  defaultReplica: "replica:matter:township-demo#root:AAA",
};
const toolshedOptions: PairingDeepLinkOptions = {
  scheme: "toolshed",
  handoffPrefix: "toolshed-pairing:v1:",
  legacyHandoffPrefix: "toolshed-pairing:",
  defaultReplica: "replica:shed:toolshed-demo#root:BBB",
};

const pubkey = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const config: CarrierPeerConfig = {
  url: "wss://carrier.example/pilot",
  localRealm: "device-local",
  expectedPeerRealm: "carrier",
  expectedPeerPubkey: pubkey,
  replica: "replica:matter:township-demo#root:AAA",
};

// ── Each product parses its own scheme ───────────────────────────────────────
for (const options of [townshipOptions, toolshedOptions]) {
  const handoff = exportCarrierPairingHandoff(config, options);
  const link = `${options.scheme}://pairing?handoff=${encodeURIComponent(handoff)}&state=s-1`;
  const parsed = parseCarrierPairingDeepLink(link, options);
  assert.equal(parsed.ok, true, `${options.scheme} link parses`);
  if (parsed.ok) {
    assert.equal(parsed.handoff, handoff);
    assert.equal(parsed.state, "s-1");
    assert.equal(parsed.draft.url, config.url);
  }
}

// ── Cross-product scheme dispatch refuses ────────────────────────────────────
const townshipHandoff = exportCarrierPairingHandoff(config, townshipOptions);
const townshipLink = `township://pairing?handoff=${encodeURIComponent(townshipHandoff)}`;
const crossParse = parseCarrierPairingDeepLink(townshipLink, toolshedOptions);
assert.equal(crossParse.ok, false, "a toolshed shell must refuse a township:// link");
if (!crossParse.ok) {
  assert.equal(crossParse.reason, "invalid_pairing_deeplink");
  assert.equal(
    crossParse.message,
    "Pairing link invalid: expected toolshed://pairing with a pairing handoff.",
  );
}

// ── The Android no-host route normalization follows the product prefix ──────
const toolshedHandoff = exportCarrierPairingHandoff(config, toolshedOptions);
const encoded = toolshedHandoff.replaceAll(":", "_3A");
const androidRoute = `toolshed://nohost/_pairing_${encoded}`;
const androidParse = parseCarrierPairingDeepLink(androidRoute, toolshedOptions);
assert.equal(androidParse.ok, true, "android no-host route parses");
if (androidParse.ok) assert.equal(androidParse.handoff, toolshedHandoff);

// ── Garbage refuses ──────────────────────────────────────────────────────────
assert.equal(parseCarrierPairingDeepLink("https://example.com", townshipOptions).ok, false);
assert.equal(parseCarrierPairingDeepLink("township://elsewhere", townshipOptions).ok, false);

console.log("  ✓ deep-link parsing is product-neutral and refuses cross-product schemes");
