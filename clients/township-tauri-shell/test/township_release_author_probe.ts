import assert from "node:assert/strict";
import {
  logTownshipReleaseAuthorProbeFromEnv,
  townshipReleaseAuthorProbeConfigFromEnv,
  townshipReleaseAuthorProbeLogLine,
  TOWNSHIP_RELEASE_AUTHOR_PROBE_METADATA_KEY,
  TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
  type TownshipReleaseAuthorProbeResult,
} from "../src/township_release_author_probe";
import type { CarrierOpFrame, Op } from "@treetopdevs/lattice-client";
import type { TownshipNativeWorkflow } from "../src/native_workflow";

console.log("\n▸ Township release author probe contract");

const peerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
const grantAudiencePubkey = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";

const config = townshipReleaseAuthorProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL: " ws://127.0.0.1:43192/carrier ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM: " resident ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM: " clerk ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY: ` ${peerPubkey} `,
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_REPLICA: ` ${replica} `,
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_KEY_ID: " township-release-author-resident ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE: " township:release-author-probe ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY: ` ${grantAudiencePubkey} `,
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_POST_TEXT: " release authored post ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_BAD_SUMMARY_TEXT: " release unauthorized summary ",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_TIMEOUT_MS: "9000",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_RETRY_DELAY_MS: "250",
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PAUSE_AFTER_AUTHOR_MS: "25",
});
assert.deepEqual(config, {
  peer: {
    url: "ws://127.0.0.1:43192/carrier",
    localRealm: "resident",
    expectedPeerRealm: "clerk",
    expectedPeerPubkey: peerPubkey,
    replica,
    keyId: "township-release-author-resident",
  },
  keyId: "township-release-author-resident",
  storageNamespace: "township:release-author-probe",
  grantAudiencePubkey,
  postText: "release authored post",
  badSummaryText: "release unauthorized summary",
  timeoutMs: 9000,
  retryDelayMs: 250,
  pauseAfterAuthorMs: 25,
});
assert.equal(townshipReleaseAuthorProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleaseAuthorProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL: "ws://10.0.2.2:43192/carrier",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);
assert.equal(
  townshipReleaseAuthorProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL: "wss://example.com/carrier",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);

const nativeKeyLine = townshipReleaseAuthorProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "resident",
  storageNamespace: "township:release-author-probe",
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);
assert.match(nativeKeyLine, /storage_namespace=township:release-author-probe/);

const reloadLine = townshipReleaseAuthorProbeLogLine({
  phase: "reload",
  outcome: "loaded",
  localOpIds: ["base", "post"],
  delegationFrameIds: ["base"],
  carrierFrameCount: 0,
});
assert.match(reloadLine, /phase=reload/);
assert.match(reloadLine, /outcome=loaded/);
assert.match(reloadLine, /local_op_ids=base,post/);
assert.match(reloadLine, /delegation_frame_ids=base/);
assert.match(reloadLine, /outbox_frame_count=0/);

const pullLine = townshipReleaseAuthorProbeLogLine({
  phase: "pull",
  outcome: "synced",
  elapsedMs: 11,
  pulledOpIds: ["grant"],
  localOpIds: ["base", "grant"],
  delegationFrameIds: ["base", "grant"],
  carrierFrameCount: 0,
  pushedFrameCount: 0,
  acceptedCount: 0,
  grantDelegationId: "grant-delegation",
});
assert.match(pullLine, /phase=pull/);
assert.match(pullLine, /outcome=synced/);
assert.match(pullLine, /pulled_op_ids=grant/);
assert.match(pullLine, /grant_delegation_id=grant-delegation/);

const grantLine = townshipReleaseAuthorProbeLogLine({
  phase: "grant",
  outcome: "authored",
  grantFrameId: "grant-app",
  grantDelegationId: "grant-app-delegation",
  grantAudiencePubkey,
  parentId: "grant-delegation",
  authorPublicKeyBase64: "YWJj",
  localOpCount: 3,
  carrierFrameCount: 1,
  delegationFrameCount: 3,
});
assert.match(grantLine, /phase=grant/);
assert.match(grantLine, /outcome=authored/);
assert.match(grantLine, /grant_frame_id=grant-app/);
assert.match(grantLine, /grant_delegation_id=grant-app-delegation/);
assert.match(grantLine, /grant_audience_b64url=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE/);
assert.match(grantLine, /parent_id=grant-delegation/);
assert.match(grantLine, /delegation_frame_count=3/);

const authorLine = townshipReleaseAuthorProbeLogLine({
  phase: "author",
  outcome: "authored",
  postFrameId: "post",
  badFrameId: "bad",
  capId: "grant-delegation",
  authorPublicKeyBase64: "YWJj",
  localOpCount: 4,
  carrierFrameCount: 2,
});
assert.match(authorLine, /phase=author/);
assert.match(authorLine, /outcome=authored/);
assert.match(authorLine, /post_frame_id=post/);
assert.match(authorLine, /bad_frame_id=bad/);
assert.match(authorLine, /outbox_frame_count=2/);

const pushLine = townshipReleaseAuthorProbeLogLine({
  phase: "push",
  outcome: "synced",
  elapsedMs: 12,
  pushedFrameIds: ["bad", "post"],
  acceptedCount: 2,
  carrierFrameCount: 0,
  pendingCount: 0,
});
assert.match(pushLine, /phase=push/);
assert.match(pushLine, /pushed_frame_ids=bad,post/);
assert.match(pushLine, /outbox_frame_count=0/);

const peerLine = townshipReleaseAuthorProbeLogLine({
  phase: "peer",
  outcome: "reported",
  postFrameId: "post",
  badFrameId: "bad",
  postMaterialized: true,
  badAuthorityReason: "operation_not_granted",
  carrierFrameCount: 0,
});
assert.match(peerLine, /phase=peer/);
assert.match(peerLine, /post_materialized=true/);
assert.match(peerLine, /bad_authority_reason=operation_not_granted/);
assert.doesNotMatch(
  [nativeKeyLine, reloadLine, pullLine, grantLine, authorLine, pushLine, peerLine].join("\n"),
  /sig|body|cap:|seed|private|secret|webview_devtools_remote/,
);

const emitted: string[] = [];
const workflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
const result = await logTownshipReleaseAuthorProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL: "ws://127.0.0.1:43192/carrier",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_REPLICA: replica,
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE: "township:release-author-probe",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY: grantAudiencePubkey,
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_POST_TEXT: "release authored post",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_BAD_SUMMARY_TEXT: "release unauthorized summary",
  },
  {
    workflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    async sync({ phase, workflow: syncWorkflow }) {
      if (phase === "pull") {
        await syncWorkflow.localLog.save([{ id: "base" } as Op, { id: "grant" } as Op]);
        await syncWorkflow.delegationFrames.save([frame("base"), frame("grant")]);
        await syncWorkflow.carrierFrames.save([]);
        return syncResult({ pulledFrameCount: 1, pulledOpCount: 1, pushedFrameIds: [], acceptedCount: 0 });
      }
      await syncWorkflow.carrierFrames.save([]);
      return syncResult({ pulledFrameCount: 0, pulledOpCount: 0, pushedFrameIds: ["grant-app", "post", "bad"], acceptedCount: 3 });
    },
    async submitGrant({ workflow: grantWorkflow, config: grantConfig }) {
      assert.equal(grantConfig.grantAudiencePubkey, grantAudiencePubkey);
      await grantWorkflow.localLog.append({ id: "grant-app" } as Op);
      await grantWorkflow.carrierFrames.append(frame("grant-app"));
      await grantWorkflow.delegationFrames.append(frame("grant-app"));
      return {
        ok: true,
        audiencePubkey: grantAudiencePubkey,
        opId: "grant-app",
        frameId: "grant-app",
        delegationId: "grant-app-delegation",
        parentId: "grant-delegation",
        localOpCount: 3,
        carrierFrameCount: 1,
        delegationFrameCount: 3,
      };
    },
    async submitPost({ workflow: postWorkflow }) {
      await postWorkflow.localLog.append({ id: "post" } as Op);
      await postWorkflow.carrierFrames.append(frame("post"));
      return {
        ok: true,
        text: "release authored post",
        opId: "post",
        frameId: "post",
        capId: "grant-delegation",
        localOpCount: 3,
        carrierFrameCount: 1,
      };
    },
    async authorBadFrame({ workflow: badWorkflow }) {
      await badWorkflow.localLog.append({ id: "bad" } as Op);
      await badWorkflow.carrierFrames.append(frame("bad"));
      return { frameId: "bad" };
    },
    async findGrantDelegationId() {
      return "grant-delegation";
    },
    async stateReport() {
      return {
        ok: true,
        postMaterialized: true,
        badAuthorityReason: "operation_not_granted",
        appGrantAuthorityAccepted: true,
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
assert.match(emitted[2] ?? "", /phase=pull/);
assert.match(emitted[3] ?? "", /phase=grant/);
assert.match(emitted[3] ?? "", /grant_delegation_id=grant-app-delegation/);
assert.match(emitted[3] ?? "", /parent_id=grant-delegation/);
assert.match(emitted[4] ?? "", /phase=author/);
assert.match(emitted[5] ?? "", /phase=push/);
assert.match(emitted[5] ?? "", /pushed_frame_ids=bad,grant-app,post/);
assert.match(emitted[6] ?? "", /phase=peer/);
assert.match(emitted[6] ?? "", /bad_authority_reason=operation_not_granted/);

const resumeWorkflow = fakeWorkflow("ZGV2aWNlLXB1YmtleQ==");
await resumeWorkflow.localLog.save([
  { id: "base" } as Op,
  { id: "grant" } as Op,
  { id: "grant-app" } as Op,
  { id: "post" } as Op,
  { id: "bad" } as Op,
]);
await resumeWorkflow.delegationFrames.save([frame("base"), frame("grant"), frame("grant-app"), frame("post"), frame("bad")]);
await resumeWorkflow.carrierFrames.save([frame("grant-app"), frame("post"), frame("bad")]);
await resumeWorkflow.storage.setItem(
  TOWNSHIP_RELEASE_AUTHOR_PROBE_METADATA_KEY,
  JSON.stringify({
    stage: "authored",
    appGrantFrameId: "grant-app",
    appGrantDelegationId: "grant-app-delegation",
    grantAudiencePubkey,
    grantParentId: "grant-delegation",
    postFrameId: "post",
    badFrameId: "bad",
    capId: "grant-delegation",
    authorPublicKeyBase64: "ZGV2aWNlLXB1YmtleQ==",
  }),
);
const resumeEmitted: string[] = [];
const resumeResult = await logTownshipReleaseAuthorProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL: "ws://127.0.0.1:43192/carrier",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_REPLICA: replica,
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE: "township:release-author-probe",
    VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY: grantAudiencePubkey,
  },
  {
    workflow: resumeWorkflow,
    retryDelayMs: 1,
    timeoutMs: 50,
    async sync({ phase, workflow: syncWorkflow }) {
      assert.equal(phase, "push", "resume path should push the persisted outbox without re-authoring");
      await syncWorkflow.carrierFrames.save([]);
      return syncResult({ pulledFrameCount: 0, pulledOpCount: 0, pushedFrameIds: ["grant-app", "post", "bad"], acceptedCount: 3 });
    },
    async submitGrant() {
      assert.fail("resume path must not author a second grant");
    },
    async submitPost() {
      assert.fail("resume path must not author a second post");
    },
    async authorBadFrame() {
      assert.fail("resume path must not author a second bad frame");
    },
    async stateReport() {
      return {
        ok: true,
        postMaterialized: true,
        badAuthorityReason: "operation_not_granted",
        appGrantAuthorityAccepted: true,
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
assert.match(resumeEmitted[1] ?? "", /outbox_frame_count=3/);
assert.match(resumeEmitted[2] ?? "", /phase=push/);
assert.match(resumeEmitted[2] ?? "", /pushed_frame_ids=bad,grant-app,post/);
assert.match(resumeEmitted[3] ?? "", /phase=peer/);

console.log("\x1b[32m✓ release author probe contract checks passed\x1b[0m");

function fakeWorkflow(publicKeyBase64: string): TownshipNativeWorkflow {
  const localOps: Op[] = [];
  const carrierFrames: CarrierOpFrame[] = [];
  const delegationFrames: CarrierOpFrame[] = [];
  const storage = new Map<string, string>();
  return {
    keyId: "township-release-author-resident",
    storageNamespace: "township:release-author-probe",
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

function syncResult(overrides: {
  pulledFrameCount: number;
  pulledOpCount: number;
  pushedFrameIds: string[];
  acceptedCount: number;
}) {
  return {
    ok: true as const,
    localOpCount: 0,
    carrierFrameCount: 0,
    pulledFrameCount: overrides.pulledFrameCount,
    pulledOpCount: overrides.pulledOpCount,
    pushedFrameCount: overrides.pushedFrameIds.length,
    pushedFrameIds: overrides.pushedFrameIds,
    compactedFrameCount: overrides.pushedFrameIds.length,
    compactedFrameIds: overrides.pushedFrameIds,
    delegationFrameCount: 0,
    acceptedCount: overrides.acceptedCount,
    acceptedIds: overrides.pushedFrameIds,
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
