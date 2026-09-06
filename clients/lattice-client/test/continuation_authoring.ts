import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import type { CarrierDelegation, CarrierTerm } from "../src/carrier";
import { canonicalBytesForContinuationClaim, continuationProfileId, continuationProfileToCarrierTerm } from "../src/continuation";
import type { ContinuationProfile } from "../src/continuation";
import { bindTownshipReplica } from "../src/township";
import { assembleContinuationFromFrames, reviewContinuationFromFrames } from "../src/continuation_authoring";
import type { ContinuationReview, ReviewContinuationFromFramesInput } from "../src/continuation_authoring";
import { analyzeAuthority } from "../src/authority";
import { carrierOpsToSemanticOps } from "../src/carrier";
import { canonicalOrder, index } from "../src/dag";
import type { ReplicaSchema } from "../src/schema";

const schema: ReplicaSchema = { name: "ContinuationAuthoringFixture", fields: { admin: { authority: "admin" } } };
const atom = (name: string): CarrierTerm => ["atom", name];
const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
const nil: CarrierTerm = ["nil"];
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const signer = (seedByte: number): CarrierOpSigner => {
  const seed = new Uint8Array(32).fill(seedByte);
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};

async function fixture(familyVersion = "bounded-continuation-v1", kind: "space" | "thread" = "space") {
  const role = kind === "space" ? "admin" : "moderator";
  const roleSchema: ReplicaSchema = { name: schema.name, fields: { [role]: { authority: role } } };
  const root = signer(1), holder = signer(2), nominee = signer(3);
  const witnesses = [signer(4), signer(5)].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(
    `replica:treehouse:${kind}:${Buffer.alloc(32, 11).toString("base64url")}#authority:${familyVersion}`,
    root.publicKey,
  );
  const profile: ContinuationProfile = { mode: "bounded_continuation", version: 1, product: "treehouse",
    kind, role, nominee: b64(nominee.publicKey),
    witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
  const original = await authorCarrierDelegation({ replica, audiencePubkey: root.publicKey,
    ops: ["manage", "post"], roles: [role], signer: root });
  const genesis = await authorCarrierOp({ replica, deps: [], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("genesis"), ["delegation", original], ["map", []]) });
  const previous = await authorCarrierDelegation({ replica, audiencePubkey: holder.publicKey,
    parentId: original.id, ops: ["post"], roles: [role], expiresEpoch: 2, signer: root });
  const transfer = await authorCarrierOp({ replica, deps: [genesis.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("transfer"), atom(role), ["delegation", previous], ["int", 0]) });
  const empty = await authorCarrierDelegation({ replica, audiencePubkey: root.publicKey, signer: root });
  const pin = await authorCarrierOp({ replica, deps: [transfer.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("genesis"), ["delegation", empty], ["map", [
      [atom("__continuation__"), continuationProfileToCarrierTerm(profile)!],
    ]]) });
  const beacon = await authorCarrierOp({ replica, deps: [pin.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("beacon"), ["int", 5]) });
  const delegation = await authorCarrierDelegation({ replica, audiencePubkey: holder.publicKey,
    ops: ["post"], roles: [role], expiresEpoch: 11, signer: holder });
  return { root, holder, nominee, witnesses, replica, profile, genesis, transfer, pin, beacon, delegation,
    input: { schema: roleSchema, frames: [genesis, transfer, pin, beacon], replica, role,
      author: b64(holder.publicKey), deps: [beacon.id], delegation } satisfies ReviewContinuationFromFramesInput };
}

test("authenticated complete history derives actual pin, expired predecessor scope and finite epoch review", async () => {
  const f = await fixture();
  const result = await reviewContinuationFromFrames(f.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.review.claim, {
    version: 1, product: "treehouse", kind: "space", replica: f.replica, role: "admin",
    profileId: continuationProfileId(f.profile), profileGenesis: f.pin.id,
    holder: b64(f.holder.publicKey), holderEpoch: f.transfer.id,
    successor: b64(f.holder.publicKey), delegationId: f.delegation.id,
    author: b64(f.holder.publicKey), deps: [f.beacon.id], epoch: 5, epochBasis: [f.beacon.id],
  });
  assert.deepEqual(result.review.profile, f.profile);
  assert.deepEqual(result.review.delegation, f.delegation);
});

async function reviewed(f: Awaited<ReturnType<typeof fixture>>): Promise<ContinuationReview> {
  const result = await reviewContinuationFromFrames(f.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.review;
}

async function certificate(review: ContinuationReview, witnesses: CarrierOpSigner[]) {
  const bytes = canonicalBytesForContinuationClaim(review.claim);
  return { claim: review.claim, signatures: await Promise.all(witnesses.map(async (witness) => ({
    witness: b64(witness.publicKey), signature: b64(await witness.sign(bytes)),
  }))) };
}

test("fresh assembly signs a normal op honored by the public authority judge", async () => {
  const f = await fixture(), review = await reviewed(f);
  const result = await assembleContinuationFromFrames({ schema, frames: f.input.frames, review,
    certificate: await certificate(review, f.witnesses), signer: f.holder });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.frame.kind, "authority");
  assert.equal(result.frame.author, b64(f.holder.publicKey));
  assert.deepEqual(result.frame.cap, nil);
  assert.deepEqual(result.frame.deps, [f.beacon.id]);
  assert.equal((await verifyCarrierOp(result.frame, { verify: async (author, bytes, sig) =>
    ed25519.verify(sig, bytes, Buffer.from(author, "base64"), { zip215: false }) })).valid, true);
  const ops = carrierOpsToSemanticOps([...f.input.frames, result.frame]);
  const byId = index(ops), order = canonicalOrder(ops, byId);
  const analysis = analyzeAuthority(schema, ops, new Set(order), order, byId, f.replica);
  assert.equal(analysis.quarantineReasons.has(result.frame.id), false);
  assert.equal(analysis.honoredWrites.has(result.frame.id), true);
  assert.deepEqual(analysis.security.honoredSuccessionIntroductions.get(f.delegation.id), [result.frame.id]);
});

test("raw history refuses wrong hashes, signatures, replicas, duplicates and incomplete closure", async () => {
  const f = await fixture();
  const forgedSig = { ...f.beacon, sig: b64(new Uint8Array(64).fill(42)) };
  const forgedBody = { ...f.beacon, body: tuple(atom("beacon"), ["int", 6]) };
  const other = await fixture("bounded-continuation-v2");
  for (const frames of [
    [...f.input.frames.slice(0, -1), forgedSig],
    [...f.input.frames.slice(0, -1), forgedBody],
    [...f.input.frames.slice(0, -1), { ...f.beacon, id: Buffer.alloc(32, 9).toString("base64url") }],
    [...f.input.frames, f.beacon],
    f.input.frames.filter((frame) => frame.id !== f.pin.id),
    [...f.input.frames, other.genesis],
    [...f.input.frames, null],
  ]) assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, frames }),
    { ok: false, reason: "invalid_verified_history" });
});

test("authenticated but malformed authority stays in the reviewed frontier", async () => {
  const f = await fixture();
  const malformed = await authorCarrierOp({ replica: f.replica, deps: [f.beacon.id],
    kind: "authority", signer: f.holder, cap: nil,
    body: tuple(atom("succeed"), atom("admin"), atom("missing_delegation"),
      tuple(atom("continuation_v1"), ["map", []])) });
  const frames = [...f.input.frames, malformed];
  const ops = carrierOpsToSemanticOps(frames);
  assert.equal(ops.at(-1)?.authorityInputReason, "malformed_term");
  const result = await reviewContinuationFromFrames({ ...f.input, frames, deps: [malformed.id] });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.review.claim.deps, [malformed.id]);
  assert.equal(result.review.claim.holderEpoch, f.transfer.id);
  assert.deepEqual(result.review.claim.epochBasis, [f.beacon.id]);
});

test("unknown signed family and display aliases cannot create an authorized review", async () => {
  const unknown = await fixture("bounded-continuation-v2");
  assert.deepEqual(await reviewContinuationFromFrames(unknown.input),
    { ok: false, reason: "unsupported_authority_profile" });
  const f = await fixture();
  assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, author: "holder" }),
    { ok: false, reason: "unauthorized_continuation" });
});

test("review authenticates a new delegation and enforces inherited scope and the finite window", async () => {
  const f = await fixture();
  for (const delegation of [
    { ...f.delegation, sig: b64(new Uint8Array(64)) },
    { ...f.delegation, expires_epoch: 10 },
    { ...f.delegation, id: Buffer.alloc(32, 10).toString("base64url") },
  ]) assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, delegation }),
    { ok: false, reason: "unauthorized_continuation" });
  for (const changes of [
    { ops: ["manage", "post"] }, { roles: ["admin", "moderator"] }, { live: true },
    { parentId: f.delegation.id }, { expiresEpoch: 4 }, { expiresEpoch: 12 },
  ]) {
    const delegation = await authorCarrierDelegation({ replica: f.replica,
      audiencePubkey: f.holder.publicKey, ops: ["post"], roles: ["admin"],
      expiresEpoch: 11, signer: f.holder, ...changes });
    assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, delegation }),
      { ok: false, reason: "continuation_scope_exceeded" }, JSON.stringify(changes));
  }
  const unleased = await authorCarrierDelegation({ replica: f.replica,
    audiencePubkey: f.holder.publicKey, ops: ["post"], roles: ["admin"], signer: f.holder });
  assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, delegation: unleased }),
    { ok: false, reason: "continuation_scope_exceeded" });
  const malformed = { ...f.delegation, expires_epoch: null } as unknown as CarrierDelegation;
  assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, delegation: malformed }),
    { ok: false, reason: "malformed_term" });
});

test("only the actual frozen frontier can be reviewed", async () => {
  const f = await fixture();
  for (const deps of [[], [f.pin.id], [f.beacon.id, f.beacon.id]]) {
    assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, deps }),
      { ok: false, reason: "stale_verified_state" });
  }
  const reordered = await reviewContinuationFromFrames({ ...f.input, frames: [...f.input.frames].reverse() });
  assert.deepEqual(reordered, { ok: true, review: await reviewed(f) });
});

test("changed current frontier or caller facts refuse before invoking the signer", async () => {
  const f = await fixture(), review = await reviewed(f), cert = await certificate(review, f.witnesses);
  let calls = 0;
  const guarded = { publicKey: f.holder.publicKey, sign: (bytes: Uint8Array) => {
    calls++; return f.holder.sign(bytes);
  } };
  const later = await authorCarrierOp({ replica: f.replica, deps: [f.beacon.id], kind: "authority",
    signer: f.root, cap: nil, body: tuple(atom("beacon"), ["int", 6]) });
  assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: [...f.input.frames, later],
    review, certificate: cert, signer: guarded }), { ok: false, reason: "stale_verified_state" });
  for (const changed of [
    { ...review, claim: { ...review.claim, holder: b64(f.nominee.publicKey) } },
    { ...review, claim: { ...review.claim, profileGenesis: f.genesis.id } },
    { ...review, profile: { ...review.profile, maxLeaseEpochs: 8 } },
  ]) assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames,
    review: changed, certificate: cert, signer: guarded }), { ok: false, reason: "stale_verified_state" });
  assert.equal(calls, 0);
});

test("certificate replay against a new delegation, invalid surplus, and wrong signer refuse", async () => {
  const f = await fixture(), review = await reviewed(f), cert = await certificate(review, f.witnesses);
  const delegation = await authorCarrierDelegation({ replica: f.replica, audiencePubkey: f.holder.publicKey,
    ops: ["post"], roles: ["admin"], expiresEpoch: 10, signer: f.holder });
  const changed = await reviewContinuationFromFrames({ ...f.input, delegation });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  let calls = 0;
  const guarded = { publicKey: f.holder.publicKey, sign: (bytes: Uint8Array) => {
    calls++; return f.holder.sign(bytes);
  } };
  assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames,
    review: changed.review, certificate: cert, signer: guarded }),
  { ok: false, reason: "invalid_continuation_certificate" });
  for (const bad of [
    { ...cert, signatures: cert.signatures.slice(0, 1) },
    { ...cert, signatures: [...cert.signatures, cert.signatures[0]!] },
    { ...cert, signatures: [cert.signatures[0]!, { ...cert.signatures[1]!, signature: b64(new Uint8Array(64)) }] },
  ]) assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames,
    review, certificate: bad, signer: guarded }), { ok: false, reason: "invalid_continuation_certificate" });
  assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames,
    review, certificate: cert, signer: { ...guarded, publicKey: f.nominee.publicKey } }),
  { ok: false, reason: "wrong_signer" });
  assert.equal(calls, 0);
});

test("the pinned nominee can author but a consumed predecessor certificate cannot be reused", async () => {
  const f = await fixture();
  const delegation = await authorCarrierDelegation({ replica: f.replica, audiencePubkey: f.nominee.publicKey,
    ops: ["post"], roles: ["admin"], expiresEpoch: 11, signer: f.nominee });
  const result = await reviewContinuationFromFrames({ ...f.input, author: b64(f.nominee.publicKey), delegation });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cert = await certificate(result.review, f.witnesses);
  const assembled = await assembleContinuationFromFrames({ schema, frames: f.input.frames,
    review: result.review, certificate: cert, signer: f.nominee });
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;
  const reused = await assembleContinuationFromFrames({ schema, frames: [...f.input.frames, assembled.frame],
    review: result.review, certificate: cert, signer: f.nominee });
  assert.deepEqual(reused, { ok: false, reason: "stale_verified_state" });
});

test("Thread moderator review and assembly use the explicit role schema", async () => {
  const f = await fixture("bounded-continuation-v1", "thread"), review = await reviewed(f);
  assert.equal(review.claim.kind, "thread");
  assert.equal(review.claim.role, "moderator");
  const result = await assembleContinuationFromFrames({ schema: f.input.schema, frames: f.input.frames,
    review, certificate: await certificate(review, f.witnesses), signer: f.holder });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const ops = carrierOpsToSemanticOps([...f.input.frames, result.frame]);
  const byId = index(ops), order = canonicalOrder(ops, byId);
  const analysis = analyzeAuthority(f.input.schema, ops, new Set(order), order, byId, f.replica);
  assert.equal(analysis.honoredWrites.has(result.frame.id), true);
  assert.equal(analysis.acquiresByRole.get("moderator")?.at(-1)?.holderPubkey, b64(f.holder.publicKey));
  assert.deepEqual(await reviewContinuationFromFrames({ ...f.input, schema }),
    { ok: false, reason: "unauthorized_continuation" });
});

test("snapshot ownership isolates caller mutations during asynchronous verification", async () => {
  const f = await fixture(), expected = await reviewed(f);
  const mutable = structuredClone(f.input);
  const pendingReview = reviewContinuationFromFrames(mutable);
  mutable.delegation.roles.push("moderator");
  mutable.frames[0]!.sig = "invalid";
  mutable.deps.length = 0;
  assert.deepEqual(await pendingReview, { ok: true, review: expected });

  const review = structuredClone(expected), frames = structuredClone(f.input.frames);
  const cert = await certificate(review, f.witnesses);
  const pendingFrame = assembleContinuationFromFrames({ schema, frames, review,
    certificate: cert, signer: f.holder });
  // These mutations are not a store change signal. The caller must serialize
  // live store updates; assembly is explicitly bound to its invocation snapshot.
  review.claim.epoch = 99;
  cert.signatures.length = 0;
  frames[0]!.sig = "invalid";
  const assembled = await pendingFrame;
  assert.equal(assembled.ok, true);
  if (!assembled.ok) return;
  const ops = carrierOpsToSemanticOps([...f.input.frames, assembled.frame]);
  const byId = index(ops), order = canonicalOrder(ops, byId);
  assert.equal(analyzeAuthority(schema, ops, new Set(order), order, byId, f.replica)
    .honoredWrites.has(assembled.frame.id), true);
});

test("signer failures and invalid returned signatures fail closed", async () => {
  const f = await fixture(), review = await reviewed(f), cert = await certificate(review, f.witnesses);
  assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames, review,
    certificate: cert, signer: { publicKey: f.holder.publicKey, sign: () => new Uint8Array(64) } }),
  { ok: false, reason: "invalid_signer_signature" });
  assert.deepEqual(await assembleContinuationFromFrames({ schema, frames: f.input.frames, review,
    certificate: cert, signer: { publicKey: f.holder.publicKey, sign: () => { throw new Error("locked"); } } }),
  { ok: false, reason: "invalid_continuation_input" });
});
