import type { CarrierTerm } from "../../src/carrier";
/** Additive public data only. Original catalog producers and fixtures stay unchanged. */
export declare function continuityCatalogFixture(): Promise<{
    version: number;
    review: {
        version: 1;
        product: "treehouse";
        space: string;
        spaceRoot: string;
        bootstrapId: string;
        observedBootstrapIds: string[];
        disposition: "pin_exact_observed_bootstrap";
    };
    catalogJson: string;
    histories: {
        frames: import("../../src").CarrierOpFrame[];
        rejected: {
            frame: {
                sig: string;
                v: number;
                id: string;
                replica: string;
                author: string;
                deps: string[];
                kind: import("../../src").OpKind;
                body: CarrierTerm;
                cap: CarrierTerm;
            };
            reason: "bad_signature";
        }[];
        replica: string;
    }[];
    cutoffProofs: never[];
    expected: {
        catalogId: string;
        cutoffs: {
            ok: true;
            cutoff: {
                replica: string;
                frontier: string[];
                logDigest: string;
            };
            canonicalBytes: Uint8Array;
            ops: import("../../src").TreehouseCutoffOp[];
            rejected: import("../../src").TreehouseCutoffRejectedOp[];
        }[];
    };
}>;
export declare function verifyContinuityCatalogVector(input: unknown): Promise<void>;
