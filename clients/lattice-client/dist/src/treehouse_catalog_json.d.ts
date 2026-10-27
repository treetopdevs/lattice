export declare const CATALOG_ARTIFACT_BYTES: number;
type ParsedArtifact = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    reason: "malformed_catalog" | "control_history_limit";
};
export declare function parseCatalogArtifactJson(json: unknown): ParsedArtifact;
export {};
