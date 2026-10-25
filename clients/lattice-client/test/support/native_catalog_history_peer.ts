import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture } from "./export_treehouse_catalog_trust";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../../src/carrier";
import { verifyCarrierOp } from "../../src/codec";
import { canonicalBase64Bytes } from "../../src/codec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalOrder } from "../../src/dag";
import { treehouseCommandDecoders } from "../../src/treehouse";

interface History { replica: string; frames: unknown[]; order?: string[]; frontier?: string[]; }
async function graph(history: History) {
  for (const frame of history.frames) {
    const result = await verifyCarrierOp(decodeCarrierOpFrame(frame), {verify: async (key, bytes, signature) =>
      ed25519.verify(signature, bytes, canonicalBase64Bytes(key, 32)!, {zip215: false})});
    assert.equal(result.valid, true);
  }
  const product = history.replica.startsWith("replica:treehouse:space:") ? "Treehouse.Space" : "Treehouse.Thread";
  const ops = carrierOpsToSemanticOps(history.frames, {}, treehouseCommandDecoders(product));
  const ids = new Set(ops.map(op => op.id));
  assert.equal(ids.size, history.frames.length);
  assert.ok(ops.every(op => op.replica === history.replica && op.deps.every(id => ids.has(id))));
  const referenced = new Set(ops.flatMap(op => op.deps));
  const order = canonicalOrder(ops);
  assert.equal(order.length, ops.length);
  return {replica: history.replica, frames: history.frames, order,
    frontier: [...ids].filter(id => !referenced.has(id)).sort()};
}
if (process.argv[2] === "produce") {
  const fixture = await trustFixture();
  console.log(JSON.stringify({histories: await Promise.all(fixture.histories.map(graph))}));
} else if (process.argv[2] === "consume") {
  const input = JSON.parse(readFileSync(0, "utf8")) as {histories: History[]};
  for (const history of input.histories) {
    const actual = await graph(history);
    assert.deepEqual(history.order, actual.order);
    assert.deepEqual(history.frontier, actual.frontier);
  }
  console.log(JSON.stringify({histories: input.histories.length}));
} else throw new Error("expected produce or consume");
