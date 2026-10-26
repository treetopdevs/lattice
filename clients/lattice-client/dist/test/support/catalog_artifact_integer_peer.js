import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture, signedCatalog } from "./export_treehouse_catalog_trust";
import { catalogRotationEnvelopeFromCarrierTerm, catalogRotationId } from "../../src/treehouse_catalog_codec";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
async function produce() {
    const f = await trustFixture();
    const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    return { ...f, rotatedCatalogJson: await signedCatalog({ ...f.catalog, binding: catalogRotationId(rotation) }, f.nextCatalogSigner) };
}
function mutate(json, field, token) {
    const result = json.replace(new RegExp(`(\\["atom","${field}"\\],\\["int",)[^\\]]+`), (_all, prefix) => prefix + token);
    assert.notEqual(result, json);
    return result;
}
const b = process.argv[2] === "consume" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : await produce();
const bundle = { review: b.review, histories: b.histories, cutoffProofs: b.cutoffProofs, catalogJson: b.catalogJson, rotationJson: b.rotationJson, rotatedCatalogJson: b.rotatedCatalogJson };
const expected = { trustRevision: 0, historyGeneration: 0 }, page = { catalogs: [], rotations: [], histories: [], cutoffProofs: [] };
const prepared = await prepareTreehouseCatalogInstallation({ review: b.review, history: b.histories[0], store: { kind: "verified_fresh", expected } });
assert.equal(prepared.kind, "propose");
const run = (installed, incoming = {}) => evaluateTreehouseCatalogTrust({ installed, expected, incoming: { ...page, ...incoming } });
const base = await run(prepared.next, { catalogs: [b.catalogJson], histories: b.histories });
assert.equal(base.kind, "propose");
const rotated = await run(base.next, { catalogs: [b.rotatedCatalogJson], rotations: [b.rotationJson], cutoffProofs: b.cutoffProofs });
assert.equal(rotated.kind, "propose");
assert.equal(rotated.next.accepted?.generation, 1);
const cases = [];
for (const [field, original, rotation] of [["version", b.catalogJson, false], ["revision", b.catalogJson, false], ["generation", b.rotationJson, true]]) {
    const n = field === "revision" ? 0 : 1;
    for (const token of [JSON.stringify(String(n)), `${n}.0`, `${n}e0`, "-0", "9007199254740992", "9".repeat(10000), JSON.stringify("9".repeat(10000)), "01", "duplicate"]) {
        const json = token === "duplicate" ? original.replace(`[["atom","${field}"],["int",${n}]]`, `[["atom","${field}"],["int",${n}]],[["atom","${field}"],["int",${n}]]`) : mutate(original, field, token), results = [];
        assert.notEqual(json, original);
        const states = rotation ? [base.next, rotated.next] : [prepared.next, base.next];
        for (const state of states) {
            const before = JSON.stringify(state);
            const d = await run(state, rotation ? { rotations: [json], catalogs: [b.rotatedCatalogJson], cutoffProofs: b.cutoffProofs } : { catalogs: [json], histories: b.histories });
            assert.equal(d.kind, "reject");
            assert.equal(d.reason, "malformed_catalog");
            assert.equal(JSON.stringify(state), before);
            results.push(d);
        }
        const broken = structuredClone(rotation ? rotated.next : base.next);
        if (rotation)
            broken.rotations[0].json = json;
        else
            broken.catalogs[0].json = json;
        const saved = await run(broken, { catalogs: [b.catalogJson, b.rotatedCatalogJson], rotations: [b.rotationJson], histories: b.histories, cutoffProofs: b.cutoffProofs });
        assert.equal(saved.kind, "reject");
        assert.equal(saved.reason, "trust_recovery_required");
        cases.push({ field, rotation, json, results, saved });
    }
}
const controls = [];
for (const [rotation, original, state] of [[false, b.catalogJson, prepared.next], [true, b.rotationJson, base.next]]) {
    const padded = original + " ".repeat(128 * 1024 - Buffer.byteLength(original));
    const d = await run(state, rotation ? { rotations: [padded], catalogs: [b.rotatedCatalogJson], cutoffProofs: b.cutoffProofs } : { catalogs: [padded], histories: b.histories });
    assert.equal(d.kind, "propose");
    const over = await run(state, rotation ? { rotations: [padded + " "] } : { catalogs: [padded + " "] });
    assert.equal(over.kind, "reject");
    assert.equal(over.reason, "control_history_limit");
    controls.push({ rotation, json: padded, result: d, over });
}
console.log(JSON.stringify({ bundle, cases, base, rotated, controls }));
