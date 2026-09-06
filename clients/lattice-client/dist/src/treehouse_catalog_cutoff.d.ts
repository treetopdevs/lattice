export interface TreehouseCutoffOp {
    id: string;
    bytes: Uint8Array;
    sig: Uint8Array;
}
export interface TreehouseCutoffRejectedOp extends TreehouseCutoffOp {
    reason: "bad_signature";
}
export type TreehouseCatalogCutoffResult = {
    ok: true;
    cutoff: {
        replica: string;
        frontier: string[];
        logDigest: string;
    };
    canonicalBytes: Uint8Array;
    ops: TreehouseCutoffOp[];
    rejected: TreehouseCutoffRejectedOp[];
} | {
    ok: false;
    reason: "invalid_verified_history" | "unsupported_cutoff";
};
export interface TreehouseCatalogCutoffInput {
    replica: string;
    frames: readonly unknown[];
    rejected: readonly {
        frame: unknown;
        reason: "bad_signature";
    }[];
}
/**
 * Exact raw observation of one caller-supplied complete retained snapshot.
 * Does not decode application terms, establish authority, discover withheld
 * history, persist evidence or replace the caller's store/session serialization.
 */
export declare function deriveTreehouseCatalogCutoff(input: TreehouseCatalogCutoffInput): Promise<TreehouseCatalogCutoffResult>;
