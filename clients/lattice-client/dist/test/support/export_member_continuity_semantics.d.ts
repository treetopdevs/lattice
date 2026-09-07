import type { CarrierOpFrame, CarrierTerm } from "../../src/carrier";
export declare function semanticSummary(replica: string, frames: readonly CarrierOpFrame[], oldPub: string): Promise<{
    frontier: string[];
    records: {
        claim_id: string;
        claim_bytes: string;
        wrappers: {
            op_id: string;
            author: string;
            cap_id: string | null;
            certificate_bytes: string;
        }[];
    }[];
    links: {
        old_pub: string;
        heads: string[];
        status: "unlinked" | "attested" | "contested" | "review_required" | "capacity_stop";
        affected_wrappers: {
            op_id: string;
            reason: string;
        }[];
    }[];
    quarantine: {
        op_id: string;
        reason: string;
    }[];
    state: {
        [x: string]: unknown;
    };
    holders: {
        admin: unknown;
        moderator: unknown;
    };
}>;
export declare function semanticCorpus(): Promise<{
    version: number;
    producer: string;
    cases: {
        name: string;
        replica: string;
        old_pub: string;
        frames: CarrierOpFrame[];
        expected: {
            frontier: string[];
            records: {
                claim_id: string;
                claim_bytes: string;
                wrappers: {
                    op_id: string;
                    author: string;
                    cap_id: string | null;
                    certificate_bytes: string;
                }[];
            }[];
            links: {
                old_pub: string;
                heads: string[];
                status: "unlinked" | "attested" | "contested" | "review_required" | "capacity_stop";
                affected_wrappers: {
                    op_id: string;
                    reason: string;
                }[];
            }[];
            quarantine: {
                op_id: string;
                reason: string;
            }[];
            state: {
                [x: string]: unknown;
            };
            holders: {
                admin: unknown;
                moderator: unknown;
            };
        };
    }[];
    authoring: {
        replica: string;
        frames: CarrierOpFrame[];
        request: {
            old_pub: string;
            old_admission: string;
            new_pub: string;
            old_membership: "active" | "removed";
            nonce: string;
            voucher_admissions: [string, string];
            author: string;
            cap_id: string;
        };
        claim_term: CarrierTerm | null;
        certificate_term: CarrierTerm | null;
        claim_id: string;
        claim_bytes: string;
        possession_bytes: string;
        frame: CarrierOpFrame;
        frame_bytes: string;
    };
}>;
export declare function verifySemanticCorpus(path: string): Promise<any>;
