import assert from "node:assert/strict";
import { fixtureId, fixtureSigner } from "./export_treehouse_catalog_trust";
import { authorCarrierDelegation, authorCarrierOp } from "../../src/codec";
import { carrierOpsToSemanticOps } from "../../src/carrier";
import { treehouseCommandDecoders, treehouseThreadSchema } from "../../src/treehouse";
import { materialize } from "../../src/materialize";
import { bindTownshipReplica } from "../../src/township";
import { readFileSync } from "node:fs";
import { decodeCarrierOpFrame } from "../../src/carrier";
import { verifyCarrierOp } from "../../src/codec";
import { ed25519 } from "@noble/curves/ed25519.js";
if (process.argv[2] === "--consume") {
    const input = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const results = [];
    for (const h of input.histories) {
        const ids = new Set(h.frames.map(f => f.id));
        assert.equal(ids.size, h.frames.length);
        for (const raw of h.frames) {
            const f = decodeCarrierOpFrame(raw);
            assert.equal(f.replica, h.replica);
            assert.ok(f.deps.every(id => ids.has(id)));
            assert.equal((await verifyCarrierOp(f, { verify: async (key, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(key, "base64"), { zip215: false }) })).valid, true);
        }
        const ops = carrierOpsToSemanticOps(h.frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
        const result = materialize(treehouseThreadSchema, ops);
        results.push(Object.fromEntries(ops.filter(o => o.kind === "command").map(o => [o.id, result.quarantineReasons.get(o.id) ?? null])));
    }
    console.log(JSON.stringify({ results }));
    process.exit(0);
}
const signer = fixtureSigner("malformed-thread-lineage");
const replica = await bindTownshipReplica(`replica:treehouse:thread:${fixtureId("malformed-thread-lineage")}#authority:bounded-continuation-v1`, signer.publicKey);
const text = (v) => ["bin", Buffer.from(v).toString("base64")];
const cap = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey, ops: ["post", "author_edit", "author_tombstone", "moderator_tombstone"], roles: ["moderator"], live: true });
const genesis = await authorCarrierOp({ replica, signer, deps: [], kind: "authority", cap: ["nil"], body: ["tuple", [["atom", "genesis"], ["delegation", cap], ["map", []]]] });
const command = (deps, name, args) => authorCarrierOp({ replica, signer, deps, kind: "command", cap: text(cap.id), body: ["tuple", [["atom", name], ["list", args]]] });
const post = await command([genesis.id], "post", [text("original")]);
const cases = [];
for (const name of ["author_edit", "author_tombstone", "moderator_tombstone"]) {
    for (const position of [0, 1]) {
        const args = [text(post.id), text(post.id), ...(name === "author_edit" ? [text("valid text")] : [])];
        args[position] = ["bin", Buffer.from([255]).toString("base64")];
        const malformed = await command([post.id], name, args);
        const frames = [genesis, post, malformed];
        const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
        const result = materialize(treehouseThreadSchema, ops);
        assert.equal(result.quarantineReasons.get(malformed.id), "malformed_command");
        cases.push({ name: `invalid-utf8-${name}-${position}`, replica, frames, reasons: Object.fromEntries(ops.filter(o => o.kind === "command").map(o => [o.id, result.quarantineReasons.get(o.id) ?? null])) });
    }
}
for (const [label, value] of [["integer", ["int", 7]], ["nil", ["nil"]], ["list", ["list", []]]]) {
    for (const predecessor of [post.id, "absent"]) {
        const malformed = await command([post.id], "author_edit", [text(post.id), text(predecessor), value]);
        for (const name of ["author_edit", "author_tombstone"]) {
            const descendant = await command([malformed.id], name, [text(post.id), text(malformed.id), ...(name === "author_edit" ? [text("descendant")] : [])]);
            const frames = [genesis, post, malformed, descendant];
            const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
            const projection = materialize(treehouseThreadSchema, ops);
            assert.equal(projection.quarantineReasons.get(malformed.id), "malformed_command");
            assert.equal(projection.quarantineReasons.get(descendant.id), "application_target_quarantined");
            cases.push({ name: `${label}-${predecessor === post.id ? "visible" : "absent"}-${name}`, replica, frames, reasons: Object.fromEntries(ops.filter(o => o.kind === "command").map(o => [o.id, projection.quarantineReasons.get(o.id) ?? null])) });
        }
    }
}
const edit = await command([post.id], "author_edit", [text(post.id), text(post.id), text("valid")]);
const later = await command([edit.id], "author_edit", [text(post.id), text(edit.id), text("latest")]);
const missing = await command([post.id], "author_edit", [text(post.id), text("absent"), text("well formed")]);
const followsMissing = await command([missing.id], "author_edit", [text(post.id), text(missing.id), text("still follows valid syntax")]);
const concurrent = await command([post.id], "author_edit", [text(post.id), text(edit.id), text("concurrent predecessor")]);
for (const [name, frames] of [["valid-lineage", [genesis, post, edit, later]], ["valid-syntax-missing-target", [genesis, post, missing]], ["quarantined-valid-syntax-still-traverses", [genesis, post, missing, followsMissing]], ["concurrent-target", [genesis, post, edit, concurrent]]]) {
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
    const result = materialize(treehouseThreadSchema, ops);
    if (name === "valid-lineage")
        assert.equal(result.quarantineReasons.size, 0);
    if (name === "quarantined-valid-syntax-still-traverses")
        assert.equal(result.quarantineReasons.get(followsMissing.id), "application_target_not_visible");
    if (name === "concurrent-target")
        assert.equal(result.quarantineReasons.get(concurrent.id), "application_target_not_visible");
    cases.push({ name, replica, frames, reasons: Object.fromEntries(ops.filter(o => o.kind === "command").map(o => [o.id, result.quarantineReasons.get(o.id) ?? null])) });
}
console.log(JSON.stringify({ cases }));
