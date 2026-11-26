// TS twin of apps/lattice_core/test/treehouse/catalog_replacement_claim_test.exs (plan 316 PR 1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalBytesForCatalogInventory, canonicalBytesForCatalogReplacementClaim, canonicalBytesForCatalogReplacementPossession, canonicalBytesForCatalogRotationPossession, catalogEntryFromCarrierTerm, catalogInventoryId, catalogReplacementClaimFromCarrierTerm, catalogReplacementClaimFromDecodedTerm, catalogReplacementClaimToCarrierTerm, normalizeCatalogReplacementClaim, normalizeCatalogRotation, verifyCatalogReplacementPossession, } from "../src/treehouse_catalog_codec";
import { deriveTreehouseCatalogCutoff } from "../src/treehouse_catalog_cutoff";
import { replacementBaseFixture, replacementHistory } from "./support/export_treehouse_catalog_replacement";
const vector = JSON.parse(readFileSync(new URL("./vectors/catalog/replacement_v1.json", import.meta.url), "utf8"));
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const id = (label) => createHash("sha256").update(`r316-claim-${label}`).digest("base64url");
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const history = await replacementHistory(await replacementBaseFixture());
const claim = history.claim;
const ok = (value) => assert.deepEqual(normalizeCatalogReplacementClaim(value), value);
const malformed = (value, message = "malformed") => assert.equal(normalizeCatalogReplacementClaim(value), null, message);
function rotation() {
    return { version: 1, product: "treehouse", space: claim.space, bootstrap: claim.bootstrap, parent: claim.bootstrap, priorCatalog: id("prior"),
        generation: 1, newCatalogKey: claim.newCatalogKey, nonce: claim.nonce, inventoryDigest: claim.inventoryDigest, cutoffs: claim.cutoffs };
}
test("closed field set", () => {
    ok(claim);
    for (const key of Object.keys(claim)) {
        const copy = { ...claim };
        delete copy[key];
        malformed(copy, `missing ${key}`);
    }
    malformed({ ...claim, extra: 1 });
    malformed({ ...claim, binding: claim.bootstrap });
    malformed({ ...claim, version: 2 });
    malformed({ ...claim, product: "township" });
    malformed({ ...claim, space: "" });
    malformed({ ...claim, bootstrap: "short" });
    assert.notEqual(normalizeCatalogRotation(rotation()), null);
    malformed(rotation());
    assert.equal(normalizeCatalogRotation(claim), null);
});
test("parents sorted, distinct, nonempty", () => {
    const ids = Array.from({ length: 17 }, (_, i) => id(`parent-${i + 1}`)).sort();
    const sole = (parents) => [...new Set(parents)].map((binding) => ({ binding, catalog: null }));
    const two = ids.slice(0, 2);
    ok({ ...claim, parents: two, priorCatalogs: sole(two) });
    ok({ ...claim, parents: ids.slice(0, 16), priorCatalogs: sole(ids.slice(0, 16)) });
    for (const parents of [[...two].reverse(), [two[0], two[0]], [], ids])
        malformed({ ...claim, parents, priorCatalogs: sole(parents) });
    malformed({ ...claim, parents: ["not-an-id"] });
});
test("prior_catalogs", () => {
    const [a, b] = [id("binding-a"), id("binding-b")].sort();
    const [c1, c2] = [id("catalog-1"), id("catalog-2")].sort();
    const withPrior = (priorCatalogs) => ({ ...claim, parents: [a, b], priorCatalogs });
    ok(withPrior([{ binding: a, catalog: c1 }, { binding: b, catalog: null }]));
    ok(withPrior([{ binding: a, catalog: c1 }, { binding: a, catalog: c2 }, { binding: b, catalog: c1 }]));
    malformed(withPrior([{ binding: b, catalog: null }, { binding: a, catalog: c1 }]));
    malformed(withPrior([{ binding: a, catalog: c2 }, { binding: a, catalog: c1 }, { binding: b, catalog: null }]));
    malformed(withPrior([{ binding: a, catalog: c1 }, { binding: a, catalog: c1 }, { binding: b, catalog: null }]));
    malformed(withPrior([{ binding: a, catalog: c1 }]));
    malformed({ ...claim, priorCatalogs: [{ binding: a, catalog: null }] });
    malformed(withPrior([{ binding: a, catalog: null }, { binding: a, catalog: c1 }, { binding: b, catalog: null }]));
    malformed(withPrior([{ binding: a, catalog: c1 }, { binding: a, catalog: null }, { binding: b, catalog: null }]));
    ok(withPrior([{ binding: a, catalog: null }, { binding: b, catalog: null }]));
    malformed(withPrior([{ binding: a, catalog: c1, extra: 1 }, { binding: b, catalog: null }]));
    malformed(withPrior([{ binding: a, catalog: "bad" }, { binding: b, catalog: null }]));
    malformed(withPrior([]));
    const many = Array.from({ length: 33 }, (_, i) => id(`catalog-many-${i + 1}`)).sort();
    malformed({ ...claim, priorCatalogs: many.map((catalog) => ({ binding: claim.bootstrap, catalog })) });
    ok({ ...claim, priorCatalogs: many.slice(0, 32).map((catalog) => ({ binding: claim.bootstrap, catalog })) });
});
test("generation safe positive integer", () => {
    for (const generation of [0, -1, MAX_SAFE + 1, 1.5])
        malformed({ ...claim, generation });
    ok({ ...claim, generation: 1 });
    ok({ ...claim, generation: MAX_SAFE });
});
test("keys and origin", () => {
    malformed({ ...claim, newServiceKey: claim.newCatalogKey });
    malformed({ ...claim, newCatalogKey: b64(new Uint8Array(31)) });
    malformed({ ...claim, newServiceKey: b64(new Uint8Array(31)) });
    malformed({ ...claim, author: b64(new Uint8Array(31)) });
    for (const newOrigin of ["ws://relay.invalid", "wss://relay.invalid:443", "wss://10.0.0.1", "wss://Relay.invalid"])
        malformed({ ...claim, newOrigin });
    malformed({ ...claim, newServiceId: "short" });
    malformed({ ...claim, cap: null });
    malformed({ ...claim, deps: [] });
    malformed({ ...claim, deps: [id("d1"), id("d2")].sort().reverse() });
    malformed({ ...claim, epochBasis: [] });
    malformed({ ...claim, epoch: -1 });
    ok({ ...claim, epoch: 0 });
    malformed({ ...claim, cutoffs: [] });
});
test("possession under the new keys", () => {
    const cp = history.catalogPossession, sp = history.servicePossession;
    assert.equal(verifyCatalogReplacementPossession(claim, cp, sp), true);
    assert.equal(verifyCatalogReplacementPossession(claim, sp, cp), false);
    const serviceAsCatalog = b64(history.newCatalog.sign(canonicalBytesForCatalogReplacementPossession("service", claim)));
    assert.equal(verifyCatalogReplacementPossession(claim, serviceAsCatalog, sp), false);
    const changes = [{ generation: 2 }, { nonce: id("other-nonce") }, { newOrigin: "wss://other.invalid" },
        { epoch: 2 }, { holderEpoch: claim.bootstrap }, { newServiceId: id("other-service") }];
    for (const change of changes)
        assert.equal(verifyCatalogReplacementPossession({ ...claim, ...change }, cp, sp), false, JSON.stringify(change));
    assert.equal(verifyCatalogReplacementPossession(claim, null, sp), false);
    assert.equal(verifyCatalogReplacementPossession({ ...claim, extra: 1 }, cp, sp), false);
    assert.throws(() => canonicalBytesForCatalogReplacementPossession("binding", claim));
});
test("rotation and replacement possession bytes refuse each other", () => {
    assert.throws(() => canonicalBytesForCatalogRotationPossession(claim));
    assert.throws(() => canonicalBytesForCatalogReplacementPossession("catalog", rotation()));
    assert.throws(() => canonicalBytesForCatalogReplacementClaim(rotation()));
});
test("decoded command arguments never throw and preserve the carrier meaning", () => {
    const term = catalogReplacementClaimToCarrierTerm(claim);
    for (const value of [null, 1, { type: "tuple", values: [] }, { type: "map", pairs: [[null]] }, { type: "list" }, "text"]) {
        assert.equal(catalogReplacementClaimFromDecodedTerm(value), null);
    }
    assert.deepEqual(catalogReplacementClaimFromCarrierTerm(term), claim);
});
test("BEAM-written replacement_v1.json reads byte-identically and verifies", () => {
    const beam = catalogReplacementClaimFromCarrierTerm(vector.claim_term);
    assert.ok(beam);
    assert.equal(b64(canonicalBytesForCatalogReplacementClaim(beam)), vector.claim_bytes);
    assert.equal(b64(canonicalBytesForCatalogReplacementPossession("catalog", beam)), vector.catalog_possession_bytes);
    assert.equal(b64(canonicalBytesForCatalogReplacementPossession("service", beam)), vector.service_possession_bytes);
    assert.equal(beam.newCatalogKey, vector.catalog_key);
    assert.equal(beam.newServiceKey, vector.service_key);
    assert.equal(verifyCatalogReplacementPossession(beam, vector.catalog_possession, vector.service_possession), true);
    const entries = vector.inventory_term[1].map((entry) => catalogEntryFromCarrierTerm(entry));
    assert.ok(entries.every((entry) => entry !== null));
    assert.equal(b64(canonicalBytesForCatalogInventory(entries)), vector.inventory_bytes);
    assert.equal(catalogInventoryId(entries), vector.inventory_id);
    assert.equal(beam.inventoryDigest, vector.inventory_id);
    assert.equal(vector.frames.at(-1).id, vector.binding_id);
    for (const negative of vector.negative) {
        if (negative.result === "malformed_catalog")
            assert.equal(catalogReplacementClaimFromCarrierTerm(negative.claim_term), null, negative.name);
        else {
            const decoded = catalogReplacementClaimFromCarrierTerm(negative.claim_term);
            assert.ok(decoded, negative.name);
            assert.equal(verifyCatalogReplacementPossession(decoded, negative.catalog_possession, negative.service_possession), false, negative.name);
        }
    }
});
test("BEAM cutoff pre-hash bytes with bad-signature rejected evidence re-derive in TS", async () => {
    const cutoff = vector.cutoff;
    const frames = vector.frames.filter((frame) => frame.id !== vector.binding_id);
    const result = await deriveTreehouseCatalogCutoff({ replica: cutoff.replica, frames, rejected: cutoff.rejected_frames });
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.ok(result.rejected.length > 0);
    assert.equal(b64(result.canonicalBytes), cutoff.canonical_bytes);
    assert.equal(result.cutoff.logDigest, cutoff.log_digest);
    assert.deepEqual(result.cutoff.frontier, cutoff.frontier);
    assert.deepEqual(result.ops.map((op) => ({ id: op.id, bytes: b64(op.bytes), sig: b64(op.sig) })), cutoff.ops);
    assert.deepEqual(result.rejected.map((op) => ({ id: op.id, bytes: b64(op.bytes), sig: b64(op.sig), reason: op.reason })), cutoff.rejected);
    const beam = catalogReplacementClaimFromCarrierTerm(vector.claim_term);
    assert.deepEqual(beam.cutoffs, [result.cutoff]);
});
