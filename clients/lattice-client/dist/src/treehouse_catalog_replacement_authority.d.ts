import type { CarrierOpFrame } from "./carrier";
import type { AuthorityDelegationEvidence, Op } from "./op";
import type { CatalogReplacementClaim } from "./treehouse_catalog_codec";
export type CatalogReplacementAuthorityPredicate = "profile" | "not_holder" | "wrong_acquisition_cap" | "delegation_unreadable" | "missing_permission" | "live_capability" | "unleased" | "no_beacon" | "epoch_mismatch" | "lease_lapsed" | "inherited_provenance";
export type CatalogReplacementAuthorityResult = null | {
    reason: "catalog_authority_refused" | "wrong_catalog_scope";
    predicate: CatalogReplacementAuthorityPredicate;
};
/** The strict causal prefix: its authenticated frames and their decoded semantic ops (same ids). */
export interface CatalogReplacementPrefix {
    replica: string;
    frames: readonly CarrierOpFrame[];
    ops: readonly Op[];
}
/** The delegation introduced by one authority op, when it is the single delegation with `id`. */
export declare function catalogReplacementAcquiredDelegation(op: Op | undefined, id: string): AuthorityDelegationEvidence | null;
export declare function checkCatalogReplacementAuthority(prefix: CatalogReplacementPrefix, op: {
    author: string;
    cap: string;
}, claim: CatalogReplacementClaim, spaceRoot: string): Promise<CatalogReplacementAuthorityResult>;
/**
 * Monotone refutation for a candidate whose causal closure is incomplete: null keeps it pending. Reads only the held
 * holder_epoch op's own delegation under claim.cap (audience, ceiling, liveness, finite lease).
 */
export declare function refuteCatalogReplacementWithoutClosure(ops: ReadonlyMap<string, Op>, author: string, claim: CatalogReplacementClaim): CatalogReplacementAuthorityPredicate | null;
