import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { authorCarrierOp, canonicalBytesForCarrierOp, canonicalBytesForCarrierTerm, canonicalHash } from "../src/codec";
import { decodeCarrierOpFrame } from "../src/carrier";
import { cutoffFixture } from "./support/export_treehouse_catalog_cutoff";
// Integrator-adopted cutoff-only scope, 2026-09-06: raw authenticated history,
// separately validated bad_signature evidence, 64 generic composites, exact
// uint64 tagged decimals, actual {type:"push",ops:[frame]} <=64,000 bytes, and
// fixed130 atom vocabulary (artifact SHA256 a66d085dd185091d745d933c3145101a97b3306406aba905af07ca051d09506c).
// No semantic decoding, generic ingress changes, persistence or trust promotion.
const module = await import("../src/index").catch(() => null);
const bin = (value) => ["bin", Buffer.from(value).toString("base64")];
test("public cutoff commits exact authenticated payloads including a semantic refusal and uint64 legacy epoch", async () => {
    const f = await cutoffFixture();
    assert.ok(module, "raw authenticated cutoff observation is not implemented");
    const result = await module.deriveTreehouseCatalogCutoff({ replica: f.replica, frames: f.frames, rejected: [] });
    const records = [...f.frames];
    // IDs use unsigned UTF8 ordering, independently from JSON object presentation.
    records.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    const ops = records.map((frame) => ({ id: frame.id, bytes: canonicalBytesForCarrierOp(frame), sig: new Uint8Array(Buffer.from(frame.sig, "base64")) }));
    const terms = ops.map((op) => ["map", [
            [["atom", "id"], bin(op.id)], [["atom", "bytes"], bin(op.bytes)], [["atom", "sig"], bin(op.sig)],
        ]]);
    const bytes = canonicalBytesForCarrierTerm(["list", [bin("lattice-treehouse-recovery-cutoff-v1"), bin(f.replica), ["list", terms], ["list", []]]]);
    assert.deepEqual(result, { ok: true, cutoff: { replica: f.replica, frontier: [f.genuine.id], logDigest: await canonicalHash(bytes) },
        canonicalBytes: bytes, ops, rejected: [] });
});
const derive = (input) => {
    assert.ok(module);
    return module.deriveTreehouseCatalogCutoff(input);
};
const invalid = { ok: false, reason: "invalid_verified_history" };
const unsupported = { ok: false, reason: "unsupported_cutoff" };
test("rejected evidence and the genuine same-ID op remain separate, ordered and byte exact", async () => {
    const f = await cutoffFixture();
    const rejected = [{ frame: f.forged, reason: "bad_signature" }, { frame: f.supplied, reason: "bad_signature" }];
    const result = await derive({ replica: f.replica, frames: f.frames, rejected });
    assert.equal(result.ok, true);
    assert.equal(result.ops.length, f.frames.length);
    assert.deepEqual(result.cutoff.frontier, [f.genuine.id]);
    assert.deepEqual(result.rejected.map((op) => ({ ...op, bytes: Buffer.from(op.bytes).toString("base64"), sig: Buffer.from(op.sig).toString("base64") })), [...rejected].sort((a, b) => Buffer.compare(Buffer.from(a.frame.id), Buffer.from(b.frame.id))).map(({ frame }) => ({
        id: frame.id, bytes: Buffer.from(canonicalBytesForCarrierOp(frame)).toString("base64"), sig: frame.sig, reason: "bad_signature",
    })));
    assert.deepEqual(await derive({ replica: f.replica, frames: [...f.frames].reverse(), rejected: [...rejected].reverse() }), result);
    const without = await derive({ replica: f.replica, frames: f.frames, rejected: [] });
    assert.equal(without.ok, true);
    assert.notEqual(result.cutoff.logDigest, without.cutoff.logDigest);
    const mutable = structuredClone({ replica: f.replica, frames: f.frames, rejected });
    const pending = derive(mutable);
    mutable.frames[0].sig = "";
    mutable.rejected.length = 0;
    assert.deepEqual(await pending, result);
});
test("accepted corruption, missing closure and malformed rejection claims refuse without repairs", async () => {
    const f = await cutoffFixture();
    for (const frames of [f.frames.slice(1), [...f.frames, f.frames[0]], [f.forged, ...f.frames.slice(0, -1)],
        [{ ...f.genesis, id: "wrong-id" }, ...f.frames.slice(1)], [{ ...f.genesis, deps: [1] }, ...f.frames.slice(1)],
        [{ ...f.genesis, replica: "wrong-replica" }, ...f.frames.slice(1)], [null]]) {
        const before = structuredClone(frames);
        assert.deepEqual(await derive({ replica: f.replica, frames, rejected: [] }), invalid);
        assert.deepEqual(frames, before);
    }
    for (const rejected of [[{ frame: f.genuine, reason: "bad_signature" }], [{ frame: f.forged, reason: "other" }], [{}],
        [{ frame: f.forged, reason: "bad_signature" }, { frame: f.forged, reason: "bad_signature" }]]) {
        assert.deepEqual(await derive({ replica: f.replica, frames: f.frames, rejected }), invalid);
    }
    assert.deepEqual(await derive({ replica: f.replica, frames: [f.genuine], rejected: [{ frame: f.high, reason: "bad_signature" }] }), invalid, "rejected evidence cannot close accepted dependencies");
});
test("raw cutoff keeps exact generic uint64 terms without routing through semantic decoding", async () => {
    const f = await cutoffFixture();
    const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [f.genuine.id], kind: "command", cap: ["nil"],
        body: ["map", [[["atom", "epoch"], ["int", "9007199254740993"]], [["atom", "version"], ["int", "18446744073709551615"]]]] });
    assert.throws(() => decodeCarrierOpFrame(frame), /malformed/);
    const result = await derive({ replica: f.replica, frames: [...f.frames, frame], rejected: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ops.find((op) => op.id === frame.id).bytes, canonicalBytesForCarrierOp(frame));
});
test("all fixed vocabulary names are shared with the durable fixture and accepted as raw evidence", async () => {
    const names = JSON.parse(readFileSync(new URL("./vectors/catalog/cutoff_atoms_v1.json", import.meta.url), "utf8"));
    const source = readFileSync(new URL("../src/treehouse_catalog_cutoff.ts", import.meta.url), "utf8");
    const literal = source.match(/const atoms = new Set\((\[[\s\S]*?\])\);/)?.[1];
    assert.ok(literal);
    assert.deepEqual(JSON.parse(literal), names);
    const f = await cutoffFixture();
    const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"],
        body: ["list", names.map((name) => ["atom", name])] });
    assert.equal((await derive({ replica: f.replica, frames: [frame], rejected: [] })).ok, true);
});
test("unknown authentic vocabulary is unsupported, while verifiable forgery keeps invalid-history precedence", async () => {
    const f = await cutoffFixture();
    const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: ["atom", "cutoff_unknown_evidence_v99"] });
    assert.deepEqual(await derive({ replica: f.replica, frames: [frame], rejected: [] }), unsupported);
    assert.deepEqual(await derive({ replica: f.replica, frames: [{ ...frame, sig: "" }], rejected: [] }), invalid);
    assert.deepEqual(await derive({ replica: f.replica, frames: [], rejected: [{ frame, reason: "bad_signature" }] }), invalid);
    assert.deepEqual(await derive({ replica: f.replica, frames: [], rejected: [{ frame: { ...frame, sig: "" }, reason: "bad_signature" }] }), unsupported);
    assert.deepEqual(await derive({ replica: f.replica, frames: [frame, { ...f.genesis, sig: "" }], rejected: [] }), invalid);
});
test("broad rejected headers and unrepresentable delegation leases refuse without dropping evidence", async () => {
    const f = await cutoffFixture();
    const shortAuthor = { ...f.forged, author: Buffer.alloc(31).toString("base64") };
    assert.deepEqual(await derive({ replica: f.replica, frames: f.frames, rejected: [{ frame: shortAuthor, reason: "bad_signature" }] }), unsupported);
    assert.deepEqual(await derive({ replica: f.replica, frames: [shortAuthor], rejected: [] }), invalid);
    const wide = structuredClone(f.genesis);
    assert.equal(wide.body[0], "tuple");
    if (wide.body[0] !== "tuple")
        throw new Error("fixture body");
    const delegation = wide.body[1][1];
    assert.equal(delegation[0], "delegation");
    if (delegation[0] !== "delegation")
        throw new Error("fixture delegation");
    delegation[1].expires_epoch = 9_007_199_254_740_992;
    assert.deepEqual(await derive({ replica: f.replica, frames: [wide], rejected: [] }), unsupported);
    assert.deepEqual(await derive({ replica: f.replica, frames: [], rejected: [{ frame: { ...f.forged, body: ["unsupported", []] }, reason: "bad_signature" }] }), unsupported);
});
async function sizedFrame(size) {
    const f = await cutoffFixture();
    for (let padding = 0; padding < 4; padding++) {
        const replica = "treehouse:cutoff:size" + "x".repeat(padding);
        const empty = await authorCarrierOp({ replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: ["bin", ""] });
        const overhead = Buffer.byteLength(JSON.stringify({ type: "push", ops: [empty] }));
        if ((size - overhead) % 4 !== 0)
            continue;
        return authorCarrierOp({ replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: bin(new Uint8Array((size - overhead) / 4 * 3)) });
    }
    throw new Error("could not construct exact size fixture");
}
test("actual single-push envelope allows exactly64000 bytes and refuses64001 without hiding forged input", async () => {
    for (const size of [64_000, 64_001]) {
        const frame = await sizedFrame(size);
        assert.equal(Buffer.byteLength(JSON.stringify({ type: "push", ops: [frame] })), size);
        const result = await derive({ replica: frame.replica, frames: [frame], rejected: [] });
        if (size === 64_000)
            assert.equal(result.ok, true);
        else
            assert.deepEqual(result, unsupported);
        assert.deepEqual(await derive({ replica: frame.replica, frames: [{ ...frame, sig: Buffer.alloc(64).toString("base64") }], rejected: [] }), invalid);
    }
});
test("generic composite depth64 remains portable and depth65 refuses explicitly", async () => {
    const f = await cutoffFixture();
    for (const depth of [64, 65]) {
        let body = ["nil"];
        for (let i = 0; i < depth; i++)
            body = ["list", [body]];
        const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body });
        const result = await derive({ replica: f.replica, frames: [frame], rejected: [] });
        if (depth === 64)
            assert.equal(result.ok, true);
        else
            assert.deepEqual(result, unsupported);
    }
});
test("wrong supplied ID is retained as bad_signature evidence even with an otherwise valid signature", async () => {
    const f = await cutoffFixture();
    const rejected = { ...f.genuine, id: "untrusted supplied id" };
    const result = await derive({ replica: f.replica, frames: f.frames, rejected: [{ frame: rejected, reason: "bad_signature" }] });
    assert.equal(result.ok, true);
    assert.equal(result.rejected[0].id, rejected.id);
    assert.equal(Buffer.from(result.rejected[0].sig).toString("base64"), f.genuine.sig);
    assert.deepEqual(result.rejected[0].bytes, canonicalBytesForCarrierOp(f.genuine));
});
test("cutoff rejects malformed raw scalar tags even when a permissive caller signed their canonical interpretation", async () => {
    const f = await cutoffFixture();
    for (const body of [["bool", "true"], ["nil", "extra"]]) {
        const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: body });
        assert.deepEqual(await derive({ replica: f.replica, frames: [frame], rejected: [] }), invalid);
    }
});
test("the existing signed dependency set normalization remains exact without changing raw frontier", async () => {
    const f = await cutoffFixture();
    const repeated = { ...f.name, deps: [f.genesis.id, f.genesis.id] };
    const original = await derive({ replica: f.replica, frames: [f.genesis, f.name], rejected: [] });
    assert.deepEqual(await derive({ replica: f.replica, frames: [repeated, f.genesis], rejected: [] }), original);
    assert.deepEqual(repeated.deps, [f.genesis.id, f.genesis.id], "observation never repairs retained input");
});
test("a representable authenticated kind outside the four wire kinds is unsupported rather than forged", async () => {
    const f = await cutoffFixture();
    const frame = await authorCarrierOp({ replica: f.replica, signer: f.signer, deps: [], kind: "request", cap: ["nil"], body: ["nil"] });
    assert.deepEqual(await derive({ replica: f.replica, frames: [frame], rejected: [] }), unsupported);
    assert.deepEqual(await derive({ replica: f.replica, frames: [{ ...frame, sig: "" }], rejected: [] }), invalid);
});
