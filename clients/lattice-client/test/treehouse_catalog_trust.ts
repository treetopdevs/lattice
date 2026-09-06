import assert from "node:assert/strict";
import { test } from "node:test";
import { trustFixture, fixtureId, fixtureSigner, signedCatalog, signedRotation } from "./support/export_treehouse_catalog_trust";
import { authorTreehouseCommand, authorTreehouseRoleTransfer } from "../src/treehouse";
import { catalogEnvelopeFromCarrierTerm, catalogEnvelopeToCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogRotationEnvelopeToCarrierTerm,
  catalogRotationId, transportCatalogId } from "../src/treehouse_catalog_codec";
import type { CatalogEntry, TransportCatalog } from "../src/treehouse_catalog_codec";
import type { InstalledTreehouseCatalogTrustV1, TreehouseCatalogEvidencePage, TreehouseCatalogTrustDecision } from "../src/treehouse_catalog_trust";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust, resolveTreehouseCatalogRoute } from "../src/treehouse_catalog_trust";

const expected = {trustRevision: 0, historyGeneration: 0};
const empty = (): TreehouseCatalogEvidencePage => ({catalogs: [], rotations: [], histories: [], cutoffProofs: []});
type Fixture = Awaited<ReturnType<typeof trustFixture>>;
async function prepare(f: Fixture) {
  const result = await prepareTreehouseCatalogInstallation({review: f.review, history: f.histories[0]!, store: {kind: "verified_fresh", expected}});
  assert.equal(result.kind, "propose", JSON.stringify(result)); return result.next;
}
function evaluate(installed: InstalledTreehouseCatalogTrustV1, incoming: Partial<TreehouseCatalogEvidencePage> = {}) {
  return evaluateTreehouseCatalogTrust({installed, expected, incoming: {...empty(), ...incoming}});
}
async function installed(f: Fixture) {
  const result = await evaluate(await prepare(f), {catalogs: [f.catalogJson], histories: f.histories});
  assert.equal(result.kind, "propose", JSON.stringify(result)); return result.next;
}
function refused(result: TreehouseCatalogTrustDecision, reason: string) {
  assert.equal(result.reason, reason, JSON.stringify(result));
  if (result.kind !== "reject") assert.equal(result.routes.length, 0);
}
function revision(f: Fixture, entries: CatalogEntry[], previous = transportCatalogId(f.catalog), number = 1): TransportCatalog {
  return {...f.catalog, entries, previous, revision: number};
}
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

test("explicit review never elects from arrival order, and forged or partial signed history refuses", async () => {
  const f = await trustFixture();
  const second = await authorTreehouseCommand({product: "Treehouse.Space", replica: f.space.replica, signer: f.root,
    deps: [f.space.frames.at(-1)!.id], capId: f.space.delegation.id,
    command: {command: "catalog_bootstrap_v1", record: {...f.bootstrapRecord, nonce: fixtureId("second-bootstrap")}}});
  const history = {...f.histories[0]!, frames: [...f.space.frames, second]};
  const run = (review = f.review, h = history) => prepareTreehouseCatalogInstallation({review, history: h, store: {kind: "verified_fresh", expected}});
  refused(await run(), "catalog_fork");
  const reviewed = {...f.review, observedBootstrapIds: [second.id, f.bootstrap.id].sort()};
  const a = await run(reviewed), b = await run(reviewed, {...history, frames: [...history.frames].reverse()});
  assert.equal(a.kind, "propose"); assert.equal(b.kind, "propose"); assert.deepEqual(a.next, b.next);
  refused(await run({...reviewed, spaceRoot: Buffer.from(fixtureSigner("wrong-root").publicKey).toString("base64")}), "wrong_catalog_scope");
  const missing = {...history, frames: history.frames.filter((frame) => frame.id !== f.space.genesis.id)};
  refused(await run(reviewed, missing), "trust_pending");
  refused(await run(reviewed, {...missing, frames: missing.frames.map((frame) => frame.id === f.bootstrap.id ? {...frame, sig: Buffer.alloc(64).toString("base64")} : frame)}), "invalid_verified_history");
});

test("actual entry metadata refuses forged roots, wrong genesis/creation/reference, schema, signer and service", async () => {
  const f = await trustFixture(), state = await prepare(f), thread = f.catalog.entries.find((entry) => entry.kind === "thread")!;
  for (const change of [{root: f.bootstrapRecord.spaceRoot}, {genesis: f.threads[0]!.pin.id},
    {creation: f.threads[0]!.genesis.id}, {reference: f.bootstrap.id}]) {
    const entries = f.catalog.entries.map((entry) => entry === thread ? {...entry, ...change} : entry);
    refused(await evaluate(state, {catalogs: [await signedCatalog({...f.catalog, entries}, f.catalogSigner)], histories: f.histories}), "invalid_catalog_transition");
  }
  refused(await evaluate(state, {catalogs: [await signedCatalog(f.catalog, fixtureSigner("forged-catalog"))], histories: f.histories}), "invalid_catalog_signature");
  const service = f.catalog.entries.map((entry) => ({...entry, serviceId: fixtureId("another-service")}));
  refused(await evaluate(state, {catalogs: [await signedCatalog({...f.catalog, entries: service}, f.catalogSigner)], histories: f.histories}), "wrong_catalog_scope");
  const wrong = JSON.parse(f.catalogJson);
  wrong[1].find((pair: unknown[]) => JSON.stringify(pair[0]) === '["atom","catalog"]')[1][1]
    .find((pair: unknown[]) => JSON.stringify(pair[0]) === '["atom","entries"]')[1][1][1][1]
    .find((pair: unknown[]) => JSON.stringify(pair[0]) === '["atom","schema"]')[1] = ["atom", "treehouse_space_v1"];
  refused(await evaluate(state, {catalogs: [JSON.stringify(wrong)], histories: f.histories}), "malformed_catalog");
});

test("catalog before reference/child proof remains pending, never fabricates a listing, and completes with exact evidence", async () => {
  const f = await trustFixture();
  const withoutRef = {...f.histories[0]!, frames: f.space.frames.filter((frame) => frame.id !== f.threads[0]!.reference.id)};
  const initial = await prepareTreehouseCatalogInstallation({review: f.review, history: withoutRef, store: {kind: "verified_fresh", expected}});
  assert.equal(initial.kind, "propose");
  const pending = await evaluate(initial.next, {catalogs: [f.catalogJson]});
  assert.equal(pending.kind, "propose"); assert.equal(pending.reason, "trust_pending");
  assert.equal(pending.next.catalogs.length, 1); assert.equal(pending.next.accepted, null); assert.deepEqual(pending.routes, []);
  assert.equal(pending.next.histories[0]!.frames.length, withoutRef.frames.length);
  const complete = await evaluate(pending.next, {histories: f.histories});
  assert.equal(complete.kind, "propose"); assert.equal(complete.routes.length, 2);
});

test("revision predecessor, retry and reopen never lower the accepted watermark or recycle identity/route history", async () => {
  const f = await trustFixture(), first = await installed(f);
  const moved = f.catalog.entries.map((entry) => ({...entry, route: `/r/${fixtureId(`moved-${entry.replica}`)}`}));
  const nextCatalog = revision(f, moved), json = await signedCatalog(nextCatalog, f.catalogSigner);
  const next = await evaluate(first, {catalogs: [json]}); assert.equal(next.kind, "propose");
  assert.equal(next.next.accepted?.revision, 1);
  const repeated = await evaluate(next.next, {catalogs: [f.catalogJson, json]}); assert.equal(repeated.kind, "unchanged");
  assert.deepEqual(repeated.next.accepted, next.next.accepted);
  const reordered = JSON.parse(JSON.stringify(next.next), (_key, value) => value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()) : value);
  const reopen = await evaluate(reordered); assert.equal(reopen.kind, "unchanged"); assert.deepEqual(reopen.next.accepted, next.next.accepted);
  refused(await evaluate(first, {catalogs: [await signedCatalog(revision(f, moved, transportCatalogId(f.catalog), 2), f.catalogSigner)]}), "invalid_catalog_transition");
  const reused = moved.map((entry) => entry.kind === "thread" ? {...entry, route: f.catalog.entries.find((e) => e.kind === "space")!.route} : entry);
  refused(await evaluate(next.next, {catalogs: [await signedCatalog(revision(f, reused, transportCatalogId(nextCatalog), 2), f.catalogSigner)]}), "invalid_catalog_transition");
  refused(await evaluate(first, {catalogs: [await signedCatalog(revision(f, [f.catalog.entries[0]!]), f.catalogSigner)]}), "invalid_catalog_transition");
});

test("valid catalog siblings freeze in both orders, including withheld child proof, without trusting a chosen branch", async () => {
  const f = await trustFixture(), initial = await installed(f);
  const a = revision(f, f.catalog.entries.map((e) => ({...e, route: `/r/${fixtureId(`a-${e.replica}`)}`})));
  const b = revision(f, f.catalog.entries.map((e) => ({...e, route: `/r/${fixtureId(`b-${e.replica}`)}`})));
  const artifacts = [await signedCatalog(a, f.catalogSigner), await signedCatalog(b, f.catalogSigner)];
  const direct = await evaluate(initial, {catalogs: artifacts}), inverse = await evaluate(initial, {catalogs: [...artifacts].reverse()});
  assert.equal(direct.kind, "retain_blocked"); assert.equal(inverse.kind, "retain_blocked");
  assert.equal(direct.reason, "catalog_fork"); assert.deepEqual(direct.next, inverse.next); assert.deepEqual(direct.routes, []);
  for (const [first, second] of [artifacts, [...artifacts].reverse()]) {
    const one = await evaluate(initial, {catalogs: [first!]}); assert.equal(one.kind, "propose");
    const fork = await evaluate(one.next, {catalogs: [second!]}); assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork"); assert.deepEqual(fork.next.accepted, one.next.accepted);
  }
  const pendingEntry = {...f.catalog.entries.find((e) => e.kind === "thread")!, replica: `replica:treehouse:thread:${fixtureId("unseen-child")}#authority:bounded-continuation-v1#root:${fixtureId("unseen-root")}`,
    route: `/r/${fixtureId("unseen-route")}`, genesis: fixtureId("unseen-genesis"), creation: fixtureId("unseen-creation"), reference: fixtureId("unseen-ref")};
  const c = {...b, entries: [...b.entries, pendingEntry].sort((a, b) => Buffer.compare(Buffer.from(a.replica), Buffer.from(b.replica)))};
  const pendingJson = await signedCatalog(c, f.catalogSigner);
  const fork = await evaluate(initial, {catalogs: [artifacts[0]!, pendingJson]}); assert.equal(fork.kind, "retain_blocked");
  assert.equal(fork.reason, "catalog_fork"); assert.deepEqual(fork.detail.pendingProofIds, [transportCatalogId(c)]);
});

test("old-key rotation verifies possession, exact cutoff and inventory, then accepts a first new-key catalog", async () => {
  const f = await trustFixture(), first = await installed(f);
  const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
  const newCatalog = {...f.catalog, binding: catalogRotationId(rotation)};
  const json = await signedCatalog(newCatalog, f.nextCatalogSigner);
  const result = await evaluate(first, {rotations: [f.rotationJson], catalogs: [json], cutoffProofs: f.cutoffProofs});
  assert.equal(result.kind, "propose", JSON.stringify(result)); assert.equal(result.next.accepted?.generation, 1);
  const post = await authorTreehouseCommand({product: "Treehouse.Thread", replica: f.threads[0]!.replica, signer: f.threads[0]!.signer,
    deps: [f.threads[0]!.pin.id], capId: f.threads[0]!.delegation.id, command: {command: "post", text: "After rotation"}});
  const grown = await evaluate(result.next, {histories: [{...f.histories[1]!, frames: [...f.threads[0]!.frames, post]}]});
  assert.equal(grown.kind, "propose"); assert.equal(grown.reason, null); assert.deepEqual(grown.next.accepted, result.next.accepted);
  const pending = await evaluate(first, {rotations: [f.rotationJson], catalogs: [json]});
  assert.equal(pending.kind, "propose"); assert.equal(pending.reason, "recovery_incomplete"); assert.deepEqual(pending.next.accepted, first.accepted);
  const bad = {...rotation, newSignature: Buffer.alloc(64).toString("base64")};
  refused(await evaluate(first, {rotations: [JSON.stringify(catalogRotationEnvelopeToCarrierTerm(bad))]}), "invalid_possession");
  const badOld = {...rotation, oldSignature: Buffer.alloc(64).toString("base64")};
  refused(await evaluate(first, {rotations: [JSON.stringify(catalogRotationEnvelopeToCarrierTerm(badOld))]}), "invalid_catalog_signature");
  const mutated = {...f.cutoffProofs[0]!, cutoff: {...f.cutoffProofs[0]!.cutoff, logDigest: fixtureId("bad-digest")}};
  refused(await evaluate(first, {rotations: [f.rotationJson], cutoffProofs: [mutated]}), "recovery_incomplete");
});

test("rotation consumes its exact catalog tip and cannot erase a concurrent old-binding catalog", async () => {
  const f = await trustFixture(), initial = await installed(f);
  const json = await signedCatalog(revision(f, f.catalog.entries), f.catalogSigner);
  const a = await evaluate(initial, {rotations: [f.rotationJson], catalogs: [json], cutoffProofs: f.cutoffProofs});
  assert.equal(a.kind, "retain_blocked"); assert.equal(a.reason, "catalog_fork"); assert.deepEqual(a.routes, []);
  const prior = await evaluate(initial, {catalogs: [json]}); assert.equal(prior.kind, "propose");
  const b = await evaluate(prior.next, {rotations: [f.rotationJson], cutoffProofs: f.cutoffProofs});
  assert.equal(b.kind, "retain_blocked"); assert.equal(b.reason, "catalog_fork");
});

test("two and three authenticated rotation heads remain retained and never evicted", async () => {
  const f = await trustFixture(), initial = await installed(f);
  const rotations = [f.rotationJson];
  for (const label of ["rotation-b", "rotation-c"]) {
    const signer = fixtureSigner(label);
    rotations.push(await signedRotation({...f.rotation, nonce: fixtureId(label), newCatalogKey: Buffer.from(signer.publicKey).toString("base64")}, f.catalogSigner, signer));
  }
  const two = await evaluate(initial, {rotations: rotations.slice(0, 2), cutoffProofs: f.cutoffProofs});
  assert.equal(two.kind, "retain_blocked"); assert.equal(two.reason, "catalog_fork"); assert.equal(two.next.rotations.length, 2);
  const three = await evaluate(initial, {rotations, cutoffProofs: f.cutoffProofs});
  assert.equal(three.kind, "retain_blocked"); assert.equal(three.reason, "control_history_limit"); assert.equal(three.next.rotations.length, 3);
  const reopened = await evaluate(three.next); assert.equal(reopened.kind, "retain_blocked"); assert.deepEqual(reopened.routes, []);
});

test("module-issued route decisions cannot be fabricated or mutated into another pinned identity", async () => {
  const f = await trustFixture();
  const decision = await evaluate(await prepare(f), {catalogs: [f.catalogJson], histories: f.histories});
  assert.equal(decision.kind, "propose");
  const replica = f.threads[0]!.replica;
  const original = resolveTreehouseCatalogRoute({decision, replica}); assert.equal(original.ok, true);
  decision.routes.find((r) => r.replica === replica)!.serviceKey = "forged";
  assert.deepEqual(resolveTreehouseCatalogRoute({decision, replica}), original);
  assert.equal(resolveTreehouseCatalogRoute({decision: structuredClone(decision), replica}).ok, false);
});

test("a concurrent real role transfer reclassifies accepted bootstrap/reference and freezes instead of repinning", async () => {
  const f = await trustFixture(), state = await installed(f), successor = fixtureSigner("successor");
  const {frame: transfer} = await authorTreehouseRoleTransfer({replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
    recipient: successor.publicKey, parent: f.space.delegation, action: "transfer_admin"});
  const changed = await evaluate(state, {histories: [{...f.histories[0]!, frames: [...f.space.frames, transfer]}]});
  assert.equal(changed.kind, "retain_blocked", JSON.stringify(changed)); assert.equal(changed.reason, "authority_changed");
  assert.deepEqual(changed.next.accepted, state.accepted); assert.deepEqual(changed.next.review, state.review); assert.deepEqual(changed.routes, []);
  const invalidCatalog = await evaluate(state, {histories: [{...f.histories[0]!, frames: [...f.space.frames, transfer]}], catalogs: ["malformed"]});
  assert.equal(invalidCatalog.kind, "retain_blocked"); assert.equal(invalidCatalog.reason, "authority_changed");
});
