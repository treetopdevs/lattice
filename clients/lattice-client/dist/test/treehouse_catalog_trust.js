import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { trustFixture, fixtureId, fixtureSigner, signedCatalog, signedRotation } from "./support/export_treehouse_catalog_trust";
import { authorTreehouseCommand, authorTreehouseRoleTransfer, treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceSchema, treehouseThreadSchema } from "../src/treehouse";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierTerm } from "../src/codec";
import { continuationProfileToCarrierTerm } from "../src/continuation";
import { carrierOpsToSemanticOps } from "../src/carrier";
import { materialize } from "../src/materialize";
import { catalogEnvelopeFromCarrierTerm, catalogEnvelopeToCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogRotationEnvelopeToCarrierTerm, catalogRotationId, transportCatalogId } from "../src/treehouse_catalog_codec";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust, resolveTreehouseCatalogRoute } from "../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
async function prepare(f) {
    const result = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
    assert.equal(result.kind, "propose", JSON.stringify(result));
    return result.next;
}
function evaluate(installed, incoming = {}) {
    return evaluateTreehouseCatalogTrust({ installed, expected, incoming: { ...empty(), ...incoming } });
}
async function installed(f) {
    const result = await evaluate(await prepare(f), { catalogs: [f.catalogJson], histories: f.histories });
    assert.equal(result.kind, "propose", JSON.stringify(result));
    return result.next;
}
function refused(result, reason) {
    assert.equal(result.reason, reason, `${result.kind}:${result.reason}:${JSON.stringify(result.detail)}`);
    if (result.kind !== "reject")
        assert.equal(result.routes.length, 0);
}
function revision(f, entries, previous = transportCatalogId(f.catalog), number = 1) {
    return { ...f.catalog, entries, previous, revision: number };
}
test("explicit root review and real independently rooted Space/Thread histories produce only installation-required catalog routes", async () => {
    const f = await trustFixture();
    const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    assert.equal(prepared.next.accepted, null);
    const result = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected,
        incoming: { catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: [] } });
    assert.equal(result.kind, "propose");
    assert.equal(result.next.accepted?.revision, 0);
    assert.equal(result.routes.length, 2);
    const route = resolveTreehouseCatalogRoute({ decision: result, replica: f.threads[0].replica });
    assert.equal(route.ok, true);
    if (route.ok) {
        assert.equal(route.installationRequired, true);
        assert.equal(route.candidate.root, f.catalog.entries.find((e) => e.kind === "thread").root);
    }
});
test("explicit review never elects from arrival order, and forged or partial signed history refuses", async () => {
    const f = await trustFixture();
    const second = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root,
        deps: [f.space.frames.at(-1).id], capId: f.space.delegation.id,
        command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId("second-bootstrap") } } });
    const history = { ...f.histories[0], frames: [...f.space.frames, second] };
    const run = (review = f.review, h = history) => prepareTreehouseCatalogInstallation({ review, history: h, store: { kind: "verified_fresh", expected } });
    refused(await run(), "catalog_fork");
    const reviewed = { ...f.review, observedBootstrapIds: [second.id, f.bootstrap.id].sort() };
    const a = await run(reviewed), b = await run(reviewed, { ...history, frames: [...history.frames].reverse() });
    assert.equal(a.kind, "propose");
    assert.equal(b.kind, "propose");
    assert.deepEqual(a.next, b.next);
    refused(await run({ ...reviewed, spaceRoot: Buffer.from(fixtureSigner("wrong-root").publicKey).toString("base64") }), "wrong_catalog_scope");
    const missing = { ...history, frames: history.frames.filter((frame) => frame.id !== f.space.genesis.id) };
    refused(await run(reviewed, missing), "trust_pending");
    refused(await run(reviewed, { ...missing, frames: missing.frames.map((frame) => frame.id === f.bootstrap.id ? { ...frame, sig: Buffer.alloc(64).toString("base64") } : frame) }), "invalid_verified_history");
});
test("an explicitly reviewed bootstrap whose signed frame has not arrived requests evidence rather than inventing an authority refusal", async () => {
    const f = await trustFixture();
    const history = { ...f.histories[0], frames: [f.space.genesis, f.space.creation, f.space.pin] };
    const result = await prepareTreehouseCatalogInstallation({ review: f.review, history, store: { kind: "verified_fresh", expected } });
    refused(result, "trust_pending");
    assert.deepEqual(result.detail.ids, [f.bootstrap.id]);
});
test("a historically honored unseen bootstrap keeps a reopenable fork after a concurrent admin transfer refuses it", async () => {
    const f = await trustFixture(), initial = await installed(f);
    const deps = [f.space.frames.at(-1).id];
    const second = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root,
        deps, capId: f.space.delegation.id,
        command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId("historical-bootstrap") } } });
    const fork = await evaluate(initial, { histories: [{ ...f.histories[0], frames: [...f.space.frames, second] }] });
    assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork");
    assert.deepEqual(fork.next.blocked.bootstrapIds, [second.id]);
    const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps, signer: f.root,
        recipient: fixtureSigner("historical-bootstrap-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
    const frames = [...f.space.frames, second, transfer];
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const projection = materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, f.space.replica);
    assert.equal(projection.quarantineReasons.has(transfer.id), false);
    assert.equal(projection.quarantineReasons.has(f.bootstrap.id), false);
    assert.equal(projection.quarantineReasons.has(f.threads[0].reference.id), false);
    assert.equal(projection.quarantineReasons.has(second.id), true, "the unseen bootstrap really becomes refused");
    const retained = [];
    for (const delivered of [frames, [...frames].reverse()]) {
        const changed = await evaluate(fork.next, { histories: [{ ...f.histories[0], frames: delivered }] });
        assert.equal(changed.kind, "retain_blocked");
        assert.equal(changed.reason, "catalog_fork");
        assert.deepEqual(changed.next.accepted, initial.accepted);
        assert.deepEqual(changed.next.blocked, fork.next.blocked);
        assert.deepEqual(changed.routes, []);
        const reopened = await evaluate(changed.next);
        assert.equal(reopened.kind, "retain_blocked", JSON.stringify(reopened));
        assert.equal(reopened.reason, "catalog_fork");
        assert.deepEqual(reopened.next, changed.next);
        assert.deepEqual(reopened.routes, []);
        retained.push(changed.next);
    }
    assert.deepEqual(retained[0], retained[1]);
    for (const mutation of ["missing", "missing-ancestor", "forged", "wrong-command", "reviewed"]) {
        const broken = structuredClone(retained[0]);
        const history = broken.histories.find((h) => h.replica === f.space.replica);
        if (mutation === "missing" || mutation === "missing-ancestor") {
            const missing = mutation === "missing" ? second.id : f.space.pin.id;
            history.frames = history.frames.filter((frame) => frame.id !== missing);
        }
        else if (mutation === "forged") {
            history.frames = history.frames.map((frame) => frame.id === second.id ?
                { ...frame, sig: Buffer.alloc(64).toString("base64") } : frame);
        }
        else
            broken.blocked.bootstrapIds = [mutation === "wrong-command" ? f.threads[0].reference.id : f.bootstrap.id];
        const rejected = await evaluate(broken, { histories: [{ ...f.histories[0], frames }] });
        assert.equal(rejected.kind, "reject", mutation);
        refused(rejected, "trust_recovery_required");
    }
    for (const defect of ["wrong-root", "never-authorized"]) {
        const invalid = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root,
            deps: defect === "never-authorized" ? [transfer.id] : deps, capId: f.space.delegation.id,
            command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId(`invalid-bootstrap-${defect}`),
                    ...(defect === "wrong-root" ? { spaceRoot: Buffer.from(fixtureSigner("impostor-root").publicKey).toString("base64") } : {}) } } });
        const history = { ...f.histories[0], frames: [...frames, invalid] };
        const observed = await treehouseCatalogBootstrapsFromFrames(history);
        assert.equal(observed.ok, true, "the entire signed raw history authenticates");
        assert.equal(observed.bootstraps.some((bootstrap) => bootstrap.id === invalid.id), false, defect);
        const broken = structuredClone(retained[0]);
        broken.histories = broken.histories.map((h) => h.replica === f.space.replica ? history : h);
        broken.blocked.bootstrapIds = [invalid.id];
        const rejected = await evaluate(broken);
        assert.equal(rejected.kind, "reject", defect);
        refused(rejected, "trust_recovery_required");
    }
});
test("actual entry metadata refuses forged roots, wrong genesis/creation/reference, schema, signer and service", async () => {
    const f = await trustFixture(), state = await prepare(f), thread = f.catalog.entries.find((entry) => entry.kind === "thread");
    for (const change of [{ root: f.bootstrapRecord.spaceRoot }, { genesis: f.threads[0].pin.id },
        { creation: f.threads[0].genesis.id }, { reference: f.bootstrap.id }]) {
        const entries = f.catalog.entries.map((entry) => entry === thread ? { ...entry, ...change } : entry);
        refused(await evaluate(state, { catalogs: [await signedCatalog({ ...f.catalog, entries }, f.catalogSigner)], histories: f.histories }), "invalid_catalog_transition");
    }
    refused(await evaluate(state, { catalogs: [await signedCatalog(f.catalog, fixtureSigner("forged-catalog"))], histories: f.histories }), "invalid_catalog_signature");
    const service = f.catalog.entries.map((entry) => ({ ...entry, serviceId: fixtureId("another-service") }));
    refused(await evaluate(state, { catalogs: [await signedCatalog({ ...f.catalog, entries: service }, f.catalogSigner)], histories: f.histories }), "wrong_catalog_scope");
    const wrong = JSON.parse(f.catalogJson);
    wrong[1].find((pair) => JSON.stringify(pair[0]) === '["atom","catalog"]')[1][1]
        .find((pair) => JSON.stringify(pair[0]) === '["atom","entries"]')[1][1][1][1]
        .find((pair) => JSON.stringify(pair[0]) === '["atom","schema"]')[1] = ["atom", "treehouse_space_v1"];
    refused(await evaluate(state, { catalogs: [JSON.stringify(wrong)], histories: f.histories }), "malformed_catalog");
});
test("catalog before reference/child proof remains pending, never fabricates a listing, and completes with exact evidence", async () => {
    const f = await trustFixture();
    const withoutRef = { ...f.histories[0], frames: f.space.frames.filter((frame) => frame.id !== f.threads[0].reference.id) };
    const initial = await prepareTreehouseCatalogInstallation({ review: f.review, history: withoutRef, store: { kind: "verified_fresh", expected } });
    assert.equal(initial.kind, "propose");
    const pending = await evaluate(initial.next, { catalogs: [f.catalogJson] });
    assert.equal(pending.kind, "propose");
    assert.equal(pending.reason, "trust_pending");
    assert.equal(pending.next.catalogs.length, 1);
    assert.equal(pending.next.accepted, null);
    assert.deepEqual(pending.routes, []);
    assert.equal(pending.next.histories[0].frames.length, withoutRef.frames.length);
    const complete = await evaluate(pending.next, { histories: f.histories });
    assert.equal(complete.kind, "propose");
    assert.equal(complete.routes.length, 2);
});
test("revision predecessor, retry and reopen never lower the accepted watermark or recycle identity/route history", async () => {
    const f = await trustFixture(), first = await installed(f);
    const moved = f.catalog.entries.map((entry) => ({ ...entry, route: `/r/${fixtureId(`moved-${entry.replica}`)}` }));
    const nextCatalog = revision(f, moved), json = await signedCatalog(nextCatalog, f.catalogSigner);
    const next = await evaluate(first, { catalogs: [json] });
    assert.equal(next.kind, "propose");
    assert.equal(next.next.accepted?.revision, 1);
    const repeated = await evaluate(next.next, { catalogs: [f.catalogJson, json] });
    assert.equal(repeated.kind, "unchanged");
    assert.deepEqual(repeated.next.accepted, next.next.accepted);
    const reordered = JSON.parse(JSON.stringify(next.next), (_key, value) => value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()) : value);
    const reopen = await evaluate(reordered);
    assert.equal(reopen.kind, "unchanged");
    assert.deepEqual(reopen.next.accepted, next.next.accepted);
    refused(await evaluate(first, { catalogs: [await signedCatalog(revision(f, moved, transportCatalogId(f.catalog), 2), f.catalogSigner)] }), "invalid_catalog_transition");
    const reused = moved.map((entry) => entry.kind === "thread" ? { ...entry, route: f.catalog.entries.find((e) => e.kind === "space").route } : entry);
    refused(await evaluate(next.next, { catalogs: [await signedCatalog(revision(f, reused, transportCatalogId(nextCatalog), 2), f.catalogSigner)] }), "invalid_catalog_transition");
    refused(await evaluate(first, { catalogs: [await signedCatalog(revision(f, [f.catalog.entries[0]]), f.catalogSigner)] }), "invalid_catalog_transition");
});
test("valid catalog siblings freeze in both orders, including withheld child proof, without trusting a chosen branch", async () => {
    const f = await trustFixture(), initial = await installed(f);
    const a = revision(f, f.catalog.entries.map((e) => ({ ...e, route: `/r/${fixtureId(`a-${e.replica}`)}` })));
    const b = revision(f, f.catalog.entries.map((e) => ({ ...e, route: `/r/${fixtureId(`b-${e.replica}`)}` })));
    const artifacts = [await signedCatalog(a, f.catalogSigner), await signedCatalog(b, f.catalogSigner)];
    const direct = await evaluate(initial, { catalogs: artifacts }), inverse = await evaluate(initial, { catalogs: [...artifacts].reverse() });
    assert.equal(direct.kind, "retain_blocked");
    assert.equal(inverse.kind, "retain_blocked");
    assert.equal(direct.reason, "catalog_fork");
    assert.deepEqual(direct.next, inverse.next);
    assert.deepEqual(direct.routes, []);
    for (const [first, second] of [artifacts, [...artifacts].reverse()]) {
        const one = await evaluate(initial, { catalogs: [first] });
        assert.equal(one.kind, "propose");
        const fork = await evaluate(one.next, { catalogs: [second] });
        assert.equal(fork.kind, "retain_blocked");
        assert.equal(fork.reason, "catalog_fork");
        assert.deepEqual(fork.next.accepted, one.next.accepted);
    }
    const pendingEntry = { ...f.catalog.entries.find((e) => e.kind === "thread"), replica: `replica:treehouse:thread:${fixtureId("unseen-child")}#authority:bounded-continuation-v1#root:${fixtureId("unseen-root")}`,
        route: `/r/${fixtureId("unseen-route")}`, genesis: fixtureId("unseen-genesis"), creation: fixtureId("unseen-creation"), reference: fixtureId("unseen-ref") };
    const c = { ...b, entries: [...b.entries, pendingEntry].sort((a, b) => Buffer.compare(Buffer.from(a.replica), Buffer.from(b.replica))) };
    const pendingJson = await signedCatalog(c, f.catalogSigner);
    const fork = await evaluate(initial, { catalogs: [artifacts[0], pendingJson] });
    assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork");
    assert.deepEqual(fork.detail.pendingProofIds, [transportCatalogId(c)]);
});
test("authentic moderator changes in a pending nonaccepted fork sibling retain a reopenable freeze", async () => {
    const f = await trustFixture(2), thread = f.threads[1];
    const baseCatalog = { ...f.catalog, entries: f.catalog.entries.filter((entry) => entry.replica !== thread.replica) };
    const base = { ...f, catalog: baseCatalog, catalogJson: await signedCatalog(baseCatalog, f.catalogSigner),
        histories: f.histories.filter((history) => history.replica !== thread.replica) };
    const first = await installed(base);
    const left = revision(base, base.catalog.entries.map((entry) => ({ ...entry, route: `/r/${fixtureId(`left-${entry.replica}`)}` })));
    const right = revision(base, f.catalog.entries.map((entry) => entry.replica === thread.replica ?
        { ...entry, route: left.entries.find((entry) => entry.kind === "space").route } : entry));
    const catalogs = [await signedCatalog(left, f.catalogSigner), await signedCatalog(right, f.catalogSigner)];
    const fork = await evaluate(first, { catalogs });
    assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork");
    assert.deepEqual(fork.detail.pendingProofIds, [transportCatalogId(right)]);
    const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: thread.replica, deps: [thread.genesis.id], signer: thread.signer,
        recipient: fixtureSigner("fork-thread-successor").publicKey, parent: thread.delegation, action: "change_moderator" });
    const frames = [...thread.frames, transfer];
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
    const projection = materialize(treehouseThreadSchema, ops, new Set(ops.map((op) => op.id)), null, thread.replica);
    assert.equal(projection.quarantineReasons.has(transfer.id), false, "the real signed moderator transfer is honored");
    assert.equal(projection.quarantineReasons.has(thread.creation.id), true, "the concurrent transfer actually refuses the child creation");
    const unblocked = await evaluate(first, { catalogs: [catalogs[1]], histories: [{ replica: thread.replica, frames, rejected: [] }] });
    assert.equal(unblocked.kind, "reject");
    refused(unblocked, "invalid_catalog_transition");
    const retained = [];
    for (const delivered of [frames, [...frames].reverse()]) {
        const changed = await evaluate(fork.next, { histories: [{ replica: thread.replica, frames: delivered, rejected: [] }] });
        assert.equal(changed.kind, "retain_blocked");
        assert.equal(changed.reason, "catalog_fork");
        assert.deepEqual(changed.next.accepted, first.accepted);
        assert.deepEqual(changed.next.catalogs, fork.next.catalogs);
        assert.deepEqual(changed.next.blocked, fork.next.blocked);
        assert.deepEqual(changed.routes, []);
        assert.deepEqual(changed.next.histories.find((history) => history.replica === thread.replica).frames, [...frames].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))), "every authenticated incoming frame is retained exactly");
        const reopened = await evaluate(changed.next);
        assert.equal(reopened.kind, "retain_blocked", JSON.stringify(reopened));
        assert.equal(reopened.reason, "catalog_fork");
        assert.deepEqual(reopened.next, changed.next);
        assert.deepEqual(reopened.routes, []);
        const invalidCandidate = await evaluate(changed.next, { catalogs: ["malformed"] });
        assert.equal(invalidCandidate.kind, "retain_blocked");
        assert.deepEqual(invalidCandidate.next, changed.next);
        const reopenedFallback = await evaluate(invalidCandidate.next);
        assert.equal(reopenedFallback.kind, "retain_blocked");
        assert.deepEqual(reopenedFallback.next, changed.next);
        retained.push(changed.next);
    }
    assert.deepEqual(retained[0], retained[1]);
    const { frame: spaceTransfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
        recipient: fixtureSigner("fork-space-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
    const authority = await evaluate(fork.next, { histories: [{ ...f.histories[0], frames: [...f.space.frames, spaceTransfer] }] });
    assert.equal(authority.kind, "retain_blocked");
    assert.equal(authority.reason, "authority_changed");
    const authorityChild = await evaluate(authority.next, { histories: [{ replica: thread.replica, frames, rejected: [] }] });
    assert.equal(authorityChild.kind, "retain_blocked");
    assert.equal(authorityChild.reason, "authority_changed");
    assert.deepEqual(authorityChild.next.blocked.authorityWitnesses, authority.next.blocked.authorityWitnesses);
    assert.equal(authorityChild.next.histories.some((history) => history.replica === thread.replica), true);
    for (const frozen of [authority, authorityChild]) {
        const reopened = await evaluate(frozen.next);
        assert.equal(reopened.kind, "retain_blocked", JSON.stringify(reopened));
        assert.deepEqual(reopened.next, frozen.next);
        assert.deepEqual(reopened.routes, []);
    }
});
for (const contradiction of ["reference", "root"])
    test(`authentic withheld proof revealing a retained sibling ${contradiction} mismatch must not emit unreopenable state`, async () => {
        const f = await trustFixture(2), thread = f.threads[1];
        const catalog = { ...f.catalog, entries: f.catalog.entries.filter((entry) => entry.replica !== thread.replica) };
        const base = { ...f, catalog, catalogJson: await signedCatalog(catalog, f.catalogSigner),
            histories: f.histories.filter((history) => history.replica !== thread.replica) };
        const first = await installed(base);
        const left = revision(base, base.catalog.entries.map((entry) => ({ ...entry, route: `/r/${fixtureId(`mismatch-left-${entry.replica}`)}` })));
        const wrongReference = f.threads[0].reference.id;
        const right = revision(base, f.catalog.entries.map((entry) => entry.replica !== thread.replica ? entry :
            contradiction === "reference" ? { ...entry, reference: wrongReference } : { ...entry, root: f.bootstrapRecord.spaceRoot }));
        const json = await signedCatalog(right, f.catalogSigner);
        const fork = await evaluate(first, { catalogs: [await signedCatalog(left, f.catalogSigner), json] });
        assert.equal(fork.kind, "retain_blocked");
        assert.equal(fork.reason, "catalog_fork");
        assert.deepEqual(fork.detail.pendingProofIds, [transportCatalogId(right)]);
        const history = f.histories.find((history) => history.replica === thread.replica);
        const unblocked = await evaluate(first, { catalogs: [json], histories: [history] });
        assert.equal(unblocked.kind, "reject");
        refused(unblocked, "invalid_catalog_transition");
        const changed = await evaluate(fork.next, { histories: [history] });
        assert.equal(changed.kind, "retain_blocked");
        assert.equal(changed.reason, "catalog_fork");
        assert.deepEqual(changed.next.catalogs, fork.next.catalogs);
        assert.deepEqual(changed.next.accepted, first.accepted);
        assert.equal(changed.next.histories.some((saved) => saved.replica === thread.replica), true);
        const reopened = await evaluate(changed.next);
        assert.equal(reopened.kind, "retain_blocked", JSON.stringify(reopened));
        assert.deepEqual(reopened.next, changed.next);
        assert.deepEqual(reopened.routes, []);
        const incomingInvalid = { ...right, revision: 2, previous: transportCatalogId(left) };
        const candidate = await evaluate(changed.next, { catalogs: [await signedCatalog(incomingInvalid, f.catalogSigner)] });
        assert.equal(candidate.kind, "retain_blocked");
        assert.deepEqual(candidate.next.catalogs, changed.next.catalogs, "a new invalid candidate is not admitted through the retained-evidence exception");
        assert.deepEqual((await evaluate(candidate.next)).kind, "retain_blocked");
        const corrupted = structuredClone(changed.next), row = corrupted.catalogs.find((row) => row.id === transportCatalogId(right));
        const envelope = catalogEnvelopeFromCarrierTerm(JSON.parse(row.json));
        row.json = JSON.stringify(catalogEnvelopeToCarrierTerm({ ...envelope, signature: Buffer.alloc(64).toString("base64") }));
        const broken = await evaluate(corrupted, { catalogs: [json], histories: f.histories });
        assert.equal(broken.kind, "reject");
        refused(broken, "trust_recovery_required");
    });
test("old-key rotation verifies possession, exact cutoff and inventory, then accepts a first new-key catalog", async () => {
    const f = await trustFixture(), first = await installed(f);
    const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    const newCatalog = { ...f.catalog, binding: catalogRotationId(rotation) };
    const json = await signedCatalog(newCatalog, f.nextCatalogSigner);
    const result = await evaluate(first, { rotations: [f.rotationJson], catalogs: [json], cutoffProofs: f.cutoffProofs });
    assert.equal(result.kind, "propose", JSON.stringify(result));
    assert.equal(result.next.accepted?.generation, 1);
    const post = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: f.threads[0].replica, signer: f.threads[0].signer,
        deps: [f.threads[0].pin.id], capId: f.threads[0].delegation.id, command: { command: "post", text: "After rotation" } });
    const grown = await evaluate(result.next, { histories: [{ ...f.histories[1], frames: [...f.threads[0].frames, post] }] });
    assert.equal(grown.kind, "propose");
    assert.equal(grown.reason, null);
    assert.deepEqual(grown.next.accepted, result.next.accepted);
    const pending = await evaluate(first, { rotations: [f.rotationJson], catalogs: [json] });
    assert.equal(pending.kind, "propose");
    assert.equal(pending.reason, "recovery_incomplete");
    assert.deepEqual(pending.next.accepted, first.accepted);
    const bad = { ...rotation, newSignature: Buffer.alloc(64).toString("base64") };
    refused(await evaluate(first, { rotations: [JSON.stringify(catalogRotationEnvelopeToCarrierTerm(bad))] }), "invalid_possession");
    const badOld = { ...rotation, oldSignature: Buffer.alloc(64).toString("base64") };
    refused(await evaluate(first, { rotations: [JSON.stringify(catalogRotationEnvelopeToCarrierTerm(badOld))] }), "invalid_catalog_signature");
    const mutated = { ...f.cutoffProofs[0], cutoff: { ...f.cutoffProofs[0].cutoff, logDigest: fixtureId("bad-digest") } };
    refused(await evaluate(first, { rotations: [f.rotationJson], cutoffProofs: [mutated] }), "recovery_incomplete");
});
test("rotation consumes its exact catalog tip and cannot erase a concurrent old-binding catalog", async () => {
    const f = await trustFixture(), initial = await installed(f);
    const json = await signedCatalog(revision(f, f.catalog.entries), f.catalogSigner);
    const a = await evaluate(initial, { rotations: [f.rotationJson], catalogs: [json], cutoffProofs: f.cutoffProofs });
    assert.equal(a.kind, "retain_blocked");
    assert.equal(a.reason, "catalog_fork");
    assert.deepEqual(a.routes, []);
    const prior = await evaluate(initial, { catalogs: [json] });
    assert.equal(prior.kind, "propose");
    const b = await evaluate(prior.next, { rotations: [f.rotationJson], cutoffProofs: f.cutoffProofs });
    assert.equal(b.kind, "retain_blocked");
    assert.equal(b.reason, "catalog_fork");
});
test("two and three authenticated rotation heads remain retained and never evicted", async () => {
    const f = await trustFixture(), initial = await installed(f);
    const rotations = [f.rotationJson];
    for (const label of ["rotation-b", "rotation-c"]) {
        const signer = fixtureSigner(label);
        rotations.push(await signedRotation({ ...f.rotation, nonce: fixtureId(label), newCatalogKey: Buffer.from(signer.publicKey).toString("base64") }, f.catalogSigner, signer));
    }
    const two = await evaluate(initial, { rotations: rotations.slice(0, 2), cutoffProofs: f.cutoffProofs });
    assert.equal(two.kind, "retain_blocked");
    assert.equal(two.reason, "catalog_fork");
    assert.equal(two.next.rotations.length, 2);
    const three = await evaluate(initial, { rotations, cutoffProofs: f.cutoffProofs });
    assert.equal(three.kind, "retain_blocked");
    assert.equal(three.reason, "control_history_limit");
    assert.equal(three.next.rotations.length, 3);
    const reopened = await evaluate(three.next);
    assert.equal(reopened.kind, "retain_blocked");
    assert.deepEqual(reopened.routes, []);
    const sequential = await evaluate(two.next, { rotations: [rotations[2]] });
    assert.equal(sequential.kind, "retain_blocked");
    assert.equal(sequential.reason, "control_history_limit");
    assert.equal(sequential.next.rotations.length, 3);
    const reopenedSequential = await evaluate(sequential.next);
    assert.equal(reopenedSequential.kind, "retain_blocked");
    assert.equal(reopenedSequential.reason, "control_history_limit");
    assert.deepEqual(reopenedSequential.next, sequential.next);
    assert.deepEqual(reopenedSequential.routes, []);
});
test("all supplied histories authenticate before any missing-page or unsupported-evidence refusal", async () => {
    const f = await trustFixture(), state = await prepare(f);
    const extra = await trustFixture(2);
    const missing = { ...extra.histories[1], frames: extra.threads[0].frames.filter((frame) => frame.id !== extra.threads[0].genesis.id) };
    const forged = { ...extra.histories[2], frames: extra.threads[1].frames.map((frame) => ({ ...frame, sig: Buffer.alloc(64).toString("base64") })) };
    for (const histories of [[missing, forged], [forged, missing]])
        refused(await evaluate(state, { histories }), "invalid_verified_history");
    const unknown = await authorCarrierOp({ replica: extra.threads[0].replica, signer: extra.threads[0].signer, deps: [extra.threads[0].pin.id],
        kind: "authority", cap: ["nil"], body: ["atom", "unsupported_trust_evidence"] });
    const unsupported = { ...extra.histories[1], frames: [...extra.threads[0].frames, unknown] };
    refused(await evaluate(state, { histories: [unsupported] }), "unsupported_cutoff");
    refused(await evaluate(state, { histories: [unsupported, forged] }), "invalid_verified_history");
});
test("a later valid profile pin reports replacement unconfigured while pinned old-key rotation remains valid", async () => {
    const f = await trustFixture(), state = await installed(f);
    const d = await authorCarrierDelegation({ replica: f.space.replica, signer: f.root, audiencePubkey: f.root.publicKey, ops: [], roles: [], live: false });
    const pin = await authorCarrierOp({ replica: f.space.replica, signer: f.root, deps: [f.space.frames.at(-1).id], kind: "authority", cap: ["nil"],
        body: ["tuple", [["atom", "genesis"], ["delegation", d], ["map", [[["atom", "__continuation__"], continuationProfileToCarrierTerm({ ...f.space.profile, maxLeaseEpochs: 9 })]]]]] });
    const envelope = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    const next = await signedCatalog({ ...f.catalog, binding: catalogRotationId(envelope) }, f.nextCatalogSigner);
    const decision = await evaluate(state, { rotations: [f.rotationJson], catalogs: [next], cutoffProofs: f.cutoffProofs,
        histories: [{ ...f.histories[0], frames: [...f.space.frames, pin] }] });
    assert.equal(decision.kind, "propose", JSON.stringify(decision));
    assert.equal(decision.replacementConfigured, false);
    assert.equal(decision.next.accepted?.generation, 1);
    assert.equal(decision.routes.length, 2);
});
test("missing rotation predecessor/proof never promotes a partial chain, and descendant rotation cannot skip an ancestor cutoff", async () => {
    const f = await trustFixture(), initial = await installed(f);
    const missing = await signedRotation({ ...f.rotation, parent: fixtureId("missing-parent") }, f.catalogSigner, f.nextCatalogSigner);
    refused(await evaluate(initial, { rotations: [missing] }), "trust_pending");
    const r1 = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson)), id1 = catalogRotationId(r1);
    const c1 = { ...f.catalog, binding: id1 }, c1json = await signedCatalog(c1, f.nextCatalogSigner);
    const nextSigner = fixtureSigner("third-catalog-key");
    const r2 = { ...f.rotation, parent: id1, priorCatalog: transportCatalogId(c1), generation: 2,
        newCatalogKey: Buffer.from(nextSigner.publicKey).toString("base64"), nonce: fixtureId("second-rotation"),
        cutoffs: f.cutoffProofs.map((p) => ({ ...p.cutoff, logDigest: fixtureId(`other-${p.cutoff.replica}`) })) };
    const r2json = await signedRotation(r2, f.nextCatalogSigner, nextSigner);
    const id2 = catalogRotationId(catalogRotationEnvelopeFromCarrierTerm(JSON.parse(r2json)));
    const c2json = await signedCatalog({ ...f.catalog, binding: id2 }, nextSigner);
    const pending = await evaluate(initial, { rotations: [f.rotationJson, r2json], catalogs: [c1json, c2json], cutoffProofs: f.cutoffProofs });
    assert.equal(pending.kind, "propose");
    assert.equal(pending.reason, "recovery_incomplete");
    assert.deepEqual(pending.next.accepted, initial.accepted);
});
test("retained state and public input are closed, immutable during async work, and missing storage is never a fresh pin", async () => {
    const f = await trustFixture(), state = await installed(f);
    const duplicates = { ...state, catalogs: [...state.catalogs, ...state.catalogs] };
    refused(await evaluate(duplicates), "trust_recovery_required");
    refused(await evaluate({ ...state, histories: [] }), "trust_recovery_required");
    refused(await evaluate({ ...state, accepted: { ...state.accepted, catalog: fixtureId("absent-accepted") } }), "trust_recovery_required");
    const corruptHistory = { ...state, histories: state.histories.map((h) => h.replica === f.space.replica ?
            { ...h, frames: h.frames.filter((frame) => frame.id !== f.space.genesis.id) } : h) };
    refused(await evaluate(corruptHistory, { histories: f.histories }), "trust_recovery_required");
    const withGetter = Object.defineProperty({ ...state }, "accepted", { get() { throw new Error("getter invoked"); }, enumerable: true });
    refused(await evaluate(withGetter), "trust_recovery_required");
    const incoming = { catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: [] };
    const promise = evaluateTreehouseCatalogTrust({ installed: await prepare(f), expected, incoming });
    incoming.catalogs[0] = "tampered after call";
    const decision = await promise;
    assert.equal(decision.kind, "propose");
    assert.equal(decision.routes.length, 2);
    const store = { kind: "existing_identity", expected };
    refused(await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store }), "malformed_catalog");
});
test("twelve actual archived Threads retain all thirteen slots, while a legitimate signer cannot add the fourteenth entry", async () => {
    const f = await trustFixture(12);
    for (const t of f.threads)
        t.frames.push(await authorTreehouseCommand({ product: "Treehouse.Thread", replica: t.replica, signer: t.signer,
            deps: [t.pin.id], capId: t.delegation.id, command: { command: "archive_thread" } }));
    const decision = await evaluate(await prepare(f), { histories: f.histories, catalogs: [f.catalogJson] });
    assert.equal(decision.kind, "propose");
    assert.equal(decision.routes.length, 13);
    const raw = JSON.parse(f.catalogJson);
    const catalog = raw[1].find(([key]) => JSON.stringify(key) === '["atom","catalog"]')[1];
    const entries = catalog[1].find(([key]) => JSON.stringify(key) === '["atom","entries"]')[1];
    entries[1].push(entries[1][1]);
    const bytes = canonicalBytesForCarrierTerm(["list", [["bin", Buffer.from("lattice-treehouse-transport-catalog-v1").toString("base64")], catalog]]);
    raw[1].find(([key]) => JSON.stringify(key) === '["atom","signature"]')[1] = ["bin", Buffer.from(await f.catalogSigner.sign(bytes)).toString("base64")];
    refused(await evaluate(decision.next, { catalogs: [JSON.stringify(raw)] }), "malformed_catalog");
});
test("actual 1024-artifact and16MiB inclusive boundaries freeze without evicting or admitting overflow", async () => {
    const f = await trustFixture(0), prepared = await prepare(f);
    async function chain(count, width) {
        const catalogs = [];
        let prior = null;
        for (let i = 0; i < count; i++) {
            const catalog = { ...f.catalog, revision: i, previous: prior };
            let json = await signedCatalog(catalog, f.catalogSigner);
            if (width !== undefined)
                json += " ".repeat(width - Buffer.byteLength(json));
            prior = transportCatalogId(catalog);
            catalogs.push({ id: prior, json });
        }
        return { catalogs: catalogs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), accepted: { binding: f.bootstrap.id, generation: 0, catalog: prior, revision: count - 1 } };
    }
    for (const [count, width] of [[1024, undefined], [128, 128 * 1024]]) {
        const prior = await chain(count, width), state = { ...prepared, ...prior };
        const atBound = await evaluate(state);
        assert.equal(atBound.kind, "unchanged", `${atBound.kind}:${atBound.reason}`);
        assert.equal(atBound.routes.length, 1);
        const extra = await signedCatalog({ ...f.catalog, revision: count, previous: prior.accepted.catalog }, f.catalogSigner);
        const result = await evaluate(state, { catalogs: [extra] });
        assert.equal(result.kind, "retain_blocked", `${result.kind}:${result.reason}`);
        assert.equal(result.reason, "control_history_limit");
        assert.deepEqual(result.next.catalogs, state.catalogs);
        assert.deepEqual(result.next.accepted, state.accepted);
        assert.deepEqual(result.routes, []);
        assert.equal(result.next.blocked.triggers[0].id, transportCatalogId({ ...f.catalog, revision: count, previous: prior.accepted.catalog }));
        assert.equal(result.next.blocked.triggers[0].bytes, Buffer.byteLength(extra));
        const reopened = await evaluate(result.next);
        assert.equal(reopened.kind, "retain_blocked");
        assert.deepEqual(reopened.routes, []);
        if (width !== undefined) {
            const latest = state.catalogs.find((row) => row.id === state.accepted.catalog);
            const previousId = catalogEnvelopeFromCarrierTerm(JSON.parse(latest.json)).catalog.previous;
            const before = { ...state, catalogs: state.catalogs.filter((row) => row.id !== latest.id), accepted: { ...state.accepted, catalog: previousId, revision: count - 2 } };
            const page = [latest.json, extra.padEnd(width, " ")];
            const exhausted = await evaluate(before, { catalogs: page });
            assert.equal(exhausted.kind, "retain_blocked");
            assert.equal(exhausted.next.blocked.triggers.length, 2, "both unadmitted records prove page exhaustion against the unchanged original store");
            assert.deepEqual(exhausted.next.catalogs, before.catalogs);
            assert.deepEqual(exhausted.next.accepted, before.accepted);
            assert.equal((await evaluate(exhausted.next)).kind, "retain_blocked");
            refused(await evaluate({ ...exhausted.next, blocked: { ...exhausted.next.blocked, triggers: exhausted.next.blocked.triggers.slice(0, 1) } }), "trust_recovery_required");
            const badWatermark = { ...before, accepted: { ...before.accepted, generation: 1 } };
            refused(await evaluate(badWatermark, { catalogs: page }), "trust_recovery_required");
            const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
                recipient: fixtureSigner("overflow-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
            const histories = [{ ...f.histories[0], frames: [...f.space.frames, transfer] }];
            const authorityFirst = await evaluate(before, { histories });
            assert.equal(authorityFirst.kind, "retain_blocked");
            assert.equal(authorityFirst.reason, "authority_changed");
            const authorityOverflow = await evaluate(authorityFirst.next, { catalogs: page });
            assert.equal(authorityOverflow.kind, "retain_blocked");
            assert.equal(authorityOverflow.reason, "authority_changed");
            assert.deepEqual(authorityOverflow.next.blocked.authorityWitnesses, authorityFirst.next.blocked.authorityWitnesses);
            assert.deepEqual(authorityOverflow.next.blocked.triggers, exhausted.next.blocked.triggers);
            const overflowAuthority = await evaluate(exhausted.next, { histories });
            assert.equal(overflowAuthority.kind, "retain_blocked");
            assert.equal(overflowAuthority.reason, "authority_changed");
            assert.deepEqual(overflowAuthority.next.blocked, authorityOverflow.next.blocked);
            for (const frozen of [authorityOverflow, overflowAuthority]) {
                const repeat = await evaluate(frozen.next, { catalogs: [...page].reverse() });
                assert.equal(repeat.kind, "retain_blocked");
                assert.deepEqual(repeat.next.blocked, frozen.next.blocked);
                assert.deepEqual(repeat.next.catalogs, before.catalogs);
                assert.deepEqual(repeat.next.accepted, before.accepted);
                assert.deepEqual(repeat.routes, []);
            }
        }
    }
});
test("module-issued route decisions cannot be fabricated or mutated into another pinned identity", async () => {
    const f = await trustFixture();
    const decision = await evaluate(await prepare(f), { catalogs: [f.catalogJson], histories: f.histories });
    assert.equal(decision.kind, "propose");
    const replica = f.threads[0].replica;
    const original = resolveTreehouseCatalogRoute({ decision, replica });
    assert.equal(original.ok, true);
    decision.routes.find((r) => r.replica === replica).serviceKey = "forged";
    assert.deepEqual(resolveTreehouseCatalogRoute({ decision, replica }), original);
    assert.equal(resolveTreehouseCatalogRoute({ decision: structuredClone(decision), replica }).ok, false);
});
test("a concurrent real role transfer reclassifies accepted bootstrap/reference and freezes instead of repinning", async () => {
    const f = await trustFixture(), state = await installed(f), successor = fixtureSigner("successor");
    const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
        recipient: successor.publicKey, parent: f.space.delegation, action: "transfer_admin" });
    const changed = await evaluate(state, { histories: [{ ...f.histories[0], frames: [...f.space.frames, transfer] }] });
    assert.equal(changed.kind, "retain_blocked", JSON.stringify(changed));
    assert.equal(changed.reason, "authority_changed");
    assert.deepEqual(changed.next.accepted, state.accepted);
    assert.deepEqual(changed.next.review, state.review);
    assert.deepEqual(changed.routes, []);
    const invalidCatalog = await evaluate(state, { histories: [{ ...f.histories[0], frames: [...f.space.frames, transfer] }], catalogs: ["malformed"] });
    assert.equal(invalidCatalog.kind, "retain_blocked");
    assert.equal(invalidCatalog.reason, "authority_changed");
    for (const frozen of [changed, invalidCatalog]) {
        const reopened = await evaluate(frozen.next);
        assert.equal(reopened.kind, "retain_blocked");
        assert.deepEqual(reopened.next, frozen.next);
    }
});
async function blockedRotation(f) {
    const first = await installed(f);
    const later = await signedCatalog(revision(f, f.catalog.entries), f.catalogSigner);
    const result = await evaluate(first, { rotations: [f.rotationJson], catalogs: [later], cutoffProofs: f.cutoffProofs });
    assert.equal(result.kind, "retain_blocked");
    assert.equal(result.reason, "catalog_fork");
    return result.next;
}
for (const corruption of ["catalog signature", "rotation signature", "cutoff proof", "raw signature", "saved JSON", "watermark", "block index"]) {
    test(`saved ${corruption} corruption requires recovery before honoring an existing block or incoming evidence`, async () => {
        const f = await trustFixture(), original = await blockedRotation(f), broken = structuredClone(original);
        if (corruption === "catalog signature") {
            const row = broken.catalogs[0], envelope = catalogEnvelopeFromCarrierTerm(JSON.parse(row.json));
            row.json = JSON.stringify(catalogEnvelopeToCarrierTerm({ ...envelope, signature: Buffer.alloc(64).toString("base64") }));
        }
        else if (corruption === "rotation signature") {
            const row = broken.rotations[0], envelope = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(row.json));
            row.json = JSON.stringify(catalogRotationEnvelopeToCarrierTerm({ ...envelope, oldSignature: Buffer.alloc(64).toString("base64") }));
        }
        else if (corruption === "cutoff proof")
            broken.cutoffProofs[0].cutoff.logDigest = fixtureId("corrupt-saved-cutoff");
        else if (corruption === "raw signature")
            broken.histories[0].frames[0].sig = Buffer.alloc(64).toString("base64");
        else if (corruption === "saved JSON")
            broken.catalogs[0].json = "{not-json";
        else if (corruption === "watermark")
            broken.accepted.generation++;
        else
            broken.blocked.catalogs.push(fixtureId("invented-fork-witness"));
        const forged = { ...f.histories[1], frames: f.threads[0].frames.map((frame) => ({ ...frame, sig: Buffer.alloc(64).toString("base64") })) };
        for (const incoming of [empty(), { ...empty(), catalogs: [f.catalogJson], rotations: [f.rotationJson], histories: f.histories, cutoffProofs: f.cutoffProofs },
            { ...empty(), histories: [f.histories[0], forged] }, { ...empty(), histories: [forged, f.histories[0]] }]) {
            const result = await evaluate(broken, incoming);
            assert.equal(result.kind, "reject", corruption);
            refused(result, "trust_recovery_required");
        }
        assert.deepEqual(await evaluate(original), await evaluate(structuredClone(original)), "valid blocked reopen remains deterministic");
        assert.equal((await evaluate(original)).kind, "retain_blocked");
    });
}
test("saved unsupported raw evidence and missing accepted rotation proofs cannot be repaired from incoming evidence", async () => {
    const f = await trustFixture(), original = await blockedRotation(f);
    const unknown = await authorCarrierOp({ replica: f.threads[0].replica, signer: f.threads[0].signer, deps: [f.threads[0].pin.id],
        kind: "authority", cap: ["nil"], body: ["atom", "unsupported_trust_evidence"] });
    const broken = structuredClone(original);
    broken.histories.find((h) => h.replica === unknown.replica).frames = [...f.threads[0].frames, unknown];
    const unsupported = await evaluate(broken);
    assert.equal(unsupported.kind, "reject");
    refused(unsupported, "trust_recovery_required");
    const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    const firstNew = { ...f.catalog, binding: catalogRotationId(rotation) };
    const accepted = await evaluate(await installed(f), { rotations: [f.rotationJson], catalogs: [await signedCatalog(firstNew, f.nextCatalogSigner)], cutoffProofs: f.cutoffProofs });
    assert.equal(accepted.kind, "propose");
    assert.equal(accepted.next.accepted?.generation, 1);
    const siblings = await Promise.all(["left", "right"].map((side) => signedCatalog({ ...firstNew, previous: transportCatalogId(firstNew), revision: 1,
        entries: firstNew.entries.map((entry) => ({ ...entry, route: `/r/${fixtureId(`${side}-${entry.replica}`)}` })) }, f.nextCatalogSigner)));
    const blocked = await evaluate(accepted.next, { catalogs: siblings });
    assert.equal(blocked.kind, "retain_blocked");
    const missing = { ...blocked.next, cutoffProofs: [] };
    const result = await evaluate(missing, { cutoffProofs: f.cutoffProofs });
    assert.equal(result.kind, "reject");
    refused(result, "trust_recovery_required");
    assert.equal((await evaluate(blocked.next)).kind, "retain_blocked");
});
test("an invented durable block cannot freeze a coherent singleton catalog without evidence", async () => {
    const f = await trustFixture(), state = await installed(f);
    for (const reason of ["catalog_fork", "authority_changed", "control_history_limit"]) {
        const result = await evaluate({ ...state, blocked: { reason, bindings: [], catalogs: [], bootstrapIds: [], opIds: [], pendingProofIds: [], triggers: [], authorityWitnesses: [] } });
        assert.equal(result.kind, "reject");
        refused(result, "trust_recovery_required");
    }
});
test("historical authority witnesses survive later authenticated history and corrupt or missing witness references require recovery", async () => {
    const f = await trustFixture(), first = await installed(f);
    const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
        recipient: fixtureSigner("witness-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
    const changed = await evaluate(first, { histories: [{ ...f.histories[0], frames: [...f.space.frames, transfer] }] });
    assert.equal(changed.kind, "retain_blocked");
    assert.equal(changed.reason, "authority_changed");
    const witnesses = changed.next.blocked.authorityWitnesses;
    assert.equal(witnesses.length, 1);
    assert.equal(witnesses[0].replica, f.space.replica);
    assert.deepEqual(witnesses[0].opIds, changed.next.blocked.opIds);
    assert.equal((await evaluate(changed.next)).kind, "retain_blocked");
    const beacon = await authorCarrierOp({ replica: f.space.replica, signer: f.root, deps: witnesses[0].frontier,
        kind: "authority", cap: ["nil"], body: ["tuple", [["atom", "beacon"], ["int", 1]]] });
    const grown = await evaluate(changed.next, { histories: [{ ...f.histories[0], frames: [...f.space.frames, transfer, beacon] }] });
    assert.equal(grown.kind, "retain_blocked");
    assert.equal(grown.reason, "authority_changed");
    assert.deepEqual(grown.next.blocked.authorityWitnesses, witnesses, "later raw frontier does not replace the recorded historical closure");
    assert.equal((await evaluate(grown.next)).kind, "retain_blocked");
    for (const mutation of ["missing", "unknown frontier", "redundant frontier", "duplicate frontier", "wrong replica", "honored target", "wrong index"]) {
        const broken = structuredClone(grown.next), block = broken.blocked, witness = block.authorityWitnesses[0];
        if (mutation === "missing")
            block.authorityWitnesses = [];
        else if (mutation === "unknown frontier")
            witness.frontier = [fixtureId("absent-witness-frame")];
        else if (mutation === "redundant frontier")
            witness.frontier = [...witness.frontier, f.space.genesis.id].sort();
        else if (mutation === "duplicate frontier")
            witness.frontier.push(witness.frontier[0]);
        else if (mutation === "wrong replica")
            witness.replica = f.threads[0].replica;
        else if (mutation === "honored target") {
            witness.opIds = [f.space.creation.id];
            block.opIds = [...witness.opIds];
        }
        else
            block.opIds = [fixtureId("unknown-witness-target")];
        const result = await evaluate(broken, { histories: grown.next.histories });
        assert.equal(result.kind, "reject", mutation);
        refused(result, "trust_recovery_required");
    }
});
test("historical fork witnesses remain valid after authenticated descendants replace the old catalog heads", async () => {
    const f = await trustFixture(), first = await installed(f);
    const siblings = ["left", "right"].map((side) => revision(f, f.catalog.entries.map((e) => ({ ...e, route: `/r/${fixtureId(`${side}-${e.replica}`)}` }))));
    const fork = await evaluate(first, { catalogs: await Promise.all(siblings.map((catalog) => signedCatalog(catalog, f.catalogSigner))) });
    assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork");
    const descendants = await Promise.all(siblings.map((catalog) => signedCatalog({ ...catalog, previous: transportCatalogId(catalog), revision: 2 }, f.catalogSigner)));
    const grown = await evaluate(fork.next, { catalogs: descendants });
    assert.equal(grown.kind, "retain_blocked");
    assert.deepEqual(grown.next.blocked, fork.next.blocked);
    assert.equal(grown.next.catalogs.length, 5);
    assert.equal((await evaluate(grown.next)).kind, "retain_blocked");
    assert.deepEqual(grown.next.accepted, first.accepted);
    assert.deepEqual(grown.routes, []);
});
test("invalid candidate transitions cannot poison a retained freeze, and the same transition in saved state requires recovery", async () => {
    const f = await trustFixture(), original = await blockedRotation(f);
    const prior = original.catalogs.map((row) => catalogEnvelopeFromCarrierTerm(JSON.parse(row.json)).catalog).find((catalog) => catalog.revision === 1);
    const reused = prior.entries.map((entry) => ({ ...entry, route: entry.kind === "thread" ? f.catalog.entries.find((e) => e.kind === "space").route : `/r/${fixtureId("moved-space")}` }));
    const invalid = { ...prior, previous: transportCatalogId(prior), revision: 2, entries: reused };
    const json = await signedCatalog(invalid, f.catalogSigner);
    const incoming = await evaluate(original, { catalogs: [json] });
    assert.equal(incoming.kind, "retain_blocked");
    assert.deepEqual(incoming.next.catalogs, original.catalogs, "the frozen error fallback contains only validated retained artifacts");
    assert.equal((await evaluate(incoming.next)).kind, "retain_blocked");
    const saved = { ...original, catalogs: [...original.catalogs, { id: transportCatalogId(invalid), json }] };
    const broken = await evaluate(saved, { catalogs: [f.catalogJson] });
    assert.equal(broken.kind, "reject");
    refused(broken, "trust_recovery_required");
});
test("continuity vocabulary remains authenticated raw evidence across catalog install and reopen", async () => {
    const f = await trustFixture();
    for (const file of ["cutoff_atoms_member_continuity_v1.json", "cutoff_atoms_with_member_continuity_v1.json"]) {
        const names = JSON.parse(readFileSync(new URL(`./vectors/catalog/${file}`, import.meta.url), "utf8"));
        const frame = await authorCarrierOp({ replica: f.space.replica, signer: f.root, deps: [f.space.frames.at(-1).id], kind: "command",
            cap: ["bin", Buffer.from(f.space.delegation.id).toString("base64")],
            body: ["tuple", [["atom", "attest_member_key_v1"], ["list", [["list", names.map((name) => ["atom", name])]]]]] });
        const history = { ...f.histories[0], frames: [...f.space.frames, frame],
            rejected: [{ frame: { ...frame, sig: Buffer.alloc(64).toString("base64") }, reason: "bad_signature" }] };
        const states = [];
        for (const frames of [history.frames, [...history.frames].reverse()]) {
            const raw = { ...history, frames };
            const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: raw, store: { kind: "verified_fresh", expected } });
            assert.equal(prepared.kind, "propose", JSON.stringify(prepared));
            const result = await evaluate(prepared.next, { catalogs: [f.catalogJson], histories: [raw, ...f.histories.slice(1)] });
            assert.equal(result.kind, "propose");
            assert.equal(result.routes.length, 2);
            const retained = result.next.histories.find((h) => h.replica === f.space.replica);
            assert.ok(retained.frames.some((op) => op.id === frame.id));
            assert.equal(retained.rejected.length, 1);
            assert.equal(retained.rejected[0].frame.id, frame.id);
            const reopened = await evaluate(result.next);
            assert.equal(reopened.kind, "unchanged");
            assert.deepEqual(reopened.next, result.next);
            const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
            const projection = materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, f.space.replica);
            assert.equal(projection.quarantineReasons.get(frame.id), "unknown_command");
            states.push(result.next);
        }
        assert.deepEqual(states[0], states[1]);
        for (const atom of ["cutoff_unknown_evidence_v99", "claim_id"]) {
            const unknown = await authorCarrierOp({ replica: f.space.replica, signer: f.root, deps: [frame.id], kind: "command", cap: ["nil"], body: ["atom", atom] });
            refused(await prepareTreehouseCatalogInstallation({ review: f.review, history: { ...history, frames: [...history.frames, unknown] },
                store: { kind: "verified_fresh", expected } }), "unsupported_cutoff");
        }
        refused(await prepareTreehouseCatalogInstallation({ review: f.review,
            history: { ...history, frames: history.frames.map((op) => op.id === frame.id ? { ...op, sig: "" } : op) },
            store: { kind: "verified_fresh", expected } }), "invalid_verified_history");
    }
});
