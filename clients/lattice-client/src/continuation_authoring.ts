import type { CarrierDelegation } from "./carrier";
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

export type ContinuationReviewResult =
  | { ok: true; review: ContinuationReview }
  | { ok: false; reason: string };

export async function reviewContinuationFromFrames(
  _input: ReviewContinuationFromFramesInput,
): Promise<ContinuationReviewResult> {
  return { ok: false, reason: "not_implemented" };
}
