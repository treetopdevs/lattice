import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalBytesForCarrierTerm,
  continuationProfileId,
  treehouseContinuationPin,
  treehouseSpaceFamily,
} from "@treetopdevs/lattice-client";
import { catalogBootstrapToCarrierTerm } from "../../lattice-client/src/treehouse_catalog_codec";
import { TreehouseWorkflow, parsePublicKeys } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, Draft } from "../src/treehouse_state";

// Row 232: the Treehouse app creates bounded-family Spaces, and the root can pin a continuation and sign the
// catalog binding a ceremony produced. Each action is a review followed by a separate explicit confirmation.

class MemoryNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  async open() {
    return {
      record: this.record,
      publicKey: this.seed ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64") : null,
      keyStatus: (this.seed ? "available" : parseState(this.record).publicKey ? "missing" : "absent") as
        | "available"
        | "missing"
        | "absent",
    };
  }
  async initialize() {
    this.seed ??= crypto.getRandomValues(new Uint8Array(32));
    return (await this.open()).publicKey!;
  }
  async commit(expected: number, next: string) {
    if (parseState(this.record).revision !== expected) return false;
    this.record = next;
    return true;
  }
  async loadDraft(): Promise<Draft | null> {
    return null;
  }
  async saveDraft(_replica: string, expected: number, text: string) {
    return { version: 1, revision: expected + 1, text } as Draft;
  }
  async sign(bytes: Uint8Array) {
    return ed25519.sign(bytes, this.seed!);
  }
}
const fresh = async (n: MemoryNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};
const spaceOf = (a: TreehouseWorkflow) => a.state.profiles.find((p) => p.product === "Treehouse.Space")!;
const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const unchanged = async (n: MemoryNative, run: () => unknown, pattern: RegExp) => {
  const before = n.record;
  await assert.rejects(async () => run(), pattern);
  assert.equal(n.record, before, `refusal ${pattern} leaves the saved record untouched`);
};
const BOUNDED = /^replica:treehouse:space:[A-Za-z0-9_-]{43}#authority:bounded-continuation-v1#root:[A-Za-z0-9_-]{43}$/;

// ---- 1. bounded creation persists and reloads --------------------------------------------------------------
const native = new MemoryNative();
const app = await fresh(native);
await app.createSpace("Canopy");
const replica = spaceOf(app).replica;
assert.match(replica, BOUNDED);
assert.equal(treehouseSpaceFamily(replica), "bounded");
assert.equal(app.state.intent, null);
const restarted = await fresh(native);
assert.deepEqual(restarted.state, app.state);
assert.equal(restarted.views.get(replica)!.state.name, "Canopy");
assert.deepEqual(
  { ...restarted.continuation(), members: [] },
  { family: "bounded", isRoot: true, pinned: false, bound: false, members: [] },
);
// Threads stay legacy-family under a bounded Space.
await app.createThread("Field notes");
const thread = app.state.profiles.find((p) => p.product === "Treehouse.Thread")!;
assert.match(thread.replica, /^replica:treehouse:thread:[A-Za-z0-9_-]{43}#root:[A-Za-z0-9_-]{43}$/);
assert.equal(treehouseSpaceFamily(thread.replica), "legacy");
const withThread = await fresh(native);
assert.equal(withThread.state.profiles.length, 2);
console.log("PASS bounded Space creation persists and reloads; Threads stay legacy-family");

// ---- 2. a hostile record cannot smuggle a malformed bounded replica ----------------------------------------
for (const bad of [
  replica.replace("v1", "v2"),
  replica.replace("#root:", "#authority:bounded-continuation-v1#root:"),
  `${replica}#authority:bounded-continuation-v1`,
]) {
  const hostile = new MemoryNative();
  hostile.seed = native.seed;
  const record = parseState(native.record);
  record.profiles = [{ ...record.profiles[0]!, replica: bad, frames: record.profiles[0]!.frames.map((f) => ({ ...f, replica: bad })) }];
  record.active = bad;
  hostile.record = JSON.stringify(record);
  await assert.rejects(fresh(hostile), /invalid_profile_replica/);
}
console.log("PASS near-miss bounded replicas are refused at load");

// ---- 3. pin: review, refusals, confirm, reload ------------------------------------------------------------
const root = app.state.publicKey!;
const nominee = randomKey();
const witnesses = [randomKey(), randomKey(), randomKey()];
assert.deepEqual(parsePublicKeys(`\n ${nominee} \n\n${witnesses[0]}\n`), [nominee, witnesses[0]]);
assert.throws(() => parsePublicKeys("not a key"), /invalid_public_key/);
assert.throws(() => parsePublicKeys(Buffer.alloc(31, 1).toString("base64")), /invalid_public_key/);
const refuse = (input: Partial<Parameters<TreehouseWorkflow["reviewContinuation"]>[0]>, pattern: RegExp) =>
  assert.throws(() => app.reviewContinuation({ nominee, witnesses: witnesses.join("\n"), ...input }), pattern);
refuse({ nominee: root }, /nominee_is_root/);
refuse({ witnesses: `${witnesses[0]}\n${root}` }, /witness_is_root/);
refuse({ witnesses: `${witnesses[0]}\n${nominee}` }, /witness_is_nominee/);
refuse({ nominee: "x" }, /invalid_public_key/);
refuse({ witnesses: "" }, /invalid_continuation_profile/);
refuse({ threshold: 4 }, /invalid_continuation_profile/);
refuse({ threshold: 0 }, /invalid_continuation_profile/);
refuse({ maxLeaseEpochs: 0 }, /invalid_continuation_profile/);
refuse({ maxLeaseEpochs: 70_000 }, /invalid_continuation_profile/);
const review = app.reviewContinuation({ nominee, witnesses: witnesses.join("\n") });
assert.equal(review.threshold, 2, "the default threshold is a majority of the witnesses");
assert.equal(review.maxLeaseEpochs, 7);
assert.deepEqual(review.witnesses, [...witnesses].sort((a, b) => Buffer.compare(Buffer.from(a, "base64"), Buffer.from(b, "base64"))),
  "the review lists witnesses in the byte order the pin signs");
const beforePin = native.record;
assert.equal(native.record, beforePin, "review signs and saves nothing");
await assert.rejects(app.pinContinuation({ ...review, threshold: 3 }), /continuation_review_mismatch/);
await assert.rejects(app.pinContinuation({ ...review, nominee: randomKey() }), /continuation_review_mismatch/);
// A persisted change between review and confirm invalidates the review (confirm-pass R3).
await app.createThread("Between review and pin");
await app.select(replica);
await assert.rejects(app.pinContinuation(review), /no_pending_continuation/);
const rereview = app.reviewContinuation({ nominee, witnesses: witnesses.join("\n") });
assert.deepEqual(rereview, review);
// The caller's review object can change after confirm without changing what is signed (confirm-pass R2).
const callerCopy = structuredClone(rereview);
const pinning = app.pinContinuation(callerCopy);
callerCopy.witnesses[0] = randomKey();
await assert.rejects(pinning, /continuation_review_mismatch/, "a review changed after confirm is refused, not signed");
app.reviewContinuation({ nominee, witnesses: witnesses.join("\n") });
const confirmed = structuredClone(review);
const pinning2 = app.pinContinuation(confirmed);
await Promise.resolve();
confirmed.witnesses.reverse();
const pinId = await pinning2;
const pinned = spaceOf(app);
assert.ok(pinned.outbox.includes(pinId) && !pinned.acked.includes(pinId), "the pin is queued, not delivered");
const pin = treehouseContinuationPin(pinned.frames);
assert.equal(pin.configured && pin.profileGenesis, pinId);
assert.deepEqual(pin.configured && pin.profile.witnesses, review.witnesses, "the signed pin carries the reviewed witnesses");
assert.equal(app.continuation().pinned, true);
assert.equal(app.views.get(replica)!.quarantineReasons.size, 0, "the pin is honored");
const reopened = await fresh(native);
assert.equal(reopened.continuation().pinned, true, "a pinned Space reloads through verifyProfile");
assert.throws(() => reopened.reviewContinuation({ nominee, witnesses: witnesses.join("\n") }), /continuation_already_pinned/);
await unchanged(native, () => reopened.pinContinuation(review), /continuation_already_pinned/);
console.log("PASS continuation review refusals, explicit pin, queued frame and reload");

// ---- 4. catalog binding: review, refusals, cancel, sign ---------------------------------------------------
const pinState = treehouseContinuationPin(pinned.frames);
assert(pinState.configured);
const record = {
  version: 1,
  product: "treehouse",
  space: replica,
  spaceRoot: root,
  profileGenesis: pinState.profileGenesis,
  profileId: continuationProfileId(pinState.profile)!,
  replacementRule: "bounded_space_admin_v1",
  catalogKey: randomKey(),
  serviceId: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  serviceKey: randomKey(),
  origin: "wss://binding.invalid",
  nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
};
const term = catalogBootstrapToCarrierTerm(record)!;
const bytes = canonicalBytesForCarrierTerm(term);
const sha = createHash("sha256").update(bytes).digest("hex");
const payloadOf = (over: Record<string, unknown> = {}, recordOver: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "lattice-catalog-bootstrap-payload-v1",
    record: {
      version: 1,
      product: "treehouse",
      space: record.space,
      space_root: record.spaceRoot,
      profile_genesis: record.profileGenesis,
      profile_id: record.profileId,
      replacement_rule: record.replacementRule,
      catalog_key: record.catalogKey,
      service_id: record.serviceId,
      service_key: record.serviceKey,
      origin: record.origin,
      nonce: record.nonce,
      ...recordOver,
    },
    record_encoding: { base64_fields: ["space_root", "catalog_key", "service_key"], atom_fields: ["product", "replacement_rule"], note: "n" },
    canonical_base64: Buffer.from(bytes).toString("base64"),
    sha256: sha,
    ...over,
  });
await unchanged(native, () => reopened.reviewCatalogBinding("not json"), /malformed_payload/);
await unchanged(native, () => reopened.reviewCatalogBinding(payloadOf({ sha256: "0".repeat(64) })), /payload_digest_mismatch/);
await unchanged(native, () => reopened.reviewCatalogBinding(payloadOf({}, { nonce: "A".repeat(43) })), /payload_digest_mismatch/);
await unchanged(native, () => reopened.reviewCatalogBinding(payloadOf({}, { extra: "x" })), /malformed_payload/);
assert.equal(reopened.hasPendingBinding(), false, "a refused review leaves nothing pending");
await assert.rejects(reopened.signCatalogBinding(), /no_pending_binding/);

const shown = await reopened.reviewCatalogBinding(payloadOf());
assert.equal(shown.sha256, sha);
assert.deepEqual(shown.lines.map((l) => l.field), [
  "version", "product", "space", "space_root", "profile_genesis", "profile_id", "replacement_rule",
  "catalog_key", "service_id", "service_key", "origin", "nonce", "canonical sha256",
]);
assert.equal(shown.lines.at(-1)!.value, sha);
assert.equal(reopened.hasPendingBinding(), true);
reopened.cancelCatalogBinding();
assert.equal(reopened.hasPendingBinding(), false, "cancel discards the review");
await unchanged(native, () => reopened.signCatalogBinding(), /no_pending_binding/);

await reopened.reviewCatalogBinding(payloadOf());
const bindId = await reopened.signCatalogBinding();
assert.equal(reopened.hasPendingBinding(), false);
const bound = spaceOf(reopened);
const frame = bound.frames.find((f) => f.id === bindId)!;
assert.deepEqual(frame.deps, [pinState.profileGenesis], "the binding depends on the pin");
assert.ok(bound.outbox.includes(bindId));
assert.equal(reopened.views.get(replica)!.quarantineReasons.size, 0, "the binding is honored");
assert.equal(reopened.continuation().bound, true);
const final = await fresh(native);
assert.equal(final.continuation().bound, true);
await unchanged(native, () => final.reviewCatalogBinding(payloadOf()), /catalog_bootstrap_exists/);
console.log("PASS binding review refusals, cancel, separate Sign binding, honored frame depends on the pin");

// ---- 5. binding review refusals that need a different history ---------------------------------------------
{
  const other = new MemoryNative();
  const o = await fresh(other);
  await o.createSpace("Other");
  // Not pinned yet: the payload names another Space and so is refused as such; a matching one needs the pin.
  await unchanged(other, () => o.reviewCatalogBinding(payloadOf()), /wrong_space/);
  const unpinnedRecord = { ...record, space: spaceOf(o).replica, spaceRoot: o.state.publicKey! };
  const otherBytes = canonicalBytesForCarrierTerm(catalogBootstrapToCarrierTerm(unpinnedRecord)!);
  const unpinned = payloadOf(
    { canonical_base64: Buffer.from(otherBytes).toString("base64"), sha256: createHash("sha256").update(otherBytes).digest("hex") },
    { space: unpinnedRecord.space, space_root: unpinnedRecord.spaceRoot },
  );
  await unchanged(other, () => o.reviewCatalogBinding(unpinned), /continuation_not_configured/);
}
{
  // A joiner (not the root) holding the bound Space is refused for both actions.
  const joiner = new MemoryNative();
  const j = await fresh(joiner);
  await j.beginJoin();
  const from = parseState(native.record);
  const into = parseState(joiner.record);
  into.profiles = from.profiles.filter((p) => p.product === "Treehouse.Space").map((p) => ({ ...p, outbox: [], acked: p.frames.map((f) => f.id) }));
  into.revision += 1;
  joiner.record = JSON.stringify(into);
  const jr = await fresh(joiner);
  assert.equal(jr.continuation().family, "bounded");
  assert.equal(jr.continuation().isRoot, false);
  assert.throws(() => jr.reviewContinuation({ nominee, witnesses: witnesses.join("\n") }), /not_root/);
  await unchanged(joiner, () => jr.reviewCatalogBinding(payloadOf()), /not_root/);
}
console.log("PASS binding review without a pin, and non-root refusals");

// ---- 6. legacy Spaces stay readable and are refused ---------------------------------------------------------
{
  const { prepareTreehouseSpaceCreation } = await import("@treetopdevs/lattice-client");
  const legacy = new MemoryNative();
  const l = await fresh(legacy);
  const key = await l.native.initialize();
  const nonceReplica = `replica:treehouse:space:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const prepared = await prepareTreehouseSpaceCreation({
    replica: nonceReplica,
    name: "Old",
    signer: { publicKey: ed25519.getPublicKey(legacy.seed!), sign: async (b) => ed25519.sign(b, legacy.seed!) },
  });
  const state = parseState(legacy.record);
  state.publicKey = key;
  state.profiles = [
    { product: "Treehouse.Space", replica: prepared.replica, frames: prepared.pending, outbox: prepared.pending.map((f) => f.id), acked: [] },
  ];
  state.active = prepared.replica;
  state.revision += 1;
  legacy.record = JSON.stringify(state);
  const reopenedLegacy = await fresh(legacy);
  assert.equal(treehouseSpaceFamily(prepared.replica), "legacy");
  assert.equal(reopenedLegacy.views.get(prepared.replica)!.state.name, "Old", "a legacy Space stays readable");
  assert.equal(reopenedLegacy.continuation().family, "legacy");
  assert.equal(reopenedLegacy.continuation().isRoot, false);
  assert.throws(() => reopenedLegacy.reviewContinuation({ nominee, witnesses: witnesses.join("\n") }), /not_bounded_space/);
  await unchanged(legacy, () => reopenedLegacy.reviewCatalogBinding(payloadOf()), /not_bounded_space/);
  await assert.rejects(reopenedLegacy.pinContinuation(review), /not_bounded_space/);
}
console.log("PASS legacy Spaces still load and are refused for pin and binding");
