// Fresh public retained snapshots plus actual source numeric/depth observations.
// Shape bounds are separate from full graph/authentication validation.
import assert from "node:assert/strict";
import { trustFixture, signedCatalog, fixtureId } from "./export_treehouse_catalog_trust";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
import { transportCatalogId } from "../../src/treehouse_catalog_codec";
import { withinCatalogRawEvidenceBounds } from "../../src/treehouse_catalog_raw_bounds";
const f = await trustFixture(2), expected = { trustRevision: 0, historyGeneration: 0 };
const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
assert.equal(prepared.kind, "propose");
const installed = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: [] } });
assert.equal(installed.kind, "propose");
assert.equal(installed.routes.length, 3);
const one = { ...f.catalog, revision: 1, previous: transportCatalogId(f.catalog) };
const sibling = { ...one, entries: one.entries.map(e => ({ ...e, route: `/r/${fixtureId(`snapshot-fork-${e.replica}`)}` })) };
const fork = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { catalogs: [f.catalogJson, await signedCatalog(one, f.catalogSigner), await signedCatalog(sibling, f.catalogSigner)], rotations: [], histories: f.histories, cutoffProofs: [] } });
assert.equal(fork.kind, "retain_blocked");
assert.equal(fork.reason, "catalog_fork");
const original = JSON.stringify(installed.next);
const numerics = [["9007199254740991.0", 9007199254740991], ["9007199254740990.0", 9007199254740990], ["1e0", 1], ["-0.0", -0]].map(([lexeme, expectedValue]) => {
    const json = original.replace('"generation":0', `"generation":${lexeme}`);
    assert.notEqual(json, original);
    const value = JSON.parse(json).accepted.generation;
    assert.equal(typeof value, "number");
    assert(Number.isSafeInteger(value));
    assert.equal(value, expectedValue, lexeme);
    return { lexeme, json, value };
});
const depthCases = [];
for (const [name, n, leaf] of [["level205empty", 203, "array"], ["level206empty", 204, "array"], ["level205scalar", 203, "scalar"], ["level205object", 203, "object"], ["level206object", 204, "object"]]) {
    let tail = leaf === "scalar" ? [0] : leaf === "object" ? {} : [];
    for (let i = 0; i < n; i++)
        tail = [tail];
    const state = { ...installed.next, cutoffProofs: tail };
    depthCases.push({ name, json: JSON.stringify(state), withinSourceBounds: withinCatalogRawEvidenceBounds(state) });
}
assert.deepEqual(depthCases.map(c => c.withinSourceBounds), [true, false, true, true, false]);
console.log(JSON.stringify({ states: [prepared.next, installed.next, fork.next], numerics, depthCases }));
