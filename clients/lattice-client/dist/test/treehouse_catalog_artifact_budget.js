// TS twin of apps/lattice_core/test/treehouse/catalog_artifact_budget_test.exs (rows 355, 525).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm } from "../src/treehouse_catalog_codec";
import { CATALOG_ARTIFACT_BYTES, TREEHOUSE_CATALOG_MAX_ARTIFACTS, TREEHOUSE_CATALOG_MAX_TOTAL_BYTES, catalogEnvelopeJsonBytes, catalogRotationEnvelopeJsonBytes, checkCatalogArtifactBudget, } from "../src/index";
const vector = JSON.parse(readFileSync(new URL("./vectors/catalog/artifact_budget_v1.json", import.meta.url), "utf8"));
const expand = (sizes) => sizes.flatMap(([size, count]) => Array(count).fill(size));
test("vector limits are the exported ones", () => {
    assert.equal(CATALOG_ARTIFACT_BYTES, vector.limits.max_artifact_bytes);
    assert.equal(TREEHOUSE_CATALOG_MAX_ARTIFACTS, vector.limits.max_artifacts);
    assert.equal(TREEHOUSE_CATALOG_MAX_TOTAL_BYTES, vector.limits.max_total_bytes);
});
test("vector envelopes decode and measure to their recorded bytes", () => {
    assert.deepEqual(vector.envelopes.map((e) => e.kind), ["catalog", "rotation", "catalog"]);
    for (const { kind, term, bytes } of vector.envelopes) {
        if (kind === "catalog") {
            const envelope = catalogEnvelopeFromCarrierTerm(term);
            assert.notEqual(envelope, null);
            assert.equal(catalogEnvelopeJsonBytes(envelope), bytes);
        }
        else {
            const envelope = catalogRotationEnvelopeFromCarrierTerm(term);
            assert.notEqual(envelope, null);
            assert.equal(catalogRotationEnvelopeJsonBytes(envelope), bytes);
        }
    }
});
test("an envelope the codec cannot encode fails the budget closed", () => {
    assert.equal(checkCatalogArtifactBudget([catalogEnvelopeJsonBytes({ catalog: null })]), "control_history_limit");
    assert.equal(checkCatalogArtifactBudget([catalogRotationEnvelopeJsonBytes(null)]), "control_history_limit");
});
test("budget cases keep their recorded verdicts", () => {
    for (const { name, sizes, verdict } of vector.budgets) {
        assert.equal(checkCatalogArtifactBudget(expand(sizes)) ?? "ok", verdict, name);
    }
    assert.deepEqual(vector.budgets.map((b) => [b.name, b.verdict]), [
        ["empty", "ok"], ["one at the artifact limit", "ok"], ["one over the artifact limit", "control_history_limit"],
        ["total at the limit", "ok"], ["total over the limit", "control_history_limit"], ["count at the limit", "ok"],
        ["count over the limit", "control_history_limit"],
    ]);
});
test("CatalogTrust's count and total literals are the mirrored ones", () => {
    const source = readFileSync(new URL("../src/treehouse_catalog_trust.ts", import.meta.url), "utf8");
    const message = "CatalogTrust budgets changed: update treehouse_catalog_artifact_budget.ts";
    assert.ok(source.includes("> 1024"), message);
    assert.ok(source.includes("> 16 * 1024 * 1024"), message);
});
