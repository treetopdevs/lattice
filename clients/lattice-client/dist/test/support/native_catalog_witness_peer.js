// Fresh full-input historical-witness observations for the native resolver.
import assert from "node:assert/strict";
import { trustFixture, fixtureSigner, fixtureId } from "./export_treehouse_catalog_trust";
import { authorTreehouseRoleTransfer } from "../../src/treehouse";
import { authorCarrierOp } from "../../src/codec";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
const f = await trustFixture(1);
const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
assert.equal(prepared.kind, "propose");
const accepted = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...empty(), catalogs: [f.catalogJson], histories: f.histories } });
assert.equal(accepted.kind, "propose");
assert.equal(accepted.routes.length, 2);
const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root,
    recipient: fixtureSigner("witness-successor").publicKey, parent: f.space.delegation, action: "transfer_admin" });
const changed = { ...f.histories[0], frames: [...f.space.frames, transfer] };
const freezeInput = { installed: accepted.next, expected, incoming: { ...empty(), histories: [changed] } };
const freeze = await evaluateTreehouseCatalogTrust(freezeInput);
assert.equal(freeze.kind, "retain_blocked");
assert.equal(freeze.reason, "authority_changed");
assert.deepEqual(freeze.routes, []);
assert.equal(freeze.next.blocked.authorityWitnesses.length, 1);
assert.ok(freeze.next.blocked.opIds.includes(f.review.bootstrapId));
const witnesses = structuredClone(freeze.next.blocked.authorityWitnesses);
const beacon = await authorCarrierOp({ replica: f.space.replica, signer: f.root, deps: witnesses[0].frontier,
    kind: "authority", cap: ["nil"], body: ["tuple", [["atom", "beacon"], ["int", 1]]] });
const grownHistory = { ...changed, frames: [...changed.frames, beacon] };
const growInput = { installed: freeze.next, expected, incoming: { ...empty(), histories: [grownHistory] } };
const grown = await evaluateTreehouseCatalogTrust(growInput);
assert.equal(grown.kind, "retain_blocked");
assert.equal(grown.reason, "authority_changed");
assert.deepEqual(grown.next.blocked.authorityWitnesses, witnesses, "first historical frontier must remain fixed");
const inputs = [
    { name: "first-authority-freeze", input: freezeInput, reason: "authority_changed" },
    { name: "frozen-reopen", input: { installed: freeze.next, expected, incoming: empty() }, reason: "authority_changed" },
    { name: "later-history-preserves-first-witness", input: growInput, reason: "authority_changed" },
    { name: "grown-frozen-reopen", input: { installed: grown.next, expected, incoming: empty() }, reason: "authority_changed" },
];
for (const mutation of ["missing", "unknown-frontier", "redundant-frontier", "duplicate-frontier", "wrong-replica", "honored-target", "wrong-index"]) {
    const broken = structuredClone(grown.next), block = broken.blocked, witness = block.authorityWitnesses[0];
    if (mutation === "missing")
        block.authorityWitnesses = [];
    else if (mutation === "unknown-frontier")
        witness.frontier = [fixtureId("absent-witness-frame")];
    else if (mutation === "redundant-frontier")
        witness.frontier = [...witness.frontier, f.space.genesis.id].sort();
    else if (mutation === "duplicate-frontier")
        witness.frontier.push(witness.frontier[0]);
    else if (mutation === "wrong-replica")
        witness.replica = f.threads[0].replica;
    else if (mutation === "honored-target") {
        witness.opIds = [f.space.creation.id];
        block.opIds = [...witness.opIds];
    }
    else
        block.opIds = [fixtureId("unknown-witness-target")];
    inputs.push({ name: `corrupt-${mutation}-before-incoming-repair`, input: { installed: broken, expected, incoming: { ...empty(), histories: grown.next.histories } }, reason: "trust_recovery_required" });
}
const cases = [];
for (const item of inputs) {
    const orders = [];
    for (const reverse of [false, true]) {
        const input = structuredClone(item.input);
        if (reverse)
            input.incoming.histories = [...input.incoming.histories].reverse().map(h => ({ ...h, frames: [...h.frames].reverse(), rejected: [...h.rejected].reverse() }));
        const before = JSON.stringify(input), decision = await evaluateTreehouseCatalogTrust(input);
        assert.equal(JSON.stringify(input), before);
        assert.equal(decision.reason, item.reason, item.name);
        if (item.reason === "trust_recovery_required")
            assert.equal(decision.kind, "reject");
        else {
            assert.equal(decision.kind, "retain_blocked");
            assert.deepEqual(decision.routes, []);
            assert.deepEqual(decision.next.accepted, accepted.next.accepted);
            assert.deepEqual(decision.next.blocked.authorityWitnesses, witnesses);
        }
        orders.push({ input, decision });
    }
    cases.push({ name: item.name, orders });
}
assert.equal(cases.length, 11);
await new Promise(resolve => process.stdout.write(JSON.stringify({ cases }) + "\n", () => resolve()));
