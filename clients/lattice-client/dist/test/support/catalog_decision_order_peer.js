// Fresh actual-owner inputs for plan283 source ordering agreement.
import assert from "node:assert/strict";
import { authorTreehouseCommand, authorTreehouseRoleTransfer } from "../../src/treehouse";
import { transportCatalogId, catalogEnvelopeFromCarrierTerm, catalogEnvelopeToCarrierTerm } from "../../src/treehouse_catalog_codec";
import { trustFixture, signedCatalog, fixtureId, fixtureSigner } from "./export_treehouse_catalog_trust";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const f = await trustFixture(1), expected = { trustRevision: 0, historyGeneration: 0 };
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
if (prepared.kind !== "propose")
    throw Error("prepare");
const accepted = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...empty(), catalogs: [f.catalogJson], histories: f.histories } });
if (accepted.kind !== "propose")
    throw Error("accept");
function forgedCatalog(json) {
    const envelope = catalogEnvelopeFromCarrierTerm(JSON.parse(json));
    assert.ok(envelope);
    return JSON.stringify(catalogEnvelopeToCarrierTerm({ ...envelope, signature: Buffer.alloc(64).toString("base64") }));
}
const bad = forgedCatalog(f.catalogJson), wrong = fixtureId("native-scope-order-wrong-bootstrap");
const scoped = await signedCatalog({ ...f.catalog, bootstrap: wrong, entries: f.catalog.entries.map(e => e.kind === "space" ? { ...e, reference: wrong } : e) }, f.catalogSigner);
const cases = [false, true].map(reverse => ({ name: `scope-signature-order:${reverse}`, input: { installed: accepted.next, expected, incoming: { ...empty(), catalogs: reverse ? [scoped, bad] : [bad, scoped] } } }));
const one = { ...f.catalog, revision: 1, previous: transportCatalogId(f.catalog), entries: f.catalog.entries.map(e => e.kind === "thread" ? { ...e, route: `/r/${fixtureId("route-blame-moved-child")}` } : e) };
const advanced = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), catalogs: [await signedCatalog(one, f.catalogSigner)] } });
if (advanced.kind !== "propose")
    throw Error("advance");
const f2 = await trustFixture(2), oldRoute = f.catalog.entries.find(e => e.kind === "thread").route;
let collision;
for (let n = 0; n < 64; n++) {
    const c = { ...f2.catalog, revision: 2, previous: transportCatalogId(one), entries: f2.catalog.entries.map(e => e.kind === "space" ? { ...e, route: `/r/${fixtureId(`route-blame-space-${n}`)}` } :
            e.replica === f.threads[0].replica ? { ...e, route: one.entries.find(x => x.replica === e.replica).route } : { ...e, route: oldRoute }) };
    if (transportCatalogId(c) < transportCatalogId(f.catalog) && transportCatalogId(c) < transportCatalogId(one)) {
        collision = await signedCatalog(c, f.catalogSigner);
        break;
    }
}
if (!collision)
    throw Error("collision ordering");
for (const reverse of [false, true])
    cases.push({ name: `route-collision-blame:${reverse}`, input: { installed: advanced.next, expected, incoming: { ...empty(), catalogs: [collision], histories: reverse ? [...f2.histories].reverse() : f2.histories } } });
const forkJson = await signedCatalog({ ...f.catalog, entries: f.catalog.entries.map(e => ({ ...e, route: `/r/${fixtureId("frozen-witness:" + e.replica)}` })) }, f.catalogSigner);
const frozen = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), catalogs: [forkJson] } });
if (frozen.kind !== "retain_blocked" || frozen.reason !== "catalog_fork")
    throw Error("fork");
const boot = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root, deps: [f.space.frames.at(-1).id], capId: f.space.delegation.id,
    command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId("new-bootstrap-after-graph-fork") } } });
for (const reverse of [false, true])
    cases.push({ name: `graph-fork-before-bootstrap:${reverse}`, input: { installed: frozen.next, expected, incoming: { ...empty(), histories: [{ ...f.histories[0], frames: reverse ? [...f.space.frames, boot].reverse() : [...f.space.frames, boot] }] } } });
function paired(name, installed, incoming) {
    for (const reverse of [false, true]) {
        const page = structuredClone(incoming);
        if (reverse) {
            page.catalogs = [...page.catalogs].reverse();
            page.rotations = [...page.rotations].reverse();
            page.histories = [...page.histories].reverse();
        }
        cases.push({ name: `${name}:${reverse}`, input: { installed: structuredClone(installed), expected: { ...expected }, incoming: page } });
    }
}
paired("conflict-before-malformed-catalog", accepted.next, { ...empty(), catalogs: [bad, "not JSON"] });
paired("conflict-before-oversized-catalog", accepted.next, { ...empty(), catalogs: [bad, " ".repeat(128 * 1024 + 1)] });
paired("catalog-conflict-before-malformed-rotation", accepted.next, { ...empty(), catalogs: [bad], rotations: ["not JSON"] });
paired("scope-before-malformed-rotation", accepted.next, { ...empty(), catalogs: [scoped], rotations: ["not JSON"] });
paired("valid-duplicate-keeps-first-json", accepted.next, { ...empty(), catalogs: [" " + f.catalogJson] });
const permuted = structuredClone(advanced.next);
permuted.catalogs.reverse();
paired("valid-saved-row-permutation", permuted, { ...empty(), catalogs: [" " + await signedCatalog(one, f.catalogSigner)] });
const missing = await signedCatalog({ ...f.catalog, revision: 1, previous: fixtureId("missing-catalog-parent") }, f.catalogSigner);
paired("invalid-signature-before-missing-parent", accepted.next, { ...empty(), catalogs: [forgedCatalog(missing)] });
paired("valid-signature-needs-missing-parent", accepted.next, { ...empty(), catalogs: [missing] });
const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root, parent: f.space.delegation,
    recipient: fixtureSigner("source-order-successor").publicKey, action: "transfer_admin" });
const changed = { ...f.histories[0], frames: [...f.space.frames, transfer] };
const authority = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), histories: [changed] } });
assert.equal(authority.kind, "retain_blocked");
assert.equal(authority.reason, "authority_changed");
paired("early-authority-before-catalog-preflight", accepted.next, { ...empty(), catalogs: [bad, scoped], histories: [changed] });
paired("saved-graph-fork-survives-malformed-proof", frozen.next, { ...empty(), cutoffProofs: [{}] });
paired("new-graph-fork-does-not-mask-malformed-proof", accepted.next, { ...empty(), catalogs: [forkJson], cutoffProofs: [{}] });
// Cross the small-map threshold: runtime hash-map layout must not choose ids.
const records = [];
let previous = null;
let last = f.catalog;
for (let revision = 0; revision < 34; revision++) {
    const catalog = { ...f.catalog, revision, previous, entries: revision === 33 ? one.entries : f.catalog.entries };
    const id = transportCatalogId(catalog);
    records.push({ id, json: await signedCatalog(catalog, f.catalogSigner) });
    previous = id;
    last = catalog;
}
const large = structuredClone(accepted.next);
large.catalogs = records.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
large.accepted = { binding: f.bootstrap.id, generation: 0, catalog: previous, revision: 33 };
const reopened = await evaluateTreehouseCatalogTrust({ installed: large, expected, incoming: empty() });
assert.equal(reopened.kind, "unchanged");
let largeCollision;
for (let n = 0; n < 4096; n++) {
    const c = { ...f2.catalog, revision: 34, previous, entries: f2.catalog.entries.map(e => e.kind === "space" ? { ...e, route: `/r/${fixtureId(`large-map-route-space-${n}`)}` } :
            e.replica === f.threads[0].replica ? { ...e, route: last.entries.find(x => x.replica === e.replica).route } : { ...e, route: oldRoute }) };
    if (transportCatalogId(c) < large.catalogs[0].id) {
        largeCollision = await signedCatalog(c, f.catalogSigner);
        break;
    }
}
assert.ok(largeCollision);
paired("large-map-route-collision-blame", large, { ...empty(), catalogs: [largeCollision], histories: f2.histories });
const bootstrapPage = { ...empty(), histories: [{ ...f.histories[0], frames: [...f.space.frames, boot] }] };
const bootstrapFirst = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: bootstrapPage });
assert.equal(bootstrapFirst.kind, "retain_blocked");
assert.equal(bootstrapFirst.reason, "catalog_fork");
paired("bootstrap-before-graph-fork", bootstrapFirst.next, { ...empty(), catalogs: [forkJson] });
paired("simultaneous-bootstrap-and-graph-forks", accepted.next, { ...bootstrapPage, catalogs: [forkJson] });
paired("bootstrap-freeze-before-catalog-preflight", accepted.next, { ...bootstrapPage, catalogs: [bad, scoped] });
const expectedReasons = {
    "scope-signature-order": "wrong_catalog_scope", "route-collision-blame": "invalid_catalog_transition", "graph-fork-before-bootstrap": "catalog_fork",
    "conflict-before-malformed-catalog": "malformed_catalog", "conflict-before-oversized-catalog": "control_history_limit",
    "catalog-conflict-before-malformed-rotation": "invalid_catalog_signature", "scope-before-malformed-rotation": "wrong_catalog_scope",
    "valid-duplicate-keeps-first-json": null, "valid-saved-row-permutation": null, "invalid-signature-before-missing-parent": "invalid_catalog_signature",
    "valid-signature-needs-missing-parent": "trust_pending", "early-authority-before-catalog-preflight": "authority_changed",
    "saved-graph-fork-survives-malformed-proof": "catalog_fork", "new-graph-fork-does-not-mask-malformed-proof": "malformed_catalog",
    "large-map-route-collision-blame": "invalid_catalog_transition",
    "bootstrap-before-graph-fork": "catalog_fork", "simultaneous-bootstrap-and-graph-forks": "catalog_fork",
    "bootstrap-freeze-before-catalog-preflight": "catalog_fork"
};
const table = [];
for (let index = 0; index < cases.length; index += 2) {
    const pair = cases.slice(index, index + 2);
    const orders = [];
    for (const item of pair) {
        const before = JSON.stringify(item.input), decision = await evaluateTreehouseCatalogTrust(item.input), name = item.name.split(":")[0];
        assert.equal(JSON.stringify(item.input), before);
        assert.equal(decision.reason, expectedReasons[name], item.name);
        if (name === "graph-fork-before-bootstrap") {
            assert.equal(decision.kind, "retain_blocked");
            assert.deepEqual(decision.next.blocked, frozen.next.blocked);
            assert.ok(decision.observed.bootstrapIds.includes(boot.id));
        }
        if (["bootstrap-before-graph-fork", "simultaneous-bootstrap-and-graph-forks", "bootstrap-freeze-before-catalog-preflight"].includes(name)) {
            assert.equal(decision.kind, "retain_blocked");
            assert.deepEqual(decision.next.blocked, bootstrapFirst.next.blocked);
            assert.deepEqual(decision.routes, []);
        }
        if (name === "route-collision-blame")
            assert.deepEqual(decision.detail.ids, [transportCatalogId(f.catalog)]);
        if (name === "valid-duplicate-keeps-first-json")
            assert.equal(decision.kind, "unchanged");
        if (name === "valid-saved-row-permutation")
            assert.equal(decision.kind, "propose");
        if (name === "early-authority-before-catalog-preflight") {
            assert.equal(decision.kind, "retain_blocked");
            assert.deepEqual(decision.next.blocked, authority.next.blocked);
            assert.deepEqual(decision.routes, []);
        }
        orders.push({ input: item.input, decision });
    }
    table.push({ name: pair[0].name.split(":")[0], orders });
}
assert.equal(table.length, 18);
await new Promise(resolve => process.stdout.write(JSON.stringify({ cases: table }) + "\n", () => resolve()));
