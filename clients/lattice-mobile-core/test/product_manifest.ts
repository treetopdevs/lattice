import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allProductManifests,
  assertUniqueProductManifests,
  productAcceptsScheme,
  productForDeepLink,
  productManifestFor,
  type ProductManifest,
} from "../src/product_manifest";

console.log("\n▸ Product isolation manifest (plan 158 collision contract)");

// ── The table matches the normative products.json byte-for-byte ─────────────
const normative = JSON.parse(
  readFileSync(fileURLToPath(new URL("../products.json", import.meta.url)), "utf-8"),
) as { products: ProductManifest[] };
assert.deepEqual(
  allProductManifests(),
  normative.products,
  "the TypeScript manifest table must match products.json exactly",
);

// ── All three products exist with the exact plan-158 identifiers ────────────
const township = productManifestFor("township");
assert.equal(township.appId, "dev.treetop.lattice.township");
assert.equal(township.deepLinkScheme, "township");
assert.equal(township.keyService, "dev.treetop.lattice.township.carrier");
assert.equal(township.databaseFile, "township-v1.sqlite3");
assert.equal(township.androidSigningAlias, "township-pilot-v1");

const toolshed = productManifestFor("toolshed");
assert.equal(toolshed.appId, "dev.treetop.lattice.toolshed");
assert.equal(toolshed.deepLinkScheme, "toolshed");
assert.equal(toolshed.keyService, "dev.treetop.lattice.toolshed.carrier");
assert.equal(toolshed.databaseFile, "toolshed-v1.sqlite3");
assert.equal(toolshed.androidSigningAlias, "toolshed-pilot-v1");

const treehouse = productManifestFor("treehouse");
assert.equal(treehouse.appId, "dev.treetop.lattice.treehouse");
assert.equal(treehouse.deepLinkScheme, "treehouse");
assert.equal(treehouse.keyService, "dev.treetop.lattice.treehouse.carrier");
assert.equal(treehouse.databaseFile, "treehouse-v1.sqlite3");
assert.equal(treehouse.androidSigningAlias, "treehouse-pilot-v1");

assert.equal(allProductManifests().length, 3, "exactly the three plan-158 products");

// ── Uniqueness across every isolation identifier ─────────────────────────────
assertUniqueProductManifests();
assert.throws(
  () => assertUniqueProductManifests([township, { ...toolshed, databaseFile: township.databaseFile }]),
  /databaseFile values collide/,
  "a database file collision must throw",
);
assert.throws(
  () => assertUniqueProductManifests([township, { ...toolshed, keyService: township.keyService }]),
  /keyService values collide/,
  "a key service collision must throw",
);

// ── Cross-product scheme dispatch refuses ────────────────────────────────────
for (const manifest of allProductManifests()) {
  assert.equal(productAcceptsScheme(manifest, manifest.deepLinkScheme), true);
  for (const other of allProductManifests()) {
    if (other.product === manifest.product) continue;
    assert.equal(
      productAcceptsScheme(manifest, other.deepLinkScheme),
      false,
      `${manifest.product} must refuse the ${other.product} scheme`,
    );
  }
  assert.equal(productAcceptsScheme(manifest, ""), false);
  assert.equal(productAcceptsScheme(manifest, "https"), false);
}

assert.equal(productForDeepLink("township://pairing?handoff=x")?.product, "township");
assert.equal(productForDeepLink("toolshed://pairing?handoff=x")?.product, "toolshed");
assert.equal(productForDeepLink("treehouse://join?invite=x")?.product, "treehouse");
assert.equal(productForDeepLink("https://example.com"), null, "unknown scheme must refuse");
assert.equal(productForDeepLink("townshipx://pairing"), null, "prefix-collision scheme must refuse");
assert.equal(productForDeepLink(""), null, "empty link must refuse");

// ── Unknown products refuse ──────────────────────────────────────────────────
assert.throws(() => productManifestFor("mystery"), /unknown product: mystery/);

console.log("  ✓ three unique product manifests; cross-product dispatch refuses");
