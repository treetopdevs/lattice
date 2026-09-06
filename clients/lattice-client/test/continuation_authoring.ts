import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import type { CarrierTerm } from "../src/carrier";
import { canonicalBytesForContinuationClaim, continuationProfileId, continuationProfileToCarrierTerm } from "../src/continuation";
import type { ContinuationProfile } from "../src/continuation";
import { bindTownshipReplica } from "../src/township";
import { assembleContinuationFromFrames, reviewContinuationFromFrames } from "../src/continuation_authoring";
import type { ContinuationReview } from "../src/continuation_authoring";
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

async function fixture() {
  const root = signer(1), holder = signer(2), nominee = signer(3);
  const witnesses = [signer(4), signer(5)].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(
    `replica:treehouse:space:${Buffer.alloc(32, 11).toString("base64url")}#authority:bounded-continuation-v1`,
    root.publicKey,
  );
  const profile: ContinuationProfile = { mode: "bounded_continuation", version: 1, product: "treehouse",
    kind: "space", role: "admin", nominee: b64(nominee.publicKey),
    witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
  const original = await authorCarrierDelegation({ replica, audiencePubkey: root.publicKey,
    ops: ["manage", "post"], roles: ["admin"], signer: root });
  const genesis = await authorCarrierOp({ replica, deps: [], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("genesis"), ["delegation", original], ["map", []]) });
  const previous = await authorCarrierDelegation({ replica, audiencePubkey: holder.publicKey,
    parentId: original.id, ops: ["post"], roles: ["admin"], expiresEpoch: 2, signer: root });
  const transfer = await authorCarrierOp({ replica, deps: [genesis.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("transfer"), atom("admin"), ["delegation", previous], ["int", 0]) });
  const empty = await authorCarrierDelegation({ replica, audiencePubkey: root.publicKey, signer: root });
  const pin = await authorCarrierOp({ replica, deps: [transfer.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("genesis"), ["delegation", empty], ["map", [
      [atom("__continuation__"), continuationProfileToCarrierTerm(profile)!],
    ]]) });
  const beacon = await authorCarrierOp({ replica, deps: [pin.id], kind: "authority", signer: root, cap: nil,
    body: tuple(atom("beacon"), ["int", 5]) });
  const delegation = await authorCarrierDelegation({ replica, audiencePubkey: holder.publicKey,
    ops: ["post"], roles: ["admin"], expiresEpoch: 11, signer: holder });
  return { root, holder, nominee, witnesses, replica, profile, genesis, transfer, pin, beacon, delegation,
    input: { schema, frames: [genesis, transfer, pin, beacon], replica, role: "admin" as const,
      author: b64(holder.publicKey), deps: [beacon.id], delegation } };
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
  if (!result.ok) throw new Error(result.reason);
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
  assert.equal(analysis.security.delegations.get(f.delegation.id)?.validation.valid, true);
});
