// Plan 316 PR 4a: the TS binding-graph resolver reproduces every hand-written expectation and every BEAM outcome in
// binding_graph_v1.json, with this runtime's own state persistence, and agrees with BEAM on the generation horizon.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../src/carrier";
import { prepareTreehouseCatalogReplacementFromFrames } from "../src/index";
import { treehouseCommandDecoders } from "../src/treehouse";
import { advanceCatalogBindingState, coverCatalogReplacementClaim, nextCatalogGeneration, resolveCatalogBindingGraph, } from "../src/treehouse_catalog_binding_graph";
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
// S16b / C4: T2 refuses the accepted R1 and an old-key rotation TR under R1 names a withheld prior catalog, so the verifier is
// trust_pending (with the complete part's freeze); the public preflight escapes TR, which R2 citing {R1, K1} closes out.
test("authoring escapes a withheld rotation prior the claim closes out (C4)", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "S16b: a withheld prior under a refused binding freezes");
    const labels = scenario.labels;
    const step = scenario.steps[1];
    assert.equal(step.expect.error, "trust_pending");
    assert.equal(step.expect.freeze, true);
    const frames = step.frames.map((id) => vector.frames[id]);
    const artifact = (label) => JSON.parse(vector.artifacts[labels[label]]);
    const catalog = (label) => catalogEnvelopeFromCarrierTerm(artifact(label));
    const [r2] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R2])], {}, treehouseCommandDecoders("Treehouse.Space"));
    const claim = r2.commandArgs[0];
    const request = (parents, priorCatalogs, generation) => ({
        author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-s16b-prep").digest("base64url"),
        parents, priorCatalogs, generation, newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId,
        newServiceKey: claim.newServiceKey, newOrigin: claim.newOrigin, entries: [...catalog("K2").catalog.entries],
        replicaHistories: {}, rotations: [catalogRotationEnvelopeFromCarrierTerm(artifact("TR"))], catalogs: [catalog("C0"), catalog("K1")]
    });
    const prepare = (r) => prepareTreehouseCatalogReplacementFromFrames({ replica: vector.space,
        frames, request: r, journal: {} });
    const ok = await prepare(request([labels.R1], [{ binding: labels.R1, catalog: labels.K1 }], 2));
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    // A claim that does not close TR out keeps trust_pending.
    assert.deepEqual(await prepare(request([labels.B], [{ binding: labels.B, catalog: labels.C0 }], 1)), { ok: false, reason: "trust_pending" });
});
// F2 (PR #221 round 1, finding 2): Cx (B key, revision 2 on a withheld previous) pends under B. A resolution citing the
// rotation T = B -> T closes B as T's ancestor (D-275), so the public preflight escapes Cx (HEAD: trust_pending).
test("authoring escapes a withheld chain under a rotated ancestor (F2)", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "F2: a withheld chain under a rotated ancestor is closed out by a resolution");
    const labels = scenario.labels;
    const step = scenario.steps[0];
    assert.equal(step.expect.error, "trust_pending");
    const frames = step.frames.map((id) => vector.frames[id]);
    const artifact = (label) => JSON.parse(vector.artifacts[labels[label]]);
    const catalog = (label) => catalogEnvelopeFromCarrierTerm(artifact(label));
    const [r] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R])], {}, treehouseCommandDecoders("Treehouse.Space"));
    const claim = r.commandArgs[0];
    const request = (catalogs) => ({
        author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-f2-prep").digest("base64url"),
        parents: [labels.T], priorCatalogs: [{ binding: labels.T, catalog: labels.CT }], generation: 2,
        newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId, newServiceKey: claim.newServiceKey,
        newOrigin: claim.newOrigin, entries: [...catalog("KR").catalog.entries], replicaHistories: {},
        rotations: [catalogRotationEnvelopeFromCarrierTerm(artifact("T"))], catalogs
    });
    const prepare = (catalogs) => prepareTreehouseCatalogReplacementFromFrames({ replica: vector.space, frames,
        request: request(catalogs), journal: {} });
    const ok = await prepare([catalog("C0"), catalog("CT"), catalog("Cx")]);
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    const without = await prepare([catalog("C0"), catalog("CT")]);
    assert.ok(without.ok, without.ok ? "" : without.reason);
});
// F3 (PR #221 round 1, finding 3): a lattice of null citations keeps one copy of the Space entry per floor (without the
// deduplicating join, 2,048 copies per final head at 12 levels).
// Rows 386 and 390: entry facts are judged per causal slice, never on a whole Thread history, so a gen1 frame whose dependency
// is withheld (above every fact op) changes no outcome in any scenario, including the R390 gen1 refusals.
test("a withheld Thread dependency above every fact op changes no verdict", async () => {
    const late = vector.late_thread_frame;
    const replica = decodeCarrierOpFrame(late).replica;
    assert.ok(Array.isArray(vector.histories[replica]));
    const histories = { ...vector.histories, [replica]: [...vector.histories[replica], late] };
    const torn = await runVector({ ...vector, histories });
    assert.deepEqual(torn.map((o) => o.id), outcomes.map((o) => o.id));
});
test("null-citation lattice floors hold one entry copy (F3)", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "F3: a lattice of nil citations keeps one copy of each floor entry");
    const step = scenario.steps[0];
    const result = await resolveCatalogBindingGraph({ bootstrap: { id: vector.bootstrap.id,
            record: catalogBootstrapFromCarrierTerm(vector.bootstrap.record) }, frames: step.frames.map((id) => vector.frames[id]),
        rotations: new Map(), catalogs: new Map(step.catalogs.map((id) => [id, catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[id]))])), provenCutoffs: step.proven, accepted: null });
    assert.ok(result.ok);
    assert.equal(result.graph.floors.size, 25);
    for (const floor of result.graph.floors.values())
        assert.ok(floor.entries.length <= 1);
});
// B4 (PR #221 bot, the old line 137): a malformed frame refuses as malformed_catalog instead of rejecting the promise.
test("a malformed frame is malformed_catalog", async () => {
    const record = catalogBootstrapFromCarrierTerm(vector.bootstrap.record);
    for (const bad of [{ not: "a frame" }, null, 7, ["tuple"]]) {
        const result = await resolveCatalogBindingGraph({ bootstrap: { id: vector.bootstrap.id, record }, frames: [bad],
            rotations: new Map(), catalogs: new Map(), provenCutoffs: [], accepted: null });
        assert.deepEqual(result, { ok: false, reason: "malformed_catalog", detail: { ids: [] } });
    }
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
// PR #221 round 5, finding 4 (D-A10): the closed-out old-key Squat maps KR's route to another replica, but it cannot veto a
// generation-2 resolution that carries KR's entries unchanged; a new entry re-pointing that route is still refused.
test("authoring carries entries past a closed-out squat catalog", async () => {
    const scenario = vector.scenarios.find((s) => s.name === "closed-out old-key catalogs reserve no route");
    const labels = scenario.labels;
    const frames = scenario.steps[0].frames.map((id) => vector.frames[id]);
    const catalog = (label) => catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[labels[label]]));
    const [r] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R])], {}, treehouseCommandDecoders("Treehouse.Space"));
    const claim = r.commandArgs[0];
    const kr = catalog("KR").catalog.entries;
    const request = (entries) => ({
        author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-squat-carry").digest("base64url"),
        parents: [labels.R], priorCatalogs: [{ binding: labels.R, catalog: labels.KR }], generation: 2,
        newCatalogKey: catalogBootstrapFromCarrierTerm(vector.bootstrap.record).catalogKey, newServiceId: claim.newServiceId,
        newServiceKey: claim.newServiceKey, newOrigin: claim.newOrigin, entries: [...entries], replicaHistories: {}, rotations: [],
        catalogs: [catalog("Squat"), catalog("KR")]
    });
    const prepare = (entries) => prepareTreehouseCatalogReplacementFromFrames({ replica: vector.space, frames,
        request: request(entries), journal: {} });
    const ok = await prepare(kr);
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    const fresh = { ...kr[0], route: "/r/" + createHash("sha256").update("r316-4a-ts-squat-fresh").digest("base64url") };
    const moved = { ...kr[0], replica: kr[0].replica + "-new" };
    const step = scenario.steps[0];
    const resolved = await resolveCatalogBindingGraph({ bootstrap: { id: vector.bootstrap.id,
            record: catalogBootstrapFromCarrierTerm(vector.bootstrap.record) }, frames, rotations: new Map(),
        catalogs: new Map(step.catalogs.map((id) => [id, catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[id]))])),
        provenCutoffs: step.proven, accepted: null });
    assert.ok(resolved.ok);
    const next = { ...claim, parents: [labels.R], priorCatalogs: [{ binding: labels.R, catalog: labels.KR }], generation: 2 };
    assert.equal(coverCatalogReplacementClaim(resolved.graph, next, kr), null);
    assert.equal(coverCatalogReplacementClaim(resolved.graph, next, [fresh, moved]), "invalid_catalog_transition");
});
// Design section 1.5: only an accepting decision that clears lifts frozen; a freezing block sets it.
test("advanceCatalogBindingState lifts frozen only on an accepting decision that clears", () => {
    const a = { binding: "b", generation: 0, catalog: "c", revision: 0, routes: { "/a": "space" } };
    const result = (accepted, clears, block) => ({ ok: true,
        graph: { catalogs: new Map([["k", { entries: [{ route: "/k", replica: "space" }] }]]), catParent: new Map([["k", null]]),
            decision: { accepted, head: "h", generation: 1, catalog: accepted ? "k" : null, revision: 0, clearsAuthorityChanged: clears,
                block, serving: accepted ? "k" : null } } });
    const frozen = { accepted: a, frozen: true };
    assert.deepEqual(advanceCatalogBindingState(frozen, result(true, false, null)), { accepted: a, frozen: true, serving: null });
    assert.deepEqual(advanceCatalogBindingState(frozen, result(true, true, null)), { accepted: { binding: "h", generation: 1,
            catalog: "k", revision: 0, routes: { "/a": "space", "/k": "space" } }, frozen: false, serving: "k" });
    const open = { accepted: a, frozen: false };
    assert.deepEqual(advanceCatalogBindingState(open, result(false, false, { reason: "authority_changed", ids: ["h"], freeze: true })), { accepted: a, frozen: true, serving: null });
    assert.deepEqual(advanceCatalogBindingState(open, result(false, false, { reason: "catalog_authority_refused", ids: ["h"], freeze: false })), { accepted: a, frozen: false, serving: null });
    // Row 386, repair (a): trust_pending ORs the complete part's freeze into frozen and serves its watermark serving only while
    // not frozen; a trust_pending without those fields keeps frozen and serves nothing.
    const pending = (freeze, serving) => ({ ok: false, reason: "trust_pending", detail: { ids: ["x"], freeze, serving } });
    assert.deepEqual(advanceCatalogBindingState(frozen, pending(false, "c")), { accepted: a, frozen: true, serving: null });
    assert.deepEqual(advanceCatalogBindingState(open, pending(true, "c")), { accepted: a, frozen: true, serving: null });
    assert.deepEqual(advanceCatalogBindingState(open, pending(false, "c")), { accepted: a, frozen: false, serving: "c" });
    for (const state of [frozen, open]) {
        assert.deepEqual(advanceCatalogBindingState(state, { ok: false, reason: "trust_pending", detail: { ids: [] } }), { accepted: a, frozen: state.frozen, serving: null });
    }
});
// Row 524: an accepting decision adds every catalog on the accepted chain (D-881 walk), which reaches a rotation's prior
// catalog through catParent; a cycle or an id the graph does not hold ends the walk.
test("row 524: advanceCatalogBindingState walks a rotation's prior catalog", () => {
    const result = (catParent) => ({ ok: true,
        graph: { catalogs: new Map([["k", { entries: [{ route: "/k", replica: "space" }] }], ["p", { entries: [{ route: "/p", replica: "thread" }] }]]),
            catParent, decision: { accepted: true, head: "t", generation: 1, catalog: "k", revision: 0, clearsAuthorityChanged: false,
                block: null, serving: "k" } } });
    const empty = { accepted: null, frozen: false };
    const routes = (catParent) => advanceCatalogBindingState(empty, result(catParent)).accepted.routes;
    assert.deepEqual(routes(new Map([["k", "p"], ["p", null]])), { "/k": "space", "/p": "thread" });
    assert.deepEqual(routes(new Map([["k", "p"], ["p", "k"]])), { "/k": "space", "/p": "thread" });
    assert.deepEqual(routes(new Map([["k", "x"]])), { "/k": "space" });
});
// Row 524, review round 1 (D-930): a route the stored watermark reserves keeps its replica when the accepted chain walks an
// intermediate catalog this client never accepted.
test("row 524: advanceCatalogBindingState keeps a stored route over the chain", () => {
    const result = { ok: true,
        graph: { catalogs: new Map([["k", { entries: [{ route: "/k", replica: "thread2" }] }], ["p", { entries: [{ route: "/u", replica: "thread2" }] }]]),
            catParent: new Map([["k", "p"], ["p", null]]), decision: { accepted: true, head: "t", generation: 1, catalog: "k", revision: 1,
                clearsAuthorityChanged: true, block: null, serving: "k" } } };
    const a = { binding: "b", generation: 0, catalog: "c", revision: 0, routes: { "/u": "u" } };
    assert.deepEqual(advanceCatalogBindingState({ accepted: a, frozen: true }, result).accepted.routes, { "/u": "u", "/k": "thread2" });
});
test("row 524: an unaccepted intermediate catalog never re-points a reserved route", () => {
    const name = "S12r: an unaccepted intermediate catalog keeps a reserved route/one page";
    const stateIn = (step) => {
        const o = outcomes.find((x) => x.scenario === name && x.step === step);
        assert.ok(o, `${name}, delivery ${step}`);
        return o.stateIn;
    };
    const before = stateIn(4).accepted.routes;
    const promoted = stateIn(5).accepted.routes;
    for (const [route, replica] of Object.entries(before))
        assert.equal(promoted[route], replica);
    assert.ok(Object.keys(promoted).length > Object.keys(before).length);
});
// Row 524: a chain delivered on one page persists the same watermark routes as the same chain delivered catalog by catalog,
// including the route its intermediate catalog moved away (this runtime's own persisted state).
test("row 524: one-page and separate deliveries persist the same watermark routes", () => {
    const stateAt = (scenario, step) => {
        const o = outcomes.find((x) => x.scenario === scenario && x.step === step);
        assert.ok(o, `${scenario}, delivery ${step}`);
        return o.stateIn;
    };
    const pairs = [
        ["S12r: a replacement chain moves a route/separate", 4, "S12r: a replacement chain moves a route/one page", 3],
        ["S12: a route served earlier is never re-pointed", 3, "S12: C0 and C1 on one page keep the route C1 moved", 2],
    ];
    for (const [a, i, b, j] of pairs) {
        const separate = stateAt(a, i);
        const onePage = stateAt(b, j);
        assert.deepEqual(onePage, separate);
        // Space plus the Thread at its first route and at the route the later catalog moved it to.
        const counts = Object.values(onePage.accepted.routes).reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
        assert.deepEqual([...counts.values()].sort(), [1, 2]);
    }
});
test("binding_graph_ts_v1.json equals this runtime's outcomes", () => {
    const committed = JSON.parse(readFileSync(tsVectorUrl, "utf8"));
    assert.deepEqual(committed.outcomes, outcomes.map((o) => ({ scenario: o.scenario, step: o.step, label: o.label, ts: o.id })));
});
