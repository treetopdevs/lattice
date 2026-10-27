import test from "node:test";
import assert from "node:assert/strict";
import {trustFixture, fixtureSigner} from "./support/export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../src/treehouse";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../src/treehouse_catalog_trust";

const expected = {trustRevision: 0, historyGeneration: 0};
async function setup() {
  const f = await trustFixture(0);
  const prepared = await prepareTreehouseCatalogInstallation({review: f.review, history: f.histories[0]!, store: {kind: "verified_fresh", expected}});
  assert.equal(prepared.kind, "propose");
  const accepted = await evaluateTreehouseCatalogTrust({installed: prepared.next, expected,
    incoming: {catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: []}});
  assert.equal(accepted.kind, "propose");
  const {frame} = await authorTreehouseRoleTransfer({replica: f.space.replica, deps: [f.space.creation.id], signer: f.root, parent: f.space.delegation,
    recipient: fixtureSigner("capture-successor").publicKey, action: "transfer_admin"});
  return {installed: accepted.next, incoming: {catalogs: [] as string[], rotations: [] as string[],
    histories: [{...f.histories[0]!, frames: [...f.space.frames, frame]}], cutoffProofs: [null] as unknown[]}};
}

test("capture refuses visible/index accessors and symbols without executing getters before a security freeze", async () => {
  const fixture = await setup();
  const control = await evaluateTreehouseCatalogTrust({...fixture, expected} as never);
  assert.equal(control.kind, "retain_blocked");
  assert.equal(control.reason, "authority_changed");
  let calls = 0;
  const getter = () => { calls++; throw Error("capture getter executed"); };
  const indexed = Object.defineProperty([], "0", {get: getter, enumerable: true});
  const hiddenIndex = Object.defineProperty([], "0", {get: getter, enumerable: false});
  const decorated = Object.defineProperty([0], "decoration", {get: getter, enumerable: true});
  const symbol = Object.defineProperty([0], Symbol("decoration"), {value: 0, enumerable: false});
  for (const row of [indexed, hiddenIndex, decorated, symbol]) {
    const decision = await evaluateTreehouseCatalogTrust({...fixture, expected,
      incoming: {...fixture.incoming, cutoffProofs: [row]}} as never);
    assert.deepEqual(decision, {kind: "reject", reason: "malformed_catalog",
      detail: {ids: [], coreReason: null, pendingProofIds: []}});
  }
  assert.equal(calls, 0);
});

test("saved corruption retains priority over unsafe incoming metadata and capture never reads the getter", async () => {
  const fixture = await setup();
  let calls = 0;
  const incoming = Object.defineProperty({...fixture.incoming}, "cutoffProofs", {
    enumerable: true, get() { calls++; throw Error("incoming getter executed"); },
  });
  const installed = {...fixture.installed, histories: []};
  const decision = await evaluateTreehouseCatalogTrust({installed, expected, incoming} as never);
  assert.deepEqual(decision, {kind: "reject", reason: "trust_recovery_required",
    detail: {ids: [], coreReason: null, pendingProofIds: []}});
  assert.equal(calls, 0);
});

test("capture rejects cycles and nonplain values while preserving shared acyclic malformed JSON fallback", async () => {
  const fixture = await setup();
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const row of [cycle, new Date(0)]) {
    const decision = await evaluateTreehouseCatalogTrust({...fixture, expected,
      incoming: {...fixture.incoming, cutoffProofs: [row]}} as never);
    assert.equal(decision.kind, "reject");
    assert.equal(decision.reason, "malformed_catalog");
  }
  const shared: unknown[] = [0];
  const decision = await evaluateTreehouseCatalogTrust({...fixture, expected,
    incoming: {...fixture.incoming, cutoffProofs: [shared, shared]}} as never);
  assert.equal(decision.kind, "retain_blocked");
  assert.equal(decision.reason, "authority_changed");
});

test("both origins are captured before caller mutations during asynchronous original replay", async () => {
  const fixture = await setup();
  const baseline = await evaluateTreehouseCatalogTrust({...fixture, expected} as never);
  assert.equal(baseline.kind, "retain_blocked");
  const input = structuredClone({...fixture, expected});
  const pending = evaluateTreehouseCatalogTrust(input as never);
  input.installed.histories.length = 0;
  input.installed.catalogs.length = 0;
  input.incoming.histories.length = 0;
  input.incoming.cutoffProofs.length = 0;
  input.expected.trustRevision = 1;
  assert.deepEqual(await pending, baseline);
});
