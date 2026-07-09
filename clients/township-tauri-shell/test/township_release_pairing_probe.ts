import assert from "node:assert/strict";
import type { CarrierOpFrame, Op } from "@treetopdevs/lattice-client";
import type { TownshipNativeWorkflow } from "../src/native_workflow";
import {
  exportTownshipCarrierPairingHandoff,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import {
  logTownshipReleasePairingProbeFromEnv,
  townshipReleasePairingProbeConfigFromEnv,
  townshipReleasePairingProbeLogLine,
  TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
  TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE,
  type TownshipReleasePairingProbeResult,
} from "../src/township_release_pairing_probe";

console.log("\n▸ Township release pairing probe contract");

const peerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const peerConfig: TownshipCarrierPeerConfig = {
  url: "ws://127.0.0.1:43193/carrier",
  localRealm: "resident",
  expectedPeerRealm: "clerk",
  expectedPeerPubkey: peerPubkey,
  replica,
  keyId: "township-release-pairing-resident",
};
const handoff = exportTownshipCarrierPairingHandoff(peerConfig);
const pairingLink = `township://pairing?handoff=${encodeURIComponent(handoff)}`;
const armedPairingLink = `${pairingLink}&state=release-pairing-state-103`;
const peerFingerprint = townshipCarrierPeerFingerprint(peerPubkey);

const config = townshipReleasePairingProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM: " resident ",
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID: " township-release-pairing-resident ",
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE: " township:release-pairing-probe ",
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE: " release-pairing-state-103 ",
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS: "9000",
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_RETRY_DELAY_MS: "250",
});
assert.deepEqual(config, {
  localRealm: "resident",
  keyId: "township-release-pairing-resident",
  storageNamespace: "township:release-pairing-probe",
  armState: "release-pairing-state-103",
  timeoutMs: 9000,
  retryDelayMs: 250,
});
assert.equal(townshipReleasePairingProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleasePairingProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID: "township-release-pairing-resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE: "township:release-pairing-probe",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL: "ws://127.0.0.1:43193/carrier",
  }),
  null,
);

const nativeKeyLine = townshipReleasePairingProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "resident",
  storageNamespace: TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE,
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);

const emptyReloadLine = townshipReleasePairingProbeLogLine({
  phase: "reload",
  outcome: "loaded",
  paired: false,
  carrierFrameCount: 0,
});
assert.match(emptyReloadLine, /phase=reload/);
assert.match(emptyReloadLine, /paired=false/);

const savedLine = townshipReleasePairingProbeLogLine({
  phase: "pairing",
  outcome: "saved",
  peerFingerprint,
  hostClass: "loopback",
  urlPort: "43193",
});
assert.match(savedLine, /phase=pairing/);
assert.match(savedLine, /outcome=saved/);
assert.match(savedLine, /host_class=loopback/);
assert.match(savedLine, /url_port=43193/);
assert.match(savedLine, new RegExp(`peer_fingerprint=${peerFingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

const loadedLine = townshipReleasePairingProbeLogLine({
  phase: "reload",
  outcome: "loaded",
  paired: true,
  peerFingerprint,
  hostClass: "loopback",
  urlPort: "43193",
  carrierFrameCount: 0,
});
assert.match(loadedLine, /paired=true/);
assert.match(loadedLine, /peer_fingerprint=/);

const syncLine = townshipReleasePairingProbeLogLine({
  phase: "sync",
  outcome: "synced",
  elapsedMs: 12,
  peerFingerprint,
  pulledOpIds: ["base", "grant"],
  localOpIds: ["base", "grant"],
  delegationFrameIds: ["base", "grant"],
  carrierFrameCount: 0,
  pushedFrameCount: 0,
  acceptedCount: 0,
});
assert.match(syncLine, /phase=sync/);
assert.match(syncLine, /outcome=synced/);
assert.match(syncLine, /pulled_op_ids=base,grant/);
assert.match(syncLine, /outbox_frame_count=0/);

const armingLine = townshipReleasePairingProbeLogLine({
  phase: "arming",
  outcome: "armed",
  stateRequired: true,
});
assert.match(armingLine, /phase=arming/);
assert.match(armingLine, /state_required=true/);
assert.doesNotMatch(armingLine, /release-pairing-state-103/);

const blockedLine = townshipReleasePairingProbeLogLine({
  phase: "deeplink",
  outcome: "blocked",
  urlCount: 1,
  pairingUrlCount: 1,
  blockedReason: "state_mismatch",
});
assert.match(blockedLine, /phase=deeplink/);
assert.match(blockedLine, /outcome=blocked/);
assert.match(blockedLine, /blocked_reason=state_mismatch/);
assert.doesNotMatch(blockedLine, /release-pairing-state-103/);

const deeplinkRouteLine = townshipReleasePairingProbeLogLine({
  phase: "deeplink",
  outcome: "current",
  urlCount: 1,
  pairingUrlCount: 0,
  firstRoute: `township:nohost:_pairing_${handoff}`,
});
assert.match(deeplinkRouteLine, /first_route=township:nohost:_pairing/);
assert.doesNotMatch(deeplinkRouteLine, /township-pairing:v1|eyJ1cmwi|127\.0\.0\.1/);
assert.doesNotMatch(
  [nativeKeyLine, emptyReloadLine, savedLine, loadedLine, syncLine, armingLine, blockedLine, deeplinkRouteLine].join("\n"),
  /sig|body|cap:|seed|private|secret|webview_devtools_remote|127\.0\.0\.1|release-pairing-state-103/,
);

const emitted: string[] = [];
const workflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
const result = await logTownshipReleasePairingProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID: "township-release-pairing-resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE: "township:release-pairing-probe",
  },
  {
    workflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    source: {
      async current() {
        return [pairingLink];
      },
      async onOpenUrl() {
        return () => {};
      },
    },
    async sync({ workflow: syncWorkflow, peer }) {
      assert.equal(peer.url, "ws://127.0.0.1:43193/carrier");
      assert.equal(peer.expectedPeerPubkey, peerPubkey);
      await syncWorkflow.localLog.save([{ id: "base" } as Op, { id: "grant" } as Op]);
      await syncWorkflow.delegationFrames.save([frame("base"), frame("grant")]);
      await syncWorkflow.carrierFrames.save([]);
      return syncResult({ pulledFrameCount: 2, pulledOpCount: 2 });
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") emitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);
assert.equal(result?.outcome, "synced");
assert.ok(
  emitted.some((line) => /phase=deeplink/.test(line) && /outcome=current/.test(line) && /pairing_url_count=1/.test(line)),
  "pairing probe should log non-secret deep-link current counts",
);
const probePhases = emitted.filter((line) => !/phase=deeplink/.test(line));
assert.match(probePhases[0] ?? "", /phase=native_key/);
assert.match(probePhases[1] ?? "", /phase=reload/);
assert.match(probePhases[1] ?? "", /paired=false/);
assert.match(probePhases[2] ?? "", /phase=pairing/);
assert.match(probePhases[3] ?? "", /phase=reload/);
assert.match(probePhases[3] ?? "", /paired=true/);
assert.match(probePhases[4] ?? "", /phase=sync/);

const persisted = await workflow.storage.getItem("carrier_peer_config");
assert.ok(persisted, "pairing probe should persist the deep-link peer config");
assert.match(persisted, /ws:\/\/127\.0\.0\.1:43193\/carrier/);

const delayedWorkflow = fakeWorkflow("ZGV2aWNlLXB1YmtleS0y");
const delayedEmitted: string[] = [];
let delayedCurrentCalls = 0;
const delayedResult = await logTownshipReleasePairingProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID: "township-release-pairing-resident",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE: "township:release-pairing-probe",
    VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE: "release-pairing-state-103",
  },
  {
    workflow: delayedWorkflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    source: {
      async current() {
        delayedCurrentCalls++;
        return delayedCurrentCalls >= 2 ? [armedPairingLink] : [pairingLink];
      },
      async onOpenUrl(callback) {
        callback([pairingLink]);
        return () => {};
      },
    },
    async sync({ workflow: syncWorkflow }) {
      await syncWorkflow.localLog.save([{ id: "base" } as Op, { id: "grant" } as Op]);
      await syncWorkflow.delegationFrames.save([frame("base"), frame("grant")]);
      await syncWorkflow.carrierFrames.save([]);
      return syncResult({ pulledFrameCount: 2, pulledOpCount: 2 });
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") delayedEmitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);
assert.equal(delayedResult?.outcome, "synced");
assert.ok(delayedCurrentCalls >= 2, "pairing probe should poll current URLs after route-only callbacks");
assert.ok(
  delayedEmitted.some((line) => /phase=arming/.test(line) && /state_required=true/.test(line)),
  "pairing probe should log that the release OS link path is armed without logging the state value",
);
assert.ok(
  delayedEmitted.some((line) => /phase=deeplink/.test(line) && /outcome=blocked/.test(line) && /blocked_reason=state_mismatch/.test(line)),
  "pairing probe should block a release OS pairing link that omits the app-local state",
);
assert.ok(
  delayedEmitted.some((line) => /phase=deeplink/.test(line) && /outcome=current/.test(line) && /pairing_url_count=1/.test(line)),
  "pairing probe should log the later current poll that contains the raw pairing URL",
);
assert.doesNotMatch(delayedEmitted.join("\n"), /release-pairing-state-103/);

console.log("\x1b[32m✓ release pairing probe contract checks passed\x1b[0m");

function fakeWorkflow(publicKeyBase64: string): TownshipNativeWorkflow {
  const localOps: Op[] = [];
  const carrierFrames: CarrierOpFrame[] = [];
  const delegationFrames: CarrierOpFrame[] = [];
  const storage = new Map<string, string>();
  return {
    keyId: "township-release-pairing-resident",
    storageNamespace: "township:release-pairing-probe",
    storage: {
      async getItem(key) {
        return storage.get(key) ?? null;
      },
      async setItem(key, value) {
        storage.set(key, value);
      },
      async removeItem(key) {
        storage.delete(key);
      },
    },
    localLog: opStore(localOps),
    carrierFrames: frameStore(carrierFrames),
    delegationFrames: frameStore(delegationFrames),
    signer: {
      publicKey: new Uint8Array(Buffer.from(publicKeyBase64, "base64")),
      async sign() {
        return new Uint8Array([1, 2, 3]);
      },
    },
  };
}

function opStore(values: Op[]): TownshipNativeWorkflow["localLog"] {
  return {
    async load() {
      return [...values];
    },
    async save(next) {
      values.splice(0, values.length, ...next);
    },
    async append(op) {
      values.push(op);
      return [...values];
    },
  };
}

function frameStore(values: CarrierOpFrame[]): TownshipNativeWorkflow["carrierFrames"] {
  return {
    async load() {
      return [...values];
    },
    async save(next) {
      values.splice(0, values.length, ...next);
    },
    async append(next) {
      values.push(next);
      return [...values];
    },
  };
}

function frame(id: string): CarrierOpFrame {
  return { id, v: 1, replica, author: "", deps: [], kind: "cmd", body: ["nil"], cap: ["nil"], sig: "" };
}

function syncResult(overrides: { pulledFrameCount: number; pulledOpCount: number }) {
  return {
    ok: true as const,
    localOpCount: 0,
    carrierFrameCount: 0,
    pulledFrameCount: overrides.pulledFrameCount,
    pulledOpCount: overrides.pulledOpCount,
    pushedFrameCount: 0,
    pushedFrameIds: [],
    compactedFrameCount: 0,
    compactedFrameIds: [],
    delegationFrameCount: 0,
    acceptedCount: 0,
    acceptedIds: [],
    quarantinedCount: 0,
    quarantined: [],
    rejectedCount: 0,
    rejected: [],
    pendingCount: 0,
    pending: [],
    authorityQuarantinedGrantCount: 0,
    authorityQuarantinedGrantIds: [],
    carrierAcceptedRevocationCount: 0,
    carrierAcceptedRevocationIds: [],
    authorityQuarantinedRevocationCount: 0,
    authorityQuarantinedRevocationIds: [],
    authorityRevokedCapabilityCount: 0,
    authorityRevokedCapabilityIds: [],
    authorityRevokedCapabilityAttributionCount: 0,
    authorityRevokedCapabilityAttributions: [],
    authorityRevokedCapabilityUnattributedCount: 0,
    authorityRevokedCapabilityUnattributedIds: [],
  };
}
