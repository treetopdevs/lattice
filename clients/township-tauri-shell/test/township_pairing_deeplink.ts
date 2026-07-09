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
  createOneShotTownshipPairingDeepLinkGate,
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
const tauriAndroidEncodedHandoff = encodeURIComponent(handoff).replace(/%/g, "_");
const imported = importTownshipCarrierPairingHandoff(handoff);
assert.equal(imported.ok, true);
if (!imported.ok) throw new Error(imported.message);

assertDeepLinkOk(`township://pairing?handoff=${handoff}`, handoff);
assertDeepLinkOk(`township://pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township://pairing/${handoff}`, handoff);
assertDeepLinkOk(`township:/pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township:////pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township:////pairing/${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township:nohost:_pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township:nohost:_pairing/${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township://nohost/_pairing?handoff=${encodeURIComponent(handoff)}`, handoff);
assertDeepLinkOk(`township://nohost/_pairing_${handoff}`, handoff);
assertDeepLinkOk(`township://nohost/_pairing_${tauriAndroidEncodedHandoff}`, handoff);
const stateBoundLink = parseTownshipPairingDeepLink(
  `township://pairing?handoff=${encodeURIComponent(handoff)}&state=township-state-1`,
);
assert.equal(stateBoundLink.ok, true);
if (!stateBoundLink.ok) throw new Error(stateBoundLink.message);
assert.equal(stateBoundLink.state, "township-state-1");

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
assertDeepLinkError(`township://evil.example/pairing?handoff=${encodeURIComponent(handoff)}`, "invalid_pairing_deeplink");
assertDeepLinkError(`township:////evil.example/pairing?handoff=${encodeURIComponent(handoff)}`, "invalid_pairing_deeplink");
assertDeepLinkError(
  `township://evil.example/nohost:_pairing?handoff=${encodeURIComponent(handoff)}`,
  "invalid_pairing_deeplink",
);
assertDeepLinkError(`township://pairing.example?handoff=${encodeURIComponent(handoff)}`, "invalid_pairing_deeplink");
assertDeepLinkError(`township://pairing:8080?handoff=${encodeURIComponent(handoff)}`, "invalid_pairing_deeplink");
assertDeepLinkError("township://pairing", "invalid_pairing_deeplink");
assertDeepLinkError("township:nohost:_pairing", "invalid_pairing_deeplink");
assertDeepLinkError("township://nohost/_pairing", "invalid_pairing_deeplink");
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

const gate = createOneShotTownshipPairingDeepLinkGate();
const gatedApplied: TownshipPairingDeepLinkParse[] = [];
const gatedBlocked: TownshipPairingDeepLinkParse[] = [];
let gatedOnOpenUrl: ((urls: readonly string[]) => void) | null = null;
const gatedListener = await createTownshipPairingDeepLinkListener({
  source: {
    async current(): Promise<readonly string[] | null> {
      return [`township://pairing?handoff=${handoff}`];
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<void> {
      gatedOnOpenUrl = callback;
    },
  },
  gate,
  apply(parse) {
    gatedApplied.push(parse);
  },
  onBlocked(blocked) {
    gatedBlocked.push(blocked.parse);
  },
});
assert.equal(gatedApplied.length, 0);
assert.equal(gatedBlocked.length, 1);
assert.equal(gate.armed(), false);
assert.ok(gatedOnOpenUrl, "gated listener should subscribe to future URL events");

const firstGateState = gate.arm();
assert.match(firstGateState, /^[0-9a-f]{32}$/);
gatedOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}&state=${firstGateState}`]);
assert.equal(gatedApplied.length, 1);
assert.equal(gatedApplied[0]?.ok, true);
assert.equal(gate.armed(), false);

gatedOnOpenUrl([`township://pairing/${handoff}`]);
assert.equal(gatedApplied.length, 1);
assert.equal(gatedBlocked.length, 2);

const secondGateState = gate.arm();
gatedOnOpenUrl(["garbage"]);
assert.equal(gatedApplied.length, 2);
assert.equal(gatedApplied[1]?.ok, false);
assert.equal(gate.armed(), true);

gatedOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}&state=${secondGateState}`]);
assert.equal(gatedApplied.length, 3);
assert.equal(gatedApplied[2]?.ok, true);
assert.equal(gate.armed(), false);

gate.arm();
assert.equal(gate.armed(), true);
gatedListener.stop();
assert.equal(gate.armed(), false);

const statefulGate = createOneShotTownshipPairingDeepLinkGate({ createState: () => "armed-state" });
const statefulApplied: TownshipPairingDeepLinkParse[] = [];
const statefulBlocked: string[] = [];
let statefulOnOpenUrl: ((urls: readonly string[]) => void) | null = null;
await createTownshipPairingDeepLinkListener({
  source: {
    async current(): Promise<readonly string[] | null> {
      return null;
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<void> {
      statefulOnOpenUrl = callback;
    },
  },
  gate: statefulGate,
  apply(parse) {
    statefulApplied.push(parse);
  },
  onBlocked(blocked) {
    statefulBlocked.push(blocked.reason);
  },
});
assert.ok(statefulOnOpenUrl, "stateful gated listener should subscribe to future URL events");

assert.equal(statefulGate.arm(), "armed-state");
assert.equal(statefulGate.state(), "armed-state");
statefulOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}`]);
assert.equal(statefulApplied.length, 0);
assert.deepEqual(statefulBlocked, ["state_mismatch"]);
assert.equal(statefulGate.armed(), true);
assert.equal(statefulGate.state(), "armed-state");

statefulOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}&state=wrong-state`]);
assert.equal(statefulApplied.length, 0);
assert.deepEqual(statefulBlocked, ["state_mismatch", "state_mismatch"]);
assert.equal(statefulGate.armed(), true);

statefulOnOpenUrl(["garbage"]);
assert.equal(statefulApplied.length, 1);
assert.equal(statefulApplied[0]?.ok, false);
assert.equal(statefulGate.armed(), true);

statefulOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}&state=armed-state`]);
assert.equal(statefulApplied.length, 2);
assert.equal(statefulApplied[1]?.ok, true);
assert.equal(statefulGate.armed(), false);
assert.equal(statefulGate.state(), null);

statefulOnOpenUrl([`township://pairing?handoff=${encodeURIComponent(handoff)}&state=armed-state`]);
assert.equal(statefulApplied.length, 2);
assert.deepEqual(statefulBlocked, ["state_mismatch", "state_mismatch", "not_armed"]);

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
