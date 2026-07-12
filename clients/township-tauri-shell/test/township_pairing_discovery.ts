import assert from "node:assert/strict";
import {
  createTownshipPairingDiscovery,
  type TownshipPairingDiscoveryAdvert,
} from "../src/township_pairing_discovery";
import {
  advertiseTauriPairingHandoff,
  createTauriPairingDiscoverySource,
  TOWNSHIP_PAIRING_ADVERTISE_COMMAND,
  TOWNSHIP_PAIRING_DISCOVERY_COMMAND,
} from "../src/township_pairing_discovery_source";
import {
  exportTownshipCarrierPairingHandoff,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

console.log("\n▸ Township pairing discovery candidates");

const config: TownshipCarrierPeerConfig = {
  url: "wss://carrier.example/township",
  localRealm: "resident-device-local",
  expectedPeerRealm: "township-carrier",
  expectedPeerPubkey: Buffer.from(new Uint8Array(32).fill(13)).toString("base64"),
  replica: TOWNSHIP_REPLICA,
  keyId: "resident-device-key",
};
const handoff = exportTownshipCarrierPairingHandoff(config);

let sink: ((advert: TownshipPairingDiscoveryAdvert) => void) | null = null;
let stopCount = 0;
const applied: unknown[] = [];
const discovery = await createTownshipPairingDiscovery({
  source: {
    async start(onAdvert) {
      sink = onAdvert;
      return () => {
        stopCount++;
      };
    },
  },
  apply(candidate) {
    applied.push(candidate);
  },
});

assert.ok(sink, "discovery should subscribe to candidate adverts");
sink({ label: "  Town hall carrier  ", handoff });
assert.deepEqual(applied, [
  {
    ok: true,
    id: "0d0d0d0d...0d0d0d0d:wss://carrier.example/township",
    label: "Town hall carrier",
    handoff,
    draft: {
      url: config.url,
      expectedPeerRealm: config.expectedPeerRealm,
      expectedPeerPubkey: config.expectedPeerPubkey,
      replica: config.replica,
      submission: "push",
    },
    peerFingerprint: "0d0d0d0d...0d0d0d0d",
  },
]);
assert.doesNotMatch(JSON.stringify(applied), /resident-device-local|resident-device-key|localRealm|keyId/);

sink({ label: "Duplicate carrier", handoff });
assert.equal(applied.length, 1, "duplicate discovered handoffs should not produce a second candidate");

sink({ label: "Broken carrier", handoff: "township-pairing:v1:not-json" });
assert.deepEqual(applied[1], {
  ok: false,
  label: "Broken carrier",
  reason: "invalid_pairing_payload",
  message: "Pairing handoff invalid: payload could not be decoded.",
});

sink({ label: "   ", handoff: "not-a-handoff" });
assert.deepEqual(applied[2], {
  ok: false,
  label: "Discovered carrier",
  reason: "invalid_pairing_format",
  message: "Pairing handoff invalid: expected township-pairing:v1 payload.",
});

discovery.stop();
discovery.stop();
assert.equal(stopCount, 1, "discovery stop should be idempotent");

sink({ label: "Late carrier", handoff });
assert.equal(applied.length, 3, "adverts after stop should be ignored");

const nativeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
const nativeSource = createTauriPairingDiscoverySource({
  async invoke(command, args = {}) {
    nativeCalls.push({ command, args });
    return [
      {
        label: "  Town hall carrier  ",
        handoff,
        localRealm: "resident-device-local",
        keyId: "resident-device-key",
      },
      { label: "Missing handoff" },
      "not an advert",
    ];
  },
  timeoutMs: 25,
  pollIntervalMs: 5000,
});
const nativeSeen: TownshipPairingDiscoveryAdvert[] = [];
const stopNativeSource = await nativeSource.start((advert) => nativeSeen.push(advert));
stopNativeSource?.();

assert.deepEqual(nativeCalls, [
  {
    command: TOWNSHIP_PAIRING_DISCOVERY_COMMAND,
    args: { timeoutMs: 25 },
  },
]);
assert.deepEqual(nativeSeen, [{ label: "Town hall carrier", handoff }]);
assert.doesNotMatch(JSON.stringify(nativeSeen), /resident-device-local|resident-device-key|localRealm|keyId/);

const advertiseCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
await advertiseTauriPairingHandoff({
  handoff: `  ${handoff}  `,
  label: "  Town hall carrier  ",
  targetAddr: "127.0.0.1:45721",
  async invoke(command, args = {}) {
    advertiseCalls.push({ command, args });
  },
});
assert.deepEqual(advertiseCalls, [
  {
    command: TOWNSHIP_PAIRING_ADVERTISE_COMMAND,
    args: {
      handoff,
      label: "Town hall carrier",
      targetAddr: "127.0.0.1:45721",
    },
  },
]);
assert.doesNotMatch(JSON.stringify(advertiseCalls), /resident-device-local|resident-device-key|localRealm|keyId/);

await assert.rejects(
  () =>
    advertiseTauriPairingHandoff({
      handoff: "   ",
      async invoke() {
        throw new Error("should not invoke native command for a blank handoff");
      },
    }),
  /pairing handoff cannot be empty/,
);

await assert.rejects(
  () =>
    createTauriPairingDiscoverySource({
      async invoke() {
        throw new Error("native discovery down");
      },
    }).start(() => {}),
  /native discovery down/,
);

console.log("\x1b[32m✓ Township pairing discovery checks passed\x1b[0m");
