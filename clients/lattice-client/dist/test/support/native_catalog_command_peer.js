/** Executable command-gate fixtures; no saved decision or private application key. */
import assert from "node:assert/strict";
import { fixtureId, fixtureSigner, trustFixture } from "./export_treehouse_catalog_trust";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../../src/codec";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../../src/carrier";
import { analyzeAuthority } from "../../src/authority";
import { isQuarantined } from "../../src/quarantine";
import { gatedBy } from "../../src/schema";
import { canonicalOrder, index } from "../../src/dag";
import { treehouseCommandDecoders, treehouseThreadSchema, treehouseSpaceSchema } from "../../src/treehouse";
import { bindTownshipReplica } from "../../src/township";
import { ed25519 } from "@noble/curves/ed25519.js";
import { reviewContinuationFromFrames, assembleContinuationFromFrames } from "../../src/continuation_authoring";
import { canonicalBytesForContinuationClaim, continuationCertificateToCarrierTerm } from "../../src/continuation";
const atom = (name) => ["atom", name];
const text = (value) => ["bin", Buffer.from(value).toString("base64")];
const body = (name, args) => ["tuple", [atom(name), ["list", args]]];
const b64 = (key) => Buffer.from(key).toString("base64");
export async function commandCases() {
    const cases = [];
    for (const kind of ["space", "thread"]) {
        const root = fixtureSigner(`native-command-root-${kind}`), member = fixtureSigner(`native-command-member-${kind}`);
        const replica = await bindTownshipReplica(`replica:treehouse:${kind}:${fixtureId(`native-command-${kind}`)}#authority:bounded-continuation-v1`, root.publicKey);
        const product = kind === "space" ? "Treehouse.Space" : "Treehouse.Thread";
        const names = [...treehouseCommandDecoders(product).keys()];
        const roles = kind === "space" ? ["admin", "moderator"] : ["moderator"];
        const cap = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, ops: names, roles, live: true });
        const genesis = await authorCarrierOp({ replica, signer: root, deps: [], kind: "authority", cap: ["nil"], body: ["tuple", [atom("genesis"), ["delegation", cap], ["map", []]]] });
        const command = (signer, deps, capId, name, args) => authorCarrierOp({ replica, signer, deps, kind: "command", body: body(name, args), cap: capId === null ? ["nil"] : text(capId) });
        const add = (name, frames) => cases.push({ name: `${kind}:${name}`, replica, frames });
        const commonName = kind === "space" ? "create_space" : "post";
        for (const [name, capId, args] of [["no-cap", null, [text("text")]], ["missing-cap", "absent", [text("text")]], ["bad-arity", null, []], ["bad-argument", null, [["int", 7]]]]) {
            add(name, [genesis, await command(root, [genesis.id], capId, commonName, [...args])]);
        }
        add("wrong-product-command", [genesis, await command(root, [genesis.id], cap.id, kind === "space" ? "post" : "create_space", [text("wrong product")])]);
        add("wrong-audience", [genesis, await command(member, [genesis.id], cap.id, commonName, [text("wrong audience")])]);
        const lease = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, parentId: cap.id, ops: names, roles: [], live: false, expiresEpoch: 0 });
        const grant = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", lease]]] });
        const argsFor = (name) => {
            switch (name) {
                case "create_space":
                case "create_thread": return kind === "space" && name === "create_thread" ? [text("thread-reference"), text("title")] : [text("title")];
                case "issue_invitation": return [text(b64(member.publicKey)), ["list", []]];
                case "revoke_invitation": return [text("invitation")];
                case "admit_member": return [text("invitation"), text(b64(member.publicKey)), text("member"), text("signature")];
                case "remove_member": return [text(b64(member.publicKey))];
                case "catalog_bootstrap_v1": return [["nil"]];
                case "attest_member_key_v1": return [["nil"], ["nil"], ["nil"]];
                case "post": return [text("post")];
                case "archive_thread": return [];
                default: return [];
            }
        };
        for (const name of names.filter(n => !["author_edit", "author_tombstone"].includes(n))) {
            const args = name === "moderator_tombstone" ? [text("post"), text("post")] : argsFor(name);
            add(`effect-roles-${name}`, [genesis, grant, await command(root, [grant.id], lease.id, name, args)]);
        }
        const invalid = { ...lease, sig: Buffer.alloc(64).toString("base64") };
        const badGrant = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", invalid]]] });
        add("invalid-delegation-signature", [genesis, badGrant, await command(root, [badGrant.id], lease.id, commonName, [text("bad signature")])]);
        for (const [label, scope, parent] of [["wrong-replica", "other-replica", cap.id], ["invalid-parent", replica, "withheld-parent"]]) {
            const d = await authorCarrierDelegation({ replica: scope, signer: root, audiencePubkey: root.publicKey, parentId: parent, ops: names, roles, live: false });
            const g = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", d]]] });
            add(label, [genesis, g, await command(root, [g.id], d.id, commonName, [text(label)])]);
        }
        const broad = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, parentId: cap.id, ops: names, roles, live: false });
        const broadGrant = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", broad]]] });
        add("grant-not-visible", [genesis, broadGrant, await command(root, [genesis.id], broad.id, commonName, [text("not visible")])]);
        const empty = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, parentId: cap.id, ops: [], roles, live: false });
        const emptyGrant = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", empty]]] });
        add("scope-before-visibility", [genesis, emptyGrant, await command(root, [genesis.id], empty.id, commonName, [text("not granted")])]);
        const memberCap = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: member.publicKey, parentId: cap.id, ops: names, roles, live: false });
        const memberGrant = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("grant"), ["delegation", memberCap]]] });
        const gated = kind === "space" ? "create_space" : "archive_thread";
        add("not-holder", [genesis, memberGrant, await command(member, [memberGrant.id], memberCap.id, gated, argsFor(gated))]);
        const moved = await authorCarrierOp({ replica, signer: root, deps: [memberGrant.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("transfer"), atom(roles[0]), ["delegation", memberCap], ["int", 1]]] });
        const concurrent = await command(root, [memberGrant.id], cap.id, gated, argsFor(gated));
        add("concurrent-holder-change", [genesis, memberGrant, moved, concurrent]);
        const before = await command(root, [memberGrant.id], cap.id, gated, argsFor(gated));
        const afterMove = await authorCarrierOp({ replica, signer: root, deps: [before.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("transfer"), atom(roles[0]), ["delegation", memberCap], ["int", 1]]] });
        add("earlier-holder-command-survives", [genesis, memberGrant, before, afterMove]);
        if (kind === "thread") {
            const early = await command(root, [grant.id], lease.id, "post", [text("early")]);
            const beacon = await authorCarrierOp({ replica, signer: root, deps: [early.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("beacon"), ["int", 1]]] });
            const late = await command(root, [beacon.id], lease.id, "post", [text("late")]);
            add("causal-expiry", [genesis, grant, early, beacon, late]);
            add("concurrent-expiry", [genesis, grant, beacon, early, await command(root, [grant.id], lease.id, "post", [text("concurrent")])]);
            const revoke = await authorCarrierOp({ replica, signer: root, deps: [beacon.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("revoke"), text(lease.id)]] });
            add("revocation-before-expiry", [genesis, grant, early, beacon, revoke, await command(root, [revoke.id], lease.id, "post", [text("revoked and expired")])]);
            const goodPost = await command(root, [genesis.id], cap.id, "post", [text("lineage")]);
            for (const name of ["author_edit", "author_tombstone"]) {
                add(`role-free-${name}`, [genesis, goodPost, await command(root, [goodPost.id], cap.id, name, [text(goodPost.id), text(goodPost.id), ...(name === "author_edit" ? [text("edited")] : [])])]);
            }
        }
    }
    const f = await trustFixture(), t = f.threads[0], nominee = fixtureSigner("nominee");
    const beacon = await authorCarrierOp({ replica: t.replica, signer: t.signer, deps: [t.pin.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("beacon"), ["int", 0]]] });
    const prior = [...t.frames, beacon];
    const delegation = await authorCarrierDelegation({ replica: t.replica, signer: nominee, audiencePubkey: nominee.publicKey, ops: ["post"], roles: ["moderator"], live: false, expiresEpoch: 6 });
    const review = await reviewContinuationFromFrames({ schema: treehouseThreadSchema, replica: t.replica, frames: prior, role: "moderator", author: b64(nominee.publicKey), deps: [beacon.id], delegation });
    assert.equal(review.ok, true, JSON.stringify(review));
    const bytes = canonicalBytesForContinuationClaim(review.review.claim);
    const witnesses = ["w1", "w2", "w3"].map(fixtureSigner).sort((a, b) => Buffer.compare(a.publicKey, b.publicKey)).slice(0, 2);
    const certificate = { claim: review.review.claim, signatures: await Promise.all(witnesses.map(async (w) => ({ witness: b64(w.publicKey), signature: b64(await w.sign(bytes)) }))) };
    const assembled = await assembleContinuationFromFrames({ schema: treehouseThreadSchema, frames: prior, review: review.review, certificate, signer: nominee });
    assert.equal(assembled.ok, true, JSON.stringify(assembled));
    for (const visible of [false, true]) {
        const post = await authorCarrierOp({ replica: t.replica, signer: nominee, deps: [visible ? assembled.frame.id : beacon.id], kind: "command", cap: text(delegation.id), body: body("post", [text("candidate")]) });
        cases.push({ name: `thread:candidate-${visible ? "activated" : "not-visible"}`, replica: t.replica, frames: [...prior, assembled.frame, post] });
    }
    const bad = await authorCarrierOp({ replica: t.replica, signer: nominee, deps: [beacon.id], kind: "authority", cap: ["nil"], body: ["tuple", [atom("succeed"), atom("moderator"), ["delegation", delegation], ["tuple", [atom("continuation_v1"), continuationCertificateToCarrierTerm({ ...certificate, signatures: certificate.signatures.slice(0, 1) })]]]] });
    const post = await authorCarrierOp({ replica: t.replica, signer: nominee, deps: [bad.id], kind: "command", cap: text(delegation.id), body: body("post", [text("unactivated")]) });
    cases.push({ name: "thread:refused-candidate-confers-no-capability", replica: t.replica, frames: [...prior, bad, post] });
    return cases;
}
export async function judgeCommands(history) {
    for (const raw of history.frames) {
        const frame = decodeCarrierOpFrame(raw);
        assert.equal((await verifyCarrierOp(frame, { verify: async (pub, b, s) => ed25519.verify(s, b, Buffer.from(pub, "base64"), { zip215: false }) })).valid, true);
    }
    const schema = history.replica.startsWith("replica:treehouse:space:") ? treehouseSpaceSchema : treehouseThreadSchema;
    const ops = carrierOpsToSemanticOps(history.frames, {}, treehouseCommandDecoders(schema.name));
    const by = index(ops), order = canonicalOrder(ops, by);
    const authority = analyzeAuthority(schema, ops, new Set(order), order, by, history.replica);
    return Object.fromEntries(ops.filter(op => op.kind === "command").map(op => {
        const result = isQuarantined(op, schema, by, authority);
        return [op.id, { reason: result.quarantined ? result.reason : null, fields: op.effects?.map(e => e.field) ?? null,
                roles: op.effects === undefined ? null : [...new Set(op.effects.map(e => gatedBy(schema, e.field)).filter(r => r !== null))] }];
    }));
}
