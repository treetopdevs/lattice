import assert from "node:assert/strict";
import {
  logTownshipReleaseSyncProbeFromEnv,
  townshipReleaseSyncProbeConfigFromEnv,
  townshipReleaseSyncProbeLogLine,
  TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX,
  type TownshipReleaseSyncProbeResult,
} from "../src/township_release_sync_probe";
import type { CarrierOpFrame, Op } from "@treetopdevs/lattice-client";
import type { TownshipNativeWorkflow } from "../src/native_workflow";

console.log("\n▸ Township release sync probe contract");

const peerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";

const config = townshipReleaseSyncProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL: " ws://127.0.0.1:43191/carrier ",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM: " resident ",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM: " clerk ",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY: ` ${peerPubkey} `,
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_REPLICA: ` ${replica} `,
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_KEY_ID: " township-release-sync-resident ",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE: " township:release-sync-probe ",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_TIMEOUT_MS: "8000",
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_RETRY_DELAY_MS: "250",
});
assert.deepEqual(config, {
  peer: {
    url: "ws://127.0.0.1:43191/carrier",
    localRealm: "resident",
    expectedPeerRealm: "clerk",
    expectedPeerPubkey: peerPubkey,
    replica,
    keyId: "township-release-sync-resident",
  },
  keyId: "township-release-sync-resident",
  storageNamespace: "township:release-sync-probe",
  timeoutMs: 8000,
  retryDelayMs: 250,
});
assert.equal(townshipReleaseSyncProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleaseSyncProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL: "ws://10.0.2.2:43191/carrier",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);
assert.equal(
  townshipReleaseSyncProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL: "wss://example.com/carrier",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);

const nativeKeyLine = townshipReleaseSyncProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "resident",
  storageNamespace: "township:release-sync-probe",
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);
assert.match(nativeKeyLine, /storage_namespace=township:release-sync-probe/);

const reloadLine = townshipReleaseSyncProbeLogLine({
  phase: "reload",
  outcome: "loaded",
  localOpIds: ["b", "a"],
  delegationFrameIds: ["d2", "d1"],
  carrierFrameCount: 0,
});
assert.match(reloadLine, /phase=reload/);
assert.match(reloadLine, /outcome=loaded/);
assert.match(reloadLine, /local_op_ids=a,b/);
assert.match(reloadLine, /delegation_frame_ids=d1,d2/);
assert.match(reloadLine, /carrier_frame_count=0/);
assert.doesNotMatch(reloadLine, /sig|body|cap|seed|private|secret|webview_devtools_remote/);

const syncedLine = townshipReleaseSyncProbeLogLine({
  phase: "sync",
  outcome: "synced",
  elapsedMs: 42,
  pulledOpIds: ["op2", "op1"],
  localOpIds: ["op2", "op1"],
  delegationFrameIds: ["op2", "op1"],
  carrierFrameCount: 0,
  pushedFrameCount: 0,
  acceptedCount: 0,
});
assert.match(syncedLine, /phase=sync/);
assert.match(syncedLine, /outcome=synced/);
assert.match(syncedLine, /pulled_op_ids=op1,op2/);
assert.match(syncedLine, /local_op_ids=op1,op2/);
assert.match(syncedLine, /delegation_frame_ids=op1,op2/);
assert.match(syncedLine, /pushed_frame_count=0/);
assert.doesNotMatch(syncedLine, /sig|body|cap|seed|private|secret|webview_devtools_remote/);

const errorLine = townshipReleaseSyncProbeLogLine({
  phase: "sync",
  outcome: "error",
  elapsedMs: 7,
  message: "peer key mismatch",
});
assert.match(errorLine, /phase=sync/);
assert.match(errorLine, /outcome=error/);
assert.match(errorLine, /message=peer_key_mismatch/);

const emitted: string[] = [];
const workflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
workflow.localLog.save([{ id: "cached" } as Op]);
workflow.delegationFrames.save([frame("cached")]);
let attempts = 0;
const result = await logTownshipReleaseSyncProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL: "ws://127.0.0.1:43191/carrier",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_REPLICA: replica,
    VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE: "township:release-sync-probe",
  },
  {
    workflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    async sync({ workflow: syncWorkflow }) {
      attempts++;
      if (attempts === 1) return { ok: false, reason: "sync_failed", message: "peer not ready" };
      await syncWorkflow.localLog.save([{ id: "cached" } as Op, { id: "pulled" } as Op]);
      await syncWorkflow.delegationFrames.save([frame("cached"), frame("pulled")]);
      await syncWorkflow.carrierFrames.save([]);
      return {
        ok: true,
        localOpCount: 2,
        carrierFrameCount: 0,
        pulledFrameCount: 1,
        pulledOpCount: 1,
        pushedFrameCount: 0,
        pushedFrameIds: [],
        strandedReplicaFrameIds: [],
        unboundReplicaFrameIds: [],
        unverifiableFrameIds: [],
        unverifiableArchiveFrameIds: [],
        compactedFrameCount: 0,
        compactedFrameIds: [],
        delegationFrameCount: 2,
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
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") emitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);

assert.equal(result?.outcome, "synced");
assert.equal((result as Extract<TownshipReleaseSyncProbeResult, { phase: "sync" }>).pulledOpIds.join(","), "pulled");
assert.equal(attempts, 2);
assert.match(emitted[0] ?? "", /phase=native_key/);
assert.match(emitted[1] ?? "", /phase=reload/);
assert.match(emitted[1] ?? "", /local_op_ids=cached/);
assert.match(emitted[2] ?? "", /phase=sync/);
assert.match(emitted[2] ?? "", /outcome=synced/);
assert.match(emitted[2] ?? "", /pulled_op_ids=pulled/);

console.log("\x1b[32m✓ release sync probe contract checks passed\x1b[0m");

function fakeWorkflow(publicKeyBase64: string): TownshipNativeWorkflow {
  const localOps: Op[] = [];
  const carrierFrames: CarrierOpFrame[] = [];
  const delegationFrames: CarrierOpFrame[] = [];
  return {
    keyId: "township-resident",
    storageNamespace: "township:release-sync-probe",
    storage: {
      async getItem() {
        return null;
      },
      async setItem() {},
      async removeItem() {},
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
