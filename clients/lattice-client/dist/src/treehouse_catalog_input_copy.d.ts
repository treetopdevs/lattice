export declare class CatalogInputResourceError extends Error {
}
type EvidenceRoot = "snapshot" | "incoming";
export declare function copyCatalogInput<T>(input: T, evidenceBounds?: EvidenceRoot): T;
export {};
