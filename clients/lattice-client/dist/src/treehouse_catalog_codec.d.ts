import type { CarrierTerm, DecodedTerm } from "./carrier";
/** Pure signed record shapes. Valid signatures do not establish installed trust or authority. */
export interface CatalogBootstrap {
    version: 1;
    product: "treehouse";
    space: string;
    spaceRoot: string;
    profileGenesis: string;
    profileId: string;
    replacementRule: "bounded_space_admin_v1";
    catalogKey: string;
    serviceId: string;
    serviceKey: string;
    origin: string;
    nonce: string;
}
export interface CatalogEntry {
    product: "treehouse";
    replica: string;
    kind: "space" | "thread";
    schema: "treehouse_space_v1" | "treehouse_thread_v1";
    root: string;
    genesis: string;
    creation: string;
    reference: string;
    route: string;
    serviceId: string;
    serviceKey: string;
}
export interface TransportCatalog {
    version: 1;
    product: "treehouse";
    space: string;
    bootstrap: string;
    binding: string;
    revision: number;
    previous: string | null;
    entries: CatalogEntry[];
}
export interface CatalogEnvelope {
    catalog: TransportCatalog;
    signature: string;
}
export interface CatalogCutoff {
    replica: string;
    frontier: string[];
    logDigest: string;
}
export interface CatalogRotation {
    version: 1;
    product: "treehouse";
    space: string;
    bootstrap: string;
    parent: string;
    priorCatalog: string;
    generation: number;
    newCatalogKey: string;
    nonce: string;
    inventoryDigest: string;
    cutoffs: CatalogCutoff[];
}
export interface CatalogRotationEnvelope {
    rotation: CatalogRotation;
    oldSignature: string;
    newSignature: string;
}
export declare function normalizeCatalogBootstrap(value: unknown): CatalogBootstrap | null;
export declare function catalogBootstrapToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogBootstrapFromCarrierTerm(value: unknown): CatalogBootstrap | null;
/** Flat decoded command argument only; the existing codec owns closed fields and types. */
export declare function catalogBootstrapFromDecodedTerm(value: DecodedTerm): CatalogBootstrap | null;
export declare function normalizeCatalogEntry(value: unknown): CatalogEntry | null;
export declare function catalogEntryToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogEntryFromCarrierTerm(value: unknown): CatalogEntry | null;
export declare function normalizeTransportCatalog(value: unknown): TransportCatalog | null;
export declare function transportCatalogToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function transportCatalogFromCarrierTerm(value: unknown): TransportCatalog | null;
export declare function normalizeCatalogEnvelope(value: unknown): CatalogEnvelope | null;
export declare function catalogEnvelopeToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogEnvelopeFromCarrierTerm(value: unknown): CatalogEnvelope | null;
export declare function normalizeCatalogCutoff(value: unknown): CatalogCutoff | null;
export declare function catalogCutoffToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogCutoffFromCarrierTerm(value: unknown): CatalogCutoff | null;
export declare function normalizeCatalogRotation(value: unknown): CatalogRotation | null;
export declare function catalogRotationToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogRotationFromCarrierTerm(value: unknown): CatalogRotation | null;
export declare function normalizeCatalogRotationEnvelope(value: unknown): CatalogRotationEnvelope | null;
export declare function catalogRotationEnvelopeToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function catalogRotationEnvelopeFromCarrierTerm(value: unknown): CatalogRotationEnvelope | null;
export declare function canonicalBytesForTransportCatalog(value: unknown): Uint8Array;
export declare function transportCatalogId(value: unknown): string;
export declare function canonicalBytesForCatalogRotation(value: unknown): Uint8Array;
export declare function canonicalBytesForCatalogRotationPossession(value: unknown): Uint8Array;
/** The binding ID commits both signatures, not just the unsigned rotation record. */
export declare function catalogRotationId(value: unknown): string;
export declare function canonicalBytesForCatalogInventory(value: unknown): Uint8Array;
export declare function catalogInventoryId(value: unknown): string;
export declare function catalogServiceRealm(value: unknown): string;
/** Signature validity under the caller's trusted key only; no history or route readiness judgment. */
export declare function verifyCatalogEnvelope(value: unknown, expectedCatalogKey: unknown): boolean;
/** Old-key approval and new-key possession only; the caller independently resolves parent/head trust. */
export declare function verifyCatalogRotationEnvelope(value: unknown, expectedOldKey: unknown): boolean;
