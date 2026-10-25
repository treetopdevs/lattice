import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture } from "./export_treehouse_catalog_trust";
import { authorCarrierOpUnchecked } from "./unchecked_author";
import { verifyCarrierOpHash } from "../../src/codec";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
async function produce() {
    const f = await trustFixture(0), baseline = f.histories[0];
    const control = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [f.bootstrap.id, baseline.frames.find(v => v.id !== f.bootstrap.id).id], kind: "command", body: ["map", [[["atom", "version"], ["int", 1]], [["atom", "epoch"], ["int", 2]]]], cap: ["nil"] });
    const wrong = await authorCarrierOpUnchecked({ replica: "outside-treehouse-family", signer: f.root, deps: [], kind: "command", body: ["int", 1], cap: ["nil"] });
    return { wrongHistory: { replica: wrong.replica, frames: [wrong], rejected: [] }, review: f.review, history: { ...baseline, frames: [...baseline.frames, control] }, catalogJson: f.catalogJson, control };
}
async function run(b) {
    const page = { catalogs: [], rotations: [], histories: [], cutoffProofs: [] };
    const prepared = await prepareTreehouseCatalogInstallation({ review: b.review, history: b.history, store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    const base = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...page, histories: [b.history], catalogs: [b.catalogJson] } });
    assert.equal(base.kind, "propose");
    assert.equal(base.next.accepted?.revision, 0);
    assert.equal(base.routes.length, 1);
    const original = JSON.stringify(base.next), results = [];
    const dup = { ...b.control, deps: [...b.control.deps, b.control.deps[0]] };
    if (b.control.body[0] !== "map")
        throw new Error("map-order control required");
    const small = JSON.parse(JSON.stringify(b.control));
    for (const pair of small.body[1])
        if (pair[1][0] === "int" && pair[1][1] === 1)
            pair[1] = ["int", "1"];
    const mapped = { ...b.control, body: ["map", [...b.control.body[1]].reverse()] };
    const variants = [{ name: "exact", frame: b.control }, { name: "object-key-order", frame: Object.fromEntries(Object.entries(b.control).reverse()) }, { name: "small-text", frame: small }, { name: "dependency-alias", frame: dup }, { name: "dependency-order", frame: { ...b.control, deps: [...b.control.deps].reverse() } }, { name: "map-order", frame: mapped }];
    for (const { name, frame } of variants) {
        assert.equal(await verifyCarrierOpHash(JSON.parse(JSON.stringify(frame))), true);
        const incoming = JSON.parse(JSON.stringify({ ...page, histories: [{ replica: b.history.replica, frames: [frame], rejected: [] }] }));
        const d = await evaluateTreehouseCatalogTrust({ installed: base.next, expected, incoming });
        assert.equal(d.kind, "unchanged");
        assert.equal(d.reason, null);
        assert.deepEqual(d.detail.ids, []);
        assert.deepEqual(d.next, base.next);
        assert.equal(d.routes.length, 1);
        results.push({ name, kind: d.kind, reason: d.reason, ids: d.detail.ids });
    }
    const cutoff = await deriveTreehouseCatalogCutoff(b.history);
    assert.equal(cutoff.ok, true);
    if (!cutoff.ok)
        throw new Error("valid proof cutoff required");
    const aliasHistory = { ...b.history, frames: b.history.frames.map(f => f.id === b.control.id ? dup : f) };
    const aliasCutoff = await deriveTreehouseCatalogCutoff(aliasHistory);
    assert.equal(aliasCutoff.ok, true);
    if (!aliasCutoff.ok)
        throw new Error("alias proof must be authentic/portable");
    assert.deepEqual(aliasCutoff.cutoff, cutoff.cutoff);
    const proof = await evaluateTreehouseCatalogTrust({ installed: base.next, expected, incoming: { ...page, cutoffProofs: [{ cutoff: cutoff.cutoff, history: aliasHistory }] } });
    assert.equal(proof.kind, "propose");
    assert.equal(proof.reason, null);
    assert.deepEqual(proof.next.histories, base.next.histories);
    const reopened = await evaluateTreehouseCatalogTrust({ installed: JSON.parse(JSON.stringify(proof.next)), expected, incoming: page });
    assert.equal(reopened.kind, "unchanged");
    assert.deepEqual(reopened.next, proof.next);
    const aliasFirst = { ...b.history, frames: b.history.frames.map(f => f.id === b.control.id ? { ...mapped, deps: dup.deps } : f) };
    const pin = await prepareTreehouseCatalogInstallation({ review: b.review, history: aliasFirst, store: { kind: "verified_fresh", expected } });
    assert.equal(pin.kind, "propose");
    const first = await evaluateTreehouseCatalogTrust({ installed: pin.next, expected, incoming: { ...page, catalogs: [b.catalogJson] } });
    assert.equal(first.kind, "propose");
    assert.equal(first.routes.length, 1);
    const honest = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: { ...page, histories: [{ ...b.history, frames: [b.control] }], cutoffProofs: [{ cutoff: cutoff.cutoff, history: b.history }] } });
    assert.equal(honest.kind, "propose");
    assert.equal(honest.reason, null);
    assert.equal(honest.routes.length, 1);
    assert.deepEqual(honest.next.histories, first.next.histories);
    const again = await evaluateTreehouseCatalogTrust({ installed: JSON.parse(JSON.stringify(honest.next)), expected, incoming: page });
    assert.equal(again.kind, "unchanged");
    assert.deepEqual(again.next, honest.next);
    for (const frames of [[dup, dup], [dup, b.control, b.control], [b.control, b.control, dup], [null]]) {
        const d = await evaluateTreehouseCatalogTrust({ installed: base.next, expected, incoming: JSON.parse(JSON.stringify({ ...page, histories: [{ ...b.history, frames }] })) });
        assert.equal(d.kind, "reject");
        assert.equal(d.reason, "invalid_verified_history");
        assert.deepEqual(d.detail.ids, []);
    }
    const damaged = { ...base.next, histories: [...base.next.histories, b.wrongHistory].sort((a, b) => a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0) };
    const recovery = await evaluateTreehouseCatalogTrust({ installed: damaged, expected, incoming: { ...page, histories: [b.history] } });
    assert.equal(recovery.kind, "reject");
    assert.equal(recovery.reason, "trust_recovery_required");
    assert.deepEqual(recovery.detail.ids, []);
    const wrongCutoff = await deriveTreehouseCatalogCutoff(b.wrongHistory);
    assert.equal(wrongCutoff.ok, true);
    if (!wrongCutoff.ok)
        throw new Error("signed wrong-family proof required");
    const wrongProof = await evaluateTreehouseCatalogTrust({ installed: base.next, expected, incoming: { ...page, cutoffProofs: [{ cutoff: wrongCutoff.cutoff, history: b.wrongHistory }] } });
    assert.equal(wrongProof.kind, "reject");
    assert.equal(wrongProof.reason, "recovery_incomplete");
    assert.deepEqual(wrongProof.detail.ids, []);
    assert.equal(JSON.stringify(base.next), original);
    return { bundle: b, results };
}
const b = process.argv[2] === "consume" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : await produce();
console.log(JSON.stringify(await run(b)));
