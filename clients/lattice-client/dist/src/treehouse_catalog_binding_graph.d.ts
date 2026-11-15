import type { CatalogBootstrap, CatalogEntry, CatalogEnvelope, CatalogPriorCatalog, CatalogReplacementClaim, CatalogRotationEnvelope, TransportCatalog } from "./treehouse_catalog_codec";
export interface CatalogBindingNode {
    id: string;
    kind: "bootstrap" | "rotation" | "replacement";
    generation: number;
    key: string;
    serviceId: string;
    serviceKey: string;
    origin: string;
    parents: readonly string[];
    prior: readonly CatalogPriorCatalog[];
    inventory: string | null;
    refused: boolean;
    coreReason: string | null;
    pending: readonly {
        replica: string;
        logDigest: string;
    }[];
}
export interface CatalogBindingAccepted {
    binding: string;
    generation: number;
    catalog: string;
    revision: number;
}
export interface CatalogBindingBlocked {
    reason: string;
    triggers: readonly string[];
}
export type CatalogBindingStatus = "current" | "closed" | "closed_out" | "refused" | "missing";
export type CatalogBindingCatalogStatus = "current" | "ancestor_of_cited" | "closed_out" | "refused" | "missing";
export interface CatalogBindingDecision {
    accepted: boolean;
    reason: string | null;
    block: CatalogBindingBlocked | null;
    head: string | null;
    catalog: string | null;
    generation: number | null;
    revision: number | null;
    clearsAuthorityChanged: boolean;
    acceptedBindingStatus: CatalogBindingStatus;
    acceptedCatalogStatus: CatalogBindingCatalogStatus;
}
export interface CatalogBindingFork {
    kind: "heads" | "nonce" | "catalog";
    binding: string | null;
    ids: readonly string[];
}
export interface CatalogBindingGraph {
    nodes: ReadonlyMap<string, CatalogBindingNode>;
    heads: readonly string[];
    closed: readonly string[];
    closedOut: ReadonlyMap<string, string>;
    pending: readonly string[];
    rawEvidence: ReadonlyMap<string, string>;
    refusals: ReadonlyMap<string, {
        reason: string;
        coreReason: string | null;
    }>;
    catalogHeads: ReadonlyMap<string, readonly string[]>;
    catalogStatus: ReadonlyMap<string, CatalogStatus>;
    citations: ReadonlyMap<string, readonly (string | null)[]>;
    previous: ReadonlyMap<string, string | null>;
    forks: readonly CatalogBindingFork[];
    catalogs: ReadonlyMap<string, TransportCatalog>;
    decision: CatalogBindingDecision;
}
export type CatalogBindingGraphResult = {
    ok: true;
    graph: CatalogBindingGraph;
} | {
    ok: false;
    reason: string;
    detail: {
        ids: string[];
    };
};
export interface CatalogBindingGraphInput {
    bootstrap: {
        id: string;
        record: CatalogBootstrap;
    };
    /** Authenticated Space frames of one replica; a frame whose deps are not all held keeps its closure incomplete. */
    frames: readonly unknown[];
    rotations: ReadonlyMap<string, CatalogRotationEnvelope>;
    catalogs: ReadonlyMap<string, CatalogEnvelope>;
    provenCutoffs: readonly {
        replica: string;
        logDigest: string;
    }[];
    accepted: CatalogBindingAccepted | null;
    blocked: CatalogBindingBlocked | null;
}
type CatalogStatus = "current" | "covered" | "closed_out" | "uncovered" | "refused" | "pending";
/** max(generations) + 1 within the safe-integer horizon, or null (finding 9). */
export declare function nextCatalogGeneration(generations: readonly number[]): number | null;
export declare function catalogBindingReasonRank(reason: string): number;
export declare function resolveCatalogBindingGraph(input: CatalogBindingGraphInput): Promise<CatalogBindingGraphResult>;
/**
 * Check a candidate claim against a resolved graph for the authoring preflight (rows 352, 354, 356): pending first, then
 * transition failures, then an omitted head or catalog head (catalog_fork), then first-catalog extension of every cited
 * prior against `entries`. Returns null when covered.
 */
export declare function coverCatalogReplacementClaim(graph: CatalogBindingGraph, claim: CatalogReplacementClaim, entries: readonly CatalogEntry[]): string | null;
export {};
