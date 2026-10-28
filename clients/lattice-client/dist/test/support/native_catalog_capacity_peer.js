// Fresh maximum-size source values; files keep large evidence out of the IPC response.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { produce, check } from "./catalog_valid_capacity_fixture";
function digest(value) {
    const hash = createHash("sha256");
    const walk = (v) => {
        if (Array.isArray(v)) {
            hash.update("[");
            v.forEach((x, i) => { if (i)
                hash.update(","); walk(x); });
            hash.update("]");
        }
        else if (v !== null && typeof v === "object") {
            hash.update("{");
            Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).forEach((k, i) => { if (i)
                hash.update(","); hash.update(JSON.stringify(k) + ":"); walk(v[k]); });
            hash.update("}");
        }
        else {
            if (typeof v === "number")
                assert.ok(Number.isSafeInteger(v), "capacity digest fixture uses safe integers only");
            hash.update(JSON.stringify(v));
        }
    };
    walk(value);
    return hash.digest("base64url");
}
const { directory, frozen = false } = JSON.parse(readFileSync(0, "utf8"));
assert.equal(typeof frozen, "boolean");
assert.equal(typeof directory, "string");
async function wireBundle() {
    const produced = await produce(frozen), sourcePath = join(directory, "source.json");
    // Preserve failed inputs too; no manifest is emitted until every check passes.
    writeFileSync(sourcePath, JSON.stringify(produced), { flag: "wx" });
    const decoded = JSON.parse(readFileSync(sourcePath, "utf8"));
    assert.deepEqual(decoded, produced, "capacity fixture must be a lossless JSON value");
    return decoded;
}
// All source decisions use the same wire values consumed by the other peers.
const bundle = await wireBundle();
const cases = [];
const results = await check(bundle, (name, decision) => cases.push({ name, kind: decision.kind, reason: decision.reason, decisionSha256: digest(decision) })).catch(error => {
    // Native callers remove their temporary directory on panic. Keep failed inputs
    // outside that directory so a fresh-peer failure remains independently replayable.
    const retained = mkdtempSync(join(tmpdir(), "treehouse-capacity-failure-"));
    const sourcePath = join(retained, "source.json");
    copyFileSync(join(directory, "source.json"), sourcePath);
    writeFileSync(join(retained, "decisions.json"), JSON.stringify(cases), { flag: "wx" });
    console.error(JSON.stringify({ capacityFailureSource: sourcePath, sourceSha256: createHash("sha256").update(readFileSync(sourcePath)).digest("hex") }));
    throw error;
});
const path = join(directory, "capacity.json");
const encoded = JSON.stringify({ ...bundle, initial: results.initial.next, blockedAt: results.blockedAt, blockedOver: results.blockedOver });
const wire = JSON.parse(encoded);
assert.deepEqual(wire.initial, results.initial.next);
assert.deepEqual(wire.blockedAt, results.blockedAt);
assert.deepEqual(wire.blockedOver, results.blockedOver);
for (const [key, value] of Object.entries(bundle))
    assert.deepEqual(wire[key], value);
writeFileSync(path, encoded, { flag: "wx" });
const bundleSha256 = createHash("sha256").update(encoded).digest("hex");
console.log(JSON.stringify({ path, bundleSha256, frozen, frameCount: bundle.frameCount, cases }));
