import assert from "node:assert/strict";
import { test } from "node:test";
import { trustFixture } from "./support/export_treehouse_catalog_trust";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust, resolveTreehouseCatalogRoute } from "../src/treehouse_catalog_trust";

const expected = {trustRevision: 0, historyGeneration: 0};
test("explicit root review and real independently rooted Space/Thread histories produce only installation-required catalog routes", async () => {
  const f = await trustFixture();
  const prepared = await prepareTreehouseCatalogInstallation({review: f.review, history: f.histories[0]!, store: {kind: "verified_fresh", expected}});
  assert.equal(prepared.kind, "propose");
  assert.equal(prepared.next.accepted, null);
  const result = await evaluateTreehouseCatalogTrust({installed: prepared.next, expected,
    incoming: {catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: []}});
  assert.equal(result.kind, "propose");
  assert.equal(result.next.accepted?.revision, 0);
  assert.equal(result.routes.length, 2);
  const route = resolveTreehouseCatalogRoute({decision: result, replica: f.threads[0]!.replica});
  assert.equal(route.ok, true);
  if (route.ok) { assert.equal(route.installationRequired, true); assert.equal(route.candidate.root, f.catalog.entries.find((e) => e.kind === "thread")!.root); }
});
