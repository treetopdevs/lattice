// TS twin of apps/lattice_core/test/treehouse/catalog_replacement_authoring_test.exs (plan 316 PR 2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { authorCarrierDelegation, authorCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import type { CarrierOpFrame, CarrierTerm } from "../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../src/township";
import { deriveTreehouseCatalogCutoff } from "../src/treehouse_catalog_cutoff";
import { catalogReplacementClaimToCarrierTerm } from "../src/treehouse_catalog_codec";
import type { CatalogEntry } from "../src/treehouse_catalog_codec";
import {
  authorTreehouseCatalogReplacementFromFrames, prepareTreehouseCatalogReplacementFromFrames,
} from "../src/index";
import type {
  TreehouseCatalogReplacementAttempt, TreehouseCatalogReplacementJournal, TreehouseCatalogReplacementRequest,
} from "../src/index";
import { judge, replacementBaseFixture, seededSigner } from "./support/export_treehouse_catalog_replacement";

const atom = (name: string): CarrierTerm => ["atom", name];
const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
const nil: CarrierTerm = ["nil"];
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const text = (value: string): CarrierTerm => ["bin", b64(new TextEncoder().encode(value))];
const id = (label: string) => createHash("sha256").update(`r316-pr2-ts-${label}`).digest("base64url");

async function fixture(options: { beacon?: boolean } = {}) {
  const base = await replacementBaseFixture("r316-pr2-ts-");
  const leased = await authorCarrierDelegation({ replica: base.replica, signer: base.root, audiencePubkey: base.nominee.publicKey,
    parentId: base.delegation.id, ops: ["create_space", "create_thread", "replace_catalog_v1"], roles: ["admin"], expiresEpoch: 10 });
  const transfer = await authorCarrierOp({ replica: base.replica, signer: base.root, deps: [base.bootstrap.id], kind: "authority", cap: nil,
    body: tuple(atom("transfer"), atom("admin"), ["delegation", leased], ["int", 0]) });
  const frames: CarrierOpFrame[] = [...base.frames, transfer];
  let beacon: CarrierOpFrame | null = null;
  if (options.beacon !== false) {
    beacon = await authorCarrierOp({ replica: base.replica, signer: base.root, deps: [transfer.id], kind: "authority", cap: nil,
      body: tuple(atom("beacon"), ["int", 1]) });
    frames.push(beacon);
  }
  const thread = await bindTownshipReplica(`replica:treehouse:thread:${id("thread")}`, base.root.publicKey);
  const threadDelegation = await authorCarrierDelegation({ replica: thread, signer: base.root, audiencePubkey: base.root.publicKey,
    ops: ["post"], roles: [], live: true });
  const threadGenesis = await authorCarrierOp({ replica: thread, signer: base.root, deps: [], kind: "authority", cap: nil,
    body: tuple(atom("genesis"), ["delegation", threadDelegation], ["map", []]) });
  const newCatalog = seededSigner("r316-pr2-ts-new-catalog"), newService = seededSigner("r316-pr2-ts-new-service");
  return { ...base, leased, transfer, beacon, frames, thread, threadGenesis, newCatalog, newService };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const post = (f: Fixture, body: string) => authorCarrierOp({ replica: f.thread, signer: f.root, deps: [f.threadGenesis.id],
  kind: "command", cap: nil, body: tuple(atom("post"), ["list", [text(body)]]) });

function entries(f: Fixture, serviceKey: string): CatalogEntry[] {
  const entry = (replica: string, kind: "space" | "thread", genesis: string, creation: string, reference: string): CatalogEntry => ({
    product: "treehouse", replica, kind, schema: kind === "space" ? "treehouse_space_v1" : "treehouse_thread_v1",
    root: b64(f.root.publicKey), genesis, creation, reference, route: `/r/${id(`route-${replica}`)}`, serviceId: id("service"), serviceKey });
  return [entry(f.replica, "space", f.genesis.id, f.creation.id, f.bootstrap.id),
    entry(f.thread, "thread", f.threadGenesis.id, f.threadGenesis.id, id("thread-reference"))]
    .sort((a, b) => a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0);
}

function request(f: Fixture, overrides: Partial<TreehouseCatalogReplacementRequest> = {}, threadFrames: unknown[] = [f.threadGenesis]): TreehouseCatalogReplacementRequest {
  const serviceKey = overrides.newServiceKey ?? b64(f.newService.publicKey);
  return { author: b64(f.nominee.publicKey), nonce: id("nonce"), parents: [f.bootstrap.id],
    priorCatalogs: [{ binding: f.bootstrap.id, catalog: null }], generation: 1, newCatalogKey: b64(f.newCatalog.publicKey),
    newServiceId: id("service"), newServiceKey: serviceKey, newOrigin: "wss://replacement-relay.invalid",
    entries: entries(f, serviceKey), replicaHistories: { [f.thread]: { frames: threadFrames, rejected: [] } }, ...overrides };
}

let signed: string[] = [];
const spy = (signer: CarrierOpSigner, label: string, during: () => void = () => {}): CarrierOpSigner => ({
  publicKey: signer.publicKey, sign: (bytes) => { signed.push(label); const signature = signer.sign(bytes); during(); return signature; },
});
const possess = (f: Fixture, attempt: TreehouseCatalogReplacementAttempt) => ({
  catalog: b64(spy(f.newCatalog, "catalog_possession").sign(attempt.catalogPossessionBytes) as Uint8Array),
  service: b64(spy(f.newService, "service_possession").sign(attempt.servicePossessionBytes) as Uint8Array),
});

async function prepare(f: Fixture, frames: unknown[] = f.frames, req = request(f), journal: TreehouseCatalogReplacementJournal = {}) {
  return prepareTreehouseCatalogReplacementFromFrames({ replica: f.replica, frames, request: req, journal });
}
async function prepared(f: Fixture, journal: TreehouseCatalogReplacementJournal = {}) {
  const result = await prepare(f, f.frames, request(f), journal);
  if (!result.ok) assert.fail(result.reason);
  return result.attempt;
}
const push = (frame: unknown) => new TextEncoder().encode(JSON.stringify({ type: "push", ops: [frame] })).length;

test("catalog_command_too_large before any signature", async () => {
  signed = [];
  const f = await fixture();
  const wide: CarrierOpFrame[] = [f.threadGenesis];
  for (let n = 1; n <= 1_500; n++) wide.push(await post(f, `post ${n}`));
  const refused = await prepare(f, f.frames, request(f, {}, wide));
  assert.deepEqual(refused, { ok: false, reason: "catalog_command_too_large" });
  assert.deepEqual(signed, []);

  const attempt = await prepared(f);
  const possession = possess(f, attempt);
  signed = [];
  const widened = { ...attempt, request: request(f, {}, wide) };
  const stale = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt: widened, possession,
    signer: spy(f.nominee, "op") });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, "stale_verified_state");
  assert.equal(stale.journalEntry.status, "cancelled");
  assert.deepEqual(signed, []);

  // The zero-filled placeholder measures the signed frame byte-exactly.
  const zero = b64(new Uint8Array(64));
  const placeholder = await authorCarrierOp({ replica: f.replica, deps: attempt.frozenFrontier, kind: "command", cap: townshipCapTerm(attempt.cap),
    body: tuple(atom("replace_catalog_v1"), ["list", [catalogReplacementClaimToCarrierTerm(attempt.claim)!,
      ["bin", zero], ["bin", zero]]]), signer: { publicKey: f.nominee.publicKey, sign: () => new Uint8Array(64) } });
  const result = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession, signer: spy(f.nominee, "op") });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(push(placeholder), push(result.frame));
});

test("catalog_epoch_missing with zero beacons", async () => {
  signed = [];
  const f = await fixture({ beacon: false });
  assert.deepEqual(await prepare(f), { ok: false, reason: "catalog_epoch_missing" });
  assert.deepEqual(signed, []);
});

test("a changed dep, key or cutoff requires new possession bytes", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const possession = possess(f, attempt);
  signed = [];

  // (dep) An ordinary honored Space command after the freeze.
  const command = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: attempt.frozenFrontier, kind: "command",
    cap: townshipCapTerm(f.leased.id), body: tuple(atom("create_thread"), ["list", [text(f.thread), text("Moved")]]) });
  const moved = [...f.frames, command];
  assert.equal((await judge(moved)).get(command.id), undefined);
  const dep = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => moved, attempt, possession, signer: spy(f.nominee, "op") });
  assert.deepEqual(dep.ok ? null : [dep.reason, dep.journalEntry.status], ["stale_verified_state", "cancelled"]);

  // (key) A swapped new service key is a different claim; the old possession refuses.
  const swapped = request(f, { newServiceKey: b64(seededSigner("r316-pr2-ts-other-service").publicKey) });
  const rekeyed = await prepare(f, f.frames, swapped);
  assert.equal(rekeyed.ok, true);
  if (!rekeyed.ok) return;
  assert.notDeepEqual(rekeyed.attempt.catalogPossessionBytes, attempt.catalogPossessionBytes);
  const key = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt: rekeyed.attempt, possession,
    signer: spy(f.nominee, "op") });
  assert.deepEqual(key.ok ? null : [key.reason, key.journalEntry.status], ["invalid_possession", "cancelled"]);

  // (cutoff) An op appended to the Thread log after the freeze.
  const later = { ...attempt, request: request(f, {}, [f.threadGenesis, await post(f, "later")]) };
  const cutoff = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt: later, possession,
    signer: spy(f.nominee, "op") });
  assert.deepEqual(cutoff.ok ? null : [cutoff.reason, cutoff.journalEntry.status], ["stale_verified_state", "cancelled"]);
  assert.deepEqual(signed, []);

  const journal = { [attempt.attemptId]: attempt.journalEntry };
  const fresh = await prepare(f, moved, { ...request(f), nonce: id("fresh") }, journal);
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.notDeepEqual(fresh.attempt.catalogPossessionBytes, attempt.catalogPossessionBytes);
  assert.notDeepEqual(fresh.attempt.servicePossessionBytes, attempt.servicePossessionBytes);
  assert.deepEqual(await prepare(f, moved, request(f), journal), { ok: false, reason: "attempt_nonce_reused" });
  assert.deepEqual(await prepare(f, f.frames, swapped, journal), { ok: false, reason: "attempt_nonce_reused" });
});

test("the cutoff excludes the action", async () => {
  signed = [];
  const f = await fixture();
  const attempt = await prepared(f);
  const possession = possess(f, attempt);
  const result = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: async () => f.frames, attempt, possession,
    signer: spy(f.nominee, "op") });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(signed.includes("op"));
  const space = attempt.claim.cutoffs.find((item) => item.replica === f.replica)!;
  assert.deepEqual(space.frontier, result.frame.deps);
  assert.deepEqual(result.frame.deps, attempt.frozenFrontier);
  const derived = await deriveTreehouseCatalogCutoff({ replica: f.replica, frames: f.frames, rejected: [] });
  assert.equal(derived.ok && derived.cutoff.logDigest, space.logDigest);
  assert.ok(attempt.claim.cutoffs.every((item) => !item.frontier.includes(result.frame.id)));
  assert.equal(result.bindingId, result.frame.id);
  assert.equal(result.attemptId, attempt.claim.nonce);
  assert.deepEqual(result.journalEntry, { attemptId: attempt.attemptId, claimBytes: attempt.claimBytes, status: "signed", reason: null,
    opId: result.frame.id });
  assert.equal(attempt.claim.holderEpoch, f.transfer.id);
  assert.equal(attempt.cap, f.leased.id);
  assert.deepEqual([attempt.claim.epoch, attempt.claim.epochBasis], [1, [f.beacon!.id]]);
  assert.equal((await judge([...f.frames, result.frame])).get(result.frame.id), undefined);
});

test("authority reclassification of the frozen state cancels the pending attempt before and after the signing call (C13)", async () => {
  const f = await fixture();
  for (const label of ["revoke", "lapse"] as const) {
    const attempt = await prepared(f);
    const possession = possess(f, attempt);
    const change = await authorCarrierOp({ replica: f.replica, signer: f.root, deps: attempt.frozenFrontier, kind: "authority", cap: nil,
      body: label === "revoke" ? tuple(atom("revoke"), text(f.leased.id)) : tuple(atom("beacon"), ["int", 11]) });

    const honored = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession, signer: f.nominee });
    assert.equal(honored.ok, true);
    if (!honored.ok) return;
    assert.equal((await judge([...f.frames, change, honored.frame])).get(honored.frame.id),
      label === "revoke" ? "revoked_capability" : "lease_expired");

    // (before)
    signed = [];
    let store: CarrierOpFrame[] = [...f.frames, change];
    const before = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => store, attempt, possession, signer: spy(f.nominee, "op") });
    assert.deepEqual(before.ok ? null : [before.reason, before.journalEntry.status], ["authority_changed", "cancelled"], `${label} before`);
    assert.deepEqual(signed, []);

    // (after) The same change lands while the signer runs.
    store = [...f.frames];
    const after = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => store, attempt, possession,
      signer: spy(f.nominee, "op", () => { store = [...store, change]; }) });
    assert.equal(after.ok, false, `${label} after`);
    if (after.ok) return;
    assert.equal(after.reason, "authority_changed");
    assert.equal(after.journalEntry.status, "cancelled_after_signature");
    assert.equal(after.journalEntry.opId, null);
    assert.equal("frame" in after, false);
    assert.deepEqual(signed, ["op"]);
  }
});

test("an identical retry under the same nonce is idempotent", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const retry = await prepared(f, { [attempt.attemptId]: attempt.journalEntry });
  assert.deepEqual(retry.claimBytes, attempt.claimBytes);
  assert.equal(retry.journalEntry.status, "awaiting_possession");
  const first = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession: possess(f, attempt), signer: f.nominee });
  const second = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt: retry, possession: possess(f, retry), signer: f.nominee });
  assert.equal(first.ok && second.ok && first.frame.id === second.frame.id, true);
  const wrong = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession: possess(f, attempt), signer: f.root });
  assert.deepEqual(wrong.ok ? null : wrong.reason, "wrong_signer");
  assert.deepEqual(await prepare(f, f.frames, { ...request(f), author: b64(f.root.publicKey) }), { ok: false, reason: "not_holder" });
});
