import type { CarrierTerm } from "./carrier";
export interface ContinuationProfile {
    mode: "bounded_continuation";
    version: 1;
    product: "treehouse";
    kind: "space" | "thread";
    role: "admin" | "moderator";
    nominee: string;
    witnesses: string[];
    threshold: number;
    maxLeaseEpochs: number;
}
export interface ContinuationClaim {
    version: 1;
    product: "treehouse";
    kind: "space" | "thread";
    replica: string;
    role: "admin" | "moderator";
    profileId: string;
    profileGenesis: string;
    holder: string;
    holderEpoch: string;
    successor: string;
    delegationId: string;
    author: string;
    deps: string[];
    epoch: number;
    epochBasis: string[];
}
export interface ContinuationSignature {
    witness: string;
    signature: string;
}
export interface ContinuationCertificate {
    claim: ContinuationClaim;
    signatures: ContinuationSignature[];
}
export declare function continuationProfileToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function continuationProfileFromCarrierTerm(value: unknown): ContinuationProfile | null;
export declare function continuationClaimToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function continuationClaimFromCarrierTerm(value: unknown): ContinuationClaim | null;
export declare function continuationCertificateToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function continuationCertificateFromCarrierTerm(value: unknown): ContinuationCertificate | null;
/** Domain-separated bytes from the existing canonical encoder; no independent codec. */
export declare function canonicalBytesForContinuationProfile(value: unknown): Uint8Array;
export declare function canonicalBytesForContinuationClaim(value: unknown): Uint8Array;
export declare function continuationProfileId(value: unknown): string | null;
/** Cryptographic consent only; the caller independently judges the causal authority history. */
export declare function verifyContinuationCertificate(certificate: unknown, expected: unknown, profile: unknown): boolean;
/** Shape validation only: authority must derive the expected claim from verified history. */
export declare function normalizeContinuationClaim(value: unknown): ContinuationClaim | null;
/** Preserve signature order; quorum, order, membership and validity belong to verification. */
export declare function normalizeContinuationCertificate(value: unknown): ContinuationCertificate | null;
/** Validate the closed profile and copy witnesses into unsigned byte order. */
export declare function normalizeContinuationProfile(value: unknown): ContinuationProfile | null;
