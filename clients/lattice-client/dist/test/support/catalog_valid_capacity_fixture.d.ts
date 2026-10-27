import type { TreehouseCatalogBootstrapReview, TreehouseCatalogRawHistory, TreehouseCatalogCutoffProof, TreehouseCatalogTrustDecision } from "../../src/treehouse_catalog_trust";
import type { CarrierOpFrame } from "../../src/carrier";
type Bundle = {
    frozen: boolean;
    transfer: CarrierOpFrame | null;
    review: TreehouseCatalogBootstrapReview;
    baseline: TreehouseCatalogRawHistory;
    catalogJson: string;
    proof: TreehouseCatalogCutoffProof;
    at: TreehouseCatalogRawHistory;
    overFrame: CarrierOpFrame;
    frameCount: number;
};
export declare function produce(frozen?: boolean): Promise<Bundle>;
export declare function check(b: Bundle, onDecision?: (name: string, decision: TreehouseCatalogTrustDecision) => void): Promise<{
    initial: {
        kind: "unchanged" | "propose" | "retain_blocked";
        expected: import("../../src").TreehouseCatalogStoreToken;
        next: import("../../src").InstalledTreehouseCatalogTrustV1;
        reason: import("../../src").TreehouseCatalogTrustReason | null;
        detail: import("../../src").TreehouseCatalogRefusalDetail;
        replacementConfigured: boolean;
        observed: {
            bootstrapIds: string[];
            bindingHeads: string[];
            catalogHeads: {
                binding: string;
                catalogs: string[];
            }[];
        };
        routes: import("../../src").VerifiedTreehouseCatalogRoute[];
    };
    blockedAt: {
        authorityWitnesses: {
            frontier: string[];
            replica: string;
            opIds: string[];
        }[];
        reason: "catalog_fork" | "authority_changed" | "control_history_limit";
        bindings: string[];
        catalogs: string[];
        bootstrapIds: string[];
        opIds: string[];
        pendingProofIds: string[];
        triggers: import("../../src").TreehouseCatalogOverflowTrigger[];
    } | null;
    blockedOver: {
        authorityWitnesses: {
            frontier: string[];
            replica: string;
            opIds: string[];
        }[];
        reason: "catalog_fork" | "authority_changed" | "control_history_limit";
        bindings: string[];
        catalogs: string[];
        bootstrapIds: string[];
        opIds: string[];
        pendingProofIds: string[];
        triggers: import("../../src").TreehouseCatalogOverflowTrigger[];
    } | null;
}>;
export {};
