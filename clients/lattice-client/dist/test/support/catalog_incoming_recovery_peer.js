import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture, fixtureId, signedCatalog } from "./export_treehouse_catalog_trust";
import { authorCarrierOpUnchecked } from "./unchecked_author";
import { boundaryCases } from "./catalog_incoming_boundary_cases";
import { authorTreehouseCommand } from "../../src/treehouse";
import { transportCatalogId } from "../../src/treehouse_catalog_codec";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
const page = (histories = []) => ({ catalogs: [], rotations: [], histories, cutoffProofs: [] });
async function produce() {
    const f = await trustFixture(1);
    const retainedHistories = f.histories;
    retainedHistories[0].rejected = [{ frame: { ...f.histories[0].frames[0], sig: Buffer.alloc(64).toString("base64") }, reason: "bad_signature" }];
    const fork = await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.space.replica, signer: f.root, deps: [f.histories[0].frames.at(-1).id], capId: f.space.delegation.id, command: { command: "catalog_bootstrap_v1", record: { ...f.bootstrapRecord, nonce: fixtureId("recovery-bootstrap-fork") } } });
    const names = new Set(["depth-64-complete", "depth-65-complete", "depth-66-partial", "push-64000-complete", "push-64001-complete", "forged-depth-65-partial"]);
    const inputs = (await boundaryCases(f)).filter(([name]) => names.has(name));
    assert.equal(inputs.length, names.size);
    return { review: f.review, histories: f.histories, catalogJson: f.catalogJson, advancedCatalogJson: await signedCatalog({ ...f.catalog, revision: 1, previous: transportCatalogId(f.catalog) }, f.catalogSigner), forkHistory: { ...f.histories[0], frames: [...f.histories[0].frames, fork] }, incrementalFrame: await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [f.histories[0].frames.at(-1).id], kind: "command", body: ["nil"], cap: ["nil"] }), deepFrame: inputs.find(([name]) => name === "depth-65-complete")[1].at(-1), cases: inputs.map(([name, frames]) => ({ name, history: { replica: f.space.replica, frames, rejected: [] } })) };
}
function summary(d) {
    const state = d.kind === "reject" ? null : d.next;
    return { kind: d.kind, reason: d.reason, ids: d.detail.ids, accepted: state?.accepted ?? null, blocked: state?.blocked?.reason ?? null, routes: d.kind === "reject" ? [] : d.routes.map(r => r.replica).sort(), histories: state === null ? [] : state.histories.map(h => [h.replica, h.frames.map(f => f.id).sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), catalogs: state?.catalogs.map(c => c.id).sort() ?? [], rotations: state?.rotations.map(r => r.id).sort() ?? [] };
}
async function run(bundle) {
    const prepared = await prepareTreehouseCatalogInstallation({ review: bundle.review, history: bundle.histories.find(h => h.replica === bundle.review.space), store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    const first = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...page(bundle.histories), catalogs: [bundle.catalogJson, bundle.advancedCatalogJson] } });
    assert.equal(first.kind, "propose");
    assert.equal(first.next.accepted?.revision, 1);
    assert.equal(first.routes.length, 2);
    const frozen = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: page([bundle.forkHistory]) });
    assert.equal(frozen.kind, "retain_blocked");
    assert.equal(frozen.reason, "catalog_fork");
    assert.deepEqual(frozen.next.accepted, first.next.accepted);
    const observations = [];
    const wrong = { replica: "not-a-treehouse-family", frames: [], rejected: [] };
    const forged = { replica: bundle.review.space, frames: [{ ...bundle.deepFrame, sig: Buffer.alloc(64).toString("base64") }], rejected: [] };
    for (const [name, histories] of [["scope-forged", [wrong, forged]], ["forged-scope", [forged, wrong]], ["scope-only", [wrong]]]) {
        const decision = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: page([...histories]) });
        assert.equal(decision.kind, "reject");
        assert.equal(decision.reason, "wrong_catalog_scope");
        observations.push({ name, decision: summary(decision) });
    }
    const malformed = [null, { replica: bundle.review.space, frames: [] }, { replica: 4, frames: [], rejected: [] }, { replica: bundle.review.space, frames: [], rejected: [], extra: true }];
    for (const [slot, bad] of malformed.entries())
        for (const [order, histories] of [["first", [bad, wrong]], ["last", [wrong, bad]]]) {
            const incoming = JSON.parse(JSON.stringify({ ...page(), histories }));
            const decision = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming });
            assert.equal(decision.kind, "reject");
            assert.equal(decision.reason, "malformed_catalog");
            assert.deepEqual(decision.detail.ids, []);
            observations.push({ name: `shape-${slot}-${order}`, decision: summary(decision) });
        }
    const nonlist = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: JSON.parse(JSON.stringify({ ...page(), histories: { wrong } })) });
    assert.equal(nonlist.kind, "reject");
    assert.equal(nonlist.reason, "malformed_catalog");
    observations.push({ name: "shape-nonlist", decision: summary(nonlist) });
    const forgedOnly = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: page([forged]) });
    assert.equal(forgedOnly.kind, "reject");
    assert.equal(forgedOnly.reason, "invalid_verified_history");
    assert.deepEqual(forgedOnly.detail.ids, []);
    observations.push({ name: "forged-only", decision: summary(forgedOnly) });
    const suffix = bundle.incrementalFrame, deps = [...new Set(suffix.deps)].sort();
    assert.ok(deps.length > 0);
    assert.ok(!first.next.histories.some(h => h.frames.some(f => f.id === suffix.id)));
    assert.ok(deps.every(id => first.next.histories.find(h => h.replica === suffix.replica).frames.some(f => f.id === id)));
    const suffixHistory = { replica: suffix.replica, frames: [suffix], rejected: [] };
    const isolated = await prepareTreehouseCatalogInstallation({ review: bundle.review, history: suffixHistory, store: { kind: "verified_fresh", expected } });
    assert.equal(isolated.kind, "reject");
    assert.equal(isolated.reason, "trust_pending");
    assert.deepEqual(isolated.detail.ids, deps);
    observations.push({ name: "isolated-suffix", decision: summary(isolated) });
    const incremental = await evaluateTreehouseCatalogTrust({ installed: first.next, expected, incoming: page([suffixHistory]) });
    assert.equal(incremental.kind, "propose");
    assert.equal(incremental.reason, null);
    assert.deepEqual(incremental.detail.ids, []);
    assert.deepEqual(incremental.next.accepted, first.next.accepted);
    assert.deepEqual(incremental.next.histories.find(h => h.replica === suffix.replica).frames.find(f => f.id === suffix.id), suffix);
    observations.push({ name: "incremental", decision: summary(incremental) });
    for (const [label, original] of [["accepted", first.next], ["blocked", frozen.next]]) {
        const base = JSON.parse(JSON.stringify(original));
        const before = JSON.stringify(base);
        for (const [name, incoming] of [["reopen", page()], ["older-catalog", { ...page(), catalogs: [bundle.catalogJson] }], ...bundle.cases.map(c => [c.name, page([c.history])])]) {
            const decision = await evaluateTreehouseCatalogTrust({ installed: base, expected, incoming });
            assert.equal(JSON.stringify(base), before, "incoming processing mutated retained input");
            if (name === "reopen") {
                assert.equal(decision.kind, label === "accepted" ? "unchanged" : "retain_blocked");
                assert.equal(decision.reason, label === "accepted" ? null : "catalog_fork");
            }
            if (decision.kind !== "reject") {
                assert.deepEqual(decision.next.accepted, base.accepted, "accepted watermark changed");
                if (base.blocked !== null) {
                    assert.deepEqual(decision.next.blocked, base.blocked);
                    assert.deepEqual(decision.routes, []);
                }
                for (const h of base.histories) {
                    const retained = decision.next.histories.find((n) => n.replica === h.replica);
                    for (const frame of h.frames)
                        assert.deepEqual(retained.frames.find((n) => n.id === frame.id), frame);
                    for (const rejected of h.rejected)
                        assert.ok(retained.rejected.some(n => JSON.stringify(n) === JSON.stringify(rejected)));
                }
                if (name === "reopen")
                    assert.deepEqual(decision.next, base);
            }
            observations.push({ name: `${label}:${name}`, decision: summary(decision) });
        }
        for (const defect of ["signature", "unportable-depth", "watermark"]) {
            const damaged = JSON.parse(before);
            const h = damaged.histories.find(h => h.replica === bundle.review.space);
            if (defect === "signature")
                h.frames = h.frames.map((f, n) => n === 0 ? { ...f, sig: Buffer.alloc(64).toString("base64") } : f);
            else if (defect === "unportable-depth")
                h.frames = [...h.frames, bundle.deepFrame];
            else
                damaged.accepted = { ...damaged.accepted, revision: 0 };
            for (const [name, incoming] of [["repair", page(bundle.histories)], ["malformed", JSON.parse('{"catalogs":[],"rotations":[],"histories":null,"cutoffProofs":[]}')]]) {
                const decision = await evaluateTreehouseCatalogTrust({ installed: damaged, expected, incoming });
                assert.equal(decision.kind, "reject");
                assert.equal(decision.reason, "trust_recovery_required");
                observations.push({ name: `${label}:corrupt-${defect}:${name}`, decision: summary(decision) });
            }
        }
    }
    return observations;
}
const bundle = process.argv[2] === "consume" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : await produce();
console.log(JSON.stringify({ bundle, observations: await run(bundle) }));
