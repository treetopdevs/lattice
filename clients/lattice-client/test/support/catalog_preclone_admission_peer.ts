import assert from "node:assert/strict";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
const expected = {trustRevision: 0, historyGeneration: 0};
const f = await trustFixture(0);
const prepared = await prepareTreehouseCatalogInstallation({review: f.review, history: f.histories[0]!, store: {kind: "verified_fresh", expected}});
assert.equal(prepared.kind, "propose");
const accepted = await evaluateTreehouseCatalogTrust({installed: prepared.next, expected,
  incoming: {catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: []}});
assert.equal(accepted.kind, "propose");
const template = {catalogs: [] as string[], rotations: [] as string[],
  histories: [{replica: "outside-bounded-families", frames: [], rejected: []}], cutoffProofs: [] as unknown[]};
const cases = [];
for (const name of ["over-string", "within", "saved-corrupt", "cheap-token", "cheap-count", "over-depth", "over-nodes"]) {
  const installed = name === "saved-corrupt" ? {...accepted.next, histories: []} : accepted.next;
  const token = name === "cheap-token" ? {...expected, trustRevision: -1} : expected;
  const incoming = structuredClone(template);
  if (name === "over-depth" || name === "over-nodes") {
    let tree: unknown = [];
    for (let depth = 0; depth < (name === "over-depth" ? 210 : 26); depth++) tree = name === "over-depth" ? [tree] : [tree, tree];
    incoming.cutoffProofs = [tree];
  } else {
    incoming.catalogs = [name === "within" ? "not JSON" : "x".repeat(64 * 1024 * 1024 + 1)];
    if (name === "cheap-count") incoming.catalogs.push(...Array<string>(32).fill("not JSON"));
  }
  const decision = await evaluateTreehouseCatalogTrust({installed, expected: token, incoming} as never);
  assert.equal(decision.kind, "reject");
  const reason = name === "within" ? "wrong_catalog_scope" : name === "saved-corrupt" ? "trust_recovery_required" :
    name === "cheap-token" ? "malformed_catalog" : name === "cheap-count" ? "control_history_limit" : "invalid_verified_history";
  assert.equal(decision.reason, reason, name);
  cases.push({name, decision});
}
// Large values are constructed independently by both public-owner controls.
// Only the fresh signed snapshot, small template and actual decisions cross IPC.
console.log(JSON.stringify({installed: accepted.next, expected, template, cases}));
