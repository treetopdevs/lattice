/**
 * Normative product isolation manifest (plan 158 "Product isolation contract").
 *
 * The single source of truth is `clients/lattice-mobile-core/products.json`;
 * the Rust crate under `native/` embeds the same file, and the contract test
 * asserts this module never drifts from it. A change to the table requires
 * updating the collision contract before any product shell lands.
 */
const PRODUCT_MANIFESTS = [
    {
        product: "township",
        appId: "dev.treetop.lattice.township",
        deepLinkScheme: "township",
        keyService: "dev.treetop.lattice.township.carrier",
        databaseFile: "township-v1.sqlite3",
        androidSigningAlias: "township-pilot-v1",
    },
    {
        product: "toolshed",
        appId: "dev.treetop.lattice.toolshed",
        deepLinkScheme: "toolshed",
        keyService: "dev.treetop.lattice.toolshed.carrier",
        databaseFile: "toolshed-v1.sqlite3",
        androidSigningAlias: "toolshed-pilot-v1",
    },
    {
        product: "treehouse",
        appId: "dev.treetop.lattice.treehouse",
        deepLinkScheme: "treehouse",
        keyService: "dev.treetop.lattice.treehouse.carrier",
        databaseFile: "treehouse-v1.sqlite3",
        androidSigningAlias: "treehouse-pilot-v1",
    },
];
export function allProductManifests() {
    return PRODUCT_MANIFESTS;
}
export function productManifestFor(product) {
    const manifest = PRODUCT_MANIFESTS.find((candidate) => candidate.product === product);
    if (!manifest)
        throw new Error(`unknown product: ${product}`);
    return manifest;
}
export function productAcceptsScheme(manifest, scheme) {
    return scheme.length > 0 && scheme === manifest.deepLinkScheme;
}
/** Dispatch a deep link to the owning product, refusing unknown schemes. */
export function productForDeepLink(url) {
    const colon = url.indexOf(":");
    if (colon <= 0)
        return null;
    const scheme = url.slice(0, colon).toLowerCase();
    return PRODUCT_MANIFESTS.find((manifest) => productAcceptsScheme(manifest, scheme)) ?? null;
}
/** Throws when the manifest table carries a duplicate isolation identifier. */
export function assertUniqueProductManifests(manifests = PRODUCT_MANIFESTS) {
    const fields = [
        "product",
        "appId",
        "deepLinkScheme",
        "keyService",
        "databaseFile",
        "androidSigningAlias",
    ];
    for (const field of fields) {
        const values = manifests.map((manifest) => manifest[field]);
        if (new Set(values).size !== values.length) {
            throw new Error(`product manifest ${field} values collide: ${values.join(", ")}`);
        }
    }
}
