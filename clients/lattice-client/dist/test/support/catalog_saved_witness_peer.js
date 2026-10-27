// Fresh signed saved-witness requests evaluated through the actual public owner.
import assert from "node:assert/strict";
import { trustFixture, signedCatalog, signedRotation, fixtureSigner, fixtureId } from "./export_treehouse_catalog_trust";
import { catalogRotationEnvelopeFromCarrierTerm, catalogRotationId, transportCatalogId } from "../../src/treehouse_catalog_codec";
import { authorTreehouseCommand, authorTreehouseRoleTransfer } from "../../src/treehouse";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
const f = await trustFixture(1);
const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
assert.equal(prepared.kind, "propose");
const accepted = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...empty(), catalogs: [f.catalogJson], histories: f.histories } });
assert.equal(accepted.kind, "propose");
assert.equal(accepted.routes.length, 2);
const rotationId = (json) => catalogRotationId(catalogRotationEnvelopeFromCarrierTerm(JSON.parse(json)));
const rotatedCatalog = { ...f.catalog, binding: rotationId(f.rotationJson) };
const rotatedJson = await signedCatalog(rotatedCatalog, f.nextCatalogSigner);
const rotated = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), catalogs: [rotatedJson], rotations: [f.rotationJson], cutoffProofs: f.cutoffProofs } });
assert.equal(rotated.kind, "propose");
assert.equal(rotated.next.accepted.generation, 1);
const priorId = transportCatalogId(f.catalog);
const late = { ...f.catalog, revision: 1, previous: priorId };
const lateJson = await signedCatalog(late, f.catalogSigner), lateId = transportCatalogId(late);
const frozen = await evaluateTreehouseCatalogTrust({ installed: rotated.next, expected, incoming: { ...empty(), catalogs: [lateJson] } });
assert.equal(frozen.kind, "retain_blocked");
assert.equal(frozen.reason, "catalog_fork");
const entries = (label) => f.catalog.entries.map(e => ({ ...e, route: `/r/${fixtureId(label + e.replica)}` }));
const branch = { ...late, entries: entries("other-branch") };
const branchJson = await signedCatalog(branch, f.catalogSigner), branchId = transportCatalogId(branch);
const siblings = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), catalogs: [lateJson, branchJson] } });
assert.equal(siblings.kind, "retain_blocked");
assert.equal(siblings.reason, "catalog_fork");
const cases = [];
function add(name, installed, reason, incoming = empty()) {
    cases.push({ name, input: { installed: structuredClone(installed), expected: { ...expected }, incoming: structuredClone(incoming) }, reason });
}
add("historical-rotation-fork", frozen.next, "catalog_fork");
const broken = structuredClone(frozen.next);
broken.blocked.catalogs = [lateId];
add("singleton-fork-witness", broken, "trust_recovery_required");
add("singleton-cannot-be-repaired-by-incoming", broken, "trust_recovery_required", { ...empty(), catalogs: [f.catalogJson, lateJson, rotatedJson], histories: f.histories });
const lateDescendant = { ...late, revision: 2, previous: lateId }, lateDescendantJson = await signedCatalog(lateDescendant, f.catalogSigner);
const grown = await evaluateTreehouseCatalogTrust({ installed: frozen.next, expected, incoming: { ...empty(), catalogs: [lateDescendantJson] } });
assert.equal(grown.kind, "retain_blocked");
assert.deepEqual(grown.next.blocked, frozen.next.blocked);
add("historical-catalog-witness-after-descendant-growth", grown.next, "catalog_fork");
add("independent-catalog-siblings", siblings.next, "catalog_fork");
for (const mutation of ["ancestor-pair", "unrelated-binding", "unknown", "duplicate", "noncanonical", "empty", "pending-unknown", "valid-pair-plus-orphan"]) {
    const state = structuredClone(siblings.next), block = state.blocked;
    if (mutation === "ancestor-pair")
        block.catalogs = [priorId, lateId].sort();
    else if (mutation === "unrelated-binding") {
        // Retain a valid rotation branch in the same authentic graph, but name catalogs
        // from distinct bindings as if those records established a catalog conflict.
        state.rotations = structuredClone(rotated.next.rotations);
        state.cutoffProofs = structuredClone(rotated.next.cutoffProofs);
        state.catalogs = [...state.catalogs, ...rotated.next.catalogs.filter(c => !state.catalogs.some(x => x.id === c.id))].sort((a, b) => a.id.localeCompare(b.id));
        block.catalogs = [lateId, transportCatalogId(rotatedCatalog)].sort();
    }
    else if (mutation === "unknown")
        block.catalogs = [fixtureId("unknown-saved-catalog")];
    else if (mutation === "duplicate")
        block.catalogs = [lateId, lateId];
    else if (mutation === "noncanonical")
        block.catalogs = [lateId, branchId].sort().reverse();
    else if (mutation === "empty") {
        block.catalogs = [];
        block.bindings = [];
    }
    else if (mutation === "pending-unknown")
        block.pendingProofIds = [fixtureId("unknown-pending-catalog")];
    else
        block.catalogs = [priorId, lateId, branchId].sort();
    add(`catalog-${mutation}`, state, "trust_recovery_required", { ...empty(), catalogs: [lateJson, branchJson], histories: f.histories });
}
const rotations = [f.rotationJson];
for (const label of ["witness-rotation-two", "witness-rotation-three"]) {
    const key = fixtureSigner(label);
    rotations.push(await signedRotation({ ...f.rotation, newCatalogKey: Buffer.from(key.publicKey).toString("base64"), nonce: fixtureId(label) }, f.catalogSigner, key));
}
const bindingFork = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), rotations: rotations.slice(0, 2), cutoffProofs: f.cutoffProofs } });
assert.equal(bindingFork.kind, "retain_blocked");
assert.equal(bindingFork.reason, "catalog_fork");
assert.equal(bindingFork.next.blocked.bindings.length, 2);
add("independent-binding-fork", bindingFork.next, "catalog_fork");
const control = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), rotations, cutoffProofs: f.cutoffProofs } });
assert.equal(control.kind, "retain_blocked");
assert.equal(control.reason, "control_history_limit");
assert.equal(control.next.blocked.bindings.length, 3);
add("three-independent-binding-control-witness", control.next, "control_history_limit");
const mislabeledControl = structuredClone(control.next);
mislabeledControl.blocked.reason = "catalog_fork";
add("three-head-control-cannot-be-relabeled-as-binding-fork", mislabeledControl, "trust_recovery_required", { ...empty(), rotations, cutoffProofs: f.cutoffProofs });
const tooFew = structuredClone(control.next);
tooFew.blocked.bindings = tooFew.blocked.bindings.slice(0, 2);
add("control-requires-three-independent-bindings", tooFew, "trust_recovery_required");
for (const [label, state] of [["fork", bindingFork.next], ["control", control.next]]) {
    for (const mutation of ["singleton", "ancestor-related", "empty", "unknown", "duplicate", "noncanonical"]) {
        const broken = structuredClone(state), block = broken.blocked;
        if (mutation === "singleton")
            block.bindings = [block.bindings[0]];
        else if (mutation === "ancestor-related")
            block.bindings = [f.bootstrap.id, ...block.bindings.slice(1)].sort();
        else if (mutation === "empty")
            block.bindings = [];
        else if (mutation === "unknown")
            block.bindings = [fixtureId("unknown-binding")];
        else if (mutation === "duplicate")
            block.bindings = [block.bindings[0], block.bindings[0]];
        else
            block.bindings.reverse();
        add(`${label}-binding-${mutation}`, broken, "trust_recovery_required", { ...empty(), rotations, cutoffProofs: f.cutoffProofs });
    }
}
// A saved pair can remain independent after a later authenticated descendant
// replaces one of its current heads. Reopen must use the recorded relations.
const withChildCatalog = await evaluateTreehouseCatalogTrust({ installed: bindingFork.next, expected, incoming: { ...empty(), catalogs: [rotatedJson] } });
assert.equal(withChildCatalog.kind, "retain_blocked");
const nextKey = fixtureSigner("historical-binding-descendant");
const descendantRotation = await signedRotation({ ...f.rotation, parent: rotationId(f.rotationJson), priorCatalog: transportCatalogId(rotatedCatalog), generation: 2,
    nonce: fixtureId("historical-binding-descendant"), newCatalogKey: Buffer.from(nextKey.publicKey).toString("base64") }, f.nextCatalogSigner, nextKey);
const grownBindings = await evaluateTreehouseCatalogTrust({ installed: withChildCatalog.next, expected, incoming: { ...empty(), rotations: [descendantRotation], cutoffProofs: f.cutoffProofs } });
assert.equal(grownBindings.kind, "retain_blocked");
assert.deepEqual(grownBindings.next.blocked, bindingFork.next.blocked);
add("historical-bindings-after-descendant-growth", grownBindings.next, "catalog_fork");
const bootstrap = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root,
    deps: [f.space.frames.at(-1).id], capId: f.space.delegation.id, command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId("saved-bootstrap-fork") } } });
const bootstrapFork = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), histories: [{ ...f.histories[0], frames: [...f.space.frames, bootstrap] }] } });
assert.equal(bootstrapFork.kind, "retain_blocked");
assert.equal(bootstrapFork.reason, "catalog_fork");
assert.deepEqual(bootstrapFork.next.blocked.bootstrapIds, [bootstrap.id]);
add("historical-bootstrap-fork-unchanged", bootstrapFork.next, "catalog_fork");
const reviewed = structuredClone(bootstrapFork.next);
reviewed.blocked.bootstrapIds = [f.bootstrap.id];
add("reviewed-bootstrap-is-not-a-fork-witness", reviewed, "trust_recovery_required");
// Authenticate the whole overflow page, then reopen the recorded unadmitted
// triggers. The retained inventory stays below the source artifact count budget.
const records = [];
let previous = null;
for (let revision = 0; revision < 1023; revision++) {
    const catalog = { ...f.catalog, entries: f.catalog.entries.filter(e => e.kind === "space"), revision, previous };
    const id = transportCatalogId(catalog), json = await signedCatalog(catalog, f.catalogSigner);
    records.push({ id, json });
    previous = id;
}
const overflowOriginal = structuredClone(accepted.next);
overflowOriginal.catalogs = records.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
overflowOriginal.accepted = { binding: f.bootstrap.id, generation: 0, catalog: previous, revision: 1022 };
const overflowPage = [];
for (const revision of [1023, 1024]) {
    const catalog = { ...f.catalog, entries: f.catalog.entries.filter(e => e.kind === "space"), revision, previous };
    overflowPage.push(await signedCatalog(catalog, f.catalogSigner));
    previous = transportCatalogId(catalog);
}
const overflow = await evaluateTreehouseCatalogTrust({ installed: overflowOriginal, expected, incoming: { ...empty(), catalogs: overflowPage } });
assert.equal(overflow.kind, "retain_blocked");
assert.equal(overflow.reason, "control_history_limit");
assert.equal(overflow.next.catalogs.length, 1023);
assert.equal(overflow.next.blocked.triggers.length, 2);
add("whole-page-overflow-trigger-reopen", overflow.next, "control_history_limit");
const falseTrigger = structuredClone(overflow.next);
falseTrigger.blocked.triggers = [falseTrigger.blocked.triggers[0]];
add("insufficient-overflow-trigger-before-incoming-repair", falseTrigger, "trust_recovery_required", { ...empty(), catalogs: overflowPage });
const emptyAuthority = structuredClone(accepted.next);
emptyAuthority.blocked = { reason: "authority_changed", bindings: [], catalogs: [], bootstrapIds: [], opIds: [], pendingProofIds: [], triggers: [],
    authorityWitnesses: [{ replica: f.space.replica, frontier: [], opIds: [] }] };
add("empty-authority-witness", emptyAuthority, "trust_recovery_required");
const emptyTargets = structuredClone(emptyAuthority);
emptyTargets.blocked.authorityWitnesses[0].frontier = [f.bootstrap.id];
add("empty-authority-targets-with-real-frontier", emptyTargets, "trust_recovery_required");
const installedTrigger = structuredClone(overflow.next);
installedTrigger.blocked.triggers[0] = { ...installedTrigger.blocked.triggers[0], kind: "rotation", id: f.bootstrap.id };
installedTrigger.blocked.triggers.sort((a, b) => Buffer.compare(Buffer.from(`${a.kind}:${a.id}`), Buffer.from(`${b.kind}:${b.id}`)));
add("rotation-trigger-names-installed-bootstrap", installedTrigger, "trust_recovery_required");
const wrongPrior = structuredClone(grown.next);
wrongPrior.blocked.catalogs = [lateId, transportCatalogId(lateDescendant)].sort();
add("ancestor-conflict-requires-exact-rotation-prior", wrongPrior, "trust_recovery_required");
const exactPrior = structuredClone(grown.next);
exactPrior.blocked.catalogs = [priorId, transportCatalogId(lateDescendant)].sort();
add("exact-rotation-prior-with-later-descendant", exactPrior, "catalog_fork");
const bindingAndBadCatalog = structuredClone(bindingFork.next);
bindingAndBadCatalog.catalogs.push({ id: lateId, json: lateJson });
bindingAndBadCatalog.catalogs.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
bindingAndBadCatalog.blocked.catalogs = [lateId];
add("valid-bindings-cannot-hide-corrupt-catalog-witness", bindingAndBadCatalog, "trust_recovery_required");
const strayBootstrap = structuredClone(control.next);
strayBootstrap.histories = structuredClone(bootstrapFork.next.histories);
strayBootstrap.blocked.bootstrapIds = [bootstrap.id];
add("control-witness-cannot-add-bootstrap-fork", strayBootstrap, "trust_recovery_required");
const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
    recipient: fixtureSigner("saved-authority-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
const authority = await evaluateTreehouseCatalogTrust({ installed: accepted.next, expected, incoming: { ...empty(), histories: [{ ...f.histories[0], frames: [...f.space.frames, transfer] }] } });
assert.equal(authority.kind, "retain_blocked");
assert.equal(authority.reason, "authority_changed");
add("real-historical-authority-witness-reopen", authority.next, "authority_changed");
// Hundreds of late descendants all conflict with the exact old rotation prior.
// This is legitimate signed input, so the stored check must reuse ancestor facts.
const deepRecords = [];
previous = null;
for (let revision = 0; revision < 340; revision++) {
    const catalog = { ...f.catalog, revision, previous }, id = transportCatalogId(catalog);
    deepRecords.push({ id, json: await signedCatalog(catalog, f.catalogSigner) });
    previous = id;
}
const deepOriginal = structuredClone(accepted.next);
deepOriginal.catalogs = deepRecords.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
deepOriginal.accepted = { binding: f.bootstrap.id, generation: 0, catalog: previous, revision: 339 };
const deep = await evaluateTreehouseCatalogTrust({ installed: deepOriginal, expected, incoming: { ...empty(), rotations: [f.rotationJson], cutoffProofs: f.cutoffProofs } });
assert.equal(deep.kind, "retain_blocked");
assert.equal(deep.reason, "catalog_fork");
assert.equal(deep.next.blocked.catalogs.length, 340);
add("340-historical-catalog-witnesses-reopen", deep.next, "catalog_fork");
const results = [];
for (const item of cases) {
    const orders = [];
    for (const reverse of [false, true]) {
        const input = structuredClone(item.input);
        if (reverse) {
            input.installed.histories.reverse();
            input.installed.histories = input.installed.histories.map(h => ({ ...h, frames: [...h.frames].reverse(), rejected: [...h.rejected].reverse() }));
            input.incoming.catalogs = [...input.incoming.catalogs].reverse();
            input.incoming.rotations = [...input.incoming.rotations].reverse();
            input.incoming.histories = [...input.incoming.histories].reverse().map(h => ({ ...h, frames: [...h.frames].reverse(), rejected: [...h.rejected].reverse() }));
            input.incoming.cutoffProofs = [...input.incoming.cutoffProofs].reverse();
        }
        const before = JSON.stringify(input), decision = await evaluateTreehouseCatalogTrust(input);
        assert.equal(JSON.stringify(input), before);
        assert.equal(decision.reason, item.reason, `${item.name} reverse=${reverse}`);
        if (item.reason === "trust_recovery_required")
            assert.equal(decision.kind, "reject", item.name);
        else {
            assert.equal(decision.kind, "retain_blocked", item.name);
            assert.deepEqual(decision.routes, []);
            assert.deepEqual(decision.next.accepted, item.input.installed.accepted);
            assert.deepEqual(decision.next.blocked, item.input.installed.blocked);
        }
        orders.push({ input, decision });
    }
    results.push({ name: item.name, orders });
}
await new Promise(resolve => process.stdout.write(JSON.stringify({ cases: results }) + "\n", () => resolve()));
