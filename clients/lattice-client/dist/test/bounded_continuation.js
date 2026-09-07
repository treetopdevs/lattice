import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority, canonicalBytesForCarrierOp, canonicalOrder, carrierOpsToSemanticOps, continuationFamily, index, materialize, verifyCarrierOp, } from "../src/index";
import { canonicalBytesForContinuationClaim, canonicalBytesForContinuationProfile, continuationProfileId, } from "../src/continuation";
/** Called from the existing conformance gate; no separate CI opt-in. */
export async function runBoundedContinuationConformance() {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
        assert.equal(continuationFamily(`replica:treehouse:space:bad${separator}nonce#authority:bounded-continuation-v1#root:bad`), "unsupported", "malformed reserved family cannot fall back through a line separator");
    }
    const vectors = JSON.parse(readFileSync(new URL("./vectors/continuation/authority.json", import.meta.url), "utf8"));
    const verifier = { verify: async (author, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(author, "base64"), { zip215: false }) };
    for (const vector of vectors) {
        for (const frame of vector.frames)
            assert.equal((await verifyCarrierOp(frame, verifier)).valid, true, `${vector.name}: authenticated frame`);
        const ops = carrierOpsToSemanticOps(vector.frames, vector.realmByPubkey);
        const byId = index(ops);
        const analysis = analyzeAuthority(vector.schema, ops, new Set(byId.keys()), canonicalOrder(ops, byId), byId, vector.replica);
        const result = materialize(vector.schema, ops, undefined, null, vector.replica);
        assert.deepEqual(Object.fromEntries(result.quarantineReasons), vector.reasons, `${vector.name}: public quarantine`);
        assert.deepEqual(result.state.posts, vector.posts, `${vector.name}: public posts`);
        assert.equal(analysis.acquiresByRole.get(vector.role)?.at(-1)?.opId ?? null, vector.holderEpoch, `${vector.name}: acquisition token`);
        for (const proof of vector.canonical) {
            const frame = vector.frames.find((op) => op.id === proof.id);
            assert.equal(Buffer.from(canonicalBytesForCarrierOp(frame)).toString("base64"), proof.bytes, `${vector.name}: signed operation bytes`);
        }
        for (const proof of vector.profiles) {
            const evidence = byId.get(proof.opId).authority;
            assert.equal(evidence?.type, "genesis");
            if (evidence?.type !== "genesis")
                throw new Error("missing profile genesis");
            assert.equal(continuationProfileId(evidence.continuationProfile), proof.profileId);
            assert.equal(Buffer.from(canonicalBytesForContinuationProfile(evidence.continuationProfile)).toString("base64"), proof.bytes);
        }
        for (const proof of vector.certificates) {
            const evidence = byId.get(proof.opId).authority;
            if (evidence?.type !== "succeed" || evidence.proof.mode !== "continuation")
                throw new Error("missing continuation");
            assert.equal(Buffer.from(canonicalBytesForContinuationClaim(evidence.proof.certificate.claim)).toString("base64"), proof.claimBytes);
        }
        const reversed = [...ops].reverse();
        const reverseResult = materialize(vector.schema, reversed, undefined, null, vector.replica);
        const reverseById = index(reversed);
        const reverseAnalysis = analyzeAuthority(vector.schema, reversed, new Set(reverseById.keys()), canonicalOrder(reversed, reverseById), reverseById, vector.replica);
        assert.deepEqual(reverseResult.state, result.state, `${vector.name}: reversed delivery`);
        assert.deepEqual(reverseResult.quarantineReasons, result.quarantineReasons, `${vector.name}: reversed quarantine`);
        assert.equal(reverseAnalysis.acquiresByRole.get(vector.role)?.at(-1)?.opId ?? null, vector.holderEpoch, `${vector.name}: reversed acquisition`);
    }
    console.log(`PASS bounded continuation: ${vectors.length} signed BEAM/TS histories, including 13 two-cycle replicas`);
}
