import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportTownshipCarrierPairingHandoff,
  importTownshipCarrierPairingHandoff,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import {
  createTownshipPairingDeepLinkListener,
  parseTownshipPairingDeepLink,
  type TownshipPairingDeepLinkParse,
} from "../src/township_pairing_deeplink";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";

interface TownshipCarrierVector {
  replica: string;
  client: { realm: string };
  peer: { realm: string; sessionPubkey: string };
}

console.log("\n▸ Township pairing deep-link ingress");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const handoffConfig: TownshipCarrierPeerConfig = {
  url: " wss://deeplink.township.example/carrier ",
  localRealm: vector.client.realm,
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
  keyId: "sender-key",
};
const handoff = exportTownshipCarrierPairingHandoff(handoffConfig);
const imported = importTownshipCarrierPairingHandoff(handoff);
assert.equal(imported.ok, true);
if (!imported.ok) throw new Error(imported.message);

assertDeepLinkOk(`township://pairing?handoff=${handoff}`, handoff);
assertDeepLinkOk(`township://pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township://pairing/${handoff}`, handoff);

const smuggled = encodedHandoff({
  url: "wss://deeplink.township.example/carrier",
  localRealm: "attacker-local",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
  keyId: "attacker-key",
});
const smuggledLink = parseTownshipPairingDeepLink(`township://pairing?handoff=${smuggled}`);
assert.equal(smuggledLink.ok, true);
if (!smuggledLink.ok) throw new Error(smuggledLink.message);
assert.deepEqual(smuggledLink.draft, {
  url: "wss://deeplink.township.example/carrier",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: vector.peer.sessionPubkey,
  replica: vector.replica,
});
assert.equal("localRealm" in smuggledLink.draft, false);
assert.equal("keyId" in smuggledLink.draft, false);
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["carrier_peer_config", JSON.stringify(smuggledLink.draft)]]));

assertDeepLinkError("not a url", "invalid_pairing_deeplink");
assertDeepLinkError("https://pairing.example/?handoff=x", "invalid_pairing_deeplink");
assertDeepLinkError("township://sync?handoff=x", "invalid_pairing_deeplink");
assertDeepLinkError("township://pairing", "invalid_pairing_deeplink");
assertDeepLinkError("township://pairing?handoff=township-pairing:v2:abc", "unsupported_pairing_version");
assertDeepLinkError("township://pairing?handoff=township-pairing:v1:not-json", "invalid_pairing_payload");

const invalidPeer = encodedHandoff({
  url: "https://deeplink.township.example/carrier",
  expectedPeerRealm: vector.peer.realm,
  expectedPeerPubkey: "short",
});
assertDeepLinkError(`township://pairing/${invalidPeer}`, "invalid_url");

const applied: TownshipPairingDeepLinkParse[] = [];
let onOpenUrl: ((urls: readonly string[]) => void) | null = null;
let stopCount = 0;
const listener = await createTownshipPairingDeepLinkListener({
  source: {
    async current(): Promise<readonly string[] | null> {
      return [`township://pairing?handoff=${handoff}`];
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<() => void> {
      onOpenUrl = callback;
      return () => {
        stopCount++;
      };
    },
  },
  apply(parse) {
    applied.push(parse);
  },
});
assert.equal(applied.length, 1);
assert.equal(applied[0]?.ok, true);
assert.ok(onOpenUrl, "listener should subscribe to future URL events");
onOpenUrl([`township://pairing/${handoff}`, "garbage"]);
assert.equal(applied.length, 3);
assert.equal(applied[1]?.ok, true);
assert.deepEqual(applied[2], {
  ok: false,
  reason: "invalid_pairing_deeplink",
  message: "Pairing link invalid: expected township://pairing with a pairing handoff.",
});
listener.stop();
assert.equal(stopCount, 1);

console.log("\x1b[32m✓ Township pairing deep-link ingress checks passed\x1b[0m");

function assertDeepLinkOk(link: string, expectedHandoff: string): void {
  const parsed = parseTownshipPairingDeepLink(link);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.message);
  assert.equal(parsed.handoff, expectedHandoff);
  assert.deepEqual(parsed.draft, imported.draft);
  assert.equal(parsed.peerFingerprint, townshipCarrierPeerFingerprint(vector.peer.sessionPubkey));
}

function assertDeepLinkError(link: string, reason: TownshipPairingDeepLinkParse extends infer Result
  ? Result extends { ok: false; reason: infer Reason }
    ? Reason
    : never
  : never): void {
  assert.doesNotThrow(() => parseTownshipPairingDeepLink(link));
  const parsed = parseTownshipPairingDeepLink(link);
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("deep-link unexpectedly parsed");
  assert.equal(parsed.reason, reason);
  assert.match(parsed.message, /Pairing/);
}

function encodedHandoff(payload: unknown): string {
  return `township-pairing:v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}
