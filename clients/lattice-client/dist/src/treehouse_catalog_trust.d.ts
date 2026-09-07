import type { CatalogCutoff } from "./treehouse_catalog_codec";
export interface TreehouseCatalogRawHistory {
    replica: string;
    frames: readonly unknown[];
    rejected: readonly {
        frame: unknown;
        reason: "bad_signature";
    }[];
}
export interface TreehouseCatalogBootstrapReview {
    version: 1;
    product: "treehouse";
    space: string;
    spaceRoot: string;
    bootstrapId: string;
    observedBootstrapIds: string[];
    disposition: "pin_exact_observed_bootstrap";
}
export interface TreehouseCatalogCutoffProof {
    cutoff: CatalogCutoff;
    history: TreehouseCatalogRawHistory;
}
export interface TreehouseCatalogEvidencePage {
    catalogs: readonly string[];
    rotations: readonly string[];
    histories: readonly TreehouseCatalogRawHistory[];
    cutoffProofs: readonly TreehouseCatalogCutoffProof[];
}
export interface TreehouseCatalogStoreToken {
    trustRevision: number;
    historyGeneration: number;
}
export interface TreehouseCatalogWatermark {
    binding: string;
    generation: number;
    catalog: string;
    revision: number;
}
export interface TreehouseCatalogOverflowTrigger {
    kind: "catalog" | "rotation";
    id: string;
    digest: string;
    bytes: number;
}
export interface TreehouseCatalogBlock {
    reason: "catalog_fork" | "authority_changed" | "control_history_limit";
    bindings: string[];
    catalogs: string[];
    bootstrapIds: string[];
    opIds: string[];
    pendingProofIds: string[];
    triggers: TreehouseCatalogOverflowTrigger[];
    /** Authenticated prior causal refusals, not a timestamp or proof of store provenance. */
    authorityWitnesses: {
        replica: string;
        frontier: string[];
        opIds: string[];
    }[];
}
export interface InstalledTreehouseCatalogTrustV1 {
    version: 1;
    review: TreehouseCatalogBootstrapReview;
    histories: TreehouseCatalogRawHistory[];
    catalogs: {
        id: string;
        json: string;
    }[];
    rotations: {
        id: string;
        json: string;
    }[];
    cutoffProofs: TreehouseCatalogCutoffProof[];
    accepted: TreehouseCatalogWatermark | null;
    blocked: TreehouseCatalogBlock | null;
}
export type TreehouseCatalogTrustReason = "malformed_catalog" | "control_history_limit" | "wrong_catalog_scope" | "trust_pending" | "invalid_catalog_signature" | "invalid_possession" | "catalog_authority_refused" | "invalid_catalog_transition" | "catalog_rollback" | "catalog_fork" | "recovery_incomplete" | "carrier_pending" | "authority_changed" | "invalid_verified_history" | "unsupported_cutoff" | "trust_recovery_required" | "stale_trust_snapshot" | "trust_persistence_failed";
export interface TreehouseCatalogRefusalDetail {
    ids: string[];
    coreReason: string | null;
    pendingProofIds: string[];
}
export interface VerifiedTreehouseCatalogRoute {
    replica: string;
    kind: "space" | "thread";
    schema: "treehouse_space_v1" | "treehouse_thread_v1";
    root: string;
    genesis: string;
    creation: string;
    reference: string;
    binding: string;
    catalog: string;
    revision: number;
    origin: string;
    path: string;
    url: string;
    serviceId: string;
    serviceKey: string;
    realm: string;
}
export type TreehouseCatalogTrustDecision = {
    kind: "reject";
    reason: TreehouseCatalogTrustReason;
    detail: TreehouseCatalogRefusalDetail;
} | {
    kind: "unchanged" | "propose" | "retain_blocked";
    expected: TreehouseCatalogStoreToken;
    next: InstalledTreehouseCatalogTrustV1;
    reason: TreehouseCatalogTrustReason | null;
    detail: TreehouseCatalogRefusalDetail;
    /** Profile equality only; no cap, acquisition, epoch or replacement readiness proof. */
    replacementConfigured: boolean;
    observed: {
        bootstrapIds: string[];
        bindingHeads: string[];
        catalogHeads: {
            binding: string;
            catalogs: string[];
        }[];
    };
    routes: VerifiedTreehouseCatalogRoute[];
};
export type TreehouseCatalogRouteDecision = {
    ok: true;
    candidate: VerifiedTreehouseCatalogRoute;
    installationRequired: true;
} | {
    ok: false;
    reason: TreehouseCatalogTrustReason | "thread_not_authorized" | "thread_unavailable";
};
/** Pure preparation only. The trusted adapter, not this caller flag, proves fresh storage. */
export declare function prepareTreehouseCatalogInstallation(input: {
    review: TreehouseCatalogBootstrapReview;
    history: TreehouseCatalogRawHistory;
    store: {
        kind: "verified_fresh";
        expected: TreehouseCatalogStoreToken;
    };
}): Promise<TreehouseCatalogTrustDecision>;
/** Pure authenticated decision over a caller-supplied current retained store snapshot. */
export declare function evaluateTreehouseCatalogTrust(input: {
    installed: InstalledTreehouseCatalogTrustV1;
    expected: TreehouseCatalogStoreToken;
    incoming: TreehouseCatalogEvidencePage;
}): Promise<TreehouseCatalogTrustDecision>;
/** Candidate only: the adapter must persist the exact decision before using transport. */
export declare function resolveTreehouseCatalogRoute(input: {
    decision: TreehouseCatalogTrustDecision;
    replica: string;
}): TreehouseCatalogRouteDecision;
