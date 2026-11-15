// Plan 316 PR 4a: the TS binding-graph resolver reproduces every hand-written expectation and every BEAM outcome in
// binding_graph_v1.json, with this runtime's own state persistence, and agrees with BEAM on the generation horizon.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../src/carrier";
import { prepareTreehouseCatalogReplacementFromFrames } from "../src/index";
import { treehouseCommandDecoders } from "../src/treehouse";
import { nextCatalogGeneration } from "../src/treehouse_catalog_binding_graph";
import { catalogEnvelopeFromCarrierTerm } from "../src/treehouse_catalog_codec";
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
test("binding_graph_ts_v1.json equals this runtime's outcomes", () => {
    const committed = JSON.parse(readFileSync(tsVectorUrl, "utf8"));
    assert.deepEqual(committed.outcomes, outcomes.map((o) => ({ scenario: o.scenario, step: o.step, label: o.label, ts: o.id })));
});
