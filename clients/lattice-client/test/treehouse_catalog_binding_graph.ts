// Plan 316 PR 4a: the TS binding-graph resolver reproduces every hand-written expectation and every BEAM outcome in
// binding_graph_v1.json, with this runtime's own state persistence, and agrees with BEAM on the generation horizon.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../src/carrier";
import { prepareTreehouseCatalogReplacementFromFrames } from "../src/index";
import type { TreehouseCatalogReplacementRequest } from "../src/index";
import { treehouseCommandDecoders } from "../src/treehouse";
import {
  advanceCatalogBindingState, coverCatalogReplacementClaim, nextCatalogGeneration, resolveCatalogBindingGraph,
} from "../src/treehouse_catalog_binding_graph";
import type {
  CatalogBindingBlock, CatalogBindingGraph, CatalogBindingGraphResult, ProvenCutoff,
} from "../src/treehouse_catalog_binding_graph";
import {
  catalogBootstrapFromCarrierTerm, catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm,
} from "../src/treehouse_catalog_codec";
import type { CatalogEnvelope, CatalogReplacementClaim } from "../src/treehouse_catalog_codec";
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
  for (const c of vector.generation_cases) assert.equal(nextCatalogGeneration(c.generations), c.next);
});

// D-A19: a proven cutoff is the whole {replica, frontier, logDigest}; an entry without a string frontier is malformed input.
test("a proven cutoff without its frontier is malformed input", async () => {
  const scenario = vector.scenarios.find((s: {name: string}) => s.name === "a replacement cutoff proof must match the claimed frontier");
  const step = scenario.steps[0];
  const record = catalogBootstrapFromCarrierTerm(vector.bootstrap.record)!;
  const run = (provenCutoffs: unknown[]) => resolveCatalogBindingGraph({bootstrap: {id: vector.bootstrap.id, record},
    frames: step.frames.map((id: string) => vector.frames[id]), rotations: new Map(), catalogs: new Map(),
    provenCutoffs: provenCutoffs as ProvenCutoff[], accepted: null});
  const [cut] = step.proven;
  const {frontier: _dropped, ...noFrontier} = cut;
  for (const bad of [noFrontier, {...cut, frontier: [1]}]) {
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
  const scenario = vector.scenarios.find((s: {name: string}) =>
    s.name === "C13: concurrent revoke after accepting R1, then a fresh resolution clears");
  const labels = scenario.labels as Record<string, string>;
  const frames = (scenario.steps[1].frames as string[]).map((id) => vector.frames[id]);
  const catalog = (label: string): CatalogEnvelope => catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[labels[label]!]))!;
  const [r2] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R2!])], {},
    treehouseCommandDecoders("Treehouse.Space"));
  const claim = r2!.commandArgs![0] as CatalogReplacementClaim;
  const request = (prior: string | null): TreehouseCatalogReplacementRequest => ({
    author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-c13-prep").digest("base64url"),
    parents: [labels.R1!], priorCatalogs: [{binding: labels.R1!, catalog: prior}], generation: 2,
    newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId, newServiceKey: claim.newServiceKey,
    newOrigin: claim.newOrigin, entries: [...catalog("K2").catalog.entries], replicaHistories: {}, rotations: [],
    catalogs: [catalog("C0"), catalog("K1")]});
  const prepare = (prior: string | null) => prepareTreehouseCatalogReplacementFromFrames({replica: vector.space, frames,
    request: request(prior), journal: {}});
  const ok = await prepare(labels.K1!);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  assert.deepEqual(ok.attempt.claim.priorCatalogs, [{binding: labels.R1, catalog: labels.K1}]);
  assert.deepEqual(await prepare(null), {ok: false, reason: "catalog_fork"});
});

// S11 (C4): three old-key rotations under the accepted R1 make the verifier return control_history_limit, but the public
// preflight prepares R2h {R1, K1} through the head-root escape; a claim not citing every head root keeps the limit.
test("authoring prepares a resolution past three rotation heads (head-limit escape)", async () => {
  const scenario = vector.scenarios.find((s: {name: string}) =>
    s.name === "S11: three rotation heads under an honored watermark are resolved by one citation");
  const labels = scenario.labels as Record<string, string>;
  const step = scenario.steps[1];
  assert.equal(step.expect.error, "control_history_limit");
  const frames = (step.frames as string[]).map((id) => vector.frames[id]);
  const artifact = (label: string) => JSON.parse(vector.artifacts[labels[label]!]);
  const catalog = (label: string): CatalogEnvelope => catalogEnvelopeFromCarrierTerm(artifact(label))!;
  const [r2h] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R2h!])], {},
    treehouseCommandDecoders("Treehouse.Space"));
  const claim = r2h!.commandArgs![0] as CatalogReplacementClaim;
  const request = (parents: string[], priorCatalogs: {binding: string; catalog: string | null}[]):
    TreehouseCatalogReplacementRequest => ({
    author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-s11-prep").digest("base64url"),
    parents, priorCatalogs, generation: 2, newCatalogKey: claim.newCatalogKey, newServiceId: claim.newServiceId,
    newServiceKey: claim.newServiceKey, newOrigin: claim.newOrigin, entries: [...catalog("K2h").catalog.entries],
    replicaHistories: {}, rotations: ["TRa", "TRb", "TRc"].map((l) => catalogRotationEnvelopeFromCarrierTerm(artifact(l))!),
    catalogs: [catalog("C0"), catalog("K1")]});
  const prepare = (r: TreehouseCatalogReplacementRequest) => prepareTreehouseCatalogReplacementFromFrames({replica: vector.space,
    frames, request: r, journal: {}});
  const ok = await prepare(request([labels.R1!], [{binding: labels.R1!, catalog: labels.K1!}]));
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  assert.deepEqual(ok.attempt.claim.priorCatalogs, [{binding: labels.R1, catalog: labels.K1}]);
  assert.deepEqual(await prepare(request([labels.B!], [{binding: labels.B!, catalog: labels.C0!}])),
    {ok: false, reason: "control_history_limit"});
});

// PR #221 round 5, finding 4 (D-A10): the closed-out old-key Squat maps KR's route to another replica, but it cannot veto a
// generation-2 resolution that carries KR's entries unchanged; a new entry re-pointing that route is still refused.
test("authoring carries entries past a closed-out squat catalog", async () => {
  const scenario = vector.scenarios.find((s: {name: string}) => s.name === "closed-out old-key catalogs reserve no route");
  const labels = scenario.labels as Record<string, string>;
  const frames = (scenario.steps[0].frames as string[]).map((id) => vector.frames[id]);
  const catalog = (label: string): CatalogEnvelope => catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[labels[label]!]))!;
  const [r] = carrierOpsToSemanticOps([decodeCarrierOpFrame(vector.frames[labels.R!])], {},
    treehouseCommandDecoders("Treehouse.Space"));
  const claim = r!.commandArgs![0] as CatalogReplacementClaim;
  const kr = catalog("KR").catalog.entries;
  const request = (entries: typeof kr): TreehouseCatalogReplacementRequest => ({
    author: claim.author, nonce: createHash("sha256").update("r316-4a-ts-nonce-squat-carry").digest("base64url"),
    parents: [labels.R!], priorCatalogs: [{binding: labels.R!, catalog: labels.KR!}], generation: 2,
    newCatalogKey: catalogBootstrapFromCarrierTerm(vector.bootstrap.record)!.catalogKey, newServiceId: claim.newServiceId,
    newServiceKey: claim.newServiceKey, newOrigin: claim.newOrigin, entries: [...entries], replicaHistories: {}, rotations: [],
    catalogs: [catalog("Squat"), catalog("KR")]});
  const prepare = (entries: typeof kr) => prepareTreehouseCatalogReplacementFromFrames({replica: vector.space, frames,
    request: request(entries), journal: {}});
  const ok = await prepare(kr);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  const fresh = {...kr[0]!, route: "/r/" + createHash("sha256").update("r316-4a-ts-squat-fresh").digest("base64url")};
  const moved = {...kr[0]!, replica: kr[0]!.replica + "-new"};
  const step = scenario.steps[0];
  const resolved = await resolveCatalogBindingGraph({bootstrap: {id: vector.bootstrap.id,
    record: catalogBootstrapFromCarrierTerm(vector.bootstrap.record)!}, frames, rotations: new Map(),
    catalogs: new Map((step.catalogs as string[]).map((id) => [id, catalogEnvelopeFromCarrierTerm(JSON.parse(vector.artifacts[id]))!])),
    provenCutoffs: step.proven, accepted: null});
  assert.ok(resolved.ok);
  const next = {...claim, parents: [labels.R!], priorCatalogs: [{binding: labels.R!, catalog: labels.KR!}], generation: 2};
  assert.equal(coverCatalogReplacementClaim(resolved.graph, next, kr), null);
  assert.equal(coverCatalogReplacementClaim(resolved.graph, next, [fresh, moved]), "invalid_catalog_transition");
});

// Design section 1.5: only an accepting decision that clears lifts frozen; a freezing block sets it.
test("advanceCatalogBindingState lifts frozen only on an accepting decision that clears", () => {
  const a = {binding: "b", generation: 0, catalog: "c", revision: 0, routes: {"/a": "space"}};
  const result = (accepted: boolean, clears: boolean, block: CatalogBindingBlock | null): CatalogBindingGraphResult => ({ok: true,
    graph: {catalogs: new Map([["k", {entries: [{route: "/k", replica: "space"}]}]]),
      decision: {accepted, head: "h", generation: 1, catalog: accepted ? "k" : null, revision: 0, clearsAuthorityChanged: clears,
        block, serving: accepted ? "k" : null}} as unknown as CatalogBindingGraph});
  const frozen = {accepted: a, frozen: true};
  assert.deepEqual(advanceCatalogBindingState(frozen, result(true, false, null)), {accepted: a, frozen: true, serving: null});
  assert.deepEqual(advanceCatalogBindingState(frozen, result(true, true, null)), {accepted: {binding: "h", generation: 1,
    catalog: "k", revision: 0, routes: {"/a": "space", "/k": "space"}}, frozen: false, serving: "k"});
  const open = {accepted: a, frozen: false};
  assert.deepEqual(advanceCatalogBindingState(open, result(false, false, {reason: "authority_changed", ids: ["h"], freeze: true})),
    {accepted: a, frozen: true, serving: null});
  assert.deepEqual(advanceCatalogBindingState(open,
    result(false, false, {reason: "catalog_authority_refused", ids: ["h"], freeze: false})), {accepted: a, frozen: false, serving: null});
  assert.deepEqual(advanceCatalogBindingState(frozen, {ok: false, reason: "trust_pending", detail: {ids: []}}),
    {accepted: a, frozen: true, serving: "unchanged"});
});

test("binding_graph_ts_v1.json equals this runtime's outcomes", () => {
  const committed = JSON.parse(readFileSync(tsVectorUrl, "utf8"));
  assert.deepEqual(committed.outcomes, outcomes.map((o) => ({scenario: o.scenario, step: o.step, label: o.label, ts: o.id})));
});
