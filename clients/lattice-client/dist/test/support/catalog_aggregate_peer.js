import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture } from "./export_treehouse_catalog_trust";
import { authorCarrierOpUnchecked } from "./unchecked_author";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const expected = { trustRevision: 0, historyGeneration: 0 };
function strings(value) {
    if (typeof value === "string")
        return Buffer.byteLength(value);
    if (Array.isArray(value))
        return value.reduce((n, v) => n + strings(v), 0);
    if (value !== null && typeof value === "object")
        return Object.entries(value).reduce((n, [k, v]) => n + Buffer.byteLength(k) + strings(v), 0);
    return 0;
}
const page = (history) => ({ catalogs: [], rotations: [], histories: [history], cutoffProofs: [] });
async function produce(pageMode) {
    const f = await trustFixture(0), baseline = f.histories[0];
    const author = (text, deps) => authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps, kind: "command", body: ["atom", text], cap: ["nil"] });
    const deps = [baseline.frames.at(-1).id];
    const a = await author("", deps), b = await author("", []);
    const empty = { ...baseline, frames: [...baseline.frames, a, b] };
    const available = 64 * 1024 * 1024 - strings(pageMode ? page(empty) : [empty]);
    const left = "q".repeat(Math.floor(available / 2)), right = "q".repeat(Math.ceil(available / 2));
    const at = { ...baseline, frames: [...baseline.frames, await author(left, deps), await author(right, [])] };
    return { review: f.review, baseline, at, overFrame: await author(right + "z", []), cutoff: f.cutoffProofs[0].cutoff };
}
async function run(bundle, pageMode) {
    const { review, baseline, at, overFrame, cutoff } = bundle;
    const over = { ...at, frames: [...at.frames.slice(0, -1), overFrame] };
    const context = (history) => pageMode ? page(history) : [history];
    assert.equal(strings(context(at)), 64 * 1024 * 1024);
    assert.equal(strings(context(over)), 64 * 1024 * 1024 + 1);
    const forged = { ...at, frames: at.frames.map((v, n) => n === baseline.frames.length ? { ...v, sig: Buffer.alloc(64).toString("base64") } : v) };
    const installed = await prepareTreehouseCatalogInstallation({ review, history: baseline, store: { kind: "verified_fresh", expected } });
    assert.equal(installed.kind, "propose");
    for (const [name, history, reason] of [["at", at, "unsupported_cutoff"], ["over", over, "invalid_verified_history"], ["forged", forged, "invalid_verified_history"]]) {
        const prepare = await prepareTreehouseCatalogInstallation({ review, history, store: { kind: "verified_fresh", expected } });
        const evaluate = await evaluateTreehouseCatalogTrust({ installed: installed.next, expected, incoming: page(history) });
        const prepareReason = name === "over" && pageMode ? "unsupported_cutoff" : reason;
        const evaluateReason = name === "at" && !pageMode ? "invalid_verified_history" : reason;
        for (const [d, wanted] of [[prepare, prepareReason], [evaluate, evaluateReason]]) {
            assert.equal(d.kind, "reject");
            assert.equal(d.reason, wanted);
            assert.deepEqual(d.detail.ids, []);
        }
    }
    const proof = { cutoff, history: baseline };
    for (const incoming of [
        { ...page(at), cutoffProofs: [proof] },
        { ...page(baseline), cutoffProofs: [{ cutoff, history: at }] }
    ]) {
        const decision = await evaluateTreehouseCatalogTrust({ installed: installed.next, expected, incoming });
        assert.equal(decision.kind, "reject");
        assert.equal(decision.reason, "invalid_verified_history");
        assert.deepEqual(decision.detail.ids, []);
    }
    const corrupt = { ...installed.next, cutoffProofs: [{ cutoff, history: at }] };
    const recovered = await evaluateTreehouseCatalogTrust({ installed: corrupt, expected, incoming: page(baseline) });
    assert.equal(recovered.kind, "reject");
    assert.equal(recovered.reason, "trust_recovery_required");
}
const consuming = process.argv[2] === "consume", pageMode = process.argv[consuming ? 4 : 2] === "page";
const bundle = consuming ? JSON.parse(readFileSync(process.argv[3], "utf8")) : await produce(pageMode);
await run(bundle, pageMode);
console.log(JSON.stringify(consuming ? { checked: true } : bundle));
