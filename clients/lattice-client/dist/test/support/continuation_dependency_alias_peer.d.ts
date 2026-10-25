import type { CarrierOpFrame } from "../../src/carrier";
export type Kind = "space" | "thread";
export declare function fixture(kind: Kind): Promise<{
    kind: Kind;
    role: string;
    replica: string;
    prior: CarrierOpFrame[];
    frame: CarrierOpFrame;
    nominee: import("../../src").CarrierOpSigner;
    witnesses: import("../../src").CarrierOpSigner[];
    delegation: import("../../src").CarrierDelegation;
    claim: import("../../src").ContinuationClaim;
}>;
export declare function aliases(frame: CarrierOpFrame): CarrierOpFrame[];
export declare function judge(kind: Kind, replica: string, frames: CarrierOpFrame[]): Promise<{
    epoch: string | null;
    holder: string | null;
    reasons: {
        [k: string]: string;
    };
    cutoff: {
        replica: string;
        frontier: string[];
        logDigest: string;
    };
    cutoffBytes: string;
}>;
export declare function negativeFrames(f: Awaited<ReturnType<typeof fixture>>): Promise<{
    frame: CarrierOpFrame;
    reason: string;
}[]>;
export declare function produce(): Promise<{
    vectors: {
        kind: "space" | "thread";
        replica: string;
        prior: CarrierOpFrame[];
        frame: CarrierOpFrame;
        expected: {
            epoch: string | null;
            holder: string | null;
            reasons: {
                [k: string]: string;
            };
            cutoff: {
                replica: string;
                frontier: string[];
                logDigest: string;
            };
            cutoffBytes: string;
        };
        negatives: {
            frame: CarrierOpFrame;
            reason: string;
        }[];
    }[];
}>;
