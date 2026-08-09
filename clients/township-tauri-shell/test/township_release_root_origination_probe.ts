import assert from "node:assert/strict";
import type { CarrierOpFrame, Op } from "@treetopdevs/lattice-client";
import type { TownshipNativeWorkflow } from "../src/native_workflow";
import {
  logTownshipReleaseRootOriginationProbeFromEnv,
  townshipReleaseRootOriginationProbeConfigFromEnv,
  townshipReleaseRootOriginationProbeLogLine,
  TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
  TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_METADATA_KEY,
  type TownshipReleaseRootOriginationProbeMetadata,
  type TownshipReleaseRootOriginationProbeResult,
} from "../src/township_release_root_origination_probe";

console.log("\n▸ Township release root-origination probe contract");

const peerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replicaName = "replica:matter:township-root-origination";
const rootReplica = "replica:matter:township-root-origination#root:rootTag";

const config = townshipReleaseRootOriginationProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL: " ws://127.0.0.1:43199/carrier ",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM: " founder ",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM: " clerk ",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY: ` ${peerPubkey} `,
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME: ` ${replicaName} `,
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_KEY_ID: " township-release-root-founder ",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE: " township:release-root-origination-probe ",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_TIMEOUT_MS: "9000",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_RETRY_DELAY_MS: "250",
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PAUSE_AFTER_GENESIS_MS: "25",
});
assert.deepEqual(config, {
  peer: {
    url: "ws://127.0.0.1:43199/carrier",
    localRealm: "founder",
    expectedPeerRealm: "clerk",
    expectedPeerPubkey: peerPubkey,
    keyId: "township-release-root-founder",
  },
  replicaName,
  keyId: "township-release-root-founder",
  storageNamespace: "township:release-root-origination-probe",
  timeoutMs: 9000,
  retryDelayMs: 250,
  pauseAfterGenesisMs: 25,
});
assert.equal(townshipReleaseRootOriginationProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleaseRootOriginationProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL: "ws://10.0.2.2:43199/carrier",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM: "founder",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);
assert.equal(
  townshipReleaseRootOriginationProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL: "wss://example.com/carrier",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM: "founder",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);

const nativeKeyLine = townshipReleaseRootOriginationProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "founder",
  storageNamespace: "township:release-root-origination-probe",
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);

const reloadLine = townshipReleaseRootOriginationProbeLogLine({
  phase: "reload",
  outcome: "loaded",
  rootReplica,
  localOpIds: ["genesis"],
  delegationFrameIds: [],
  carrierFrameCount: 1,
});
assert.match(reloadLine, /phase=reload/);
assert.match(reloadLine, /root_replica=replica:matter:township-root-origination#root:rootTag/);
assert.match(reloadLine, /local_op_ids=genesis/);
assert.match(reloadLine, /outbox_frame_count=1/);

const genesisLine = townshipReleaseRootOriginationProbeLogLine({
  phase: "genesis",
  outcome: "authored",
  rootReplica,
  genesisFrameId: "genesis",
  rootPublicKeyBase64: "YWJj",
  localOpCount: 1,
  carrierFrameCount: 1,
});
assert.match(genesisLine, /phase=genesis/);
assert.match(genesisLine, /root_replica=replica:matter:township-root-origination#root:rootTag/);
assert.match(genesisLine, /genesis_frame_id=genesis/);
assert.match(genesisLine, /outbox_frame_count=1/);

const pushLine = townshipReleaseRootOriginationProbeLogLine({
  phase: "push",
  outcome: "synced",
  elapsedMs: 12,
  rootReplica,
  pushedFrameIds: ["genesis"],
  acceptedCount: 1,
  carrierFrameCount: 0,
  pendingCount: 0,
});
assert.match(pushLine, /phase=push/);
assert.match(pushLine, /pushed_frame_ids=genesis/);
assert.match(pushLine, /outbox_frame_count=0/);

const peerLine = townshipReleaseRootOriginationProbeLogLine({
  phase: "peer",
  outcome: "reported",
  rootReplica,
  genesisFrameId: "genesis",
  forgedFrameId: "forged",
  rootAuthorityAccepted: true,
  forgedAuthorityReason: "impostor_genesis",
  carrierFrameCount: 0,
});
assert.match(peerLine, /phase=peer/);
assert.match(peerLine, /root_authority_accepted=true/);
assert.match(peerLine, /forged_authority_reason=impostor_genesis/);
assert.doesNotMatch(
  [nativeKeyLine, reloadLine, genesisLine, pushLine, peerLine].join("\n"),
  /sig|body|cap:|seed|private|secret|webview_devtools_remote/,
);

const emitted: string[] = [];
const workflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
const result = await logTownshipReleaseRootOriginationProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL: "ws://127.0.0.1:43199/carrier",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM: "founder",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME: replicaName,
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE: "township:release-root-origination-probe",
  },
  {
    workflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    async authorGenesis(rootConfig, rootWorkflow) {
      assert.equal(rootConfig.replicaName, replicaName);
      await rootWorkflow.localLog.append({ id: "genesis" } as Op);
      await rootWorkflow.carrierFrames.append(frame("genesis"));
      return metadata("authored");
    },
    async sync({ rootReplica: pushedReplica, workflow: syncWorkflow }) {
      assert.equal(pushedReplica, rootReplica);
      await syncWorkflow.carrierFrames.save([]);
      return syncResult(["genesis"]);
    },
    async authorForgedGenesis({ workflow: forgedWorkflow, metadata: existing }) {
      assert.equal(existing.genesisFrameId, "genesis");
      await forgedWorkflow.localLog.append({ id: "forged" } as Op);
      await forgedWorkflow.carrierFrames.append(frame("forged"));
      return { ...existing, forgedFrameId: "forged", forgedPublicKeyBase64: "Zm9yZ2Vy" };
    },
    async stateReport({ metadata: reported }) {
      assert.equal(reported.forgedFrameId, "forged");
      return {
        ok: true,
        rootAuthorityAccepted: true,
        forgedAuthorityReason: "impostor_genesis",
      };
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") emitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);
assert.equal(result?.outcome, "reported");
assert.match(emitted[0] ?? "", /phase=native_key/);
assert.match(emitted[1] ?? "", /phase=reload/);
assert.match(emitted[2] ?? "", /phase=genesis/);
assert.match(emitted[2] ?? "", /outbox_frame_count=1/);
assert.match(emitted[3] ?? "", /phase=push/);
assert.match(emitted[3] ?? "", /pushed_frame_ids=genesis/);
assert.match(emitted[4] ?? "", /phase=peer/);
assert.match(emitted[4] ?? "", /root_authority_accepted=true/);
assert.match(emitted[4] ?? "", /forged_authority_reason=impostor_genesis/);

const resumeWorkflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
await resumeWorkflow.localLog.save([{ id: "genesis" } as Op]);
await resumeWorkflow.carrierFrames.save([frame("genesis")]);
await resumeWorkflow.storage.setItem(TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_METADATA_KEY, JSON.stringify(metadata("authored")));
const resumeEmitted: string[] = [];
const resumeResult = await logTownshipReleaseRootOriginationProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL: "ws://127.0.0.1:43199/carrier",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM: "founder",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME: replicaName,
  },
  {
    workflow: resumeWorkflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    async authorGenesis() {
      assert.fail("resume path must not author a second genesis");
    },
    async sync({ workflow: syncWorkflow }) {
      await syncWorkflow.carrierFrames.save([]);
      return syncResult(["genesis"]);
    },
    async authorForgedGenesis({ workflow: forgedWorkflow, metadata: existing }) {
      await forgedWorkflow.localLog.append({ id: "forged" } as Op);
      await forgedWorkflow.carrierFrames.append(frame("forged"));
      return { ...existing, forgedFrameId: "forged", forgedPublicKeyBase64: "Zm9yZ2Vy" };
    },
    async stateReport() {
      return {
        ok: true,
        rootAuthorityAccepted: true,
        forgedAuthorityReason: "impostor_genesis",
      };
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") resumeEmitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);
assert.equal(resumeResult?.outcome, "reported");
assert.match(resumeEmitted[1] ?? "", /phase=reload/);
assert.match(resumeEmitted[1] ?? "", /outbox_frame_count=1/);
assert.match(resumeEmitted[2] ?? "", /phase=push/);
assert.match(resumeEmitted[3] ?? "", /phase=peer/);

console.log("\x1b[32m✓ release root-origination probe contract checks passed\x1b[0m");

function fakeWorkflow(publicKeyBase64: string): TownshipNativeWorkflow {
  const localOps: Op[] = [];
  const carrierFrames: CarrierOpFrame[] = [];
  const delegationFrames: CarrierOpFrame[] = [];
  const storage = new Map<string, string>();
  return {
    keyId: "township-release-root-founder",
    storageNamespace: "township:release-root-origination-probe",
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
  return { id, v: 1, replica: rootReplica, author: "", deps: [], kind: "cmd", body: ["nil"], cap: ["nil"], sig: "" };
}

function metadata(stage: TownshipReleaseRootOriginationProbeMetadata["stage"]): TownshipReleaseRootOriginationProbeMetadata {
  return {
    stage,
    rootReplica,
    genesisFrameId: "genesis",
    rootPublicKeyBase64: "ZGV2aWNlLXB1YmtleQ==",
  };
}

function syncResult(pushedFrameIds: string[]) {
  return {
    ok: true as const,
    localOpCount: 0,
    carrierFrameCount: 0,
    pulledFrameCount: 0,
    pulledOpCount: 0,
    pushedFrameCount: pushedFrameIds.length,
    pushedFrameIds,
    strandedReplicaFrameIds: [],
    unboundReplicaFrameIds: [],
    unverifiableFrameIds: [],
    unverifiableArchiveFrameIds: [],
    compactedFrameCount: pushedFrameIds.length,
    compactedFrameIds: pushedFrameIds,
    delegationFrameCount: 0,
    acceptedCount: pushedFrameIds.length,
    acceptedIds: pushedFrameIds,
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
