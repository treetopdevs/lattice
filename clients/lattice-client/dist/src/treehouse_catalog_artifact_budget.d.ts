import { CATALOG_ARTIFACT_BYTES } from "./treehouse_catalog_json";
export { CATALOG_ARTIFACT_BYTES };
export declare const TREEHOUSE_CATALOG_MAX_ARTIFACTS = 1024;
export declare const TREEHOUSE_CATALOG_MAX_TOTAL_BYTES: number;
/** Compact JSON length of a catalog envelope's carrier term. */
export declare function catalogEnvelopeJsonBytes(envelope: unknown): number;
/** Compact JSON length of a rotation envelope's carrier term. */
export declare function catalogRotationEnvelopeJsonBytes(envelope: unknown): number;
/** Refuses a size list CatalogTrust would refuse: count, per-artifact or total. Every size must be a non-negative safe
 * integer; anything else (NaN, an infinity, a negative or a fraction) fails closed. */
export declare function checkCatalogArtifactBudget(sizes: Iterable<number>): "control_history_limit" | null;
/** Measures retained envelopes lazily and checks them as checkCatalogArtifactBudget does, stopping at the first refusal so
 * an oversized history is not serialized in full. */
export declare function checkCatalogEnvelopeBudget(rotations: Iterable<unknown>, catalogs: Iterable<unknown>): "control_history_limit" | null;
