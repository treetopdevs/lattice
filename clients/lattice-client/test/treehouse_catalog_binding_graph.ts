// Plan 316 PR 4a: the TS binding-graph resolver reproduces every hand-written expectation and every BEAM outcome in
// binding_graph_v1.json, with this runtime's own state persistence, and agrees with BEAM on the generation horizon.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nextCatalogGeneration } from "../src/treehouse_catalog_binding_graph";
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

test("binding_graph_ts_v1.json equals this runtime's outcomes", () => {
  const committed = JSON.parse(readFileSync(tsVectorUrl, "utf8"));
  assert.deepEqual(committed.outcomes, outcomes.map((o) => ({scenario: o.scenario, step: o.step, label: o.label, ts: o.id})));
});
