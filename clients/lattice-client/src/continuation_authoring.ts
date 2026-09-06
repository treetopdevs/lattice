import { ed25519 } from "@noble/curves/ed25519.js";
import { deriveContinuationReview } from "./authority";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import type { CarrierDelegation } from "./carrier";
import { canonicalBase64Bytes, canonicalBytesForCarrierDelegation, canonicalHash, verifyCarrierOp } from "./codec";
import type { ContinuationClaim, ContinuationProfile } from "./continuation";
import type { AuthorityDelegationEvidence, Op } from "./op";
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

/**
 * Authenticate a complete caller-supplied snapshot, retaining signed semantic
 * refusals, then derive the claim from its exact frontier. This verifies closure;
 * it cannot prove that a caller supplied every operation known elsewhere.
 */
export async function reviewContinuationFromFrames(
  input: ReviewContinuationFromFramesInput,
): Promise<ContinuationReviewResult> {
  try {
    // Freeze the reviewed values before the first asynchronous hash operation.
    const snapshot = structuredClone(input);
    const authenticated = await authenticateHistory(snapshot.frames, snapshot.replica);
    if (!authenticated.ok) return authenticated;
    if (!delegationShape(snapshot.delegation)) return refuse("malformed_term");
    const d = snapshot.delegation;
    const payload = canonicalBytesForCarrierDelegation(d);
    if (await canonicalHash(payload) !== d.id ||
      !verifySignature(d.issuer, payload, canonicalBase64Bytes(d.sig, 64)!)) {
      return refuse("unauthorized_continuation");
    }
    const derived = deriveContinuationReview(snapshot.schema, authenticated.ops, snapshot.replica,
      snapshot.role, snapshot.author, [...snapshot.deps], evidence(d));
    if (!derived.ok) return derived;
    return { ok: true, review: { claim: derived.claim, profile: derived.profile, delegation: d } };
  } catch {
    return refuse("invalid_verified_history");
  }
}

async function authenticateHistory(frames: readonly unknown[], replica: string): Promise<
  { ok: true; ops: Op[] } | { ok: false; reason: string }
> {
  const decoded = frames.map(decodeCarrierOpFrame);
  const ids = new Set(decoded.map((frame) => frame.id));
  if (ids.size !== decoded.length || decoded.some((frame) => frame.replica !== replica ||
    frame.deps.some((dep) => !ids.has(dep)))) return refuse("invalid_verified_history");
  for (const frame of decoded) {
    if (!(await verifyCarrierOp(frame, { verify: async (...args) => verifySignature(...args) })).valid) {
      return refuse("invalid_verified_history");
    }
  }
  // Do not filter quarantine or substitute application materialization for the
  // signed authority history. The authority judge owns semantic admission.
  return { ok: true, ops: carrierOpsToSemanticOps(decoded) };
}

function verifySignature(author: string, bytes: Uint8Array, signature: Uint8Array): boolean {
  const key = canonicalBase64Bytes(author, 32);
  return key !== null && ed25519.verify(signature, bytes, key, { zip215: false });
}

function delegationShape(value: CarrierDelegation): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const required = ["id", "replica", "issuer", "audience", "parent_id", "ops", "roles", "live", "sig"];
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || key === "expires_epoch") &&
    typeof value.id === "string" && typeof value.replica === "string" &&
    canonicalBase64Bytes(value.issuer, 32) !== null && canonicalBase64Bytes(value.audience, 32) !== null &&
    canonicalBase64Bytes(value.sig, 64) !== null &&
    (value.parent_id === null || typeof value.parent_id === "string") &&
    stringSet(value.ops) && stringSet(value.roles) && typeof value.live === "boolean" &&
    (!Object.hasOwn(value, "expires_epoch") ||
      Number.isSafeInteger(value.expires_epoch) && value.expires_epoch! >= 0);
}

function stringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length;
}

function evidence(d: CarrierDelegation): AuthorityDelegationEvidence {
  return { id: d.id, replica: d.replica, issuer: d.issuer, audience: d.audience,
    issuerRealm: d.issuer, audienceRealm: d.audience, parentId: d.parent_id,
    ops: [...d.ops], roles: [...d.roles], live: d.live, sig: d.sig,
    ...(d.expires_epoch === undefined ? {} : { expiresEpoch: d.expires_epoch }) };
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
