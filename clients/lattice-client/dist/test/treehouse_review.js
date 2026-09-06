import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority, authorTownshipGenesis, authorTreehouseCommand, canonicalOrder, carrierDelegationsFromFrames, carrierOpsToSemanticOps, index, materialize, treehouseCommandDecoders, treehouseSpaceSchema, verifyCarrierOp, } from "../src/index";
const seed = new Uint8Array(32).fill(73);
const signer = { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
const genesis = await authorTownshipGenesis({ replica: "treehouse:review:space", signer,
    ops: ["create_thread"], roles: ["admin", "moderator"] });
const decode = (frames) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
if (process.env.TREEHOUSE_REVIEW_CASE !== "map") {
    const duplicate = structuredClone(genesis);
    if (duplicate.body[0] !== "tuple" || duplicate.body[1][1]?.[0] !== "delegation")
        throw new Error("genesis shape");
    duplicate.body[1][1][1].roles = ["admin", "admin", "moderator"];
    const verified = await verifyCarrierOp(duplicate, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
    assert.equal(verified.valid, true, "flat role arrays have canonical set semantics");
    const ops = decode([duplicate]);
    const byId = index(ops);
    const result = analyzeAuthority(treehouseSpaceSchema, ops, new Set([genesis.id]), canonicalOrder(ops, byId), byId);
    assert.equal(result.acquiresByRole.get("admin").length, 1, "one acquisition per original genesis role");
    assert.equal(result.quarantineReasons.size, 0);
    assert.deepEqual(materialize(treehouseSpaceSchema, ops).state, materialize(treehouseSpaceSchema, decode([genesis])).state);
    console.log("PASS authenticated duplicate flat roles retain exactly one acquisition per role");
}
if (process.env.TREEHOUSE_REVIEW_CASE !== "roles") {
    const capId = carrierDelegationsFromFrames([genesis])[0].id;
    const titles = ["One more", "One", 'One"', "One/", "One\\", "One]", "One\u{10000}", "One\uE000"];
    const frames = [genesis];
    for (const title of titles)
        frames.push(await authorTreehouseCommand({ product: "Treehouse.Space", replica: genesis.replica,
            signer, deps: [frames.at(-1).id], capId, command: { command: "create_thread", threadReplica: "same-replica", title } }));
    const expected = ["One", "One more", 'One"', "One/", "One\\", "One]", "One\uE000", "One\u{10000}"];
    for (const delivery of [frames, [...frames].reverse()]) {
        const view = materialize(treehouseSpaceSchema, decode(delivery));
        assert.deepEqual(view.state.threads.map((entry) => entry.title), expected);
        assert.equal(view.quarantineReasons.size, 0);
    }
    console.log("PASS signed Thread maps use Erlang binary prefix/escape/Unicode order");
}
