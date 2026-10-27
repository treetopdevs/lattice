import type { TreehouseCatalogBootstrapReview, TreehouseCatalogRawHistory, TreehouseCatalogCutoffProof } from "../../src/treehouse_catalog_trust";
import type { CarrierOpFrame } from "../../src/carrier";
type Bundle = {
    review: TreehouseCatalogBootstrapReview;
    baseline: TreehouseCatalogRawHistory;
    catalogJson: string;
    proof: TreehouseCatalogCutoffProof;
    at: TreehouseCatalogRawHistory;
    overFrame: CarrierOpFrame;
    frameCount: number;
};
export declare function produce(): Promise<Bundle>;
export declare function check(b: Bundle): Promise<{
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
    accepted: {
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
    reopened: {
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
    proposedOver: {
        kind: "reject";
        reason: import("../../src").TreehouseCatalogTrustReason;
        detail: import("../../src").TreehouseCatalogRefusalDetail;
    };
    savedOver: {
        kind: "reject";
        reason: import("../../src").TreehouseCatalogTrustReason;
        detail: import("../../src").TreehouseCatalogRefusalDetail;
    };
}>;
export {};
