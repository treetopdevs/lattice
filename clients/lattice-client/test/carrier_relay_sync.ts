import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  syncCarrierOnce,
  type CarrierOpFrame,
  type CarrierPushReport,
  type CarrierRelayClient,
  type CarrierSyncClient,
} from "../src/index";

interface CarrierVector {
  realmByPubkey: Record<string, string>;
  clientDivergedCarrierOps: CarrierOpFrame[];
}

type RelayOutcome = CarrierPushReport | Error;

class ScriptedRelaySyncClient implements CarrierSyncClient, CarrierRelayClient {
  readonly relayedIds: string[] = [];
  advertiseCalls = 0;
  pushCalls = 0;

  constructor(
    private readonly advertisements: string[][],
    private readonly outcomes: ReadonlyMap<string, RelayOutcome>,
  ) {}

  async advertise(): Promise<string[]> {
    const index = Math.min(this.advertiseCalls, this.advertisements.length - 1);
    this.advertiseCalls++;
    return [...(this.advertisements[index] ?? [])];
  }

  async pull(): Promise<unknown[]> {
    return [];
  }

  async push(): Promise<CarrierPushReport> {
    this.pushCalls++;
    throw new Error("generic push fallback called");
  }

  async relay(op: CarrierOpFrame): Promise<CarrierPushReport> {
    this.relayedIds.push(op.id);
    const outcome = this.outcomes.get(op.id);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? emptyReport();
  }
}

class PushRecordingClient implements CarrierSyncClient {
  readonly pushedIds: string[] = [];

  async advertise(): Promise<string[]> {
    return [];
  }

  async pull(): Promise<unknown[]> {
    return [];
  }

  async push(ops: unknown[]): Promise<CarrierPushReport> {
    this.pushedIds.push(...(ops as CarrierOpFrame[]).map((op) => op.id));
    return { ...emptyReport(), accepted: [...this.pushedIds] };
  }
}

console.log("\n▸ Relay-aware carrier sync");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const [genesis, grant, , , summary, post] = vector.clientDivergedCarrierOps;
if (!genesis || !grant || !summary || !post) throw new Error("missing relay sync fixtures");
const localOps = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);

const defaultPush = new PushRecordingClient();
const defaultFrames = [post, summary];
const defaultSynced = await syncCarrierOnce(defaultPush, localOps, defaultFrames, vector.realmByPubkey);
assert.deepEqual(defaultPush.pushedIds, defaultFrames.map((frame) => frame.id));
assert.deepEqual(defaultSynced.pushedFrames, defaultFrames);

const relayFrames = [post, grant, genesis, summary];
const relayReports = new Map<string, RelayOutcome>([
  [genesis.id, { ...emptyReport(), accepted: [genesis.id] }],
  [grant.id, { ...emptyReport(), quarantined: [[grant.id, "authority"]] }],
  [summary.id, { ...emptyReport(), rejected: [[summary.id, "invalid"]] }],
  [post.id, { ...emptyReport(), pending: [post.id] }],
]);
const relayClient = new ScriptedRelaySyncClient([[]], relayReports);
const relaySynced = await syncCarrierOnce(
  relayClient,
  localOps,
  relayFrames,
  vector.realmByPubkey,
  { submission: "relay" },
);
const causalOrder = [genesis.id, grant.id, summary.id, post.id];
assert.deepEqual(relayClient.relayedIds, causalOrder);
assert.equal(relayClient.pushCalls, 0);
assert.deepEqual(relaySynced.pushedFrames.map(frameId), causalOrder);
assert.deepEqual(relaySynced.pushReport, {
  accepted: [genesis.id],
  quarantined: [[grant.id, "authority"]],
  rejected: [[summary.id, "invalid"]],
  pending: [post.id],
});
assert.deepEqual(relaySynced.acknowledgedFrameIds, [genesis.id]);

const confirmedDuplicateClient = new ScriptedRelaySyncClient([[], [post.id]], new Map());
const confirmedDuplicate = await syncCarrierOnce(
  confirmedDuplicateClient,
  localOps,
  [post],
  vector.realmByPubkey,
  { submission: "relay" },
);
assert.equal(confirmedDuplicateClient.advertiseCalls, 2);
assert.deepEqual(confirmedDuplicateClient.relayedIds, [post.id]);
assert.deepEqual(confirmedDuplicate.pushReport, emptyReport());
assert.deepEqual(confirmedDuplicate.acknowledgedFrameIds, [post.id]);

const unconfirmedDuplicateClient = new ScriptedRelaySyncClient([[], []], new Map());
const unconfirmedDuplicate = await syncCarrierOnce(
  unconfirmedDuplicateClient,
  localOps,
  [post],
  vector.realmByPubkey,
  { submission: "relay" },
);
assert.equal(unconfirmedDuplicateClient.advertiseCalls, 2);
assert.deepEqual(unconfirmedDuplicate.acknowledgedFrameIds, []);

let pushFallbackCalls = 0;
const pushOnlyClient: CarrierSyncClient = {
  async advertise() {
    return [];
  },
  async pull() {
    return [];
  },
  async push() {
    pushFallbackCalls++;
    return { ...emptyReport(), accepted: [post.id] };
  },
};
await assert.rejects(
  () => syncCarrierOnce(pushOnlyClient, localOps, [post], vector.realmByPubkey, { submission: "relay" }),
  /does not support relay/,
);
assert.equal(pushFallbackCalls, 0);

console.log("\x1b[32m✓ Relay-aware carrier sync checks passed\x1b[0m");

function emptyReport(): CarrierPushReport {
  return { accepted: [], quarantined: [], rejected: [], pending: [] };
}

function frameId(frame: unknown): string {
  if (frame && typeof frame === "object" && typeof (frame as { id?: unknown }).id === "string") {
    return (frame as { id: string }).id;
  }
  throw new Error("carrier frame missing id");
}
