import { ed25519 } from "@noble/curves/ed25519.js";
import { deriveContinuationReview } from "./authority";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { authorCarrierOp, canonicalBase64Bytes, canonicalBytesForCarrierDelegation, canonicalHash, verifyCarrierOp } from "./codec";
import { canonicalBytesForContinuationClaim, canonicalBytesForContinuationProfile, continuationCertificateToCarrierTerm, verifyContinuationCertificate } from "./continuation";
import { frontier } from "./sync";
/**
 * Reconstruct against the caller's current complete snapshot before signing.
 * The caller owns store/session serialization and must supply current frames;
 * this pure wrapper provides neither a live-store lock nor native signing proof.
 */
export async function assembleContinuationFromFrames(input) {
    try {
        const snapshot = structuredClone({ schema: input.schema, frames: input.frames,
            review: input.review, certificate: input.certificate });
        const publicKey = new Uint8Array(input.signer.publicKey);
        const sign = input.signer.sign.bind(input.signer);
        const prior = snapshot.review;
        const authenticated = await authenticateHistory(snapshot.frames, prior.claim.replica);
        if (!authenticated.ok)
            return authenticated;
        const current = await deriveReview({ schema: snapshot.schema, replica: prior.claim.replica,
            role: prior.claim.role, author: prior.claim.author, delegation: prior.delegation,
            deps: frontier(authenticated.ops).sort() }, authenticated.ops);
        if (!current.ok)
            return current;
        if (!equalBytes(canonicalBytesForContinuationClaim(prior.claim), canonicalBytesForContinuationClaim(current.review.claim)) ||
            !equalBytes(canonicalBytesForContinuationProfile(prior.profile), canonicalBytesForContinuationProfile(current.review.profile)))
            return refuse("stale_verified_state");
        if (!verifyContinuationCertificate(snapshot.certificate, current.review.claim, current.review.profile)) {
            return refuse("invalid_continuation_certificate");
        }
        const authorKey = canonicalBase64Bytes(current.review.claim.author, 32);
        if (authorKey === null || !equalBytes(publicKey, authorKey))
            return refuse("wrong_signer");
        const frame = await authorCarrierOp({ replica: current.review.claim.replica,
            deps: current.review.claim.deps, kind: "authority", cap: ["nil"], signer: { publicKey, sign },
            body: ["tuple", [["atom", "succeed"], ["atom", current.review.claim.role],
                    ["delegation", current.review.delegation], ["tuple", [["atom", "continuation_v1"],
                            continuationCertificateToCarrierTerm(snapshot.certificate)]]]] });
        if (!(await verifyCarrierOp(frame, { verify: async (...args) => verifySignature(...args) })).valid) {
            return refuse("invalid_signer_signature");
        }
        return { ok: true, frame };
    }
    catch {
        return refuse("invalid_continuation_input");
    }
}
/**
 * Authenticate a complete caller-supplied snapshot, retaining signed semantic
 * refusals, then derive the claim from its exact frontier. This verifies closure;
 * it cannot prove that a caller supplied every operation known elsewhere.
 */
export async function reviewContinuationFromFrames(input) {
    try {
        // Freeze the reviewed values before the first asynchronous hash operation.
        const snapshot = structuredClone(input);
        const authenticated = await authenticateHistory(snapshot.frames, snapshot.replica);
        if (!authenticated.ok)
            return authenticated;
        return await deriveReview(snapshot, authenticated.ops);
    }
    catch {
        return refuse("invalid_verified_history");
    }
}
async function deriveReview(input, ops) {
    if (!delegationShape(input.delegation))
        return refuse("malformed_term");
    const d = input.delegation;
    const payload = canonicalBytesForCarrierDelegation(d);
    if (await canonicalHash(payload) !== d.id ||
        !verifySignature(d.issuer, payload, canonicalBase64Bytes(d.sig, 64))) {
        return refuse("unauthorized_continuation");
    }
    const derived = deriveContinuationReview(input.schema, ops, input.replica, input.role, input.author, [...input.deps], evidence(d));
    if (!derived.ok)
        return derived;
    return { ok: true, review: { claim: derived.claim, profile: derived.profile, delegation: d } };
}
async function authenticateHistory(frames, replica) {
    const decoded = frames.map(decodeCarrierOpFrame);
    const ids = new Set(decoded.map((frame) => frame.id));
    if (ids.size !== decoded.length || decoded.some((frame) => frame.replica !== replica ||
        frame.deps.some((dep) => !ids.has(dep))))
        return refuse("invalid_verified_history");
    for (const frame of decoded) {
        if (!(await verifyCarrierOp(frame, { verify: async (...args) => verifySignature(...args) })).valid) {
            return refuse("invalid_verified_history");
        }
    }
    // Do not filter quarantine or substitute application materialization for the
    // signed authority history. The authority judge owns semantic admission.
    return { ok: true, ops: carrierOpsToSemanticOps(decoded) };
}
function verifySignature(author, bytes, signature) {
    const key = canonicalBase64Bytes(author, 32);
    return key !== null && ed25519.verify(signature, bytes, key, { zip215: false });
}
function delegationShape(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const required = ["id", "replica", "issuer", "audience", "parent_id", "ops", "roles", "live", "sig"];
    return required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => required.includes(key) || key === "expires_epoch") &&
        typeof value.id === "string" && typeof value.replica === "string" &&
        canonicalBase64Bytes(value.issuer, 32) !== null && canonicalBase64Bytes(value.audience, 32) !== null &&
        canonicalBase64Bytes(value.sig, 64) !== null &&
        (value.parent_id === null || typeof value.parent_id === "string") &&
        stringSet(value.ops) && stringSet(value.roles) && typeof value.live === "boolean" &&
        (!Object.hasOwn(value, "expires_epoch") ||
            Number.isSafeInteger(value.expires_epoch) && value.expires_epoch >= 0);
}
function stringSet(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") &&
        new Set(value).size === value.length;
}
function evidence(d) {
    return { id: d.id, replica: d.replica, issuer: d.issuer, audience: d.audience,
        issuerRealm: d.issuer, audienceRealm: d.audience, parentId: d.parent_id,
        ops: [...d.ops], roles: [...d.roles], live: d.live, sig: d.sig,
        ...(d.expires_epoch === undefined ? {} : { expiresEpoch: d.expires_epoch }) };
}
function refuse(reason) {
    return { ok: false, reason };
}
function equalBytes(a, b) {
    return a.length === b.length && a.every((byte, offset) => byte === b[offset]);
}
