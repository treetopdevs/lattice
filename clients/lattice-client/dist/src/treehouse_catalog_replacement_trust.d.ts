import type { CatalogBindingState } from "./treehouse_catalog_binding_graph";
import { prepareTreehouseCatalogInstallation } from "./treehouse_catalog_trust";
import type { InstalledTreehouseCatalogTrustV1, TreehouseCatalogEvidencePage, TreehouseCatalogRefusalDetail, TreehouseCatalogStoreToken, TreehouseCatalogTrustDecision, TreehouseCatalogTrustReason, VerifiedTreehouseCatalogRoute } from "./treehouse_catalog_trust";
export interface InstalledReplacementTrust {
    trust: InstalledTreehouseCatalogTrustV1;
    binding: CatalogBindingState;
    extra: SidecarExtra;
    routes: VerifiedTreehouseCatalogRoute[];
}
/** The sidecar; rotations is present only while a sidecar rotation is held (row 526). */
type SidecarExtra = {
    catalogs: string[];
    rotations?: string[];
};
export type ReplacementTrustResult = {
    kind: "reject";
    reason: TreehouseCatalogTrustReason;
    detail: TreehouseCatalogRefusalDetail;
} | {
    kind: "unchanged" | "propose" | "retain_blocked";
    reason: string | null;
    refused: Record<string, string>;
    next: InstalledReplacementTrust;
    routes: VerifiedTreehouseCatalogRoute[];
    servedOrigin: string | null;
    trustDecision: TreehouseCatalogTrustDecision;
};
/** Wrap a bare trust state as an installed state with nothing served yet. */
export declare function wrapReplacementTrust(trust: InstalledTreehouseCatalogTrustV1): InstalledReplacementTrust;
/** As prepareTreehouseCatalogInstallation, with the proposed state wrapped. */
export declare function prepareReplacementTrustInstallation(input: Parameters<typeof prepareTreehouseCatalogInstallation>[0]): Promise<{
    decision: TreehouseCatalogTrustDecision;
    next: InstalledReplacementTrust | null;
}>;
export declare function evaluateReplacementTrust(input: {
    installed: InstalledReplacementTrust;
    expected: TreehouseCatalogStoreToken;
    incoming: TreehouseCatalogEvidencePage;
}): Promise<ReplacementTrustResult>;
export {};
