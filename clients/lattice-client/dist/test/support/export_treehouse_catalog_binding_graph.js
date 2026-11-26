// Plan 316 PR 4a: run binding_graph_v1.json (BEAM-written inputs, hand-written expectations, BEAM incidental outputs)
// through the TS resolver, and write the TS outcomes to binding_graph_ts_v1.json for the BEAM reciprocal test.
// The accepted watermark (with its cumulative routes) and the frozen bit persist between deliveries through
// advanceCatalogBindingState, exactly as the BEAM harness persists them through CatalogBindingGraph.advance/2.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { advanceCatalogBindingState, resolveCatalogBindingGraph } from "../../src/treehouse_catalog_binding_graph";
import { catalogBootstrapFromCarrierTerm, catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, } from "../../src/treehouse_catalog_codec";
import { compareUtf8 } from "../../src/op";
export const vectorUrl = new URL("../vectors/catalog/binding_graph_v1.json", import.meta.url);
export const tsVectorUrl = new URL("../vectors/catalog/binding_graph_ts_v1.json", import.meta.url);
export function loadVector() { return JSON.parse(readFileSync(vectorUrl, "utf8")); }
function parseArtifact(json, decode) {
    const value = decode(JSON.parse(json));
    if (value === null)
        throw new Error("malformed vector artifact");
    return value;
}
function stateFrom(json) {
    return { accepted: json.accepted ?? null, frozen: json.frozen === true };
}
/** The JSON shape of CatalogBindingGraphFixtures.state_json/1 (routes keyed in sorted order). */
export function stateJson(state) {
    const a = state.accepted;
    return { accepted: a && { binding: a.binding, generation: a.generation, catalog: a.catalog, revision: a.revision,
            routes: Object.fromEntries(sorted(Object.keys(a.routes)).map((k) => [k, a.routes[k]])) }, frozen: state.frozen };
}
function afterJson(next) {
    return { ...stateJson(next), serving: next.serving };
}
const sorted = (values) => [...values].sort(compareUtf8);
const sortKeys = (map, f) => Object.fromEntries(sorted(map.keys()).map((k) => [k, f(map.get(k))]));
/** The id-space view, same shape as CatalogBindingGraphFixtures.view/1. */
export function idView(result, next) {
    if (!result.ok) {
        const { freeze, serving } = result.detail;
        return result.reason === "trust_pending" && freeze !== undefined && serving !== undefined
            ? { error: result.reason, ids: sorted(result.detail.ids), freeze, serving, after: afterJson(next) }
            : { error: result.reason, ids: sorted(result.detail.ids), after: afterJson(next) };
    }
    const g = result.graph, d = g.decision;
    return {
        heads: [...g.heads], closed: [...g.closed], closed_out: sortKeys(g.closedOut, (r) => r),
        nodes: sortKeys(g.nodes, (n) => ({ kind: n.kind, generation: n.generation, refused: n.refused, core_reason: n.coreReason,
            pending: n.pending.length })),
        raw_evidence: sortKeys(g.rawEvidence, (r) => r), refusals: sortKeys(g.refusals, (r) => r.reason),
        catalog_heads: sortKeys(g.catalogHeads, (ids) => [...ids]),
        forks: g.forks.map((f) => ({ kind: f.kind, binding: f.binding, ids: [...f.ids] })),
        decision: { accepted: d.accepted, reason: d.reason,
            block: d.block && { reason: d.block.reason, ids: [...d.block.ids], freeze: d.block.freeze },
            head: d.head, catalog: d.catalog, clears: d.clearsAuthorityChanged, serving: d.serving,
            binding_status: d.acceptedBindingStatus, catalog_status: d.acceptedCatalogStatus },
        after: afterJson(next),
    };
}
/** The label-space view, same shape as CatalogBindingGraphScenarios.label_view/2. */
export function labelView(result, labels, next) {
    const reverse = new Map(Object.entries(labels).map(([k, v]) => [v, k]));
    const l = (id) => reverse.get(id) ?? `?${id}`;
    const after = { frozen: next.frozen, serving: next.serving === null ? null : l(next.serving) };
    if (!result.ok) {
        const { freeze, serving } = result.detail;
        return result.reason === "trust_pending" && freeze !== undefined && serving !== undefined
            ? { error: result.reason, freeze, serving: serving === null ? null : l(serving), after } : { error: result.reason, after };
    }
    const ls = (ids) => [...ids].map(l).sort(compareUtf8);
    const g = result.graph, d = g.decision;
    return {
        heads: ls(g.heads), closed: ls(g.closed), closed_out: ls(g.closedOut.keys()), nodes: ls(g.nodes.keys()),
        refused: ls([...g.nodes.values()].filter((n) => n.refused).map((n) => n.id)),
        raw: Object.fromEntries([...g.rawEvidence].map(([id, r]) => [l(id), r])),
        refusals: Object.fromEntries([...g.refusals].map(([id, r]) => [l(id), r.reason])),
        pending: ls(g.pending), forks: [...new Set(g.forks.map((f) => f.kind))].sort(compareUtf8),
        decision: { accepted: d.accepted, reason: d.reason, block: d.block?.reason ?? null, freeze: d.block?.freeze ?? false,
            head: d.head && l(d.head), catalog: d.catalog && l(d.catalog), clears: d.clearsAuthorityChanged,
            serving: d.serving && l(d.serving) },
        after,
    };
}
/** Run every scenario step through the TS resolver with persisted state. */
export async function runVector(vector = loadVector()) {
    const record = catalogBootstrapFromCarrierTerm(vector.bootstrap.record);
    if (record === null)
        throw new Error("malformed bootstrap record");
    const bootstrap = { id: vector.bootstrap.id, record };
    const outcomes = [];
    for (const scenario of vector.scenarios) {
        let state = { accepted: null, frozen: false };
        for (const [i, step] of scenario.steps.entries()) {
            // The first delivery may carry a scenario-supplied state; later ones use this runtime's own persistence.
            if (i === 0)
                state = stateFrom(step.state);
            const stateIn = stateJson(state);
            const rotations = new Map(step.rotations.map((id) => [id, parseArtifact(vector.artifacts[id], catalogRotationEnvelopeFromCarrierTerm)]));
            const catalogs = new Map(step.catalogs.map((id) => [id, parseArtifact(vector.artifacts[id], catalogEnvelopeFromCarrierTerm)]));
            const result = await resolveCatalogBindingGraph({ bootstrap, frames: step.frames.map((id) => vector.frames[id]),
                rotations, catalogs, provenCutoffs: step.proven, accepted: state.accepted, histories: vector.histories });
            const next = advanceCatalogBindingState(state, result);
            outcomes.push({ scenario: scenario.name, step: i + 1, expect: step.expect, beam: step.beam,
                label: labelView(result, scenario.labels, next), id: idView(result, next), stateIn, beamStateIn: step.state });
            state = { accepted: next.accepted, frozen: next.frozen };
        }
    }
    return outcomes;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outcomes = await runVector();
    const out = { version: 1, outcomes: outcomes.map((o) => ({ scenario: o.scenario, step: o.step, label: o.label, ts: o.id })) };
    writeFileSync(tsVectorUrl, JSON.stringify(out, null, 2) + "\n");
}
