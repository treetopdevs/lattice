// TS twin of Treehouse.CatalogReplacementAuthoring (plan 316 PR 2): freeze, derive, review, sign last.
// Unsigned intents are private full-judge inputs; they are never appended or exported. A Core-honored
// result is an authorized signed proposal, not a route switch or installed catalog trust.
// Binding-graph coverage (plan 316 PR 4a-2, rows 352, 354, 356) is resolveCatalogBindingGraph over the frozen history and
// the caller's retained rotations and catalogs, then coverCatalogReplacementClaim; step 4 is
// checkCatalogReplacementAuthority on the frozen history. A retained rotation or catalog the resolver refuses on its own
// bytes still refuses, so nothing is signed over evidence Stage B rejects structurally. Authoring-only: retained-client
// trust waits on 4c. Non-claim: catalog entry facts are not observed against retained histories here (row 354, 4c).
import { verifyEd25519 } from "./signature";
import { analyzeAuthority } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { authorCarrierOp, canonicalBase64Bytes, verifyCarrierOp } from "./codec";
import { ancestors, canonicalOrder } from "./dag";
import { materialize } from "./materialize";
import { compareUtf8 } from "./op";
import { frontier } from "./sync";
import { townshipCapTerm } from "./township";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceSchema } from "./treehouse";
import { deriveTreehouseCatalogCutoff } from "./treehouse_catalog_cutoff";
import { catalogBindingReasonRank, coverCatalogReplacementClaim, resolveCatalogBindingGraph, resolveCatalogBindingGraphForClaim, } from "./treehouse_catalog_binding_graph";
import { checkCatalogReplacementAuthority } from "./treehouse_catalog_replacement_authority";
import { canonicalBytesForCatalogReplacementClaim, canonicalBytesForCatalogReplacementPossession, catalogInventoryId, catalogReplacementClaimToCarrierTerm, catalogRotationId, normalizeCatalogEnvelope, normalizeCatalogReplacementClaim, normalizeCatalogRotationEnvelope, transportCatalogId, verifyCatalogReplacementPossession, } from "./treehouse_catalog_codec";
const requestFields = ["author", "nonce", "parents", "priorCatalogs", "generation", "newCatalogKey", "newServiceId",
    "newServiceKey", "newOrigin", "entries", "replicaHistories", "rotations", "catalogs"].sort();
const zero = () => new Uint8Array(64);
const tooLarge = "catalog_command_too_large";
const refuse = (reason) => ({ ok: false, reason });
/**
 * Review step; signs nothing. Freezes the frontier and derives the authority and recovery claim fields from the
 * judged history; the caller-chosen parents, priorCatalogs and generation are checked against the binding graph
 * (honored bootstrap, retained rotations and catalogs, on-Space replacements honored at their strict prefix).
 */
export async function prepareTreehouseCatalogReplacementFromFrames(input) {
    // Snapshot every input first: a caller mutation while derivation awaits must never mix snapshots, and the attempt
    // must retain the exact request its claim was derived from.
    let snapshot;
    try {
        snapshot = structuredClone(input);
    }
    catch {
        return refuse("application_invalid_catalog");
    }
    try {
        if (!object(snapshot.journal))
            return refuse("application_invalid_catalog");
        const prepared = await derive(snapshot.replica, { frames: snapshot.frames, rejected: snapshot.rejected ?? [] }, snapshot.request, snapshot.journal);
        if (!prepared.ok)
            return prepared;
        const attempt = { ...prepared.attempt, journalEntry: entry(prepared.attempt, "awaiting_possession", null, null) };
        return { ok: true, attempt };
    }
    catch {
        return refuse("invalid_verified_history");
    }
}
/** Re-read, refuse reclassification or a moved claim, verify both possessions, preflight, then sign once. */
export async function authorTreehouseCatalogReplacementFromFrames(input) {
    // Snapshot the caller's attempt: a mutation during the async signer must never reach the post-sign checks.
    // Possessions are snapshotted with it, so validation, preflight and signing all see the same signatures.
    let attempt, possessionInput;
    try {
        attempt = structuredClone(input.attempt);
        possessionInput = structuredClone(input.possession);
    }
    catch {
        return { ok: false, reason: "stale_verified_state", journalEntry: entry(null, "cancelled", "stale_verified_state", null) };
    }
    if (!attemptShape(attempt))
        return { ok: false, reason: "stale_verified_state", journalEntry: entry(null, "cancelled", "stale_verified_state", null) };
    const cancel = (reason) => ({ ok: false, reason, journalEntry: entry(attempt, "cancelled", reason, null) });
    let candidate, claim;
    try {
        const current = await read(input.currentFrames, attempt.replica);
        if (!current.ok)
            return cancel(current.reason);
        const before = await reclassified(current.history, attempt, null);
        if (before !== null)
            return cancel(before);
        const fresh = await derive(attempt.replica, current.raw, attempt.request, null);
        if (!fresh.ok)
            return cancel(fresh.reason === "invalid_verified_history" ? fresh.reason : "stale_verified_state");
        if (!samePrepared(fresh.attempt, attempt))
            return cancel("stale_verified_state");
        // Sign only the freshly derived claim, never the caller-held copy.
        claim = fresh.attempt.claim;
        const possession = possessionInput;
        if (!object(possession) || !same(Object.keys(possession).sort(), ["catalog", "service"]) ||
            !verifyCatalogReplacementPossession(claim, possession.catalog, possession.service))
            return cancel("invalid_possession");
        const author = canonicalBase64Bytes(attempt.author, 32);
        if (author === null || !equalBytes(input.signer.publicKey, author))
            return cancel("wrong_signer");
        candidate = await intent(claim, possession.catalog, possession.service, { publicKey: author, sign: zero });
        if (envelopeBytes(candidate) > 64_000)
            return cancel(tooLarge);
        const reason = (await judgeCandidate(current.history.frames, candidate)).quarantineReasons.get(candidate.id);
        if (reason !== undefined)
            return cancel(reason);
    }
    catch {
        return cancel("invalid_verified_history");
    }
    let frame;
    try {
        const possession = possessionInput;
        frame = await intent(claim, possession.catalog, possession.service, input.signer);
    }
    catch {
        return cancel("signer_failed");
    }
    try {
        if (frame.id !== candidate.id || !(await verifyCarrierOp(frame, { verify: async (author, bytes, signature) => verifyEd25519(signature, bytes, base64ToBytes(author)) })).valid)
            return cancel("invalid_signer_signature");
    }
    catch {
        return cancel("invalid_signer_signature");
    }
    // The signed frame leaves only if the freshly re-read frozen state is still unreclassified.
    const late = (reason) => ({ ok: false, reason, journalEntry: entry(attempt, "cancelled_after_signature", reason, null) });
    try {
        const current = await read(input.currentFrames, attempt.replica);
        if (!current.ok)
            return late(current.reason);
        const after = await reclassified(current.history, attempt, frame);
        if (after !== null)
            return late(after);
        // The signed claim must still be the one a fresh preparation derives now.
        const again = await derive(attempt.replica, current.raw, attempt.request, null);
        if (!again.ok)
            return late(again.reason === "invalid_verified_history" ? again.reason : "stale_verified_state");
        if (!samePrepared(again.attempt, attempt))
            return late("stale_verified_state");
        if (envelopeBytes(frame) > 64_000)
            return late(tooLarge);
        const unresolved = await resolvesSigned(current.history, attempt.replica, attempt.request, frame);
        if (unresolved !== null)
            return late(unresolved);
        return { ok: true, frame, bindingId: frame.id, attemptId: attempt.attemptId, journalEntry: entry(attempt, "signed", null, frame.id) };
    }
    catch {
        return late("stale_verified_state");
    }
}
// --- derive -------------------------------------------------------------------
async function derive(replica, space, value, journal) {
    if (!requestShape(value))
        return refuse("application_invalid_catalog");
    const request = value;
    const history = await authenticateJudgedHistory(replica, space.frames);
    if (history === null)
        return refuse("invalid_verified_history");
    const deps = history.frontier;
    const observed = await treehouseCatalogBootstrapsFromFrames({ replica, frames: history.frames });
    if (!observed.ok)
        return observed;
    if (observed.bootstraps.length !== 1)
        return refuse("application_invalid_catalog");
    const bootstrap = observed.bootstraps[0];
    // Holder and capability come from the judge only; the caller never supplies either.
    const acquire = history.authority.acquiresByRole.get("admin")?.at(-1);
    if (acquire === undefined || acquire.holderPubkey !== request.author)
        return refuse("not_holder");
    const evidence = history.byId.get(acquire.opId)?.authority;
    const cap = evidence !== undefined && "delegation" in evidence ? evidence.delegation.id : undefined;
    if (typeof cap !== "string")
        return refuse("not_holder");
    const beacons = history.authority.security.validBeacons;
    if (beacons.length === 0)
        return refuse("catalog_epoch_missing");
    const values = beacons.map((beacon) => typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch));
    const epoch = Math.max(...values);
    const epochBasis = beacons.filter((_beacon, index) => values[index] === epoch).map((beacon) => beacon.opId).sort(compareUtf8);
    let inventoryDigest;
    try {
        if (!request.entries.every((item) => object(item) && item.serviceId === request.newServiceId && item.serviceKey === request.newServiceKey) ||
            !request.entries.some((item) => item.kind === "space") ||
            // The Space entry is the one a first catalog can carry: its reference must be the bootstrap.
            !request.entries.every((item) => item.kind !== "space" || (item.replica === replica && item.reference === bootstrap.id))) {
            return refuse("application_invalid_catalog");
        }
        inventoryDigest = catalogInventoryId(request.entries);
    }
    catch {
        return refuse("application_invalid_catalog");
    }
    const cutoffs = await deriveCutoffs(replica, space, request);
    if (!cutoffs.ok)
        return cutoffs;
    const claim = normalizeCatalogReplacementClaim({ version: 1, product: "treehouse", space: replica, bootstrap: bootstrap.id,
        profileGenesis: bootstrap.record.profileGenesis, profileId: bootstrap.record.profileId, parents: request.parents,
        priorCatalogs: request.priorCatalogs, generation: request.generation, nonce: request.nonce, newCatalogKey: request.newCatalogKey,
        newServiceId: request.newServiceId, newServiceKey: request.newServiceKey, newOrigin: request.newOrigin, inventoryDigest,
        cutoffs: cutoffs.cutoffs, author: request.author, cap, holderEpoch: acquire.opId, deps, epoch, epochBasis });
    if (claim === null)
        return refuse("malformed_catalog");
    // Plan 316 section 3 step 4 on the frozen history, which is the action's strict prefix.
    const authority = await checkCatalogReplacementAuthority({ replica, frames: history.frames, ops: history.ops }, { author: request.author, cap }, claim, bootstrap.record.spaceRoot);
    if (authority !== null)
        return refuse(authority.reason);
    const covered = await coverage(history, replica, bootstrap, claim, request);
    if (covered !== null)
        return refuse(covered);
    const claimBytes = canonicalBytesForCatalogReplacementClaim(claim);
    // The journal is caller-owned and may be lost or belong to another device, so a nonce already carried by a retained
    // replacement of this Space and bootstrap that Core honored at its strict prefix (binding-node eligibility) is reused
    // regardless of the journal. A raw, unauthorized proposal reserves nothing.
    if (history.ops.some((op) => {
        if (op.command !== "replace_catalog_v1")
            return false;
        const cited = normalizeCatalogReplacementClaim(op.commandArgs?.[0]);
        return cited !== null && cited.nonce === claim.nonce && cited.space === replica && cited.bootstrap === bootstrap.id &&
            honoredAtPrefix(history, op.id, replica);
    }))
        return refuse("attempt_nonce_reused");
    // The attempt journal is keyed by the claim nonce; identical bytes are an idempotent retry.
    const prior = journal === null ? undefined : Object.hasOwn(journal, claim.nonce) ? journal[claim.nonce] : undefined;
    if (prior !== undefined && !(prior.claimBytes instanceof Uint8Array && equalBytes(prior.claimBytes, claimBytes))) {
        return refuse("attempt_nonce_reused");
    }
    // The possession and op-signature slots are fixed at 64 bytes, so the placeholder sizes the frame exactly.
    const zeroB64 = b64(zero());
    const placeholder = await intent(claim, zeroB64, zeroB64, { publicKey: base64ToBytes(request.author), sign: zero });
    if (envelopeBytes(placeholder) > 64_000)
        return refuse(tooLarge);
    const reason = (await judgeCandidate(history.frames, placeholder)).quarantineReasons.get(placeholder.id);
    if (reason !== "application_invalid_catalog")
        return refuse(reason ?? "invalid_review_intent");
    return { ok: true, attempt: { attemptId: claim.nonce, status: "awaiting_possession", replica, request, claim, claimBytes,
            catalogPossessionBytes: canonicalBytesForCatalogReplacementPossession("catalog", claim),
            servicePossessionBytes: canonicalBytesForCatalogReplacementPossession("service", claim),
            author: request.author, cap, frozenFrontier: deps } };
}
// --- retained-evidence coverage (plan 316 PR 4a-2) ------------------------------------------------------------------
const maxArtifacts = 1_024;
async function coverage(history, replica, bootstrap, claim, request) {
    // CatalogTrust refuses more than 1,024 retained artifacts; its JSON byte budgets are not mirrored here (row 355).
    if (request.catalogs.length + request.rotations.length > maxArtifacts)
        return "control_history_limit";
    const held = retained(replica, bootstrap, request);
    if (!held.ok)
        return held.reason;
    // resolveCatalogBindingGraphForClaim keeps the verifier's head limit but lets a claim citing every head root through it
    // (design section 2.7): three old-key rotations under the accepted binding cannot block the resolution that closes them out.
    const resolved = await resolveCatalogBindingGraphForClaim({ bootstrap, frames: history.frames, rotations: held.rotations,
        catalogs: held.catalogs, provenCutoffs: [], accepted: null }, claim);
    if (!resolved.ok)
        return resolved.reason;
    const refused = [...resolved.graph.refusals].filter(([, r]) => r.reason !== "catalog_authority_refused")
        .sort(([a, x], [b, y]) => catalogBindingReasonRank(x.reason) - catalogBindingReasonRank(y.reason) || compareUtf8(a, b));
    if (refused.length > 0)
        return refused[0][1].reason;
    return coverCatalogReplacementClaim(resolved.graph, claim, request.entries);
}
// After signing: the full retained evidence with the signed frame appended must resolve with it as the sole binding head and
// no fork (the verifier's view, head limit included). Its first catalog and cutoff proofs are not held here, so promotion
// itself is not checked.
async function resolvesSigned(history, replica, request, frame) {
    const observed = await treehouseCatalogBootstrapsFromFrames({ replica, frames: history.frames });
    if (!observed.ok || observed.bootstraps.length !== 1)
        return "application_invalid_catalog";
    const bootstrap = observed.bootstraps[0];
    const held = retained(replica, bootstrap, request);
    if (!held.ok)
        return held.reason;
    const resolved = await resolveCatalogBindingGraph({ bootstrap, frames: [...history.frames, frame], rotations: held.rotations,
        catalogs: held.catalogs, provenCutoffs: [], accepted: null });
    if (!resolved.ok)
        return resolved.reason;
    const g = resolved.graph;
    return g.heads.length === 1 && g.heads[0] === frame.id && g.forks.length === 0 ? null : "catalog_fork";
}
function retained(replica, bootstrap, request) {
    const rotations = new Map();
    for (const value of request.rotations) {
        const envelope = normalizeCatalogRotationEnvelope(value);
        if (envelope === null)
            return { ok: false, reason: "malformed_catalog" };
        if (envelope.rotation.space !== replica || envelope.rotation.bootstrap !== bootstrap.id)
            return { ok: false, reason: "wrong_catalog_scope" };
        rotations.set(catalogRotationId(envelope), envelope);
    }
    // A catalog id covers the payload only. As in CatalogTrust addCatalog, a repeated id must carry the identical
    // signature; any differing copy (even a second valid one) refuses.
    const catalogs = new Map();
    for (const value of request.catalogs) {
        const envelope = normalizeCatalogEnvelope(value);
        if (envelope === null)
            return { ok: false, reason: "malformed_catalog" };
        if (envelope.catalog.space !== replica || envelope.catalog.bootstrap !== bootstrap.id)
            return { ok: false, reason: "wrong_catalog_scope" };
        const id = transportCatalogId(envelope.catalog), known = catalogs.get(id);
        if (known === undefined)
            catalogs.set(id, envelope);
        else if (known.signature !== envelope.signature)
            return { ok: false, reason: "invalid_catalog_signature" };
    }
    return { ok: true, rotations, catalogs };
}
function honoredAtPrefix(history, id, replica) {
    const closure = ancestors(id, history.byId, new Map());
    const frames = history.frames.filter((frame) => frame.id === id || closure.has(frame.id));
    return !judge(frames, replica).quarantineReasons.has(id);
}
// The Space cutoff is the frozen pre-action history itself, so it never includes the action.
async function deriveCutoffs(replica, space, request) {
    const supplied = Object.keys(request.replicaHistories);
    const replicas = [replica, ...supplied].sort(compareUtf8);
    if (supplied.includes(replica) || !same(replicas, request.entries.map((item) => item.replica).sort(compareUtf8))) {
        return refuse("recovery_incomplete");
    }
    const cutoffs = [];
    for (const item of replicas) {
        const retained = item === replica ? space : request.replicaHistories[item];
        if (!object(retained) || !Array.isArray(retained.frames) || !Array.isArray(retained.rejected))
            return refuse("recovery_incomplete");
        const derived = await deriveTreehouseCatalogCutoff({ replica: item, frames: retained.frames, rejected: retained.rejected });
        if (!derived.ok)
            return refuse(derived.reason);
        cutoffs.push(derived.cutoff);
    }
    return { ok: true, cutoffs };
}
async function intent(claim, catalog, service, signer) {
    const body = ["tuple", [["atom", "replace_catalog_v1"], ["list", [catalogReplacementClaimToCarrierTerm(claim),
                    ["bin", catalog], ["bin", service]]]]];
    return authorCarrierOp({ replica: claim.space, deps: [...claim.deps], kind: "command", cap: townshipCapTerm(claim.cap), body, signer });
}
// --- author -------------------------------------------------------------------
async function read(source, replica) {
    let raw;
    try {
        const value = await source();
        raw = Array.isArray(value) ? { frames: value, rejected: [] } : value;
        if (!object(raw) || !Array.isArray(raw.frames) || !Array.isArray(raw.rejected))
            return refuse("stale_verified_state");
    }
    catch {
        return refuse("stale_verified_state");
    }
    const history = await authenticateJudgedHistory(replica, raw.frames);
    // Retained bad-signature evidence is validated on every read, as BEAM's Log.verify_authenticity does.
    const evidence = await deriveTreehouseCatalogCutoff({ replica, frames: raw.frames, rejected: raw.rejected });
    if (!evidence.ok && evidence.reason === "invalid_verified_history")
        return refuse("invalid_verified_history");
    return history === null ? refuse("invalid_verified_history") : { ok: true, raw, history };
}
// C13: an op honored in the frozen analysis that the union quarantines, a moved admin holder epoch,
// or a Core refusal of the action itself on the union cancels the attempt.
async function reclassified(current, attempt, signed) {
    if (attempt.frozenFrontier.length === 0 || attempt.frozenFrontier.some((id) => !current.byId.has(id)))
        return "stale_verified_state";
    const closure = new Set(attempt.frozenFrontier);
    const cache = new Map();
    for (const id of attempt.frozenFrontier)
        for (const ancestor of ancestors(id, current.byId, cache))
            closure.add(ancestor);
    const frozen = judge(current.frames.filter((frame) => closure.has(frame.id)), attempt.replica);
    const union = signed === null || current.byId.has(signed.id) ? current
        : await authenticateJudgedHistory(attempt.replica, [...current.frames, signed]);
    if (union === null)
        return "authority_changed";
    if ([...closure].some((id) => !frozen.quarantineReasons.has(id) && union.projection.quarantineReasons.has(id)))
        return "authority_changed";
    const acquire = union.authority.acquiresByRole.get("admin")?.at(-1);
    if (acquire?.opId !== attempt.claim.holderEpoch || acquire.holderPubkey !== attempt.author)
        return "authority_changed";
    if (signed !== null)
        return union.projection.quarantineReasons.has(signed.id) ? "authority_changed" : null;
    const zeroB64 = b64(zero());
    const placeholder = await intent(attempt.claim, zeroB64, zeroB64, { publicKey: base64ToBytes(attempt.author), sign: zero });
    const reason = (await judgeCandidate(union.frames, placeholder)).quarantineReasons.get(placeholder.id);
    return reason === "application_invalid_catalog" ? null : "authority_changed";
}
// Every changed dep, key, cutoff, inventory or acquisition changes these bytes.
function samePrepared(fresh, attempt) {
    return equalBytes(canonicalBytesForCatalogReplacementClaim(attempt.claim), fresh.claimBytes) && fresh.attemptId === attempt.attemptId && fresh.author === attempt.author && fresh.cap === attempt.cap &&
        same(fresh.frozenFrontier, attempt.frozenFrontier) && equalBytes(fresh.claimBytes, attempt.claimBytes) &&
        equalBytes(fresh.catalogPossessionBytes, attempt.catalogPossessionBytes) &&
        equalBytes(fresh.servicePossessionBytes, attempt.servicePossessionBytes);
}
function attemptShape(value) {
    if (!object(value))
        return false;
    const attempt = value;
    return typeof attempt.attemptId === "string" && typeof attempt.replica === "string" && object(attempt.request) &&
        normalizeCatalogReplacementClaim(attempt.claim) !== null && attempt.claimBytes instanceof Uint8Array &&
        attempt.catalogPossessionBytes instanceof Uint8Array && attempt.servicePossessionBytes instanceof Uint8Array &&
        typeof attempt.author === "string" && typeof attempt.cap === "string" && Array.isArray(attempt.frozenFrontier);
}
function requestShape(value) {
    if (!object(value) || !same(Object.keys(value).sort(), requestFields))
        return false;
    return typeof value.author === "string" && canonicalBase64Bytes(value.author, 32) !== null &&
        Array.isArray(value.entries) && object(value.replicaHistories) && Array.isArray(value.rotations) && Array.isArray(value.catalogs);
}
function entry(attempt, status, reason, opId) {
    return { attemptId: attempt?.attemptId ?? null, claimBytes: attempt?.claimBytes ?? null, status, reason, opId };
}
async function authenticateJudgedHistory(replica, values) {
    const frames = structuredClone(values).map(decodeCarrierOpFrame);
    const ids = new Set(frames.map((frame) => frame.id));
    if (ids.size !== frames.length || frames.some((frame) => frame.replica !== replica || frame.deps.some((dep) => !ids.has(dep))))
        return null;
    for (const frame of frames) {
        if (!(await verifyCarrierOp(frame, { verify: async (author, bytes, signature) => verifyEd25519(signature, bytes, base64ToBytes(author)) })).valid)
            return null;
    }
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const byId = new Map(ops.map((op) => [op.id, op]));
    const order = canonicalOrder(ops, byId);
    if (order.length !== ops.length)
        return null;
    const projection = materialize(treehouseSpaceSchema, ops, ids, null, replica);
    const authority = analyzeAuthority(treehouseSpaceSchema, ops, ids, order, byId, replica);
    return { frames, ops, byId, order, projection, authority, frontier: frontier(ops).sort(compareUtf8) };
}
function judge(frames, replica) {
    const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Space"));
    return materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, replica);
}
async function judgeCandidate(values, frame) {
    return judge([...values.map(decodeCarrierOpFrame), frame], frame.replica);
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
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function equalBytes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
