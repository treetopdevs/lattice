import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import {
  analyzeAuthority, canonicalBytesForCarrierOp, canonicalOrder, carrierOpsToSemanticOps, continuationFamily,
  index, materialize, verifyCarrierOp,
} from "../src/index";
import { authorCarrierOp, canonicalBytesForCarrierDelegation } from "../src/codec";
import {
  canonicalBytesForContinuationClaim, canonicalBytesForContinuationProfile,
  continuationProfileId,
} from "../src/continuation";
import type { CarrierOpFrame, ReplicaSchema } from "../src/index";

interface Vector {
  name: string; replica: string; role: string; schema: ReplicaSchema;
  realmByPubkey: Record<string, string>; frames: CarrierOpFrame[];
  canonical: {id: string; bytes: string}[]; reasons: Record<string, string>;
  holderEpoch: string | null; posts: unknown[];
  profiles: {opId: string; profileId: string; bytes: string}[];
  certificates: {opId: string; claimBytes: string}[];
}

/** Called from the existing conformance gate; no separate CI opt-in. */
export async function runBoundedContinuationConformance(): Promise<void> {
  for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.equal(continuationFamily(`replica:treehouse:space:bad${separator}nonce#authority:bounded-continuation-v1#root:bad`),
      "unsupported", "malformed reserved family cannot fall back through a line separator");
  }
  const vectors: Vector[] = JSON.parse(readFileSync(new URL("./vectors/continuation/authority.json", import.meta.url), "utf8"));
  const verifier = {verify: async (author: string, bytes: Uint8Array, sig: Uint8Array) =>
    ed25519.verify(sig, bytes, Buffer.from(author, "base64"), {zip215: false})};
  for (const vector of vectors) {
    for (const frame of vector.frames) assert.equal((await verifyCarrierOp(frame, verifier)).valid, true, `${vector.name}: authenticated frame`);
    const ops = carrierOpsToSemanticOps(vector.frames, vector.realmByPubkey);
    const byId = index(ops);
    const analysis = analyzeAuthority(vector.schema, ops, new Set(byId.keys()), canonicalOrder(ops, byId), byId, vector.replica);
    const result = materialize(vector.schema, ops, undefined, null, vector.replica);
    assert.deepEqual(Object.fromEntries(result.quarantineReasons), vector.reasons, `${vector.name}: public quarantine`);
    assert.deepEqual(result.state.posts, vector.posts, `${vector.name}: public posts`);
    assert.equal(analysis.acquiresByRole.get(vector.role)?.at(-1)?.opId ?? null, vector.holderEpoch, `${vector.name}: acquisition token`);
    for (const proof of vector.canonical) {
      const frame = vector.frames.find((op) => op.id === proof.id)!;
      assert.equal(Buffer.from(canonicalBytesForCarrierOp(frame)).toString("base64"), proof.bytes, `${vector.name}: signed operation bytes`);
    }
    for (const proof of vector.profiles) {
      const evidence = byId.get(proof.opId)!.authority;
      assert.equal(evidence?.type, "genesis");
      if (evidence?.type !== "genesis") throw new Error("missing profile genesis");
      assert.equal(continuationProfileId(evidence.continuationProfile), proof.profileId);
      assert.equal(Buffer.from(canonicalBytesForContinuationProfile(evidence.continuationProfile)).toString("base64"), proof.bytes);
    }
    for (const proof of vector.certificates) {
      const evidence = byId.get(proof.opId)!.authority;
      if (evidence?.type !== "succeed" || evidence.proof.mode !== "continuation") throw new Error("missing continuation");
      assert.equal(Buffer.from(canonicalBytesForContinuationClaim(evidence.proof.certificate!.claim)).toString("base64"), proof.claimBytes);
    }
    const reversed = [...ops].reverse();
    const reverseResult = materialize(vector.schema, reversed, undefined, null, vector.replica);
    const reverseById = index(reversed);
    const reverseAnalysis = analyzeAuthority(vector.schema, reversed, new Set(reverseById.keys()), canonicalOrder(reversed, reverseById), reverseById, vector.replica);
    assert.deepEqual(reverseResult.state, result.state, `${vector.name}: reversed delivery`);
    assert.deepEqual(reverseResult.quarantineReasons, result.quarantineReasons, `${vector.name}: reversed quarantine`);
    assert.equal(reverseAnalysis.acquiresByRole.get(vector.role)?.at(-1)?.opId ?? null, vector.holderEpoch, `${vector.name}: reversed acquisition`);
  }
  await twinSignedRevokedDelegation(vectors);
  console.log(`PASS bounded continuation: ${vectors.length} signed BEAM/TS histories, including 13 two-cycle replicas`);
}

/**
 * Row 193 review (Codex P1): the nominee controls its continuation delegation's key, so it
 * can introduce the same content-addressed delegation again under a second valid Ed25519
 * signature (nonce r = 7 below). Elixir keeps the first valid introduction, so the root's
 * revoke stays authorized and the claim refuses as revoked_capability; TS must agree.
 */
async function twinSignedRevokedDelegation(vectors: Vector[]): Promise<void> {
  const vector = vectors.find((v) => v.name === "space:revoked-delegation");
  if (vector === undefined) throw new Error("missing space:revoked-delegation");
  const claim = vector.frames.find((f) => JSON.stringify(f.body).includes('["atom","continuation_v1"]'))!;
  const body = claim.body as unknown as ["tuple", [unknown, unknown, ["delegation", Record<string, unknown>], unknown]];
  const delegation = body[1][2][1];
  const seed = sha256(new TextEncoder().encode("r04-fixture:nominee"));
  const publicKey = ed25519.getPublicKey(seed);
  const scalar = ed25519.utils.getExtendedPublicKey(seed).scalar;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const le = (bytes: Uint8Array) => BigInt("0x" + Buffer.from(bytes).reverse().toString("hex"));
  const bytes32 = (n: bigint) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex")).reverse();
  const message = canonicalBytesForCarrierDelegation(delegation as never);
  const r = 7n;
  const R = ed25519.Point.BASE.multiply(r).toBytes();
  const k = le(sha512(Uint8Array.from([...R, ...publicKey, ...message]))) % L;
  const twin = Uint8Array.from([...R, ...bytes32((r + k * scalar) % L)]);
  assert.equal(ed25519.verify(twin, message, publicKey, {zip215: false}), true, "twin signature is valid");
  assert.notEqual(Buffer.from(twin).toString("base64"), delegation.sig, "twin signature differs");
  const intro = await authorCarrierOp({
    replica: vector.replica,
    deps: [vector.frames[0]!.id],
    kind: "authority",
    cap: ["nil"],
    body: ["tuple", [["atom", "grant"], ["delegation", {...delegation, sig: Buffer.from(twin).toString("base64")}]]],
    signer: {publicKey, sign: async (bytes: Uint8Array) => ed25519.sign(bytes, seed)},
  } as never);
  const ops = carrierOpsToSemanticOps([...vector.frames, intro], vector.realmByPubkey);
  const result = materialize(vector.schema, ops, undefined, null, vector.replica);
  const revoke = ops.find((op) => op.authority?.type === "revoke")!;
  assert.equal(result.quarantineReasons.get(claim.id), "revoked_capability", "twin-signed claim stays revoked");
  assert.equal(result.quarantineReasons.get(revoke.id), undefined, "the root revoke stays authorized");
  assert.deepEqual([...result.quarantineReasons], [[claim.id, "revoked_capability"]],
    "only the claim quarantines (bounded_continuation_test V12 twin pins the BEAM verdict)");
}
