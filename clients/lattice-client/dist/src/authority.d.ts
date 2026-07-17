import type { AuthorityDelegationEvidence, Op, WitnessedRecoveryPolicyEvidence, WitnessedSuccessionPolicyEvidence, WitnessedSuccessionArtifactEvidence, WitnessedSuccessionCertificateEvidence, WitnessedSuccessionClaimEvidence, WitnessedSuccessionSignatureEvidence } from "./op";
import type { ReplicaSchema } from "./schema";
/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
    opId: string;
    holder: string;
    holderPubkey?: string;
    atTick?: number;
}
export type DelegationValidation = {
    valid: true;
} | {
    valid: false;
    reason: string;
};
export interface AuthorityDelegationRecord {
    delegation: AuthorityDelegationEvidence | null;
    introductionOpIds: readonly string[];
    invalidIntroductionReasons: ReadonlyMap<string, string>;
    validation: DelegationValidation;
}
export interface AuthorityRootEvidence {
    realm: string;
    pubkey: string;
}
export interface EffectiveRevokeEvidence {
    opId: string;
    delegationId: string;
}
export interface AuthoritySecurityProjection {
    delegations: ReadonlyMap<string, AuthorityDelegationRecord>;
    root: AuthorityRootEvidence | null;
    effectiveRevokes: readonly EffectiveRevokeEvidence[];
}
export interface RecoveryPolicyProjection {
    policy: WitnessedSuccessionPolicyEvidence;
    genesisOperationId: string;
}
export interface AuthorityAnalysis {
    honoredWrites: ReadonlySet<string>;
    quarantinedWrites: ReadonlySet<string>;
    quarantineReasons: ReadonlyMap<string, string>;
    /** Honored acquires per role, in the order they were honored (the oracle's timeline). */
    acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>;
    /** Effective witnessed recovery policy and the valid genesis operation that supplied it. */
    recoveryPoliciesByRole: ReadonlyMap<string, RecoveryPolicyProjection>;
    security: AuthoritySecurityProjection;
}
export interface WitnessedSuccessionReviewSelector {
    replica: string;
    role: "clerk";
    witness: string;
}
export interface WitnessedSuccessionReview {
    claim: WitnessedSuccessionClaimEvidence;
    policyGenesisOperationId: string;
    witness: string;
    threshold: number;
    verifiedFrontier: readonly string[];
}
export type WitnessedSuccessionReviewRefusal = "unsupported_role" | "replica_mismatch" | "no_current_holder" | "recovery_policy_unavailable" | "invalid_recovery_policy" | "witness_not_pinned" | "stale_verified_state" | "authority_analysis_failed";
export type WitnessedSuccessionReviewResult = {
    ok: true;
    review: WitnessedSuccessionReview;
} | {
    ok: false;
    reason: WitnessedSuccessionReviewRefusal;
};
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export declare function analyzeAuthority(schema: ReplicaSchema, ops: Op[], included: ReadonlySet<string>, order: readonly string[], byId: ReadonlyMap<string, Op>): AuthorityAnalysis;
/** Derive a witnessed-succession review solely from a verified local operation set. */
export declare function deriveWitnessedSuccessionReview(schema: ReplicaSchema, ops: Op[], selector: WitnessedSuccessionReviewSelector, priorReview: WitnessedSuccessionReview | null): WitnessedSuccessionReviewResult;
export type WitnessedSuccessionVerificationReason = "invalid_recovery_policy" | "malformed_recovery_certificate" | "unsupported_recovery_version" | "recovery_claim_mismatch" | "recovery_policy_mismatch" | "unknown_recovery_witness" | "duplicate_recovery_witness" | "noncanonical_recovery_signatures" | "invalid_recovery_signature" | "insufficient_recovery_witnesses";
export type WitnessedSuccessionVerification = {
    valid: true;
} | {
    valid: false;
    reason: WitnessedSuccessionVerificationReason;
};
export declare function assembleWitnessedSuccessionArtifact(claim: WitnessedSuccessionClaimEvidence, signature: WitnessedSuccessionSignatureEvidence): WitnessedSuccessionArtifactEvidence;
export declare function exportWitnessedSuccessionArtifactJson(artifact: WitnessedSuccessionArtifactEvidence): string;
export declare function witnessedRecoveryPolicyId(policy: WitnessedRecoveryPolicyEvidence): string | null;
export declare function verifyWitnessedSuccessionCertificate(certificate: WitnessedSuccessionCertificateEvidence | null, expectedClaim: WitnessedSuccessionClaimEvidence, policy: WitnessedRecoveryPolicyEvidence): WitnessedSuccessionVerification;
