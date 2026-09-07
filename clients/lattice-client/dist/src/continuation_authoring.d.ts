import type { CarrierDelegation, CarrierOpFrame } from "./carrier";
import type { CarrierOpSigner } from "./codec";
import type { ContinuationClaim, ContinuationProfile } from "./continuation";
import type { ReplicaSchema } from "./schema";
export interface ContinuationReview {
    claim: ContinuationClaim;
    profile: ContinuationProfile;
    delegation: CarrierDelegation;
}
export interface ReviewContinuationFromFramesInput {
    schema: ReplicaSchema;
    frames: readonly unknown[];
    replica: string;
    role: "admin" | "moderator";
    author: string;
    deps: readonly string[];
    delegation: CarrierDelegation;
}
export type ContinuationReviewResult = {
    ok: true;
    review: ContinuationReview;
} | {
    ok: false;
    reason: string;
};
export interface AssembleContinuationFromFramesInput {
    schema: ReplicaSchema;
    frames: readonly unknown[];
    review: ContinuationReview;
    certificate: unknown;
    signer: CarrierOpSigner;
}
export type ContinuationAssemblyResult = {
    ok: true;
    frame: CarrierOpFrame;
} | {
    ok: false;
    reason: string;
};
/**
 * Reconstruct against the caller's current complete snapshot before signing.
 * The caller owns store/session serialization and must supply current frames;
 * this pure wrapper provides neither a live-store lock nor native signing proof.
 */
export declare function assembleContinuationFromFrames(input: AssembleContinuationFromFramesInput): Promise<ContinuationAssemblyResult>;
/**
 * Authenticate a complete caller-supplied snapshot, retaining signed semantic
 * refusals, then derive the claim from its exact frontier. This verifies closure;
 * it cannot prove that a caller supplied every operation known elsewhere.
 */
export declare function reviewContinuationFromFrames(input: ReviewContinuationFromFramesInput): Promise<ContinuationReviewResult>;
