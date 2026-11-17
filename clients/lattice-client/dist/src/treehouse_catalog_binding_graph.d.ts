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
    pending: readonly ProvenCutoff[];
}
/**
 * The accepted watermark; `routes` is the cumulative route -> replica map of every route ever served, every route on an accepted
 * chain included (row 524).
 */
export interface CatalogBindingAccepted {
    binding: string;
    generation: number;
    catalog: string;
    revision: number;
    routes: Readonly<Record<string, string>>;
}
/** A decision block: `ids` is informational; only a changed watermark sets `freeze`. */
export interface CatalogBindingBlock {
    reason: string;
    ids: readonly string[];
    freeze: boolean;
}
/** The persisted caller state (row 383). */
export interface CatalogBindingState {
    accepted: CatalogBindingAccepted | null;
    frozen: boolean;
}
/** advanceCatalogBindingState's result: the next persisted state and the catalog to serve. */
export interface CatalogBindingAdvance extends CatalogBindingState {
    serving: string | null;
}
export type CatalogBindingStatus = "current" | "closed" | "closed_out" | "refused" | "missing";
export type CatalogBindingCatalogStatus = "current" | "ancestor_of_cited" | "closed_out" | "refused" | "missing";
export interface CatalogBindingDecision {
    accepted: boolean;
    reason: string | null;
    block: CatalogBindingBlock | null;
    head: string | null;
    catalog: string | null;
    generation: number | null;
    revision: number | null;
    clearsAuthorityChanged: boolean;
    serving: string | null;
    acceptedBindingStatus: CatalogBindingStatus;
    acceptedCatalogStatus: CatalogBindingCatalogStatus;
}
export interface CatalogBindingFork {
    kind: "heads" | "nonce" | "catalog" | "rotation";
    binding: string | null;
    ids: readonly string[];
}
export interface CatalogRotationFork {
    rotation: string;
    binding: string;
    catalogs: readonly string[];
    prior: string;
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
    /** Catalog heads a resolution must cite: current heads plus chain-valid catalogs under a union-refused node. */
    citableCatalogHeads: ReadonlyMap<string, readonly string[]>;
    catalogStatus: ReadonlyMap<string, CatalogStatus>;
    citations: ReadonlyMap<string, readonly (string | null)[]>;
    previous: ReadonlyMap<string, string | null>;
    forks: readonly CatalogBindingFork[];
    rotationForks: readonly CatalogRotationFork[];
    forkBindings: readonly string[];
    /** Floor(N) per final node: the entries every valid catalog under N must extend and its route map (RESERVED marks a
     * route reserved-to-none, row 387). */
    floors: ReadonlyMap<string, CatalogFloor>;
    /** The cumulative route map of every intrinsically valid catalog (its own ancestry plus its entries). */
    catalogRoutes: ReadonlyMap<string, ReadonlyMap<string, string>>;
    /** CatLineage parent per catalog: `previous`, or for a first catalog under a rotation that rotation's prior catalog. */
    catParent: ReadonlyMap<string, string | null>;
    catalogs: ReadonlyMap<string, TransportCatalog>;
    decision: CatalogBindingDecision;
}
/** A trust_pending detail carries the complete part's freeze bit and the watermark's own serving (row 386, repair (a)). */
export interface CatalogBindingErrorDetail {
    ids: string[];
    freeze?: boolean;
    serving?: string | null;
}
export type CatalogBindingGraphResult = {
    ok: true;
    graph: CatalogBindingGraph;
} | {
    ok: false;
    reason: string;
    detail: CatalogBindingErrorDetail;
};
/** A floor: the entries every first catalog under the node must extend, and the route map it must not conflict with. */
export interface CatalogFloor {
    entries: readonly CatalogEntry[];
    routes: ReadonlyMap<string, string>;
}
/**
 * The reserved-to-none route value (row 387): a non-nullish sentinel that can never equal a replica id (replica ids are
 * hex digests). Every lookup is `has`-based, never `??`. At a JSON boundary it is `null` (BEAM `:none`).
 */
export declare const RESERVED = "\0none";
/** Encode a route map for JSON: RESERVED becomes null. */
export declare function encodeCatalogRoutes(routes: ReadonlyMap<string, string>): Record<string, string | null>;
/** Decode a JSON route map: null becomes RESERVED. */
export declare function decodeCatalogRoutes(json: Readonly<Record<string, string | null>>): Map<string, string>;
export interface ProvenCutoff {
    replica: string;
    frontier: readonly string[];
    logDigest: string;
}
export interface CatalogBindingGraphInput {
    bootstrap: {
        id: string;
        record: CatalogBootstrap;
    };
    /** Authenticated Space frames of one replica; a frame whose deps are not all held keeps its closure incomplete. */
    frames: readonly unknown[];
    rotations: ReadonlyMap<string, CatalogRotationEnvelope>;
    catalogs: ReadonlyMap<string, CatalogEnvelope>;
    /** Complete `{replica, frontier, logDigest}` cutoffs; an entry without its frontier is malformed input. */
    provenCutoffs: readonly ProvenCutoff[];
    accepted: CatalogBindingAccepted | null;
    /** Row 390 (repair (c)): Thread histories (replica -> authenticated frames) that entry facts are judged against. A forged or
     * misfiled history is malformed input. Completeness is judged per causal slice, never on the whole history, so a later
     * Thread op whose dependency is withheld cannot make the catalogs naming that replica pend (rows 386, 390). The Space
     * history is always the complete part of `frames`. */
    histories?: Readonly<Record<string, readonly unknown[]>>;
}
type CatalogStatus = "current" | "covered" | "closed_out" | "uncovered" | "refused" | "pending";
/** max(generations) + 1 within the safe-integer horizon, or null (finding 9). */
export declare function nextCatalogGeneration(generations: readonly number[]): number | null;
export declare function catalogBindingReasonRank(reason: string): number;
export declare function resolveCatalogBindingGraph(input: CatalogBindingGraphInput): Promise<CatalogBindingGraphResult>;
/**
 * The merge rule over the persisted {accepted, frozen} (row 383; BEAM CatalogBindingGraph.advance/2). Only an accepting decision
 * that clears (or any accepting decision while not frozen) moves the watermark, adds the routes of every catalog on the accepted
 * chain to the cumulative routes (the D-881 walk, row 524: the accepted catalog, then each catParent link, which is previous or
 * a rotation's prior catalog, oldest first and newest winning, so a chain delivered on one page persists what separate
 * deliveries persist; a route the stored routes already hold is never re-pointed, D-930; any route still missing is then filled
 * from the graph's catalogRoutes for the accepted catalog, which also reaches a replacement's cited prior catalogs, skipping
 * RESERVED, D-931) and lifts frozen; a block with freeze sets frozen; nothing is served while frozen. On trust_pending the detail's freeze
 * (derived only from the complete authenticated part) is ORed into frozen and its serving is served unless frozen; any other
 * error, or a trust_pending without those fields, keeps the state and serves nothing.
 */
export declare function advanceCatalogBindingState(state: CatalogBindingState, result: CatalogBindingGraphResult): CatalogBindingAdvance;
/**
 * The authoring resolve for one claim (design section 2.7): as resolveCatalogBindingGraph, except that a control_history_limit
 * whose heads all reduce to head roots the claim cites is re-resolved without the rotations under those roots and the
 * catalogs bound to them (exactly the rotations the claim closes out). The verifier keeps its head limit.
 */
export declare function resolveCatalogBindingGraphForClaim(input: CatalogBindingGraphInput, claim: CatalogReplacementClaim): Promise<CatalogBindingGraphResult>;
/**
 * Check a candidate claim against a resolved graph for the authoring preflight (rows 352, 354, 356 and the convergence design):
 * pending first, then transition failures, then an omitted head, fork binding or rotation-fork rotation, or an omitted catalog
 * head (catalog_fork), then a prior that is not expected, entries that do not extend every cited prior and every null-cited
 * parent's floor, and a route that a held catalog maps to another replica. Returns null when covered.
 */
export declare function coverCatalogReplacementClaim(graph: CatalogBindingGraph, claim: CatalogReplacementClaim, entries: readonly CatalogEntry[]): string | null;
export {};
