import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority, canonicalOrder, carrierOpsToSemanticOps, index, materialize, treehouseCommandDecoders, treehouseSpaceSchema, verifyCarrierOp, } from "../../src/index";
const expected = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const frame of expected.frames) {
    const result = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
    assert.equal(result.valid, true, `signed frame ${frame.id}`);
}
for (const frames of [expected.frames, [...expected.frames].reverse()]) {
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const byId = index(ops);
    const authority = analyzeAuthority(treehouseSpaceSchema, ops, new Set(byId.keys()), canonicalOrder(ops, byId), byId);
    const result = materialize(treehouseSpaceSchema, ops);
    assert.equal(result.state.name, expected.name);
    assert.deepEqual(result.state.threads, expected.threads);
    assert.equal(result.state.admin_actions, expected.adminAction);
    assert.deepEqual(Object.fromEntries(result.quarantineReasons), expected.reasons);
    const acquisition = authority.acquiresByRole.get("admin").at(-1);
    assert.equal(acquisition.opId, expected.acquisition);
    assert.equal(acquisition.holderPubkey, expected.holder);
    assert.equal(ops.length, frames.length, "ordered effects retain one signed DAG node");
}
console.log("TREEHOUSE_CONTINUATION_PRODUCT_OK");
