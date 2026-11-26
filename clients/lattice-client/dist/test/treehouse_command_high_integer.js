// Row 336: wire uint64s above 2^53 - 1 in Treehouse Space and Thread command arguments get BEAM's
// Authority reason from the semantic judge, through both src and the committed package entry.
// Frame admission accepts them in every command's arguments, as BEAM Wire.decode_ops does, so an
// authenticated history holding one quarantines only that op; the numeric form refuses everywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as source from "../src/index";
const vector = JSON.parse(readFileSync(new URL("./vectors/treehouse_command/high_integer_v1.json", import.meta.url), "utf8"));
const history = (product) => product === "Treehouse.Space" ? vector.space.frames : vector.thread.frames;
const high = vector.cases.filter((c) => c.name.endsWith("-high"));
// The specifier is a runtime string so tsc, which also builds this file into dist, never needs dist to exist.
const packageEntry = "../dist/src/index.js";
const runtimes = [["src", async () => source], ["dist", async () => await import(packageEntry)]];
for (const [label, load] of runtimes) {
    test(`${label}: every Space and Thread case gets BEAM's reason from the Treehouse judge`, async () => {
        const api = await load();
        assert.ok(high.length >= 20);
        for (const product of ["Treehouse.Space", "Treehouse.Thread"]) {
            assert.equal(api.observeTreehouse(product, api.carrierOpsToSemanticOps(history(product), {}, api.treehouseCommandDecoders(product))).quarantineReasons.size, 0);
        }
        for (const c of vector.cases) {
            const ops = api.carrierOpsToSemanticOps([...history(c.product), c.frame], {}, api.treehouseCommandDecoders(c.product));
            assert.equal(api.observeTreehouse(c.product, ops).quarantineReasons.get(c.frame.id) ?? null, c.reason, c.name);
        }
    });
    test(`${label}: frame readers return every case frame unchanged, high or safe`, async () => {
        const api = await load();
        for (const c of vector.cases)
            assert.deepEqual(api.decodeCarrierOpFrame(c.frame), c.frame, c.name);
    });
    test(`${label}: authenticated Space entry points quarantine only the case op, as BEAM observe does`, async () => {
        const api = await load();
        const space = vector.cases.filter((c) => c.product === "Treehouse.Space");
        assert.ok(space.some((c) => c.name === "attest-claim-epoch-high") && space.some((c) => c.name === "replace_catalog_v1-high"));
        for (const c of space) {
            const frames = [...vector.space.frames, c.frame];
            const observed = await api.observeMemberContinuityFromFrames({ replica: vector.space.replica, frames });
            assert.equal(observed.ok, true, c.name);
            if (!observed.ok)
                continue;
            assert.equal(observed.quarantine.find((item) => item.opId === c.frame.id)?.reason ?? null, c.reason, c.name);
            assert.equal((await api.treehouseCatalogBootstrapsFromFrames({ replica: vector.space.replica, frames })).ok, true, c.name);
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
