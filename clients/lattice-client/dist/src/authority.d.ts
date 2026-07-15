import type { Op, WitnessedRecoveryPolicyEvidence, WitnessedSuccessionCertificateEvidence, WitnessedSuccessionClaimEvidence } from "./op";
import type { ReplicaSchema } from "./schema";
/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
    opId: string;
    holder: string;
    holderPubkey?: string;
    atTick?: number;
}
export interface AuthorityAnalysis {
    honoredWrites: ReadonlySet<string>;
    quarantinedWrites: ReadonlySet<string>;
    /** Honored acquires per role, in the order they were honored (the oracle's timeline). */
    acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>;
}
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export declare function analyzeAuthority(schema: ReplicaSchema, ops: Op[], included: ReadonlySet<string>, order: readonly string[], byId: ReadonlyMap<string, Op>): AuthorityAnalysis;
export type WitnessedSuccessionVerificationReason = "invalid_recovery_policy" | "malformed_recovery_certificate" | "unsupported_recovery_version" | "recovery_claim_mismatch" | "recovery_policy_mismatch" | "unknown_recovery_witness" | "duplicate_recovery_witness" | "noncanonical_recovery_signatures" | "invalid_recovery_signature" | "insufficient_recovery_witnesses";
export type WitnessedSuccessionVerification = {
    valid: true;
} | {
    valid: false;
    reason: WitnessedSuccessionVerificationReason;
};
export declare function witnessedRecoveryPolicyId(policy: WitnessedRecoveryPolicyEvidence): string | null;
export declare function verifyWitnessedSuccessionCertificate(certificate: WitnessedSuccessionCertificateEvidence | null, expectedClaim: WitnessedSuccessionClaimEvidence, policy: WitnessedRecoveryPolicyEvidence): WitnessedSuccessionVerification;
