import assert from "node:assert/strict";
import {
  logTownshipReleaseBeamProbeFromEnv,
  townshipReleaseBeamProbeConfigFromEnv,
  townshipReleaseBeamProbeLogLine,
  TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX,
  type TownshipReleaseBeamProbeResult,
} from "../src/township_release_beam_probe";
import type { TownshipNativeWorkflow } from "../src/native_workflow";

console.log("\n▸ Township release BEAM probe contract");

const peerPubkey = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const replica = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";

const config = townshipReleaseBeamProbeConfigFromEnv({
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL: " ws://127.0.0.1:43190/carrier ",
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM: " resident ",
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM: " clerk ",
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY: ` ${peerPubkey} `,
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_REPLICA: ` ${replica} `,
});
assert.deepEqual(config, {
  url: "ws://127.0.0.1:43190/carrier",
  localRealm: "resident",
  expectedPeerRealm: "clerk",
  expectedPeerPubkey: peerPubkey,
  replica,
});
assert.equal(townshipReleaseBeamProbeConfigFromEnv({}), null);
assert.equal(
  townshipReleaseBeamProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL: "https://127.0.0.1:43190/carrier",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);
assert.equal(
  townshipReleaseBeamProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL: "ws://10.0.2.2:43190/carrier",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);
assert.equal(
  townshipReleaseBeamProbeConfigFromEnv({
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL: "wss://example.com/carrier",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY: peerPubkey,
  }),
  null,
);

const nativeKeyLine = townshipReleaseBeamProbeLogLine({
  phase: "native_key",
  publicKeyBase64: "YWJj",
  localRealm: "resident",
});
assert.match(nativeKeyLine, new RegExp(`^${TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX} `));
assert.match(nativeKeyLine, /phase=native_key/);
assert.match(nativeKeyLine, /local_realm=resident/);
assert.match(nativeKeyLine, /public_key_b64url=YWJj/);

const connectedLine = townshipReleaseBeamProbeLogLine({
  phase: "carrier",
  urlScheme: "ws",
  hostClass: "loopback",
  outcome: "connected",
  elapsedMs: 12,
  status: "base",
  opCount: 9,
  authorityQuarantineCount: 0,
});
assert.match(connectedLine, /phase=carrier/);
assert.match(connectedLine, /host_class=loopback/);
assert.match(connectedLine, /outcome=connected/);
assert.match(connectedLine, /status=base/);
assert.match(connectedLine, /op_count=9/);
assert.match(connectedLine, /authority_quarantine_count=0/);
assert.doesNotMatch(connectedLine, /Sync outbox|stateReport|webview_devtools_remote/);

const emitted: string[] = [];
let attempts = 0;
const result = await logTownshipReleaseBeamProbeFromEnv(
  {
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL: "ws://127.0.0.1:43190/carrier",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM: "resident",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM: "clerk",
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY: peerPubkey,
    VITE_TOWNSHIP_RELEASE_BEAM_PROBE_REPLICA: replica,
  },
  {
    workflow: fakeWorkflow("ZGV2aWNlLXB1YmtleQ=="),
    retryDelayMs: 1,
    timeoutMs: 50,
    async connect() {
      attempts++;
      if (attempts === 1) throw new Error("peer not ready");
      return {
        async status() {
          return "base";
        },
        async stateReport() {
          return {
            state_b64: "state",
            op_ids: ["a", "b"],
            frontier: ["b"],
            structural_quarantine: [],
            authority_quarantine: [["stale", "not_holder"]],
            log_size: 2,
          };
        },
        close() {},
      };
    },
    async invoke(command, args) {
      if (command === "lattice_log_probe") emitted.push(String((args as { event?: unknown }).event));
      return null;
    },
  },
);

assert.equal(result?.outcome, "connected");
assert.equal((result as Extract<TownshipReleaseBeamProbeResult, { phase: "carrier" }>).opCount, 2);
assert.equal(attempts, 2);
assert.match(emitted[0] ?? "", /phase=native_key/);
assert.match(emitted[0] ?? "", /public_key_b64url=ZGV2aWNlLXB1YmtleQ/);
assert.match(emitted[1] ?? "", /phase=carrier/);
assert.match(emitted[1] ?? "", /outcome=connected/);
assert.match(emitted[1] ?? "", /authority_quarantine_count=1/);

console.log("\x1b[32m✓ release BEAM probe contract checks passed\x1b[0m");

function fakeWorkflow(publicKeyBase64: string): TownshipNativeWorkflow {
  return {
    keyId: "township-resident",
    storageNamespace: "township:zoning-variance-24",
    storage: {
      async getItem() {
        return null;
      },
      async setItem() {},
      async removeItem() {},
    },
    localLog: {} as TownshipNativeWorkflow["localLog"],
    carrierFrames: {} as TownshipNativeWorkflow["carrierFrames"],
    delegationFrames: {} as TownshipNativeWorkflow["delegationFrames"],
    signer: {
      publicKey: new Uint8Array(Buffer.from(publicKeyBase64, "base64")),
      async sign() {
        return new Uint8Array([1, 2, 3]);
      },
    },
  };
}
