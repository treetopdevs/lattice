// Plan 316 PR 4a: the TS binding-graph resolver reproduces every hand-written expectation and every BEAM outcome in
// binding_graph_v1.json, with this runtime's own state persistence, and agrees with BEAM on the generation horizon.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../src/carrier";
import { prepareTreehouseCatalogReplacementFromFrames } from "../src/index";
import { treehouseCommandDecoders } from "../src/treehouse";
import { nextCatalogGeneration, resolveCatalogBindingGraph } from "../src/treehouse_catalog_binding_graph";
import { catalogBootstrapFromCarrierTerm, catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, } from "../src/treehouse_catalog_codec";
import { loadVector, runVector, tsVectorUrl } from "./support/export_treehouse_catalog_binding_graph";
const vector = loadVector();
const outcomes = await runVector(vector);
for (const o of outcomes) {
    test(`${o.scenario}, delivery ${o.step}`, () => {
        assert.deepEqual(o.label, o.expect, "hand-written expectation");
        assert.deepEqual(o.id, o.beam, "BEAM outcome");
        assert.deepEqual(o.stateIn, o.beamStateIn, "persisted state");
    });
}
test("generation arithmetic is capped at 2^53-1 identically in both runtimes", () => {
    for (const c of vector.generation_cases)
        assert.equal(nextCatalogGeneration(c.generations), c.next);
});
// D-A19: a proven cutoff is the whole {replica, frontier, logDigest}; an entry without a string frontier is malformed input.
test("a proven cutoff without its frontier is malformed input", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "a replacement cutoff proof must match the claimed frontier");
    const step = scenario.steps[0];
    const record = catalogBootstrapFromCarrierTerm(vector.bootstrap.record);
    const run = (provenCutoffs) => resolveCatalogBindingGraph({ bootstrap: { id: vector.bootstrap.id, record },
        frames: step.frames.map((id) => vector.frames[id]), rotations: new Map(), catalogs: new Map(),
        provenCutoffs: provenCutoffs, accepted: null });
    const [cut] = step.proven;
    const { frontier: _dropped, ...noFrontier } = cut;
    for (const bad of [noFrontier, { ...cut, frontier: [1] }]) {
        const result = await run([bad]);
        assert.equal(result.ok ? null : result.reason, "malformed_catalog");
    }
    // The well-formed proof gets past input validation (C0 is not supplied here, so the result is trust_pending).
    const good = await run([cut]);
    assert.notEqual(good.ok ? null : good.reason, "malformed_catalog");
});
// Review round 2, finding 4: after accepted R1/K1 is union-refused by a concurrent holder change, the public preflight must
// prepare the C13 recovery claim citing {R1, K1}; citing {R1, null} omits that citable catalog head. Frames and artifacts are
// the committed C13 scenario's (the delivery that holds R1, K1 and T2 but not yet R2).
test("authoring prepares the C13 recovery claim that cites the refused accepted catalog", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "C13: concurrent revoke after accepting R1, then a fresh resolution clears");
    const labels = scenario.labels;
    const frames = scenario.steps[1].frames.map((id) => vector.frames[id]);
    const catalog = (label) => catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[labels[label]]));
    const [r2] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R2])], {}, treehouseCommandDecoders("Treehouse.Space"));
    const claim = r2.commandArgs[0];
    const request = (prior) => ({
        author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-c13-prep").digest("base64url"),
        parents: [labels.R1], priorCatalogs: [{ binding: labels.R1, catalog: prior }], generation: 2,
        newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId, newServiceKey: claim.newServiceKey,
        newOrigin: claim.newOrigin, entries: [...catalog("K2").catalog.entries], replicaHistories: {}, rotations: [],
        catalogs: [catalog("C0"), catalog("K1")]
    });
    const prepare = (prior) => prepareTreehouseCatalogReplacementFromFrames({ replica: vector.space, frames,
        request: request(prior), journal: {} });
    const ok = await prepare(labels.K1);
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    assert.deepEqual(ok.attempt.claim.priorCatalogs, [{ binding: labels.R1, catalog: labels.K1 }]);
    assert.deepEqual(await prepare(null), { ok: false, reason: "catalog_fork" });
});
// S11 (C4): three old-key rotations under the accepted R1 make the verifier return control_history_limit, but the public
// preflight prepares R2h {R1, K1} through the head-root escape; a claim not citing every head root keeps the limit.
test("authoring prepares a resolution past three rotation heads (head-limit escape)", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "S11: three rotation heads under an honored watermark are resolved by one citation");
    const labels = scenario.labels;
    const step = scenario.steps[1];
    assert.equal(step.expect.error, "control_history_limit");
    const frames = step.frames.map((id) => vector.frames[id]);
    const artifact = (label) => JSON.parse(vector.artifacts[labels[label]]);
    const catalog = (label) => catalogEnvelopeFromCarrierTerm(artifact(label));
    const [r2h] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R2h])], {}, treehouseCommandDecoders("Treehouse.Space"));
    const claim = r2h.commandArgs[0];
    const request = (parents, priorCatalogs) => ({
        author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-s11-prep").digest("base64url"),
        parents, priorCatalogs, generation: 2, newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId,
        newServiceKey: claim.newServiceKey, newOrigin: claim.newOrigin, entries: [...catalog("K2h").catalog.entries],
        replicaHistories: {}, rotations: ["TRa", "TRb", "TRc"].map((l) => catalogRotationEnvelopeFromCarrierTerm(artifact(l))),
        catalogs: [catalog("C0"), catalog("K1")]
    });
    const prepare = (r) => prepareTreehouseCatalogReplacementFromFrames({ replica: vector.space,
        frames, request: r, journal: {} });
    const ok = await prepare(request([labels.R1], [{ binding: labels.R1, catalog: labels.K1 }]));
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    assert.deepEqual(ok.attempt.claim.priorCatalogs, [{ binding: labels.R1, catalog: labels.K1 }]);
    assert.deepEqual(await prepare(request([labels.B], [{ binding: labels.B, catalog: labels.C0 }])), { ok: false, reason: "control_history_limit" });
});
test("binding_graph_ts_v1.json equals this runtime's outcomes", () => {
    const committed = JSON.parse(readFileSync(tsVectorUrl, "utf8"));
    assert.deepEqual(committed.outcomes, outcomes.map((o) => ({ scenario: o.scenario, step: o.step, label: o.label, ts: o.id })));
});
