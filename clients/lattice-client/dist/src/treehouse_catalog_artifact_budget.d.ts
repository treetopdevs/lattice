import { CATALOG_ARTIFACT_BYTES } from "./treehouse_catalog_json";
export { CATALOG_ARTIFACT_BYTES };
export declare const TREEHOUSE_CATALOG_MAX_ARTIFACTS = 1024;
export declare const TREEHOUSE_CATALOG_MAX_TOTAL_BYTES: number;
/** Compact JSON length of a catalog envelope's carrier term. */
export declare function catalogEnvelopeJsonBytes(envelope: unknown): number;
/** Compact JSON length of a rotation envelope's carrier term. */
export declare function catalogRotationEnvelopeJsonBytes(envelope: unknown): number;
/** Refuses a size list CatalogTrust would refuse: count, per-artifact or total. */
export declare function checkCatalogArtifactBudget(sizes: readonly number[]): "control_history_limit" | null;
