import test from "node:test";
import assert from "node:assert/strict";
import {trustFixture, fixtureSigner} from "./support/export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../src/treehouse";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../src/treehouse_catalog_trust";
import {copyCatalogInput} from "../src/treehouse_catalog_input_copy";

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
  const hiddenDecoration = Object.defineProperty([0], "decoration", {get: getter, enumerable: false});
  const symbol = Object.defineProperty([0], Symbol("decoration"), {value: 0, enumerable: false});
  for (const row of [indexed, hiddenIndex, decorated, hiddenDecoration, symbol]) {
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

test("only array enumeration RangeError permits ignored hidden decorations, with unsafe metadata still refused", async () => {
  const fixture = await setup();
  const baseline = await evaluateTreehouseCatalogTrust({...fixture, expected} as never);
  assert.equal(baseline.kind, "retain_blocked");
  let calls = 0;
  const getter = () => { calls++; throw Error("engine-ceiling getter executed"); };
  const hidden = Object.defineProperty([0], "hidden", {get: getter, enumerable: false});
  const inherited = Object.setPrototypeOf([0], Object.defineProperty(Object.create(Array.prototype), "inherited", {get: getter, enumerable: true}));
  const index = Object.defineProperty([], "0", {get: getter, enumerable: true});
  const hiddenIndex = Object.defineProperty([], "0", {get: getter, enumerable: false});
  const visible = Object.defineProperty([0], "visible", {get: getter, enumerable: true});
  const extra = Object.assign([0], {extra: 0});
  const symbol = Object.defineProperty([0], Symbol("hidden"), {value: 0});
  const cycle: unknown[] = []; cycle.push(cycle);
  const ordinaryObject = {};
  const otherFailure = [0];
  const rejected = [index, hiddenIndex, visible, extra, symbol, cycle, ordinaryObject, otherFailure];
  const ceiling = new WeakSet<object>([hidden, inherited, ...rejected]);
  const ownKeys = Reflect.ownKeys;
  try {
    // Fault injection covers hostile metadata cheaply; the separate full-size
    // actual-owner regression proves the engine ceiling on genuine raw JSON.
    Reflect.ownKeys = (value: object) => {
      if (value === otherFailure) throw Error("unrelated enumeration failure");
      if (ceiling.has(value)) throw new RangeError("enumeration ceiling");
      return ownKeys(value);
    };
    for (const row of [hidden, inherited]) {
      const decision = await evaluateTreehouseCatalogTrust({...fixture, expected,
        incoming: {...fixture.incoming, cutoffProofs: [row]}} as never);
      assert.deepEqual(decision, baseline);
    }
    for (const row of rejected) {
      const decision = await evaluateTreehouseCatalogTrust({...fixture, expected,
        incoming: {...fixture.incoming, cutoffProofs: [row]}} as never);
      assert.deepEqual(decision, {kind: "reject", reason: "malformed_catalog",
        detail: {ids: [], coreReason: null, pendingProofIds: []}});
    }
    assert.equal(calls, 0);
  } finally { Reflect.ownKeys = ownKeys; }
});

test("engine-ceiling capture never visits a proxy in an array prototype chain", async () => {
  const fixture = await setup();
  const baseline = await evaluateTreehouseCatalogTrust({...fixture, expected} as never);
  const token = {...expected};
  let trapCalls = 0, getterCalls = 0;
  const prototype = new Proxy({}, {ownKeys() {
    trapCalls++;
    Object.defineProperty(token, "trustRevision", {enumerable: true, configurable: true,
      get() { getterCalls++; return 0; }});
    return [];
  }});
  const row = Object.setPrototypeOf([0], prototype);
  const ownKeys = Reflect.ownKeys;
  try {
    Reflect.ownKeys = (value: object) => {
      if (value === row) throw new RangeError("enumeration ceiling");
      return ownKeys(value);
    };
    const actual = await evaluateTreehouseCatalogTrust({...fixture, expected: token,
      incoming: {...fixture.incoming, cutoffProofs: [row]}} as never);
    assert.deepEqual(actual, baseline);
    assert.equal(trapCalls, 0);
    assert.equal(getterCalls, 0);
  } finally { Reflect.ownKeys = ownKeys; }
});

test("engine-ceiling capture preserves composite aliases and holes without changing the input", () => {
  const shared = {values: [1]};
  const row = [shared, , shared];
  const ownKeys = Reflect.ownKeys;
  try {
    Reflect.ownKeys = (value: object) => {
      if (value === row) throw new RangeError("enumeration ceiling");
      return ownKeys(value);
    };
    const copy = copyCatalogInput(row);
    assert.deepEqual(copy, row);
    assert.notEqual(copy, row);
    assert.equal(copy[0], copy[2]);
    assert.notEqual(copy[0], shared);
    assert.equal(Object.hasOwn(copy, "1"), false);
    assert.equal(Object.hasOwn(row, "1"), false);
  } finally { Reflect.ownKeys = ownKeys; }
});
