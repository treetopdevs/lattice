import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treehouseCatalogBootstrapsFromFrames } from "../../src/treehouse";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
import type { TreehouseCatalogEvidencePage } from "../../src/treehouse_catalog_trust";

// Independent real evaluator consumer for BEAM-generated operator files. This
// test program creates candidate state only; it does not install app trust.
const bytes = readFileSync(process.argv[2]!);
assert.ok(bytes.length <= 64 * 1024 * 1024);
const doc = JSON.parse(bytes.toString("utf8")) as {
  format: string; space: string; bootstrapId: string; head: string;
  pages: TreehouseCatalogEvidencePage[];
};
assert.deepEqual(Object.keys(doc).sort(), ["bootstrapId", "format", "head", "pages", "space"]);
assert.equal(doc.format, "lattice-catalog-evidence-page-v1");
assert.ok(doc.pages.length > 0 && doc.pages.length <= 32);
const histories = doc.pages.flatMap(page => page.histories);
const spaces = histories.filter(history => history.replica === doc.space);
assert.equal(spaces.length, 1);
const history = spaces[0]!;
const observed = await treehouseCatalogBootstrapsFromFrames(history);
assert.equal(observed.ok, true);
assert.equal(observed.bootstraps.length, 1);
const bootstrap = observed.bootstraps[0]!;
assert.equal(bootstrap.id, doc.bootstrapId);
const expected = {trustRevision: 0, historyGeneration: 0};
const prepared = await prepareTreehouseCatalogInstallation({
  review: {version: 1, product: "treehouse", space: doc.space,
    spaceRoot: bootstrap.record.spaceRoot, bootstrapId: bootstrap.id,
    observedBootstrapIds: [bootstrap.id], disposition: "pin_exact_observed_bootstrap"},
  history, store: {kind: "verified_fresh", expected},
});
assert.equal(prepared.kind, "propose");
assert.equal(prepared.reason, null);
let state = prepared.next;
for (const page of doc.pages) {
  assert.deepEqual(Object.keys(page).sort(), ["catalogs", "cutoffProofs", "histories", "rotations"]);
  const decision = await evaluateTreehouseCatalogTrust({installed: state, expected, incoming: page});
  assert.equal(decision.kind, "propose", decision.reason ?? "unexpected unchanged candidate");
  assert.equal(decision.reason, null);
  state = decision.next;
}
assert.equal(state.accepted?.catalog, doc.head);
assert.equal(state.blocked, null);
const snapshotBytes = Buffer.byteLength(JSON.stringify(state));
assert.ok(snapshotBytes <= 32 * 1024 * 1024);
assert.equal(state.catalogs.reduce((sum, entry) => sum + Buffer.byteLength(entry.json), 0),
  doc.pages.flatMap(page => page.catalogs).reduce((sum, entry) => sum + Buffer.byteLength(entry), 0));
console.log(JSON.stringify({head: state.accepted.catalog, snapshotBytes,
  artifactBytes: state.catalogs.reduce((sum, entry) => sum + Buffer.byteLength(entry.json), 0)}));
