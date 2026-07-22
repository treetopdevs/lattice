/**
 * Normative product isolation manifest (plan 158 "Product isolation contract").
 *
 * The single source of truth is `clients/lattice-mobile-core/products.json`;
 * the Rust crate under `native/` embeds the same file, and the contract test
 * asserts this module never drifts from it. A change to the table requires
 * updating the collision contract before any product shell lands.
 */

export interface ProductManifest {
  readonly product: string;
  readonly appId: string;
  readonly deepLinkScheme: string;
  readonly keyService: string;
  readonly databaseFile: string;
  readonly androidSigningAlias: string;
}

const PRODUCT_MANIFESTS: readonly ProductManifest[] = [];

export function allProductManifests(): readonly ProductManifest[] {
  return PRODUCT_MANIFESTS;
}

export function productManifestFor(product: string): ProductManifest {
  const manifest = PRODUCT_MANIFESTS.find((candidate) => candidate.product === product);
  if (!manifest) throw new Error(`unknown product: ${product}`);
  return manifest;
}

export function productAcceptsScheme(manifest: ProductManifest, scheme: string): boolean {
  return scheme.length > 0;
}

/** Dispatch a deep link to the owning product, refusing unknown schemes. */
export function productForDeepLink(url: string): ProductManifest | null {
  const scheme = url.split(":", 1)[0] ?? "";
  return PRODUCT_MANIFESTS.find((manifest) => productAcceptsScheme(manifest, scheme)) ?? null;
}

/** Throws when the manifest table carries a duplicate isolation identifier. */
export function assertUniqueProductManifests(
  manifests: readonly ProductManifest[] = PRODUCT_MANIFESTS,
): void {
  const fields: readonly (keyof ProductManifest)[] = [
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
