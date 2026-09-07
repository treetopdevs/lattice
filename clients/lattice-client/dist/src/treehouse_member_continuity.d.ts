import type { CarrierOpFrame } from "./carrier";
import type { CarrierOpSigner } from "./codec";
import type { Op } from "./op";
import { type MemberContinuityCertificate, type MemberContinuityClaim } from "./treehouse_member_continuity_codec";
export interface MemberContinuityContext {
    visibleOps: ReadonlyMap<string, Op>;
    verdicts: ReadonlyMap<string, string>;
    validBeacons: readonly Readonly<{
        opId: string;
        epoch: number | string;
    }>[];
}
export type MemberContinuityStatus = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export interface MemberContinuityRecord {
    wrapperId: string;
    certificate: MemberContinuityCertificate;
}
export type MemberContinuityObservation = {
    ok: true;
    replica: string;
    verifiedFrontier: string[];
    records: Array<{
        claimId: string;
        claim: MemberContinuityClaim;
        wrappers: Array<{
            opId: string;
            author: string;
            capId: string | null;
            certificate: MemberContinuityCertificate;
        }>;
    }>;
    links: Array<{
        oldPub: string;
        heads: string[];
        status: "unlinked" | "attested" | "contested" | "review_required" | "capacity_stop";
        affectedWrappers: Array<{
            opId: string;
            reason: string;
        }>;
    }>;
    quarantine: Array<{
        opId: string;
        reason: string;
    }>;
} | {
    ok: false;
    reason: "invalid_verified_history" | "unsupported_continuity_history";
};
export interface MemberContinuityReviewRequest {
    replica: string;
    frames: readonly unknown[];
    oldPub: string;
    oldAdmission: string;
    newPub: string;
    oldMembership: "active" | "removed";
    nonce: string;
    voucherAdmissions: readonly [string, string];
    author: string;
    capId: string;
}
export interface MemberContinuityReview {
    request: MemberContinuityReviewRequest;
    claim: MemberContinuityClaim;
    claimId: string;
    claimBytes: Uint8Array;
    possessionBytes: Uint8Array;
    author: string;
    capId: string;
    verifiedFrontier: string[];
}
export type MemberContinuityReviewResult = {
    ok: true;
    review: MemberContinuityReview;
} | {
    ok: false;
    reason: string;
};
export type MemberContinuityAssemblyResult = {
    ok: true;
    frame: CarrierOpFrame;
    claimId: string;
} | {
    ok: false;
    reason: string;
};
/**
 * The Treehouse.Space application conjunct for one already structurally,
 * capability and holder accepted continuity command. Inputs are judge-produced
 * causal evidence; this function does not authenticate caller-supplied Ops.
 */
export declare function memberContinuityCommandStatus(op: Op, visible: ReadonlySet<string>, context: MemberContinuityContext): MemberContinuityStatus;
/** Complete deterministic loser map over individually honored operations. */
export declare function memberContinuityCommandConflicts(ops: ReadonlyMap<string, Op>, verdicts: ReadonlyMap<string, string>): ReadonlyMap<string, string>;
/** Coalesced unresolved claim heads. Wrapper arrival order never selects one. */
export declare function memberContinuityHeads(records: readonly MemberContinuityRecord[], oldPub: string): string[];
/**
 * Authenticates a complete raw Space history before invoking the ordinary
 * authority/capability judge and this module's application checks. Semantic
 * Ops are never accepted at this public seam.
 */
export declare function observeMemberContinuityFromFrames(input: {
    replica: string;
    frames: readonly unknown[];
    oldPub?: string;
}): Promise<MemberContinuityObservation>;
/** Derive every consent-bearing claim field from one authenticated judged snapshot. */
export declare function reviewMemberContinuityFromFrames(request: MemberContinuityReviewRequest): Promise<MemberContinuityReviewResult>;
/** Recheck consent, preflight an unsigned intent, sign once, then re-fold the public signed history. */
export declare function assembleMemberContinuityFromFrames(input: {
    frames: readonly unknown[];
    review: MemberContinuityReview;
    certificate: unknown;
    signer: CarrierOpSigner;
}): Promise<MemberContinuityAssemblyResult>;
