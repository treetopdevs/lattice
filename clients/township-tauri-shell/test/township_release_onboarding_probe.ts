import assert from "node:assert/strict";
import type { TownshipNativeWorkflow } from "../src/native_workflow";
import {
  logTownshipReleaseOnboardingProbeFromEnv,
  townshipReleaseOnboardingProbeConfigFromEnv,
  townshipReleaseOnboardingProbeLogLine,
  TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX,
} from "../src/township_release_onboarding_probe";
import type { TownshipCarrierPeerConfig } from "../src/township_carrier_peer";

console.log("\n▸ Township release onboarding probe contract");

const peer: TownshipCarrierPeerConfig = {
  url: "ws://127.0.0.1:43194/carrier",
  localRealm: "resident",
  expectedPeerRealm: "clerk",
  expectedPeerPubkey: "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=",
  replica: "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w",
  keyId: "township-release-onboarding-resident",
};

const config = townshipReleaseOnboardingProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: " resident ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID: " township-release-onboarding-resident ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE: " township:release-onboarding-probe ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: " release-onboarding-state-106 ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT: " release onboarding post ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT: " release onboarding bad summary ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY: " QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE= ",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_TIMEOUT_MS: "9000",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_RETRY_DELAY_MS: "250",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_PAUSE_AFTER_AUTHOR_MS: "25",
});
assert.deepEqual(config, {
  localRealm: "resident",
  keyId: "township-release-onboarding-resident",
  storageNamespace: "township:release-onboarding-probe",
  armState: "release-onboarding-state-106",
  postText: "release onboarding post",
  badSummaryText: "release onboarding bad summary",
  grantAudiencePubkey: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
  timeoutMs: 9000,
  retryDelayMs: 250,
  pauseAfterAuthorMs: 25,
});

const grantlessEnv = {
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: "resident",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID: "township-release-onboarding-resident",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE: "township:release-onboarding-probe",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: "release-onboarding-state-106",
};
const grantlessConfig = townshipReleaseOnboardingProbeConfigFromEnv(grantlessEnv);
assert.deepEqual(grantlessConfig, {
  localRealm: "resident",
  keyId: "township-release-onboarding-resident",
  storageNamespace: "township:release-onboarding-probe",
  armState: "release-onboarding-state-106",
  postText: "release probe post",
  badSummaryText: "release probe unauthorized summary",
});
const stateExchangeEnv = {
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: "resident",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID: "township-release-onboarding-state-resident",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE: "township:release-onboarding-state-probe",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL: "http://127.0.0.1:43197/pairing-state",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT: "release onboarding state post",
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT: "release onboarding state bad summary",
};
const stateExchangeConfig = townshipReleaseOnboardingProbeConfigFromEnv(stateExchangeEnv);
assert.deepEqual(stateExchangeConfig, {
  localRealm: "resident",
  keyId: "township-release-onboarding-state-resident",
  storageNamespace: "township:release-onboarding-state-probe",
  stateExchangeUrl: "http://127.0.0.1:43197/pairing-state",
  postText: "release onboarding state post",
  badSummaryText: "release onboarding state bad summary",
});
assert.equal(
  townshipReleaseOnboardingProbeConfigFromEnv({
    ...stateExchangeEnv,
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: "release-onboarding-state-106",
  }),
  null,
  "runtime state exchange must not share a build-time arm-state constant",
);
assert.equal(
  townshipReleaseOnboardingProbeConfigFromEnv({
    ...stateExchangeEnv,
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL: "http://example.test/pairing-state",
  }),
  null,
  "runtime state exchange must reject non-loopback cleartext callback URLs",
);
assert.equal(
  townshipReleaseOnboardingProbeConfigFromEnv({
    ...grantlessEnv,
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY: "QUFB",
  }),
  null,
  "malformed grant audience pubkey must disable the optional child-grant path",
);
assert.equal(
  townshipReleaseOnboardingProbeConfigFromEnv({
    ...grantlessEnv,
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY: "!!!",
  }),
  null,
  "invalid grant audience base64 must disable the optional child-grant path",
);
assert.equal(townshipReleaseOnboardingProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleaseOnboardingProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: "release-onboarding-state-106",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_URL: "ws://127.0.0.1:43194/carrier",
  }),
  null,
  "forbidden peer env must keep the single-APK onboarding probe from baking peer config",
);

const nativeKeyLine = townshipReleaseOnboardingProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "resident",
  storageNamespace: "township:release-onboarding-probe",
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);

const completeLine = townshipReleaseOnboardingProbeLogLine({
  phase: "complete",
  outcome: "reported",
  peerFingerprint: "65ed56fb...b5d440d9",
  postMaterialized: true,
  badAuthorityReason: "operation_not_granted",
});
assert.match(completeLine, /phase=complete/);
assert.match(completeLine, /outcome=reported/);
assert.match(completeLine, /post_materialized=true/);
assert.match(completeLine, /bad_authority_reason=operation_not_granted/);
assert.doesNotMatch([nativeKeyLine, completeLine].join("\n"), /sig|body|cap:|seed|private|secret|webview_devtools_remote/);

const emitted: string[] = [];
const result = await logTownshipReleaseOnboardingProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID: "township-release-onboarding-resident",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE: "township:release-onboarding-probe",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: "release-onboarding-state-106",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT: "release onboarding post",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT: "release onboarding bad summary",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
  },
  {
    workflow: fakeWorkflow(),
    async pair({ config: pairConfig, onResult }) {
      assert.equal(pairConfig.storageNamespace, "township:release-onboarding-probe");
      assert.equal(pairConfig.armState, "release-onboarding-state-106");
      await onResult?.({
        phase: "pairing",
        outcome: "saved",
        peerFingerprint: "65ed56fb...b5d440d9",
        hostClass: "loopback",
        urlPort: "43194",
      });
      return {
        phase: "sync",
        outcome: "synced",
        elapsedMs: 1,
        peerFingerprint: "65ed56fb...b5d440d9",
        pulledOpIds: ["grant"],
        localOpIds: ["grant"],
        delegationFrameIds: ["grant"],
        carrierFrameCount: 0,
        pushedFrameCount: 0,
        acceptedCount: 0,
      };
    },
    async loadPeer() {
      return peer;
    },
    async author({ config: authorConfig, onResult }) {
      assert.deepEqual(authorConfig.peer, peer);
      assert.equal(authorConfig.storageNamespace, "township:release-onboarding-probe");
      assert.equal(authorConfig.postText, "release onboarding post");
      assert.equal(authorConfig.grantAudiencePubkey, "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=");
      await onResult?.({
        phase: "pull",
        outcome: "synced",
        elapsedMs: 1,
        pulledOpIds: [],
        localOpIds: ["grant"],
        delegationFrameIds: ["grant"],
        carrierFrameCount: 0,
        pushedFrameCount: 0,
        acceptedCount: 0,
        grantDelegationId: "grant-delegation",
      });
      await onResult?.({
        phase: "grant",
        outcome: "authored",
        grantFrameId: "app-grant",
        grantDelegationId: "app-grant-delegation",
        grantAudiencePubkey: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
        grantOps: ["post"],
        parentId: "grant-delegation",
        authorPublicKeyBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        localOpCount: 2,
        carrierFrameCount: 1,
        delegationFrameCount: 2,
      });
      await onResult?.({
        phase: "author",
        outcome: "authored",
        postFrameId: "post",
        badFrameId: "bad",
        capId: "grant-delegation",
        authorPublicKeyBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        localOpCount: 3,
        carrierFrameCount: 2,
      });
      return {
        phase: "peer",
        outcome: "reported",
        postFrameId: "post",
        badFrameId: "bad",
        postMaterialized: true,
        badAuthorityReason: "operation_not_granted",
        carrierFrameCount: 0,
      };
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") emitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);

assert.equal(result?.phase, "complete");
assert.ok(emitted.some((line) => line.includes("township-release-pairing-probe phase=pairing outcome=saved")));
assert.ok(emitted.some((line) => line.includes("township-release-author-probe phase=grant outcome=authored")));
assert.ok(emitted.some((line) => line.includes("township-release-author-probe phase=author outcome=authored")));
assert.ok(emitted.some((line) => line.includes("township-release-onboarding-probe phase=complete outcome=reported")));

const stateExchangeEmitted: string[] = [];
const stateExchangeResult = await logTownshipReleaseOnboardingProbeFromEnv(stateExchangeEnv, {
  workflow: fakeWorkflow(),
  async pair({ config: pairConfig, onResult }) {
    assert.equal(pairConfig.storageNamespace, "township:release-onboarding-state-probe");
    assert.equal(pairConfig.armState, undefined);
    assert.equal(pairConfig.stateExchangeUrl, "http://127.0.0.1:43197/pairing-state");
    await onResult?.({
      phase: "pairing",
      outcome: "saved",
      peerFingerprint: "65ed56fb...b5d440d9",
      hostClass: "loopback",
      urlPort: "43194",
    });
    return {
      phase: "sync",
      outcome: "synced",
      elapsedMs: 1,
      peerFingerprint: "65ed56fb...b5d440d9",
      pulledOpIds: ["grant"],
      localOpIds: ["grant"],
      delegationFrameIds: ["grant"],
      carrierFrameCount: 0,
      pushedFrameCount: 0,
      acceptedCount: 0,
    };
  },
  async loadPeer() {
    return peer;
  },
  async author({ config: authorConfig, onResult }) {
    assert.deepEqual(authorConfig.peer, peer);
    assert.equal(authorConfig.storageNamespace, "township:release-onboarding-state-probe");
    assert.equal(authorConfig.postText, "release onboarding state post");
    await onResult?.({
      phase: "author",
      outcome: "authored",
      postFrameId: "post",
      badFrameId: "bad",
      capId: "grant-delegation",
      authorPublicKeyBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      localOpCount: 3,
      carrierFrameCount: 2,
    });
    return {
      phase: "peer",
      outcome: "reported",
      postFrameId: "post",
      badFrameId: "bad",
      postMaterialized: true,
      badAuthorityReason: "operation_not_granted",
      carrierFrameCount: 0,
    };
  },
  async invoke(command, args) {
    if (command === "lattice_log_probe") stateExchangeEmitted.push(String((args as { event?: unknown }).event));
    return null;
  },
});
assert.equal(stateExchangeResult?.phase, "complete");
assert.ok(
  stateExchangeEmitted.some((line) => line.includes("township-release-onboarding-probe phase=complete outcome=reported")),
);

const resumeEmitted: string[] = [];
let resumePairCalled = false;
const resumeResult = await logTownshipReleaseOnboardingProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID: "township-release-onboarding-resident",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE: "township:release-onboarding-probe",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE: "release-onboarding-state-106",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT: "release onboarding post",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT: "release onboarding bad summary",
    VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
  },
  {
    workflow: fakeWorkflow({ peer, carrierFrameIds: ["bad", "post"] }),
    async pair() {
      resumePairCalled = true;
      throw new Error("pending authored frames must resume through the author probe, not pairing sync");
    },
    async author({ config: authorConfig, onResult }) {
      assert.deepEqual(authorConfig.peer, peer);
      assert.equal(authorConfig.storageNamespace, "township:release-onboarding-probe");
      assert.equal(authorConfig.grantAudiencePubkey, "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=");
      await onResult?.({
        phase: "push",
        outcome: "synced",
        elapsedMs: 1,
        pushedFrameIds: ["bad", "post"],
        acceptedCount: 2,
        carrierFrameCount: 0,
        pendingCount: 0,
      });
      return {
        phase: "peer",
        outcome: "reported",
        postFrameId: "post",
        badFrameId: "bad",
        postMaterialized: true,
        badAuthorityReason: "operation_not_granted",
        carrierFrameCount: 0,
      };
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") resumeEmitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);
assert.equal(resumePairCalled, false);
assert.equal(resumeResult?.phase, "complete");
assert.ok(resumeEmitted.some((line) => line.includes("township-release-pairing-probe phase=reload outcome=loaded paired=true")));
assert.ok(resumeEmitted.some((line) => line.includes("township-release-author-probe phase=push outcome=synced")));

console.log("\x1b[32m✓ Township release onboarding probe contract passed\x1b[0m");

function fakeWorkflow(options: { peer?: TownshipCarrierPeerConfig; carrierFrameIds?: string[] } = {}): TownshipNativeWorkflow {
  const storage = new Map<string, string>();
  if (options.peer) storage.set("carrier_peer_config", JSON.stringify(options.peer));
  const emptyStore = {
    load: async () => [],
    save: async () => undefined,
    append: async () => undefined,
  };
  const carrierFrames = {
    load: async () => (options.carrierFrameIds ?? []).map((id) => ({ id })),
    save: async () => undefined,
    append: async () => undefined,
  };
  return {
    keyId: "township-release-onboarding-resident",
    storageNamespace: "township:release-onboarding-probe",
    storage: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: async (key: string) => {
        storage.delete(key);
      },
    },
    localLog: emptyStore,
    carrierFrames,
    delegationFrames: emptyStore,
    signer: {
      publicKey: new Uint8Array(32).fill(1),
      sign: async () => new Uint8Array(64),
    },
  } as unknown as TownshipNativeWorkflow;
}
