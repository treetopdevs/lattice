import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority } from "../../src/authority";
import { carrierOpsToSemanticOps } from "../../src/carrier";
import type { CarrierTerm } from "../../src/carrier";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp } from "../../src/codec";
import type { CarrierOpSigner } from "../../src/codec";
import { canonicalBytesForContinuationClaim, canonicalBytesForContinuationProfile,
  continuationProfileId, continuationProfileToCarrierTerm } from "../../src/continuation";
import type { ContinuationProfile } from "../../src/continuation";
import { assembleContinuationFromFrames, reviewContinuationFromFrames } from "../../src/continuation_authoring";
import { canonicalOrder, index } from "../../src/dag";
import type { ReplicaSchema } from "../../src/schema";
import { bindTownshipReplica } from "../../src/township";

// The same deterministic, synthetic actors and lifecycle as continuation_authoring.ts.
// Space exercises holder renewal; Thread exercises the pinned nominee. No keys
// or authority evidence are read from the environment or an external fixture.
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const atom = (name: string): CarrierTerm => ["atom", name];
const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
const nil: CarrierTerm = ["nil"];
function signer(seedByte: number): CarrierOpSigner {
  const seed = new Uint8Array(32).fill(seedByte);
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
}

async function authorVector(kind: "space" | "thread") {
  const role = kind === "space" ? "admin" : "moderator";
  const schema: ReplicaSchema = { name: "ContinuationAuthoringFixture", fields: { [role]: { authority: role } } };
  const root = signer(1), holder = signer(2), nominee = signer(3);
  const successor = kind === "space" ? holder : nominee;
  const witnesses = [signer(4), signer(5)].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(
    `replica:treehouse:${kind}:${Buffer.alloc(32, 11).toString("base64url")}#authority:bounded-continuation-v1`,
    root.publicKey,
  );
  const profile: ContinuationProfile = { mode: "bounded_continuation", version: 1, product: "treehouse",
    kind, role, nominee: b64(nominee.publicKey), witnesses: witnesses.map((w) => b64(w.publicKey)),
    threshold: 2, maxLeaseEpochs: 7 };
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
  const delegation = await authorCarrierDelegation({ replica, audiencePubkey: successor.publicKey,
    ops: ["post"], roles: [role], expiresEpoch: 11, signer: successor });
  const history = [genesis, transfer, pin, beacon];
  const reviewed = await reviewContinuationFromFrames({ schema, frames: history, replica, role,
    author: b64(successor.publicKey), deps: [beacon.id], delegation });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const claim = reviewed.review.claim;
  const claimBytes = canonicalBytesForContinuationClaim(claim);
  const certificate = { claim, signatures: await Promise.all(witnesses.map(async (witness) => ({
    witness: b64(witness.publicKey), signature: b64(await witness.sign(claimBytes)),
  }))) };
  const assembled = await assembleContinuationFromFrames({ schema, frames: history,
    review: reviewed.review, certificate, signer: successor });
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  const frames = [...history, assembled.frame];
  const ops = carrierOpsToSemanticOps(frames), byId = index(ops), order = canonicalOrder(ops, byId);
  const analysis = analyzeAuthority(schema, ops, new Set(order), order, byId, replica);
  assert.equal(analysis.honoredWrites.has(assembled.frame.id), true);
  assert.deepEqual([...analysis.quarantineReasons], []);
  assert.deepEqual(analysis.security.honoredSuccessionIntroductions.get(delegation.id), [assembled.frame.id]);
  assert.equal(analysis.acquiresByRole.get(role)?.at(-1)?.holderPubkey, b64(successor.publicKey));
  return { kind, role, replica, schema, frames, finalOpId: assembled.frame.id,
    holder: b64(successor.publicKey), delegationId: delegation.id,
    canonical: frames.map((frame) => ({ id: frame.id, bytes: b64(canonicalBytesForCarrierOp(frame)) })),
    profileId: continuationProfileId(profile), profileBytes: b64(canonicalBytesForContinuationProfile(profile)),
    claimBytes: b64(claimBytes), profile, claim, certificate };
}

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1])) {
  throw new Error("usage: tsx test/support/export_continuation_authoring.ts [--out <path>]");
}
const defaultPath = fileURLToPath(new URL("../vectors/continuation/ts_authoring.json", import.meta.url));
const output = args.length === 0 ? defaultPath : resolve(args[1]!);
const vectors = { version: 1, vectors: [await authorVector("space"), await authorVector("thread")] };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`Exported ${vectors.vectors.length} TS-authored continuation histories to ${output}`);
