// TS twin of apps/lattice_core/test/treehouse/catalog_replacement_authoring_test.exs (plan 316 PR 2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { authorCarrierDelegation, authorCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import type { CarrierOpFrame, CarrierTerm } from "../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../src/township";
import { deriveTreehouseCatalogCutoff } from "../src/treehouse_catalog_cutoff";
import {
  canonicalBytesForCatalogReplacementPossession, canonicalBytesForCatalogRotation, canonicalBytesForCatalogRotationPossession,
  canonicalBytesForTransportCatalog, catalogInventoryId, catalogReplacementClaimToCarrierTerm, catalogRotationId, transportCatalogId,
} from "../src/treehouse_catalog_codec";
import type { CatalogEntry, CatalogEnvelope, CatalogRotationEnvelope, TransportCatalog } from "../src/treehouse_catalog_codec";
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
    entries: entries(f, serviceKey), replicaHistories: { [f.thread]: { frames: threadFrames, rejected: [] } }, rotations: [], catalogs: [],
    ...overrides };
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

test("a tampered attempt or a corrupt re-read never yields a frame", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  // A caller-held claim that differs from the fresh derivation, with matching possessions, refuses.
  const tampered = { ...attempt, claim: { ...attempt.claim, newOrigin: "wss://attacker.invalid" } };
  const tamperedPossession = possess(f, { ...tampered, catalogPossessionBytes:
    canonicalBytesForCatalogReplacementPossession("catalog", tampered.claim),
    servicePossessionBytes: canonicalBytesForCatalogReplacementPossession("service", tampered.claim) });
  signed = [];
  const stale = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt: tampered,
    possession: tamperedPossession, signer: spy(f.nominee, "op") });
  assert.deepEqual(stale.ok ? null : [stale.reason, stale.journalEntry.status], ["stale_verified_state", "cancelled"]);
  assert.deepEqual(signed, []);
  // Forged rejected-signature evidence on the post-signature re-read withholds the frame.
  let reads = 0;
  const corrupt = await authorTreehouseCatalogReplacementFromFrames({ attempt, possession: possess(f, attempt), signer: f.nominee,
    currentFrames: () => (++reads === 1 ? f.frames : { frames: f.frames, rejected: [{ frame: f.genesis, reason: "bad_signature" as const }] }) });
  assert.deepEqual(corrupt.ok ? null : [corrupt.reason, corrupt.journalEntry.status], ["invalid_verified_history", "cancelled_after_signature"]);
});

// --- review round 1 ---------------------------------------------------------

test("an honored Space command appended during signing withholds the stale frame", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const possession = possess(f, attempt);
  const command = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: attempt.frozenFrontier, kind: "command",
    cap: townshipCapTerm(f.leased.id), body: tuple(atom("create_thread"), ["list", [text(f.thread), text("Moved")]]) });
  let store: CarrierOpFrame[] = [...f.frames];
  signed = [];
  const result = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => store, attempt, possession,
    signer: spy(f.nominee, "op", () => { store = [...store, command]; }) });
  assert.deepEqual(result.ok ? null : [result.reason, result.journalEntry.status, result.journalEntry.opId],
    ["stale_verified_state", "cancelled_after_signature", null]);
  assert.deepEqual(signed, ["op"]);
  assert.equal((await judge(store)).get(command.id), undefined);
});

// --- review round 2 ---------------------------------------------------------

test("a caller attempt mutated during an async signer never pairs the old frame with new claim bytes", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const original = attempt.claimBytes;
  const possession = possess(f, attempt);
  const command = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: attempt.frozenFrontier, kind: "command",
    cap: townshipCapTerm(f.leased.id), body: tuple(atom("create_thread"), ["list", [text(f.thread), text("Moved")]]) });
  let store: CarrierOpFrame[] = [...f.frames];
  const signer: CarrierOpSigner = { publicKey: f.nominee.publicKey, sign: async (bytes) => {
    const signature = f.nominee.sign(bytes);
    store = [...store, command];
    const again = await prepare(f, store);
    if (!again.ok) assert.fail(again.reason);
    Object.assign(attempt, again.attempt);
    return signature;
  } };
  const result = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => store, attempt, possession, signer });
  assert.deepEqual(result.ok ? null : [result.reason, result.journalEntry.status, result.journalEntry.opId],
    ["stale_verified_state", "cancelled_after_signature", null]);
  if (result.ok) return;
  assert.deepEqual(result.journalEntry.claimBytes, original);
  assert.notDeepEqual(attempt.claimBytes, original);
});

const catalogSigner = (_f: Fixture) => seededSigner("r316-pr2-ts-catalog");
// Catalog entries under the bootstrap binding carry the bootstrap's own service pair.
const boundEntries = (f: Fixture) => entries(f, f.record.serviceKey).map((item) => ({ ...item, serviceId: f.record.serviceId }));
function catalog(f: Fixture, binding: string, revision: number, previous: string | null, entries?: CatalogEntry[]): CatalogEnvelope {
  const value: TransportCatalog = { version: 1, product: "treehouse", space: f.replica, bootstrap: f.bootstrap.id, binding, revision,
    previous, entries: entries ?? boundEntries(f) };
  return { catalog: value, signature: b64(catalogSigner(f).sign(canonicalBytesForTransportCatalog(value)) as Uint8Array) };
}
async function rotation(f: Fixture, parent: string, generation: number, old: CarrierOpSigner, next: CarrierOpSigner, label: string,
  prior?: CatalogEnvelope, tamper: (value: CatalogRotationEnvelope["rotation"]) => void = () => {}) {
  const attempt = await prepared(f);
  const value = { version: 1 as const, product: "treehouse" as const, space: f.replica, bootstrap: f.bootstrap.id, parent,
    priorCatalog: prior ? transportCatalogId(prior.catalog) : id(`prior-${label}`), generation, newCatalogKey: b64(next.publicKey),
    nonce: id(`rotation-${label}`), inventoryDigest: prior ? catalogInventoryId(prior.catalog.entries) : attempt.claim.inventoryDigest,
    cutoffs: attempt.claim.cutoffs };
  tamper(value);
  const envelope: CatalogRotationEnvelope = { rotation: value,
    oldSignature: b64(old.sign(canonicalBytesForCatalogRotation(value)) as Uint8Array),
    newSignature: b64(next.sign(canonicalBytesForCatalogRotationPossession(value)) as Uint8Array) };
  return { id: catalogRotationId(envelope), envelope };
}
const reason = (result: Awaited<ReturnType<typeof prepare>>) => result.ok ? "ok" : result.reason;

test("parents, priorCatalogs and generation are checked against the binding graph", async () => {
  const f = await fixture();
  assert.equal(b64(catalogSigner(f).publicKey), f.record.catalogKey);
  const unrelated = id("unrelated-binding");
  assert.equal(reason(await prepare(f, f.frames, request(f, { parents: [unrelated], priorCatalogs: [{ binding: unrelated, catalog: null }],
    generation: 9 }))), "invalid_catalog_transition");
  const both = [f.bootstrap.id, unrelated].sort();
  assert.equal(reason(await prepare(f, f.frames, request(f, { parents: both,
    priorCatalogs: both.map((binding) => ({ binding, catalog: null })) }))), "invalid_catalog_transition");
  assert.equal(reason(await prepare(f, f.frames, request(f, { generation: 9 }))), "invalid_catalog_transition");

  const first = catalog(f, f.bootstrap.id, 0, null), firstId = transportCatalogId(first.catalog);
  assert.equal(reason(await prepare(f, f.frames, request(f, { catalogs: [first] }))), "catalog_fork");
  assert.equal(reason(await prepare(f, f.frames, request(f, { catalogs: [first],
    priorCatalogs: [{ binding: f.bootstrap.id, catalog: firstId }] }))), "ok");
  assert.equal(reason(await prepare(f, f.frames, request(f, {
    priorCatalogs: [{ binding: f.bootstrap.id, catalog: firstId }] }))), "trust_pending");
  const second = catalog(f, f.bootstrap.id, 1, firstId), secondId = transportCatalogId(second.catalog);
  assert.equal(reason(await prepare(f, f.frames, request(f, { catalogs: [first, second],
    priorCatalogs: [{ binding: f.bootstrap.id, catalog: firstId }] }))), "catalog_fork");
  assert.equal(reason(await prepare(f, f.frames, request(f, { catalogs: [second, first],
    priorCatalogs: [{ binding: f.bootstrap.id, catalog: secondId }] }))), "ok");
  const forged = { ...first, signature: b64(f.root.sign(canonicalBytesForTransportCatalog(first.catalog)) as Uint8Array) };
  assert.equal(reason(await prepare(f, f.frames, request(f, { catalogs: [forged] }))), "invalid_catalog_signature");
});

test("a retained rotation advances the head the replacement must cite", async () => {
  const f = await fixture();
  const next = seededSigner("r316-pr2-ts-rotated-catalog");
  const prior = catalog(f, f.bootstrap.id, 0, null);
  const t = await rotation(f, f.bootstrap.id, 1, catalogSigner(f), next, "t", prior);
  const retained = { rotations: [t.envelope], catalogs: [prior] };
  assert.equal(reason(await prepare(f, f.frames, request(f, retained))), "catalog_fork");
  const overT = { ...retained, parents: [t.id], priorCatalogs: [{ binding: t.id, catalog: null }], generation: 2 };
  const ok = await prepare(f, f.frames, request(f, overT));
  assert.equal(reason(ok), "ok");
  if (ok.ok) assert.deepEqual([ok.attempt.claim.parents, ok.attempt.claim.generation], [[t.id], 2]);
  assert.equal(reason(await prepare(f, f.frames, request(f, { ...overT, generation: 1 }))), "invalid_catalog_transition");
  const forged = await rotation(f, f.bootstrap.id, 1, f.root, next, "forged", prior);
  assert.equal(reason(await prepare(f, f.frames, request(f, { ...retained, rotations: [forged.envelope] }))), "invalid_catalog_signature");
  const orphan = await rotation(f, id("unknown-parent"), 1, catalogSigner(f), next, "orphan", prior);
  assert.equal(reason(await prepare(f, f.frames, request(f, { ...retained, rotations: [orphan.envelope] }))), "trust_pending");
});

// Review thread (P1, :318): a correctly signed rotation is not a binding node until it resolves under the Stage B
// structural rules; otherwise the preflight refuses rather than require a replacement to cite it.
test("a signed rotation that Stage B would reject never becomes a head to sign over", async () => {
  const f = await fixture();
  signed = [];
  const next = seededSigner("r316-pr2-ts-hostile-rotation");
  const prior = catalog(f, f.bootstrap.id, 0, null);
  const over = (t: { id: string; envelope: CatalogRotationEnvelope }, catalogs: CatalogEnvelope[], extra: CatalogRotationEnvelope[] = []) =>
    request(f, { rotations: [...extra, t.envelope], catalogs, parents: [t.id], priorCatalogs: [{ binding: t.id, catalog: null }],
      generation: 2 + extra.length });
  const missing = await rotation(f, f.bootstrap.id, 1, catalogSigner(f), next, "missing-prior");
  assert.equal(reason(await prepare(f, f.frames, over(missing, []))), "trust_pending");
  const drifted = await rotation(f, f.bootstrap.id, 1, catalogSigner(f), next, "drift", prior, (value) => { value.inventoryDigest = id("other-inventory"); });
  assert.equal(reason(await prepare(f, f.frames, over(drifted, [prior]))), "invalid_catalog_transition");
  const serviceSigner = seededSigner("r316-pr2-ts-service");
  assert.equal(b64(serviceSigner.publicKey), f.record.serviceKey);
  const asService = await rotation(f, f.bootstrap.id, 1, catalogSigner(f), serviceSigner, "service", prior);
  assert.equal(reason(await prepare(f, f.frames, over(asService, [prior]))), "invalid_catalog_transition");
  const t = await rotation(f, f.bootstrap.id, 1, catalogSigner(f), next, "honest", prior);
  const crossed = await rotation(f, t.id, 2, next, seededSigner("r316-pr2-ts-hostile-rotation-2"), "crossed", prior);
  assert.equal(reason(await prepare(f, f.frames, over(crossed, [prior], [t.envelope]))), "invalid_catalog_transition");
  assert.deepEqual(signed, []);
});

// Review thread (P1, :413): a signed catalog is held, and may be a head, only once its chain and binding resolve.
test("a signed catalog whose chain Stage B would reject never becomes a held head", async () => {
  const f = await fixture();
  const first = catalog(f, f.bootstrap.id, 0, null), firstId = transportCatalogId(first.catalog);
  const cite = (catalogs: CatalogEnvelope[], head: string) =>
    request(f, { catalogs, priorCatalogs: [{ binding: f.bootstrap.id, catalog: head }] });
  const dangling = catalog(f, f.bootstrap.id, 1, id("absent-previous"));
  assert.equal(reason(await prepare(f, f.frames, cite([dangling], transportCatalogId(dangling.catalog)))), "trust_pending");
  const skipped = catalog(f, f.bootstrap.id, 5, firstId);
  assert.equal(reason(await prepare(f, f.frames, cite([first, skipped], transportCatalogId(skipped.catalog)))), "invalid_catalog_transition");
  const shrunk = catalog(f, f.bootstrap.id, 1, firstId, boundEntries(f).slice(0, 1));
  assert.equal(reason(await prepare(f, f.frames, cite([first, shrunk], transportCatalogId(shrunk.catalog)))), "invalid_catalog_transition");
  const stranger = catalog(f, f.bootstrap.id, 0, null, entries(f, b64(f.newService.publicKey)));
  assert.equal(reason(await prepare(f, f.frames, cite([stranger], transportCatalogId(stranger.catalog)))), "wrong_catalog_scope");
});

// Review thread (P2, :82): the caller-owned journal may be lost or belong to another device.
test("a nonce already carried by a retained replacement is reused even with an empty journal", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const r1 = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession: possess(f, attempt),
    signer: f.nominee });
  if (!r1.ok) assert.fail(r1.reason);
  const frames = [...f.frames, r1.frame];
  const reused = { parents: [r1.frame.id], priorCatalogs: [{ binding: r1.frame.id, catalog: null }], generation: 2,
    newCatalogKey: b64(seededSigner("r316-pr2-ts-nonce-reuse").publicKey) };
  assert.equal(reason(await prepare(f, frames, request(f, reused), {})), "attempt_nonce_reused");
  assert.equal(reason(await prepare(f, frames, request(f, { ...reused, nonce: id("fresh") }), {})), "ok");
});

test("an appended replacement is a head a later replacement must cite (D-276)", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const r1 = await authorTreehouseCatalogReplacementFromFrames({ currentFrames: () => f.frames, attempt, possession: possess(f, attempt),
    signer: f.nominee });
  if (!r1.ok) assert.fail(r1.reason);
  const frames = [...f.frames, r1.frame];
  assert.equal((await judge(frames)).get(r1.frame.id), undefined);
  assert.equal(reason(await prepare(f, frames, request(f, { nonce: id("r2") }))), "catalog_fork");
  const r2 = { nonce: id("r2"), newCatalogKey: b64(seededSigner("r316-pr2-ts-second-catalog").publicKey), parents: [r1.frame.id],
    priorCatalogs: [{ binding: r1.frame.id, catalog: null }], generation: 2 };
  assert.equal(reason(await prepare(f, frames, request(f, r2))), "ok");
  // A concurrent revoke refuses R1 on the union but leaves it a binding node.
  const revoke = await authorCarrierOp({ replica: f.replica, signer: f.root, deps: attempt.frozenFrontier, kind: "authority", cap: nil,
    body: tuple(atom("revoke"), text(f.leased.id)) });
  const revoked = [...frames, revoke];
  assert.equal((await judge(revoked)).get(r1.frame.id), "revoked_capability");
  assert.equal(reason(await prepare(f, revoked, request(f, { nonce: id("r2") }))), "catalog_fork");
});

// Review thread (P2, :329): entry and supplied replica sets are both ordered by UTF-8 bytes. U+E000 sorts after
// U+10000 under UTF-16 code units but before it under UTF-8, so a code-unit sort on either side would refuse this
// complete set of retained histories as recovery_incomplete and diverge from BEAM.
test("non-ASCII thread replicas order by UTF-8 bytes on both sides of the recovery check", async () => {
  const f = await fixture();
  const threads = await Promise.all(["", "\u{10000}"].map(async (suffix) => {
    const replica = await bindTownshipReplica(`replica:treehouse:thread:${suffix}`, f.root.publicKey);
    const delegation = await authorCarrierDelegation({ replica, signer: f.root, audiencePubkey: f.root.publicKey, ops: ["post"], roles: [],
      live: true });
    const genesis = await authorCarrierOp({ replica, signer: f.root, deps: [], kind: "authority", cap: nil,
      body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
    return { replica, genesis };
  }));
  const [bmp, astral] = threads as [typeof threads[0], typeof threads[0]];
  assert.ok(bmp.replica > astral.replica, "UTF-16 code-unit order puts U+E000 after U+10000");
  assert.ok(Buffer.compare(Buffer.from(bmp.replica), Buffer.from(astral.replica)) < 0, "UTF-8 order puts U+E000 first");
  const serviceKey = b64(f.newService.publicKey);
  const space = entries(f, serviceKey).find((item) => item.kind === "space")!;
  const threadEntries = threads.map(({ replica, genesis }) => ({ ...space, replica, kind: "thread" as const,
    schema: "treehouse_thread_v1" as const, genesis: genesis.id, creation: genesis.id, reference: id(`reference-${replica}`),
    route: `/r/${id(`route-${replica}`)}` }));
  const all = [space, ...threadEntries].sort((a, b) => Buffer.compare(Buffer.from(a.replica), Buffer.from(b.replica)));
  const result = await prepare(f, f.frames, request(f, { entries: all, replicaHistories: Object.fromEntries(threads.map(({ replica, genesis }) =>
    [replica, { frames: [genesis], rejected: [] }])) }));
  assert.equal(reason(result), "ok");
  if (result.ok) assert.deepEqual(result.attempt.claim.cutoffs.map((cutoff) => cutoff.replica), all.map((item) => item.replica));
});

// Codex round 4: route reservation, duplicate-id signatures and nonce eligibility.
test("retained catalogs that swap routes, or hide a bad signature behind a good copy, refuse", async () => {
  const f = await fixture();
  const first = catalog(f, f.bootstrap.id, 0, null), firstId = transportCatalogId(first.catalog);
  const cite = (catalogs: CatalogEnvelope[], head: string) =>
    request(f, { catalogs, priorCatalogs: [{ binding: f.bootstrap.id, catalog: head }] });
  const [a, b] = boundEntries(f) as [CatalogEntry, CatalogEntry];
  const swapped = catalog(f, f.bootstrap.id, 1, firstId, [{ ...a, route: b.route }, { ...b, route: a.route }]);
  assert.equal(reason(await prepare(f, f.frames, cite([first, swapped], transportCatalogId(swapped.catalog)))), "invalid_catalog_transition");
  const bad = { ...first, signature: b64(new Uint8Array(64).fill(7)) };
  for (const order of [[bad, first], [first, bad]]) {
    assert.equal(reason(await prepare(f, f.frames, cite(order, firstId))), "invalid_catalog_signature");
  }
  assert.equal(reason(await prepare(f, f.frames, cite([{ ...first, signature: b64(new Uint8Array([1])) }], firstId))), "malformed_catalog");
  // Round 5: like CatalogTrust, any differing copy for one id refuses at parse, before any verification, so a second
  // valid signature cannot pass either. Under an unknown binding (otherwise trust_pending) that is observable.
  const orphan = catalog(f, id("unknown-binding"), 0, null), orphanId = transportCatalogId(orphan.catalog);
  const other = { ...orphan, signature: b64(new Uint8Array([...Buffer.from(orphan.signature, "base64").subarray(0, 32), ...new Uint8Array(32).fill(9)])) };
  assert.equal(reason(await prepare(f, f.frames, cite([orphan], orphanId))), "trust_pending");
  for (const order of [[orphan, other], [other, orphan]]) {
    assert.equal(reason(await prepare(f, f.frames, cite(order, orphanId))), "invalid_catalog_signature");
  }
});

test("an unauthorized retained proposal does not reserve the nonce", async () => {
  const f = await fixture();
  const attempt = await prepared(f);
  const stranger = seededSigner("r316-pr2-ts-stranger");
  const zeroB64 = b64(new Uint8Array(64));
  const raw = await authorCarrierOp({ replica: f.replica, signer: stranger, deps: attempt.frozenFrontier, kind: "command", cap: nil,
    body: tuple(atom("replace_catalog_v1"), ["list", [catalogReplacementClaimToCarrierTerm(attempt.claim)!, ["bin", zeroB64], ["bin", zeroB64]]]) });
  const frames = [...f.frames, raw];
  assert.notEqual((await judge(frames)).get(raw.id), undefined);
  assert.equal(reason(await prepare(f, frames, request(f))), "ok");
});
