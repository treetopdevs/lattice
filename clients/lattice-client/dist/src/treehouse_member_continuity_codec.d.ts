import type { CarrierTerm } from "./carrier";
/** Detached signed statements only; no membership, authority, freshness or native ceremony proof. */
export interface MemberContinuityClaim {
    version: 1;
    product: "treehouse";
    space: string;
    oldPub: string;
    newPub: string;
    oldAdmission: string;
    oldMembership: "active" | "removed";
    nonce: string;
    deps: string[];
    epoch: number;
    epochBasis: string[];
    parents: string[];
    vouchers: {
        member: string;
        admission: string;
    }[];
}
/** Shape only: an independent authenticated history review must derive every contextual field. */
export declare function normalizeMemberContinuityClaim(value: unknown): MemberContinuityClaim | null;
export interface MemberContinuityCertificate {
    claim: MemberContinuityClaim;
    possession: string;
    vouches: {
        member: string;
        signature: string;
    }[];
}
export declare function normalizeMemberContinuityCertificate(value: unknown): MemberContinuityCertificate | null;
export declare function memberContinuityClaimToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function canonicalBytesForMemberContinuityClaim(value: unknown): Uint8Array;
export declare function canonicalBytesForMemberContinuityPossession(value: unknown): Uint8Array;
export declare function canonicalBytesForMemberContinuityVouch(value: unknown, possession: unknown): Uint8Array;
export declare function memberContinuityClaimId(value: unknown): string | null;
/** Consent verification only. Membership, causal position and permission remain independent. */
export declare function verifyMemberContinuityCertificate(value: unknown, expected: unknown): boolean;
export interface MemberKeyReturnChallenge {
    version: 1;
    product: "treehouse";
    space: string;
    oldPub: string;
    heads: string[];
    deps: string[];
    reviewer: string;
    nonce: string;
}
export declare function normalizeMemberKeyReturnChallenge(value: unknown): MemberKeyReturnChallenge | null;
export declare function memberKeyReturnChallengeToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function canonicalBytesForMemberContinuityReturn(value: unknown): Uint8Array;
/** Exact expected bytes and old-key proof only; no freshness, consumption or authorization claim. */
export declare function verifyMemberKeyReturn(value: unknown, signature: unknown, expected: unknown): boolean;
export declare function memberContinuityClaimFromCarrierTerm(value: unknown): MemberContinuityClaim | null;
/** A valid claim remains target evidence even when its exact-three-argument certificate is malformed. */
export declare function memberContinuityClaimFromDecodedTerm(value: unknown): MemberContinuityClaim | null;
export declare function memberContinuityCertificateToCarrierTerm(value: unknown): CarrierTerm | null;
export declare function memberContinuityCertificateFromCarrierTerm(value: unknown): MemberContinuityCertificate | null;
/** Three exact argument terms only; this neither registers a command nor signs an outer operation. */
export declare function memberContinuityCommandArgumentsToCarrierTerm(value: unknown): CarrierTerm | null;
/** Only the existing decoder's three command arguments; unsupported metadata stays invalid. */
export declare function memberContinuityCertificateFromDecodedArguments(value: unknown): MemberContinuityCertificate | null;
export declare function memberKeyReturnChallengeFromCarrierTerm(value: unknown): MemberKeyReturnChallenge | null;
