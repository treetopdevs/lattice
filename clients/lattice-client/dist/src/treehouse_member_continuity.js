import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority, continuationFamily, resolveContinuationProfileFromFrames } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { authorCarrierOp, canonicalBase64Bytes, verifyCarrierOp } from "./codec";
import { ancestors, canonicalOrder, concurrent } from "./dag";
import { materialize } from "./materialize";
import { frontier } from "./sync";
import { townshipCapTerm } from "./township";
import { treehouseCommandDecoders, treehouseSpaceSchema } from "./treehouse";
import { memberContinuityClaimId, memberContinuityClaimFromCarrierTerm, canonicalBytesForMemberContinuityClaim, canonicalBytesForMemberContinuityPossession, memberContinuityCommandArgumentsToCarrierTerm, normalizeMemberContinuityCertificate, normalizeMemberContinuityClaim, verifyMemberContinuityCertificate, } from "./treehouse_member_continuity_codec";
const allowed = { ok: true };
const refuse = (reason) => ({ ok: false, reason });
/**
 * The Treehouse.Space application conjunct for one already structurally,
 * capability and holder accepted continuity command. Inputs are judge-produced
 * causal evidence; this function does not authenticate caller-supplied Ops.
 */
export function memberContinuityCommandStatus(op, visible, context) {
    const certificate = certificateFor(op);
    if (certificate === null || certificate.claim.space !== op.replica ||
        !same(certificate.claim.deps, op.deps))
        return refuse("application_invalid_continuity");
    const effective = finalCausalContext(context);
    const claim = certificate.claim;
    const target = targetStatus(claim, visible, effective);
    if (!target.ok)
        return target;
    if (!eligible(claim, effective))
        return refuse("application_continuity_ineligible_member");
    if (!epochValid(claim, effective.validBeacons))
        return refuse("application_continuity_invalid_epoch");
    if (!same(claim.parents, memberContinuityHeads(records(effective), claim.oldPub))) {
        return refuse("application_continuity_stale_context");
    }
    return verifyMemberContinuityCertificate(certificate, claim)
        ? allowed : refuse("application_continuity_invalid_certificate");
}
function finalCausalContext(context) {
    const verdicts = new Map(context.verdicts);
    for (const [id, reason] of memberContinuityCommandConflicts(context.visibleOps, verdicts)) {
        if ((verdicts.get(id) ?? "honored") === "honored")
            verdicts.set(id, reason);
    }
    return { ...context, verdicts };
}
/** Complete deterministic loser map over individually honored operations. */
export function memberContinuityCommandConflicts(ops, verdicts) {
    const byId = new Map(ops);
    const ancestorCache = new Map();
    const candidates = canonicalOrder([...ops.values()], byId)
        .map((id) => byId.get(id))
        .filter((op) => verdicts.get(op.id) === "honored")
        .map((op) => ({ op, certificate: certificateFor(op) }))
        .filter((entry) => entry.certificate !== null);
    const removals = [...ops.values()].filter((op) => verdicts.get(op.id) === "honored");
    const denied = new Map();
    for (const candidate of candidates) {
        const stale = candidate.certificate.claim.vouchers.some((voucher) => removals.some((removal) => removalOf(removal, voucher.member) && concurrent(candidate.op.id, removal.id, byId, ancestorCache) &&
            ancestors(removal.id, byId, ancestorCache).has(voucher.admission)));
        const collision = candidates.some((other) => candidate.certificate.claim.oldPub !== other.certificate.claim.oldPub &&
            candidate.certificate.claim.newPub === other.certificate.claim.newPub &&
            concurrent(candidate.op.id, other.op.id, byId, ancestorCache));
        if (stale)
            denied.set(candidate.op.id, "application_continuity_stale_voucher");
        else if (collision)
            denied.set(candidate.op.id, "application_continuity_conflicting_target");
    }
    for (const candidate of candidates) {
        const invalid = candidate.certificate.claim.parents.some((parent) => !candidates.some((wrapper) => memberContinuityClaimId(wrapper.certificate.claim) === parent &&
            wrapper.certificate.claim.oldPub === candidate.certificate.claim.oldPub &&
            ancestors(candidate.op.id, byId, ancestorCache).has(wrapper.op.id) && !denied.has(wrapper.op.id)));
        if (invalid && !denied.has(candidate.op.id)) {
            denied.set(candidate.op.id, "application_continuity_invalid_parent");
        }
    }
    return denied;
}
/** Coalesced unresolved claim heads. Wrapper arrival order never selects one. */
export function memberContinuityHeads(records, oldPub) {
    const claims = records.filter((record) => record.certificate.claim.oldPub === oldPub)
        .map((record) => record.certificate.claim);
    const superseded = new Set(claims.flatMap((claim) => claim.parents));
    return [...new Set(claims.map(memberContinuityClaimId).filter((id) => id !== null))]
        .filter((id) => !superseded.has(id)).sort();
}
/**
 * Authenticates a complete raw Space history before invoking the ordinary
 * authority/capability judge and this module's application checks. Semantic
 * Ops are never accepted at this public seam.
 */
export async function observeMemberContinuityFromFrames(input) {
    const invalid = { ok: false, reason: "invalid_verified_history" };
    try {
        const snapshot = structuredClone(input);
        const frames = snapshot.frames.map(decodeCarrierOpFrame);
        const ids = new Set(frames.map((frame) => frame.id));
        if (ids.size !== frames.length || frames.some((frame) => frame.replica !== snapshot.replica ||
            frame.deps.some((dependency) => !ids.has(dependency))))
            return invalid;
        for (const frame of frames) {
            const verified = await verifyCarrierOp(frame, { verify: async (author, bytes, signature) => ed25519.verify(signature, bytes, base64ToBytes(author), { zip215: false }) });
            if (!verified.valid)
                return invalid;
        }
        if (continuationFamily(snapshot.replica) !== "space") {
            return { ok: false, reason: "unsupported_continuity_history" };
        }
        if (snapshot.oldPub !== undefined && canonicalBase64Bytes(snapshot.oldPub, 32) === null)
            return invalid;
        const profile = await resolveContinuationProfileFromFrames({ replica: snapshot.replica, frames });
        if (!profile.ok)
            return profile.reason === "invalid_verified_history"
                ? invalid : { ok: false, reason: "unsupported_continuity_history" };
        if (profile.profile.kind !== "space")
            return { ok: false, reason: "unsupported_continuity_history" };
        const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
        const byId = new Map(ops.map((op) => [op.id, op]));
        const rawClaims = new Map(frames.map((frame) => [frame.id, claimFromFrame(frame)]));
        const order = canonicalOrder(ops, byId);
        if (order.length !== ops.length)
            return invalid;
        const judged = materialize(treehouseSpaceSchema, ops, ids, null, snapshot.replica);
        const verdicts = new Map(order.map((id) => [id, judged.quarantineReasons.get(id) ?? "honored"]));
        const grouped = new Map();
        for (const id of order) {
            const op = byId.get(id);
            const certificate = certificateFor(op);
            if (certificate === null || verdicts.get(id) !== "honored")
                continue;
            const claimId = memberContinuityClaimId(certificate.claim);
            const group = grouped.get(claimId) ?? { claim: certificate.claim, wrappers: [] };
            group.wrappers.push({ opId: id, author: op.authorPubkey ?? op.author, capId: op.cap ?? null, certificate });
            grouped.set(claimId, group);
        }
        const rawRecords = [...grouped].flatMap(([, group]) => group.wrappers.map((wrapper) => ({ wrapperId: wrapper.opId, certificate: wrapper.certificate })));
        const oldKeys = new Set(order.map((id) => rawClaims.get(id)?.oldPub)
            .filter((key) => key !== undefined));
        if (snapshot.oldPub !== undefined)
            oldKeys.add(snapshot.oldPub);
        const links = [...oldKeys].sort(compareRawKeys).map((oldPub) => {
            const heads = memberContinuityHeads(rawRecords, oldPub);
            const affectedWrappers = order.filter((id) => rawClaims.get(id)?.oldPub === oldPub && verdicts.get(id) !== "honored")
                .map((opId) => ({ opId, reason: verdicts.get(opId) })).sort((left, right) => compareIds(left.opId, right.opId));
            const reviewRequired = affectedWrappers.some((item) => item.reason === "application_continuity_invalid_parent");
            const status = heads.length > 16 ? "capacity_stop" : reviewRequired ? "review_required" :
                heads.length === 0 ? "unlinked" : heads.length === 1 ? "attested" : "contested";
            return { oldPub, heads, status, affectedWrappers };
        });
        return { ok: true, replica: snapshot.replica, verifiedFrontier: frontier(ops).sort(),
            records: [...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([claimId, group]) => ({ claimId, claim: group.claim, wrappers: group.wrappers.sort((a, b) => a.opId < b.opId ? -1 : 1) })),
            links, quarantine: order.filter((id) => verdicts.get(id) !== "honored")
                .map((opId) => ({ opId, reason: verdicts.get(opId) })).sort((left, right) => compareIds(left.opId, right.opId)) };
    }
    catch {
        return invalid;
    }
}
/** Derive every consent-bearing claim field from one authenticated judged snapshot. */
export async function reviewMemberContinuityFromFrames(request) {
    try {
        if (!validReviewRequest(request))
            return refuse("application_invalid_continuity");
        const frozen = structuredClone(request);
        const observed = await observeMemberContinuityFromFrames({ replica: frozen.replica, frames: frozen.frames, oldPub: frozen.oldPub });
        if (!observed.ok)
            return observed;
        const history = await authenticateJudgedHistory(frozen.replica, frozen.frames);
        if (history === null)
            return refuse("invalid_verified_history");
        // Match the authoring contract: resolve voucher visibility and verdicts before
        // decoding their targets; old-admission precedence belongs to the later claim judge.
        if (frozen.voucherAdmissions.some((id) => !history.byId.has(id)))
            return refuse("application_target_not_visible");
        if (frozen.voucherAdmissions.some((id) => history.projection.quarantineReasons.has(id)))
            return refuse("application_target_quarantined");
        const vouchers = [];
        for (const id of frozen.voucherAdmissions) {
            const op = history.byId.get(id);
            const member = op.commandArgs?.[1];
            if (op.kind !== "command" || op.command !== "admit_member" || typeof member !== "string" ||
                canonicalBase64Bytes(member, 32) === null)
                return refuse("application_wrong_target");
            vouchers.push({ admission: id, member });
        }
        vouchers.sort((left, right) => compareRawKeys(left.member, right.member));
        const beaconValues = history.authority.security.validBeacons.map((beacon) => ({ ...beacon,
            value: typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch) }));
        if (beaconValues.length === 0 || beaconValues.some((beacon) => !Number.isSafeInteger(beacon.value) || beacon.value < 0)) {
            return refuse("application_continuity_invalid_epoch");
        }
        const epoch = Math.max(...beaconValues.map((beacon) => beacon.value));
        const epochBasis = beaconValues.filter((beacon) => beacon.value === epoch).map((beacon) => beacon.opId).sort();
        const parents = observed.links.find((link) => link.oldPub === frozen.oldPub)?.heads ?? [];
        if (parents.length > 16)
            return refuse("continuity_capacity_stop");
        const claim = normalizeMemberContinuityClaim({ version: 1, product: "treehouse", space: frozen.replica,
            oldPub: frozen.oldPub, newPub: frozen.newPub, oldAdmission: frozen.oldAdmission,
            oldMembership: frozen.oldMembership, nonce: frozen.nonce, deps: history.frontier,
            epoch, epochBasis, parents, vouchers });
        if (claim === null)
            return refuse("application_invalid_continuity");
        // The same ordinary candidate judge supplies authority and application refusal
        // precedence after the envelope check, as in the BEAM authoring path.
        const preflightReason = await reviewAuthorityPreflight(history.frames, claim, frozen.author, frozen.capId);
        if (preflightReason !== "application_continuity_invalid_certificate")
            return refuse(preflightReason ?? "stale_verified_state");
        const review = { request: frozen, claim, claimId: memberContinuityClaimId(claim),
            claimBytes: canonicalBytesForMemberContinuityClaim(claim),
            possessionBytes: canonicalBytesForMemberContinuityPossession(claim), author: frozen.author,
            capId: frozen.capId, verifiedFrontier: history.frontier };
        return { ok: true, review };
    }
    catch {
        return refuse("invalid_verified_history");
    }
}
async function reviewAuthorityPreflight(frames, claim, author, capId) {
    const zero = b64(new Uint8Array(64));
    const certificate = { claim, possession: zero, vouches: claim.vouchers.map((voucher) => ({ member: voucher.member, signature: zero })) };
    const args = memberContinuityCommandArgumentsToCarrierTerm(certificate);
    const candidate = await authorCarrierOp({ replica: claim.space, deps: [...claim.deps], kind: "command",
        cap: townshipCapTerm(capId), body: ["tuple", [["atom", "attest_member_key_v1"], args]],
        signer: { publicKey: base64ToBytes(author), sign: () => new Uint8Array(64) } });
    if (envelopeBytes(candidate) > 64_000)
        return "continuity_capacity_stop";
    return (await judgeCandidate(frames, candidate)).quarantineReasons.get(candidate.id);
}
/** Recheck consent, preflight an unsigned intent, sign once, then re-fold the public signed history. */
export async function assembleMemberContinuityFromFrames(input) {
    try {
        const frozen = structuredClone({ frames: input.frames, review: input.review, certificate: input.certificate });
        const current = await reviewMemberContinuityFromFrames({ ...frozen.review.request, frames: frozen.frames });
        if (!current.ok || !equalBytes(current.review.claimBytes, frozen.review.claimBytes) ||
            current.review.claimId !== frozen.review.claimId || !same(current.review.verifiedFrontier, frozen.review.verifiedFrontier)) {
            return refuse("stale_verified_state");
        }
        const certificate = normalizeMemberContinuityCertificate(frozen.certificate);
        if (certificate === null || !verifyMemberContinuityCertificate(certificate, current.review.claim)) {
            return refuse("application_continuity_invalid_certificate");
        }
        const reviewedAuthor = canonicalBase64Bytes(current.review.author, 32);
        if (reviewedAuthor === null || !equalBytes(input.signer.publicKey, reviewedAuthor))
            return refuse("wrong_signer");
        const args = memberContinuityCommandArgumentsToCarrierTerm(certificate);
        if (args === null || args[0] !== "list")
            return refuse("application_invalid_continuity");
        const body = ["tuple", [["atom", "attest_member_key_v1"], args]];
        const placeholder = await authorCarrierOp({ replica: current.review.claim.space, deps: [...current.review.claim.deps],
            kind: "command", cap: townshipCapTerm(current.review.capId), body, signer: { publicKey: input.signer.publicKey,
                sign: () => new Uint8Array(64) } });
        const preflight = await judgeCandidate(frozen.frames, placeholder);
        const preflightReason = preflight.quarantineReasons.get(placeholder.id);
        if (preflightReason !== undefined)
            return refuse(preflightReason);
        if (envelopeBytes(placeholder) > 64_000)
            return refuse("continuity_capacity_stop");
        const frame = await authorCarrierOp({ replica: current.review.claim.space, deps: [...current.review.claim.deps],
            kind: "command", cap: townshipCapTerm(current.review.capId), body, signer: input.signer });
        if (envelopeBytes(frame) > 64_000)
            return refuse("continuity_capacity_stop");
        const final = await observeMemberContinuityFromFrames({ replica: current.review.claim.space,
            frames: [...frozen.frames, frame], oldPub: current.review.claim.oldPub });
        if (!final.ok)
            return refuse(final.reason);
        const wrapper = final.records.flatMap((record) => record.wrappers).find((item) => item.opId === frame.id);
        if (wrapper === undefined)
            return refuse(final.quarantine.find((item) => item.opId === frame.id)?.reason ?? "stale_verified_state");
        return { ok: true, frame, claimId: current.review.claimId };
    }
    catch {
        return refuse("invalid_continuity_input");
    }
}
async function authenticateJudgedHistory(replica, values) {
    const frames = structuredClone(values).map(decodeCarrierOpFrame);
    const ids = new Set(frames.map((frame) => frame.id));
    if (ids.size !== frames.length || frames.some((frame) => frame.replica !== replica || frame.deps.some((dep) => !ids.has(dep))))
        return null;
    for (const frame of frames) {
        if (!(await verifyCarrierOp(frame, { verify: async (author, bytes, signature) => ed25519.verify(signature, bytes, base64ToBytes(author), { zip215: false }) })).valid)
            return null;
    }
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const byId = new Map(ops.map((op) => [op.id, op]));
    const order = canonicalOrder(ops, byId);
    const projection = materialize(treehouseSpaceSchema, ops, ids, null, replica);
    const authority = analyzeAuthority(treehouseSpaceSchema, ops, ids, order, byId, replica);
    return { frames, ops, byId, order, projection, authority, frontier: frontier(ops).sort() };
}
async function judgeCandidate(values, frame) {
    const frames = [...values.map(decodeCarrierOpFrame), frame];
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    return materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, frame.replica);
}
function envelopeBytes(frame) {
    return new TextEncoder().encode(JSON.stringify({ type: "push", ops: [frame] })).length;
}
function b64(bytes) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(bytes).toString("base64");
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
}
const reviewRequestFields = ["replica", "frames", "oldPub", "oldAdmission", "newPub", "oldMembership", "nonce",
    "voucherAdmissions", "author", "capId"].sort();
function validReviewRequest(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        !same(Object.keys(value).sort(), reviewRequestFields))
        return false;
    const request = value;
    const key = (item) => typeof item === "string" && canonicalBase64Bytes(item, 32) !== null;
    return typeof request.replica === "string" && Array.isArray(request.frames) &&
        key(request.author) && key(request.oldPub) && key(request.newPub) && request.oldPub !== request.newPub &&
        key(request.nonce) && canonicalId(request.oldAdmission) && canonicalId(request.capId) &&
        (request.oldMembership === "active" || request.oldMembership === "removed") &&
        Array.isArray(request.voucherAdmissions) && request.voucherAdmissions.length === 2 &&
        new Set(request.voucherAdmissions).size === 2 && request.voucherAdmissions.every(canonicalId);
}
function canonicalId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
        canonicalBase64Bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=", 32) !== null;
}
function compareRawKeys(left, right) {
    const a = canonicalBase64Bytes(left, 32);
    const b = canonicalBase64Bytes(right, 32);
    for (let index = 0; index < 32; index++)
        if (a[index] !== b[index])
            return a[index] - b[index];
    return 0;
}
function compareIds(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function equalBytes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function targetStatus(claim, visible, context) {
    const admissions = [[claim.oldAdmission, claim.oldPub],
        ...claim.vouchers.map((voucher) => [voucher.admission, voucher.member])];
    const parentGroups = claim.parents.map((parent) => ({ parent, wrappers: [...context.visibleOps.values()].filter((op) => {
            const candidate = claimFor(op);
            return candidate !== null && memberContinuityClaimId(candidate) === parent;
        }) }));
    const ids = [...admissions.map(([id]) => id), ...claim.epochBasis];
    if (ids.some((id) => !visible.has(id)) || parentGroups.some((group) => group.wrappers.length === 0)) {
        return refuse("application_target_not_visible");
    }
    if (ids.some((id) => context.verdicts.get(id) !== "honored") || parentGroups.some((group) => !group.wrappers.some((wrapper) => context.verdicts.get(wrapper.id) === "honored"))) {
        return refuse("application_target_quarantined");
    }
    if (admissions.some(([id, key]) => !admissionOf(context.visibleOps.get(id), claim.space, key)) ||
        claim.epochBasis.some((id) => !beaconOf(context.visibleOps.get(id), claim.space)) ||
        parentGroups.some((group) => !group.wrappers.some((wrapper) => {
            const certificate = certificateFor(wrapper);
            return context.verdicts.get(wrapper.id) === "honored" && wrapper.replica === claim.space &&
                certificate.claim.oldPub === claim.oldPub;
        })))
        return refuse("application_wrong_target");
    return allowed;
}
function eligible(claim, context) {
    const admitted = [...context.visibleOps.values()].filter((op) => context.verdicts.get(op.id) === "honored" &&
        admissionOf(op, claim.space, claim.oldPub));
    const active = admitted.some((op) => !removed(op.id, claim.oldPub, context));
    const prior = records(context);
    const parentTarget = prior.some((record) => claim.parents.includes(memberContinuityClaimId(record.certificate.claim)) &&
        record.certificate.claim.oldPub === claim.oldPub && record.certificate.claim.newPub === claim.newPub);
    const used = [...context.visibleOps.values()].some((op) => context.verdicts.get(op.id) === "honored" &&
        admissionOf(op, claim.space, claim.newPub));
    const otherOld = prior.some((record) => record.certificate.claim.oldPub !== claim.oldPub &&
        record.certificate.claim.newPub === claim.newPub);
    return (active ? "active" : "removed") === claim.oldMembership &&
        claim.vouchers.every((voucher) => !removed(voucher.admission, voucher.member, context)) &&
        (!used || parentTarget) && !otherOld;
}
function epochValid(claim, beacons) {
    const values = beacons.map((beacon) => typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch));
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || values.length === 0)
        return false;
    const maximum = Math.max(...values);
    const basis = beacons.filter((_beacon, index) => values[index] === maximum).map((beacon) => beacon.opId).sort();
    return claim.epoch === maximum && same(claim.epochBasis, basis);
}
function removed(tag, key, context) {
    const byId = new Map(context.visibleOps);
    return [...context.visibleOps.values()].some((op) => context.verdicts.get(op.id) === "honored" &&
        removalOf(op, key) && ancestors(op.id, byId).has(tag));
}
function admissionOf(op, replica, key) {
    return op?.replica === replica && op.kind === "command" && op.command === "admit_member" && op.commandArgs?.[1] === key;
}
function removalOf(op, key) {
    return op.kind === "command" && op.command === "remove_member" && op.commandArgs?.[0] === key;
}
function beaconOf(op, replica) {
    return op?.replica === replica && op.kind === "authority" && op.authority?.type === "beacon";
}
function certificateFor(op) {
    if (op.kind !== "command" || op.command !== "attest_member_key_v1" || op.commandArgs?.length !== 3)
        return null;
    return normalizeMemberContinuityCertificate({ claim: op.commandArgs[0], possession: op.commandArgs[1], vouches: op.commandArgs[2] });
}
function claimFor(op) {
    if (op.kind !== "command" || op.command !== "attest_member_key_v1" || op.commandArgs?.length !== 3)
        return null;
    return normalizeMemberContinuityClaim(op.commandArgs[0]);
}
function claimFromFrame(frame) {
    const body = frame.body;
    if (body[0] !== "tuple" || body[1].length !== 2 || body[1][0]?.[0] !== "atom" ||
        body[1][0][1] !== "attest_member_key_v1" || body[1][1]?.[0] !== "list")
        return null;
    const claim = body[1][1][1][0];
    return claim === undefined ? null : memberContinuityClaimFromCarrierTerm(claim);
}
function records(context) {
    const result = [];
    for (const op of context.visibleOps.values()) {
        if (context.verdicts.get(op.id) !== "honored")
            continue;
        const certificate = certificateFor(op);
        if (certificate !== null)
            result.push({ wrapperId: op.id, certificate });
    }
    return result;
}
function same(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
