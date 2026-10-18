import type { CarrierOpSigner } from "./codec";
import type { CarrierOpFrame } from "./carrier";
import type { ContinuationProfile } from "./continuation";
import type { TreehouseInitialization } from "./treehouse";
import type { CatalogBootstrap } from "./treehouse_catalog_codec";
export type TreehouseSpaceFamily = "legacy" | "bounded" | "unsupported";
/** The root's capability set is final at birth; the pin adds none. */
export declare const treehouseBoundedGenesisOps: readonly string[];
/** Legacy replicas keep their old grammar; only the exact bounded Space grammar is "bounded". */
export declare function treehouseSpaceFamily(replica: string): TreehouseSpaceFamily;
/** Pure root-only preparation of a bounded-family Space. Returned pending frames are not persisted. */
export declare function prepareTreehouseBoundedSpaceCreation(input: {
    replica: string;
    name: string;
    signer: CarrierOpSigner;
    retained?: CarrierOpFrame[];
}): Promise<{
    replica: string;
    profile: "bounded_root_only";
    status: TreehouseInitialization;
    pending: CarrierOpFrame[];
}>;
export type TreehouseContinuationPin = {
    configured: false;
} | {
    configured: true;
    profileGenesis: string;
    profileId: string;
    profile: ContinuationProfile;
    root: string;
};
/**
 * The selected pin of a complete, already-authenticated Space history. This does not verify
 * signatures; callers that need authentication use the verified authoring and review functions.
 */
export declare function treehouseContinuationPin(frames: CarrierOpFrame[]): TreehouseContinuationPin;
/** One root-signed pin: an empty, non-live delegation carrying the `__continuation__` profile. */
export declare function authorTreehouseContinuationPin(input: {
    frames: CarrierOpFrame[];
    signer: CarrierOpSigner;
    nominee: string | Uint8Array;
    witnesses: (string | Uint8Array)[];
    threshold: number;
    maxLeaseEpochs: number;
}): Promise<CarrierOpFrame>;
export type TreehouseCatalogBindingReview = {
    ok: true;
    record: CatalogBootstrap;
    sha256: string;
    lines: {
        field: string;
        value: string;
    }[];
} | {
    ok: false;
    reason: "malformed_payload" | "payload_digest_mismatch" | "wrong_space" | "not_root" | "not_bounded_space" | "binding_key_reuse" | "continuation_not_configured" | "binding_mismatch" | "catalog_bootstrap_exists";
};
/** Strict review of a ceremony `binding-payload.json` against the Space it will be signed into. */
export declare function reviewTreehouseCatalogBindingPayload(input: {
    payloadText: string;
    replica: string;
    frames: CarrierOpFrame[];
    rootPublicKey: string;
}): Promise<TreehouseCatalogBindingReview>;
/** The root's one-time catalog bootstrap command, depending on the sorted frontier (hence the pin). */
export declare function authorTreehouseCatalogBootstrap(input: {
    frames: CarrierOpFrame[];
    signer: CarrierOpSigner;
    record: CatalogBootstrap;
}): Promise<CarrierOpFrame>;
