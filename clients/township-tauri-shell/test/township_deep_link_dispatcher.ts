import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTownshipParticipantDeepLinkDispatcher,
  type TownshipActionIntentTrace,
} from "../src/township_deep_link_dispatcher";
import type {
  TownshipActionIntent,
  TownshipReviewableActionIntent,
} from "../src/township_action_intent";

interface ActionIntentFixture {
  payload: {
    v: 1;
    id: string;
    replica: string;
    command: { command: "post"; text: string };
  };
  url: string;
}

interface StatusActionIntentFixture {
  payload: Extract<TownshipActionIntent, { v: 2 }>;
  url: string;
}

interface FieldActionIntentFixture {
  payload: Extract<TownshipActionIntent, { v: 3 }>;
  url: string;
}

interface RosterActionIntentFixture {
  payload: Extract<TownshipActionIntent, { v: 4 }>;
  url: string;
}

console.log("\n▸ Township participant deep-link dispatcher");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_action_intent_v1.json"), "utf8"),
) as ActionIntentFixture;
const statusFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_status_action_intent_v2.json"), "utf8"),
) as StatusActionIntentFixture;
const fieldFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_field_action_intent_v3.json"), "utf8"),
) as FieldActionIntentFixture;
const titleFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_title_action_intent_v3.json"), "utf8"),
) as FieldActionIntentFixture;
const removeMemberFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_remove_member_action_intent_v4.json"), "utf8"),
) as RosterActionIntentFixture;
const admitFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_admit_action_intent_v4.json"), "utf8"),
) as RosterActionIntentFixture;
const pairingUrl = "township://pairing?handoff=township-pairing:v1:not-json";
const androidPairingUrl = "township://nohost/_pairing/township-pairing_3Av1_3Anot-json";
const calls: string[] = [];
const staged: TownshipReviewableActionIntent[] = [];
const rejected: string[] = [];
const other: string[] = [];
const traces: TownshipActionIntentTrace[] = [];
let expectedReplica: string | null = fixture.payload.replica;
let opened: ((urls: readonly string[]) => void) | null = null;
let unlistenCount = 0;

const dispatcher = await createTownshipParticipantDeepLinkDispatcher({
  source: {
    async current() {
      calls.push("current");
      return [pairingUrl, fixture.url, statusFixture.url, androidPairingUrl];
    },
    async onOpenUrl(callback) {
      calls.push("subscribe");
      opened = callback;
      return () => {
        unlistenCount++;
      };
    },
  },
  expectedReplica: () => expectedReplica,
  stageAction(intent) {
    staged.push(intent);
  },
  rejectAction(rejection) {
    rejected.push(rejection.reason);
  },
  routeOther(url) {
    other.push(url);
  },
  traceAction(trace) {
    traces.push(trace);
  },
});

assert.deepEqual(calls, ["subscribe", "current"], "dispatcher must close the cold-start subscription race");
assert.deepEqual(staged, [fixture.payload, statusFixture.payload]);
assert.deepEqual(other, [pairingUrl, androidPairingUrl]);
assert.deepEqual(rejected, []);
assert.deepEqual(traces, [
  { intentId: fixture.payload.id, outcome: "staged" },
  { intentId: statusFixture.payload.id, outcome: "staged" },
]);
assert.ok(opened, "dispatcher should retain one participant-ingress callback");

expectedReplica = fieldFixture.payload.replica;
opened([fieldFixture.url, titleFixture.url]);
assert.deepEqual(staged, [fixture.payload, statusFixture.payload, fieldFixture.payload, titleFixture.payload]);

opened([fieldFixture.url]);
assert.deepEqual(
  staged,
  [fixture.payload, statusFixture.payload, fieldFixture.payload, titleFixture.payload, fieldFixture.payload],
  "repeated ingress remains review-only and observable",
);

expectedReplica = removeMemberFixture.payload.replica;
const stagedBeforeRoster = staged.length;
const rejectedBeforeRoster = rejected.length;
opened([removeMemberFixture.url, admitFixture.url, removeMemberFixture.url]);
assert.deepEqual(staged.slice(stagedBeforeRoster), [
  removeMemberFixture.payload,
  admitFixture.payload,
  removeMemberFixture.payload,
]);
assert.equal(rejected.length, rejectedBeforeRoster);
assert.deepEqual(traces.slice(-3), [
  { intentId: removeMemberFixture.payload.id, outcome: "staged" },
  { intentId: admitFixture.payload.id, outcome: "staged" },
  { intentId: removeMemberFixture.payload.id, outcome: "staged" },
]);

opened(["township://action?intent=not-base64url!"]);
assert.equal(rejected.at(-1), "invalid_action");
assert.equal(other.includes("township://action?intent=not-base64url!"), false);

expectedReplica = "replica:matter:other";
opened([titleFixture.url]);
assert.equal(rejected.at(-1), "replica_mismatch");

expectedReplica = null;
opened([fieldFixture.url]);
assert.equal(rejected.at(-1), "pairing_missing");

opened(["garbage", "township://probe/canonical?vector=township_carrier_w1"]);
assert.deepEqual(other.slice(-2), ["garbage", "township://probe/canonical?vector=township_carrier_w1"]);

assert.deepEqual(traces.slice(-3), [
  { intentId: null, outcome: "invalid_action" },
  { intentId: titleFixture.payload.id, outcome: "replica_mismatch" },
  { intentId: fieldFixture.payload.id, outcome: "pairing_missing" },
]);

const traceBytes = JSON.stringify(traces);
assert.doesNotMatch(traceBytes, /resident: from instrument/);
assert.doesNotMatch(traceBytes, /Needs traffic study/);
assert.doesNotMatch(traceBytes, /Budget Hearing/);
assert.doesNotMatch(traceBytes, /replica:matter/);
assert.doesNotMatch(traceBytes, /township:\/\/action/);

dispatcher.stop();
assert.equal(unlistenCount, 1);

console.log("\x1b[32m✓ Township participant deep-link dispatcher checks passed\x1b[0m");
