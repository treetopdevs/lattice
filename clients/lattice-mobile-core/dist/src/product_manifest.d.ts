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
export declare function allProductManifests(): readonly ProductManifest[];
export declare function productManifestFor(product: string): ProductManifest;
export declare function productAcceptsScheme(manifest: ProductManifest, scheme: string): boolean;
/** Dispatch a deep link to the owning product, refusing unknown schemes. */
export declare function productForDeepLink(url: string): ProductManifest | null;
/** Throws when the manifest table carries a duplicate isolation identifier. */
export declare function assertUniqueProductManifests(manifests?: readonly ProductManifest[]): void;
