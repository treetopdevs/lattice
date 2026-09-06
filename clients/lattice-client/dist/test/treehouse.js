import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorTownshipGenesis, authorTreehouseCommand, carrierOpsToSemanticOps, materialize, treehouseCommandDecoders, treehouseThreadSchema, treehouseSpaceSchema, acceptTreehouseInvitation, authorCarrierOp, analyzeAuthority, canonicalOrder, index, canonicalBytesForCarrierOp, prepareTreehouseSpaceCreation, authorTreehouseRoleTransfer, treehouseSpaceInitialization, } from "../src/index";
const privateSeed = createHash("sha256").update("treehouse-ts:root").digest();
const signer = { publicKey: ed25519.getPublicKey(privateSeed), sign: (bytes) => ed25519.sign(bytes, privateSeed) };
const preparation = await prepareTreehouseSpaceCreation({ replica: "treehouse:ts:creation", name: "Canopy", signer });
assert.equal(preparation.status, "uninitialized");
assert.equal(preparation.profile, "legacy_root_only");
const [creationGenesis, creationName] = preparation.pending;
assert.deepEqual(creationName.deps, [creationGenesis.id]);
const retry = await prepareTreehouseSpaceCreation({ replica: preparation.replica, name: "Canopy", signer, retained: [creationGenesis] });
assert.equal(retry.status, "incomplete");
assert.deepEqual(retry.pending, [creationName]);
const creationReady = await prepareTreehouseSpaceCreation({ replica: preparation.replica, name: "Canopy", signer, retained: preparation.pending });
assert.equal(creationReady.status, "ready");
assert.deepEqual(creationReady.pending, []);
await assert.rejects(() => prepareTreehouseSpaceCreation({ replica: preparation.replica, name: "Other", signer, retained: preparation.pending }), /different_initialization/);
await assert.rejects(() => prepareTreehouseSpaceCreation({ replica: preparation.replica, name: "Canopy", signer, retained: [{ ...creationGenesis, sig: Buffer.alloc(64).toString("base64") }] }), /invalid_retained_frame/);
console.log("PASS root-only preparation retains incomplete initialization and exact signed retry");
const genesis = await authorTownshipGenesis({ replica: "treehouse:ts:thread", signer,
    ops: ["create_thread", "post", "author_edit", "author_tombstone", "moderator_tombstone", "archive_thread"], roles: ["moderator"] });
// Read the authenticated delegation through the public carrier extractor below
// once its frame has been authored; the command frame remains the real seam.
const { carrierDelegationsFromFrames } = await import("../src/index");
const capId = carrierDelegationsFromFrames([genesis])[0].id;
const post = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: genesis.replica, deps: [genesis.id], signer, capId, command: { command: "post", text: "original" } });
const edit = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: genesis.replica, deps: [post.id], signer, capId, command: { command: "author_edit", postId: post.id, targetId: post.id, text: "edited" } });
const archive = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: genesis.replica, deps: [edit.id], signer, capId, command: { command: "archive_thread" } });
const late = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: genesis.replica, deps: [archive.id], signer, capId, command: { command: "post", text: "late" } });
const tombstone = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: genesis.replica, deps: [late.id], signer, capId, command: { command: "moderator_tombstone", postId: post.id, targetId: edit.id } });
const decode = (frames) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
assert.deepEqual(materialize(treehouseThreadSchema, decode([genesis, post, edit])).state.posts, ["edited"]);
const result = materialize(treehouseThreadSchema, decode([genesis, post, edit, archive, late, tombstone]));
assert.deepEqual(result.state.posts, []);
assert.equal(result.state.archived, true);
assert.equal(result.quarantineReasons.get(late.id), "application_archived_thread");
assert.equal(result.quarantineReasons.has(tombstone.id), false);
assert.equal(decode([tombstone])[0].effects.length, 2);
console.log("PASS Treehouse public signed Thread authoring, lineage, archive and atomic moderator tombstone");
const spaceGenesis = await authorTownshipGenesis({ replica: "treehouse:ts:space", signer,
    ops: ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"], roles: ["admin", "moderator"] });
const spaceOps = carrierOpsToSemanticOps([spaceGenesis], {}, treehouseCommandDecoders("Treehouse.Space"));
const spaceState = materialize(treehouseSpaceSchema, spaceOps).state;
assert.equal(spaceState.admin, spaceOps[0].author);
assert.equal(spaceState.moderator, spaceOps[0].author);
assert.equal(spaceOps.length, 1);
console.log("PASS one signed Space genesis initializes both role holders");
const spaceIndex = index(spaceOps);
const holders = analyzeAuthority(treehouseSpaceSchema, spaceOps, new Set(spaceOps.map((op) => op.id)), canonicalOrder(spaceOps, spaceIndex), spaceIndex);
assert.equal(holders.acquiresByRole.get("admin").at(-1).holder, spaceOps[0].author);
assert.equal(holders.acquiresByRole.get("moderator").at(-1).holder, spaceOps[0].author);
const repeatedEdit = decode([genesis, post, edit]);
repeatedEdit[2].effects = [
    { field: "posts", mutation: "edit", value: { target: post.id, value: "z" } },
    { field: "posts", mutation: "edit", value: { target: post.id, value: "a" } },
];
assert.deepEqual(materialize(treehouseThreadSchema, repeatedEdit).state.posts, ["a"]);
console.log("PASS ordered same-target edit effects choose the last text");
const aliceSeed = createHash("sha256").update("treehouse-ts:alice").digest();
const aliceSigner = { publicKey: ed25519.getPublicKey(aliceSeed), sign: (bytes) => ed25519.sign(bytes, aliceSeed) };
const alice = Buffer.from(aliceSigner.publicKey).toString("base64");
const roleParent = carrierDelegationsFromFrames([spaceGenesis])[0];
const modTransfer = await authorTreehouseRoleTransfer({ replica: spaceGenesis.replica, deps: [spaceGenesis.id], signer, parent: roleParent, recipient: alice, action: "change_moderator" });
const roleDecode = (frames) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
const modState = materialize(treehouseSpaceSchema, roleDecode([spaceGenesis, modTransfer.frame]));
assert.equal(modState.state.moderator, roleDecode([modTransfer.frame])[0].value);
assert.equal(modState.state.admin, spaceOps[0].author);
const adminTransfer = await authorTreehouseRoleTransfer({ replica: spaceGenesis.replica, deps: [modTransfer.frame.id], signer, parent: roleParent, recipient: alice, action: "transfer_admin" });
const transferred = [spaceGenesis, modTransfer.frame, adminTransfer.frame];
const transferredState = materialize(treehouseSpaceSchema, roleDecode(transferred));
assert.equal(transferredState.state.admin, transferredState.state.moderator);
const staleTransfer = await authorTreehouseRoleTransfer({ replica: spaceGenesis.replica, deps: [adminTransfer.frame.id], signer, parent: roleParent, recipient: signer.publicKey, action: "change_moderator" });
const currentTransfer = await authorTreehouseRoleTransfer({ replica: spaceGenesis.replica, deps: [adminTransfer.frame.id], signer: aliceSigner, parent: modTransfer.delegation, recipient: signer.publicKey, action: "change_moderator" });
const currentState = materialize(treehouseSpaceSchema, roleDecode([...transferred, staleTransfer.frame, currentTransfer.frame]));
assert.equal(currentState.quarantineReasons.get(staleTransfer.frame.id), "transfer_not_holder");
assert.equal(currentState.quarantineReasons.has(currentTransfer.frame.id), false);
assert.equal(currentState.state.moderator, spaceOps[0].author);
assert.equal(currentState.state.moderator_actions, null);
assert.equal(roleDecode(transferred).length, 3);
assert.equal(treehouseSpaceInitialization(roleDecode(preparation.pending)), "ready");
console.log("PASS actual independent role transfers, stale holder refusal and one signed node per action");
const spaceCap = carrierDelegationsFromFrames([spaceGenesis])[0].id;
const child = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [spaceGenesis.id], signer, capId: spaceCap, command: { command: "create_thread", title: "One", threadReplica: "thread:one" } });
const invite = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [child.id], signer, capId: spaceCap, command: { command: "issue_invitation", recipient: alice, threads: ["thread:one"] } });
const decodeSpace = (frames) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
const acceptance = await acceptTreehouseInvitation(spaceGenesis.replica, decodeSpace([invite])[0], aliceSigner);
const admit = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [invite.id], signer, capId: spaceCap, command: { command: "admit_member", invitationId: invite.id, recipient: alice, level: "member", acceptance } });
assert.deepEqual(materialize(treehouseSpaceSchema, decodeSpace([spaceGenesis, child, invite, admit])).state.members, [alice]);
const rebound = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [invite.id], signer, capId: spaceCap, command: { command: "admit_member", invitationId: invite.id, recipient: Buffer.from(signer.publicKey).toString("base64"), level: "member", acceptance } });
const reboundResult = materialize(treehouseSpaceSchema, decodeSpace([spaceGenesis, child, invite, rebound]));
assert.deepEqual(reboundResult.state.members, []);
assert.equal(reboundResult.quarantineReasons.get(rebound.id), "application_invalid_invitation");
console.log("PASS recipient-signed Space admission and rebinding refusal");
for (const [command, args] of [
    ["create_space", [["map", []]]],
    ["create_thread", [["nil"], ["int", 42]]],
    ["create_thread", [["bin", ""], ["bin", "dGl0bGU="]]],
    ["remove_member", [["bin", "YmFkLWtleQ=="]]],
]) {
    const bad = await authorCarrierOp({ replica: spaceGenesis.replica, deps: [spaceGenesis.id], signer, kind: "command",
        body: ["tuple", [["atom", command], ["list", args]]], cap: ["bin", Buffer.from(spaceCap).toString("base64")] });
    const result = materialize(treehouseSpaceSchema, decodeSpace([spaceGenesis, bad]));
    assert.equal(result.quarantineReasons.get(bad.id), "malformed_command");
    assert.deepEqual(result.state.threads, []);
    assert.deepEqual(result.state.members, []);
}
console.log("PASS malformed Space command values apply no effects");
function commandFromOp(op, product) {
    const args = op.commandArgs;
    switch (op.command) {
        case "create_space": return { command: op.command, name: args[0] };
        case "create_thread": return product === "Treehouse.Space"
            ? { command: op.command, threadReplica: args[0], title: args[1] }
            : { command: op.command, title: args[0] };
        case "issue_invitation": return { command: op.command, recipient: args[0], threads: op.commandArgs[1] };
        case "revoke_invitation": return { command: op.command, invitationId: args[0] };
        case "admit_member": return { command: op.command, invitationId: args[0], recipient: args[1], level: args[2], acceptance: args[3] };
        case "remove_member": return { command: op.command, recipient: args[0] };
        case "post": return { command: op.command, text: args[0] };
        case "author_edit": return { command: op.command, postId: args[0], targetId: args[1], text: args[2] };
        case "author_tombstone":
        case "moderator_tombstone": return { command: op.command, postId: args[0], targetId: args[1] };
        case "archive_thread": return { command: op.command };
        default: throw new Error("unexpected Treehouse fixture command");
    }
}
const vectorDir = join(dirname(fileURLToPath(import.meta.url)), "vectors");
const reciprocal = {};
for (const name of readdirSync(vectorDir).filter((name) => name.startsWith("treehouse_") && name.endsWith(".json"))) {
    const vector = JSON.parse(readFileSync(join(vectorDir, name), "utf8"));
    const seed = vector.scenario === "treehouse_space_membership" ? "treehouse-membership" : vector.scenario === "treehouse_space_roles" ? "treehouse-space:roles" : `treehouse-thread:${vector.scenario.replace("treehouse_thread_", "")}`;
    const authored = [];
    for (const original of vector.oracleCarrierOps) {
        const realm = vector.realmByPubkey[original.author];
        const secret = createHash("sha256").update(`${seed}:${realm}`).digest();
        const signer = { publicKey: ed25519.getPublicKey(secret), sign: (bytes) => ed25519.sign(bytes, secret) };
        assert.equal(Buffer.from(signer.publicKey).toString("base64"), original.author);
        const semantic = carrierOpsToSemanticOps([original], vector.realmByPubkey, treehouseCommandDecoders(vector.schema.name))[0];
        const result = semantic.kind === "command" && semantic.commandError === undefined
            ? await authorTreehouseCommand({ product: vector.schema.name, replica: original.replica, deps: original.deps, signer, capId: semantic.cap ?? null, command: commandFromOp(semantic, vector.schema.name) })
            : await authorCarrierOp({ replica: original.replica, deps: original.deps, signer, kind: original.kind, body: original.body, cap: original.cap });
        assert.equal(result.id, original.id);
        assert.equal(result.sig, original.sig);
        assert.equal(Buffer.from(canonicalBytesForCarrierOp(result)).toString("hex"), vector.canonicalOps.find((entry) => entry.id === original.id).bytesHex);
        authored.push(result);
    }
    reciprocal[vector.scenario] = authored;
    console.log(`PASS reciprocal Treehouse command bytes and signatures: ${vector.scenario} (${authored.length} frames)`);
}
if (process.env.TREEHOUSE_TS_FRAMES !== undefined)
    writeFileSync(process.env.TREEHOUSE_TS_FRAMES, JSON.stringify(reciprocal));
assert.throws(() => materialize(treehouseThreadSchema, carrierOpsToSemanticOps([genesis, post])), /decoder product/i);
assert.throws(() => materialize(treehouseSpaceSchema, decode([genesis, post])), /decoder product/i);
console.log("PASS Treehouse refuses default or mismatched product decoding");
const atomic = materialize({ name: "AtomicFixture", fields: { title: { merge: "lww", default: "" }, items: { merge: "causal_list" } } }, [{
        id: "atomic", deps: [], kind: "command", author: "root", hash: "atomic", field: "title", mutation: "write", value: "partial",
        effects: [{ field: "title", mutation: "write", value: "partial" }, { field: "constructor", mutation: "append", value: "unknown" }],
    }]);
assert.equal(atomic.quarantineReasons.get("atomic"), "malformed_command");
assert.equal(atomic.state.title, "");
console.log("PASS inherited field names cannot leak partial command effects");
const unicodeScope = ["thread:\uE000", "thread:\u{10000}"];
const unicodeA = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [spaceGenesis.id], signer, capId: spaceCap, command: { command: "create_thread", title: "BMP", threadReplica: unicodeScope[0] } });
const unicodeB = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [unicodeA.id], signer, capId: spaceCap, command: { command: "create_thread", title: "supplementary", threadReplica: unicodeScope[1] } });
const unicodeInvite = await authorTreehouseCommand({ product: "Treehouse.Space", replica: spaceGenesis.replica, deps: [unicodeB.id], signer, capId: spaceCap, command: { command: "issue_invitation", recipient: alice, threads: unicodeScope } });
const unicodeResult = materialize(treehouseSpaceSchema, decodeSpace([spaceGenesis, unicodeA, unicodeB, unicodeInvite]));
assert.equal(unicodeResult.quarantineReasons.has(unicodeInvite.id), false);
assert.deepEqual(unicodeResult.state.threads.map((reference) => reference.replica), unicodeScope);
console.log("PASS Unicode Thread references follow BEAM byte order in scopes and state");
