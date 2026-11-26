// Row 336: wire uint64s above 2^53 - 1 in Treehouse Space and Thread command arguments get BEAM's
// Authority reason from the semantic judge, through both src and the committed package entry.
// Frame readers keep refusing them (row 212 fail-closed), and the numeric form refuses everywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as source from "../src/index";
import type { CarrierOpFrame } from "../src/carrier";
import type { TreehouseProduct } from "../src/treehouse";

type Api = typeof source;
interface Case { name: string; product: TreehouseProduct; frame: CarrierOpFrame; reason: string | null }
interface WireCase { name: string; frame: CarrierOpFrame; decode: string }

const vector = JSON.parse(readFileSync(new URL("./vectors/treehouse_command/high_integer_v1.json", import.meta.url), "utf8")) as {
  space: { frames: CarrierOpFrame[] }; thread: { frames: CarrierOpFrame[] }; cases: Case[]; good: CarrierOpFrame; wireCases: WireCase[];
};
const history = (product: TreehouseProduct) => product === "Treehouse.Space" ? vector.space.frames : vector.thread.frames;
const high = vector.cases.filter((c) => c.name.endsWith("-high"));

// The specifier is a runtime string so tsc, which also builds this file into dist, never needs dist to exist.
const packageEntry = "../dist/src/index.js";
const runtimes: [string, () => Promise<Api>][] = [["src", async () => source], ["dist", async () => await import(packageEntry) as Api]];

for (const [label, load] of runtimes) {
  test(`${label}: every Space and Thread case gets BEAM's reason from the Treehouse judge`, async () => {
    const api = await load();
    assert.ok(high.length >= 20);
    for (const product of ["Treehouse.Space", "Treehouse.Thread"] as const) {
      assert.equal(api.observeTreehouse(product, api.carrierOpsToSemanticOps(history(product), {}, api.treehouseCommandDecoders(product))).quarantineReasons.size, 0);
    }
    for (const c of vector.cases) {
      const ops = api.carrierOpsToSemanticOps([...history(c.product), c.frame], {}, api.treehouseCommandDecoders(c.product));
      assert.equal(api.observeTreehouse(c.product, ops).quarantineReasons.get(c.frame.id) ?? null, c.reason, c.name);
    }
  });

  test(`${label}: frame readers refuse every high case and return safe controls unchanged`, async () => {
    const api = await load();
    for (const c of vector.cases) {
      if (c.name.endsWith("-high")) assert.throws(() => api.decodeCarrierOpFrame(c.frame), /malformed carrier op/, c.name);
      else assert.deepEqual(api.decodeCarrierOpFrame(c.frame), c.frame, c.name);
    }
  });

  test(`${label}: without an injected decoder map high cases stay malformed_term`, async () => {
    const api = await load();
    for (const c of high) {
      const op = api.carrierOpToSemanticOp(c.frame);
      assert.equal(op.structuralError, "malformed_term", c.name);
      assert.equal(op.command, "malformed_term", c.name);
    }
  });

  test(`${label}: numeric and non-canonical integer forms refuse with and without decoders`, async () => {
    const api = await load();
    assert.deepEqual(api.decodeCarrierOpFrame(vector.good), vector.good);
    assert.equal(vector.wireCases.length, 5);
    for (const c of vector.wireCases) {
      assert.equal(c.decode, "malformed_op");
      assert.throws(() => api.decodeCarrierOpFrame(c.frame), /malformed carrier op/, c.name);
      for (const decoders of [undefined, api.treehouseCommandDecoders("Treehouse.Space")]) {
        assert.equal(api.carrierOpToSemanticOp(c.frame, {}, decoders).structuralError, "malformed_term", c.name);
      }
    }
  });
}
