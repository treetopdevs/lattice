// Plan 316 PR 4a: run binding_graph_v1.json (BEAM-written inputs, hand-written expectations, BEAM incidental outputs)
// through the TS resolver, and write the TS outcomes to binding_graph_ts_v1.json for the BEAM reciprocal test.
// The accepted watermark and blocked state persist between deliveries exactly as the BEAM harness persists them.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveCatalogBindingGraph } from "../../src/treehouse_catalog_binding_graph";
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
    return { accepted: json.accepted ?? null, blocked: json.blocked ?? null };
}
function persist(state, result) {
    if (!result.ok)
        return state;
    const d = result.graph.decision;
    const accepted = d.accepted ? { binding: d.head, generation: d.generation, catalog: d.catalog, revision: d.revision } : state.accepted;
    const blocked = d.clearsAuthorityChanged ? null : d.block ?? state.blocked;
    return { accepted, blocked };
}
const sorted = (values) => [...values].sort(compareUtf8);
const sortKeys = (map, f) => Object.fromEntries(sorted(map.keys()).map((k) => [k, f(map.get(k))]));
/** The id-space view, same shape as CatalogBindingGraphFixtures.view/1. */
export function idView(result) {
    if (!result.ok)
        return { error: result.reason, ids: sorted(result.detail.ids) };
    const g = result.graph, d = g.decision;
    return {
        heads: [...g.heads], closed: [...g.closed], closed_out: sortKeys(g.closedOut, (r) => r),
        nodes: sortKeys(g.nodes, (n) => ({ kind: n.kind, generation: n.generation, refused: n.refused, core_reason: n.coreReason,
            pending: n.pending.length })),
        raw_evidence: sortKeys(g.rawEvidence, (r) => r), refusals: sortKeys(g.refusals, (r) => r.reason),
        catalog_heads: sortKeys(g.catalogHeads, (ids) => [...ids]),
        forks: g.forks.map((f) => ({ kind: f.kind, binding: f.binding, ids: [...f.ids] })),
        decision: { accepted: d.accepted, reason: d.reason, block: d.block && { reason: d.block.reason, triggers: [...d.block.triggers] },
            head: d.head, catalog: d.catalog, clears: d.clearsAuthorityChanged, binding_status: d.acceptedBindingStatus,
            catalog_status: d.acceptedCatalogStatus },
    };
}
/** The label-space view, same shape as CatalogBindingGraphScenarios.label_view/2. */
export function labelView(result, labels) {
    if (!result.ok)
        return { error: result.reason };
    const reverse = new Map(Object.entries(labels).map(([k, v]) => [v, k]));
    const l = (id) => reverse.get(id) ?? `?${id}`;
    const ls = (ids) => [...ids].map(l).sort(compareUtf8);
    const g = result.graph, d = g.decision;
    return {
        heads: ls(g.heads), closed: ls(g.closed), closed_out: ls(g.closedOut.keys()), nodes: ls(g.nodes.keys()),
        refused: ls([...g.nodes.values()].filter((n) => n.refused).map((n) => n.id)),
        raw: Object.fromEntries([...g.rawEvidence].map(([id, r]) => [l(id), r])),
        refusals: Object.fromEntries([...g.refusals].map(([id, r]) => [l(id), r.reason])),
        pending: ls(g.pending), forks: [...new Set(g.forks.map((f) => f.kind))].sort(compareUtf8),
        decision: { accepted: d.accepted, reason: d.reason, block: d.block?.reason ?? null, head: d.head && l(d.head),
            catalog: d.catalog && l(d.catalog), clears: d.clearsAuthorityChanged },
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
        let state = { accepted: null, blocked: null };
        for (const [i, step] of scenario.steps.entries()) {
            // The first delivery may carry a scenario-supplied state; later ones use this runtime's own persistence.
            if (i === 0)
                state = stateFrom(step.state);
            const stateIn = { accepted: state.accepted, blocked: state.blocked };
            const rotations = new Map(step.rotations.map((id) => [id, parseArtifact(vector.artifacts[id], catalogRotationEnvelopeFromCarrierTerm)]));
            const catalogs = new Map(step.catalogs.map((id) => [id, parseArtifact(vector.artifacts[id], catalogEnvelopeFromCarrierTerm)]));
            const result = await resolveCatalogBindingGraph({ bootstrap, frames: step.frames.map((id) => vector.frames[id]),
                rotations, catalogs, provenCutoffs: step.proven, accepted: state.accepted, blocked: state.blocked });
            outcomes.push({ scenario: scenario.name, step: i + 1, expect: step.expect, beam: step.beam,
                label: labelView(result, scenario.labels), id: idView(result), stateIn, beamStateIn: step.state });
            state = persist(state, result);
        }
    }
    return outcomes;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outcomes = await runVector();
    const out = { version: 1, outcomes: outcomes.map((o) => ({ scenario: o.scenario, step: o.step, label: o.label, ts: o.id })) };
    writeFileSync(tsVectorUrl, JSON.stringify(out, null, 2) + "\n");
}
