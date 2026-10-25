/** Fresh public product histories; every verdict comes from the actual owners. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeAuthority } from "../../src/authority";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../../src/carrier";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp, canonicalBytesForCarrierTerm, verifyCarrierOp } from "../../src/codec";
import { canonicalBytesForContinuationClaim, continuationClaimToCarrierTerm } from "../../src/continuation";
import { assembleContinuationFromFrames, reviewContinuationFromFrames } from "../../src/continuation_authoring";
import { canonicalOrder, index } from "../../src/dag";
import { treehouseCommandDecoders, treehouseSpaceSchema, treehouseThreadSchema } from "../../src/treehouse";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import { fixtureSigner, trustFixture } from "./export_treehouse_catalog_trust";
import { ed25519 } from "@noble/curves/ed25519.js";
const b64 = (b) => Buffer.from(b).toString("base64");
const atom = (s) => ["atom", s];
const tuple = (...v) => ["tuple", v];
const map = (fields) => ["map", Object.entries(fields).map(([k, v]) => [atom(k), v])];
export async function fixture(kind) {
    const f = await trustFixture();
    const item = kind === "space" ? f.space : f.threads[0];
    const schema = kind === "space" ? treehouseSpaceSchema : treehouseThreadSchema;
    const role = kind === "space" ? "admin" : "moderator";
    const deps = [item.frames.at(-1).id];
    const beacon = await authorCarrierOp({ replica: item.replica, signer: item.signer, deps, kind: "authority", cap: ["nil"], body: tuple(atom("beacon"), ["int", 0]) });
    const heartbeat = await authorCarrierOp({ replica: item.replica, signer: item.signer, deps, kind: "authority", cap: ["nil"], body: tuple(atom("heartbeat"), atom(role), ["int", 0]) });
    const prior = [...item.frames, beacon, heartbeat];
    const nominee = fixtureSigner("nominee");
    const delegation = await authorCarrierDelegation({ replica: item.replica, signer: nominee, audiencePubkey: nominee.publicKey,
        ops: kind === "space" ? ["create_thread"] : ["post"], roles: [role], live: false, expiresEpoch: 6 });
    const reviewed = await reviewContinuationFromFrames({ schema, frames: prior, replica: item.replica, role, author: b64(nominee.publicKey),
        deps: [beacon.id, heartbeat.id].sort(), delegation });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    const claim = reviewed.review.claim;
    const witnesses = ["w1", "w2", "w3"].map(fixtureSigner).sort((a, b) => Buffer.compare(a.publicKey, b.publicKey)).slice(0, 2);
    const bytes = canonicalBytesForContinuationClaim(claim);
    const certificate = { claim, signatures: await Promise.all(witnesses.map(async (w) => ({ witness: b64(w.publicKey), signature: b64(await w.sign(bytes)) }))) };
    const assembled = await assembleContinuationFromFrames({ schema, frames: prior, review: reviewed.review, certificate, signer: nominee });
    assert.equal(assembled.ok, true, JSON.stringify(assembled));
    return { kind, role, replica: item.replica, prior, frame: assembled.frame, nominee, witnesses, delegation, claim };
}
export function aliases(frame) {
    assert.equal(frame.deps.length, 2);
    const [a, b] = frame.deps;
    return [frame, { ...frame, deps: [b, a] }, { ...frame, deps: [a, a, b] }, { ...frame, deps: [b, a, b, a] }];
}
export async function judge(kind, replica, frames) {
    for (const frame of frames) {
        decodeCarrierOpFrame(frame);
        const result = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
        assert.equal(result.valid, true);
    }
    const schema = kind === "space" ? treehouseSpaceSchema : treehouseThreadSchema;
    const role = kind === "space" ? "admin" : "moderator";
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders(schema.name));
    const by = index(ops), order = canonicalOrder(ops, by);
    const analysis = analyzeAuthority(schema, ops, new Set(order), order, by, replica);
    const acquired = analysis.acquiresByRole.get(role)?.at(-1);
    const cutoff = await deriveTreehouseCatalogCutoff({ replica, frames, rejected: [] });
    assert.equal(cutoff.ok, true, JSON.stringify(cutoff));
    return { epoch: acquired?.opId ?? null, holder: acquired?.holderPubkey ?? null, reasons: Object.fromEntries(analysis.quarantineReasons),
        cutoff: cutoff.cutoff, cutoffBytes: b64(cutoff.canonicalBytes) };
}
function sameOutcome(actual, expected) {
    assert.equal(actual.epoch, expected.epoch);
    assert.equal(actual.holder, expected.holder);
    assert.deepEqual(actual.reasons, expected.reasons);
    assert.deepEqual(actual.cutoff, expected.cutoff);
    assert.ok(actual.cutoffBytes === expected.cutoffBytes, "canonical cutoff bytes differ");
}
export async function negativeFrames(f) {
    const extra = f.prior[0].id;
    const resigned = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: [...f.frame.deps, extra], kind: "authority", cap: ["nil"], body: f.frame.body });
    const claim = continuationClaimToCarrierTerm(f.claim);
    assert.equal(claim[0], "map");
    const fields = claim[1];
    const pair = fields.find(([k]) => k[0] === "atom" && k[1] === "deps");
    const values = pair[1][1];
    values.splice(1, 0, values[0]);
    const bytes = canonicalBytesForCarrierTerm(["list", [["bin", b64(Buffer.from("lattice-continuation-witness-v1"))], claim]]);
    const signatures = await Promise.all(f.witnesses.map(async (w) => map({ witness: ["bin", b64(w.publicKey)], signature: ["bin", b64(await w.sign(bytes))] })));
    const malformed = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: f.frame.deps, kind: "authority", cap: ["nil"],
        body: tuple(atom("succeed"), atom(f.role), ["delegation", f.delegation], tuple(atom("continuation_v1"), map({ claim, signatures: ["list", signatures] }))) });
    return [{ frame: resigned, reason: "invalid_continuation_certificate" }, { frame: malformed, reason: "malformed_term" }];
}
export async function produce() {
    const vectors = [];
    for (const kind of ["space", "thread"]) {
        const f = await fixture(kind), expected = await judge(kind, f.replica, [...f.prior, f.frame]);
        assert.equal(expected.epoch, f.frame.id);
        assert.equal(expected.holder, b64(f.nominee.publicKey));
        for (const frame of aliases(f.frame)) {
            assert.deepEqual(canonicalBytesForCarrierOp(frame), canonicalBytesForCarrierOp(f.frame));
            for (const frames of [[...f.prior, frame], [frame, ...[...f.prior].reverse()]])
                sameOutcome(await judge(kind, f.replica, frames), expected);
        }
        vectors.push({ kind, replica: f.replica, prior: f.prior, frame: f.frame, expected, negatives: await negativeFrames(f) });
    }
    return { vectors };
}
async function verifyBeam(input) {
    for (const v of input.vectors) {
        for (const frame of aliases(v.frame))
            for (const frames of [[...v.prior, frame], [frame, ...[...v.prior].reverse()]])
                sameOutcome(await judge(v.kind, v.replica, frames), v.expected);
        for (const n of v.negatives)
            assert.equal((await judge(v.kind, v.replica, [...v.prior, n.frame])).reasons[n.frame.id], n.reason);
    }
}
if (process.argv[2] === "produce")
    console.log(JSON.stringify(await produce()));
else if (process.argv[2] === "verify-beam") {
    await verifyBeam(JSON.parse(readFileSync(process.argv[3], "utf8")));
    console.log("CONTINUATION_ALIAS_RECIPROCAL_OK");
}
