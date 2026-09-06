import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBase64Bytes, canonicalBytesForWitnessedBeaconClaim, canonicalBytesForCarrierDelegation, canonicalBytesForWitnessedRecoveryPolicy, canonicalBytesForWitnessedSuccessionArtifactId, canonicalBytesForWitnessedSuccessionClaim, } from "./codec";
import { ancestors, canonicalOrder, index } from "./dag";
import { isAuthorityField } from "./schema";
import { frontier } from "./sync";
import { continuationProfileId, normalizeContinuationCertificate, normalizeContinuationProfile, verifyContinuationCertificate, } from "./continuation";
function emptyRoleState() {
    return { holder: null, acquires: [], heartbeats: [] };
}
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export function analyzeAuthority(schema, ops, included, order, byId, expectedReplica = undefined) {
    const visible = order.map((id) => byId.get(id));
    const replica = authorityReplicaAnchor(visible, expectedReplica);
    const wrongReplicaAuthority = new Map();
    const admitted = visible.filter((op) => {
        if (op.kind !== "authority" || replica === undefined)
            return true;
        // Structured authority events carry embedded evidence naming their
        // replica, so a missing OR mismatched outer replica is judgeable foreign
        // evidence: quarantine as wrong_replica. An evidence-free write is only
        // judgeable when it names a foreign replica outright; one with NO outer
        // replica cannot be judged at all and must stay admitted so the
        // writesPerRole accounting routes it into the V-01 fail-closed refusal
        // (plan 140 vocabulary) instead of a silent quarantine-and-proceed.
        const judgeableForeign = op.authority?.type !== undefined
            ? op.replica !== replica
            : typeof op.replica === "string" && op.replica !== replica;
        if (judgeableForeign) {
            wrongReplicaAuthority.set(op.id, "wrong_replica");
            return false;
        }
        return true;
    });
    const writesPerRole = new Map();
    for (const op of admitted) {
        if (!authorityRoleWrite(schema, op))
            continue;
        writesPerRole.set(op.field, (writesPerRole.get(op.field) ?? 0) + 1);
    }
    const collectedDelegations = collectDelegations(admitted);
    const delegations = validateDelegations(admitted, collectedDelegations, replica);
    const { policies, recoveryPoliciesByRole } = collectPolicies(admitted, delegations);
    const root = resolveRoot(admitted, delegations);
    const { effectiveRevokes, unauthorizedRevokes } = collectRevokes(admitted, delegations, root);
    const { validBeacons, invalidBeacons } = collectBeacons(admitted, byId, root, delegations);
    const continuation = continuationContext(replica, admitted, delegations, root, validBeacons);
    const states = new Map();
    const honoredWrites = new Set();
    const honoredSuccessionIntroductions = new Map();
    const quarantineReasons = delegationQuarantineReasons(delegations);
    collectInvalidGenesisReasons(admitted, delegations, quarantineReasons);
    for (const [opId, reason] of unauthorizedRevokes) {
        quarantineReasons.set(opId, reason);
    }
    for (const [opId, reason] of invalidBeacons) {
        quarantineReasons.set(opId, reason);
    }
    for (const [opId, reason] of wrongReplicaAuthority) {
        quarantineReasons.set(opId, reason);
    }
    const quarantinedWrites = new Set(quarantineReasons.keys());
    for (const op of admitted) {
        if (continuation.family === "unsupported") {
            quarantineReasons.set(op.id, "unsupported_authority_profile");
            quarantinedWrites.add(op.id);
            continue;
        }
        if (op.authorityInputReason !== undefined) {
            quarantineReasons.set(op.id, op.authorityInputReason);
            quarantinedWrites.add(op.id);
            continue;
        }
        if (op.authority?.type === "heartbeat") {
            if (op.kind !== "authority")
                continue;
            // Heartbeats never write a field: they only refresh the holder's
            // last-active tick, and only when the author holds the role at its deps.
            const heartbeat = op.authority;
            const state = states.get(heartbeat.role) ?? emptyRoleState();
            const anc = ancestors(op.id, byId);
            const holderAtDeps = [...state.acquires]
                .reverse()
                .find((acquire) => anc.has(acquire.opId))?.holder;
            if (holderAtDeps === op.author) {
                state.heartbeats.push({ opId: op.id, atTick: heartbeat.atTick });
            }
            states.set(heartbeat.role, state);
            continue;
        }
        if (!authorityRoleWrite(schema, op)) {
            if (op.kind === "authority" && op.authority?.type === "succeed" &&
                (continuation.family !== "legacy" || op.authority.proof.mode === "continuation")) {
                const reason = continuationRejectionReason(op, op.authority, emptyRoleState(), continuation, byId);
                if (reason !== undefined) {
                    quarantineReasons.set(op.id, reason);
                    quarantinedWrites.add(op.id);
                }
            }
            continue;
        }
        const writeCount = writesPerRole.get(op.field) ?? 0;
        if (op.authority === undefined) {
            if (writeCount > 1)
                throw new Error(`missing authority evidence for ${op.id}`);
            const state = states.get(op.field) ?? emptyRoleState();
            if (typeof op.value === "string") {
                state.holder = op.value;
                state.acquires.push({ opId: op.id, holder: op.value, atTick: 0 });
                states.set(op.field, state);
            }
            honoredWrites.add(op.id);
            continue;
        }
        const evidence = op.authority;
        if (evidence.type === "beacon") {
            throw new Error(`beacon ${op.id} cannot write authority role ${op.field}`);
        }
        if (evidence.type === "revoke") {
            throw new Error(`revoke ${op.id} cannot write authority role ${op.field}`);
        }
        const state = states.get(op.field) ?? emptyRoleState();
        const isContinuation = evidence.type === "succeed" &&
            (continuation.family !== "legacy" || evidence.proof.mode === "continuation");
        const continuationReason = isContinuation ? continuationRejectionReason(op, evidence, state, continuation, byId) : undefined;
        const honored = isContinuation ? continuationReason === undefined : authorityWriteHonored(op, evidence, state, delegations, policies, honoredSuccessionIntroductions, byId);
        if (honored) {
            const holder = evidence.delegation.audienceRealm;
            state.holder = holder;
            state.acquires.push(honoredAcquire(op, evidence, holder));
            states.set(op.field, state);
            honoredWrites.add(op.id);
            if (evidence.type === "succeed") {
                const ids = honoredSuccessionIntroductions.get(evidence.delegation.id) ?? [];
                ids.push(op.id);
                honoredSuccessionIntroductions.set(evidence.delegation.id, ids);
            }
        }
        else {
            const reason = isContinuation ? continuationReason : authorityWriteRejectionReason(op, evidence, state, delegations, policies, honoredSuccessionIntroductions, byId);
            if (reason !== undefined)
                quarantineReasons.set(op.id, reason);
            quarantinedWrites.add(op.id);
        }
    }
    for (const op of ops) {
        if (!included.has(op.id))
            continue;
        if (!authorityRoleWrite(schema, op))
            continue;
        if (!honoredWrites.has(op.id) && !quarantinedWrites.has(op.id)) {
            throw new Error(`authority write ${op.id} was not decided`);
        }
    }
    const acquiresByRole = new Map([...states].map(([role, state]) => [role, state.acquires]));
    return {
        honoredWrites,
        quarantinedWrites,
        quarantineReasons,
        acquiresByRole,
        recoveryPoliciesByRole,
        policiesByRole: policies,
        security: {
            delegations,
            root,
            effectiveRevokes: continuation.family === "unsupported" ? [] : effectiveRevokes,
            honoredSuccessionIntroductions,
            validBeacons: continuation.family === "unsupported" ? [] : validBeacons,
        },
    };
}
/** Reserved only within the exact Treehouse Space/Thread namespace. */
export function continuationFamily(replica) {
    if (replica === undefined)
        return "legacy";
    const intended = /^replica:treehouse:(space|thread):([\s\S]*)$/.exec(replica);
    if (intended === null || !intended[2].includes("#authority:"))
        return "legacy";
    const exact = /^replica:treehouse:(space|thread):([A-Za-z0-9_-]{43})#authority:bounded-continuation-v1#root:([A-Za-z0-9_-]{43})$/.exec(replica);
    if (exact === null || !canonicalBase64UrlDigest(exact[2]) ||
        !canonicalBase64UrlDigest(exact[3]) || replicaRootCommitment(replica) !== exact[3])
        return "unsupported";
    return exact[1];
}
function continuationContext(replica, ordered, delegations, root, beacons) {
    const family = continuationFamily(replica);
    const pins = [];
    for (const op of ordered) {
        const evidence = op.authority;
        if (op.kind !== "authority" || evidence?.type !== "genesis")
            continue;
        const d = evidence.delegation;
        const record = delegations.get(d.id);
        const profile = normalizeContinuationProfile(evidence.continuationProfile);
        if (profile !== null && family === profile.kind && record?.validation.valid &&
            record.introductionOpIds.includes(op.id) && op.authorPubkey === root?.pubkey &&
            d.issuer === root?.pubkey && d.audience === root?.pubkey && d.parentId === null &&
            d.expiresEpoch === undefined && !d.live && d.ops.length === 0 && d.roles.length === 0) {
            pins.push({ opId: op.id, profile });
        }
    }
    return { family, pins, delegations, beacons };
}
function continuationPin(ctx, visible) {
    return [...ctx.pins].reverse().find((pin) => visible.has(pin.opId));
}
function continuationExpectedClaim(op, role, d, acquires, ctx, visible, byId) {
    const pin = continuationPin(ctx, visible);
    if (pin === undefined)
        return { ok: false, reason: "continuation_not_configured" };
    const p = [...acquires].reverse().find((acquire) => visible.has(acquire.opId));
    const previousEvidence = p === undefined ? undefined : byId.get(p.opId)?.authority;
    const previous = previousEvidence !== undefined && "delegation" in previousEvidence ? previousEvidence.delegation : undefined;
    if (p?.holderPubkey === undefined || previous === undefined || op.authorPubkey === undefined ||
        role !== pin.profile.role || ![p.holderPubkey, pin.profile.nominee].includes(op.authorPubkey) ||
        d.issuer !== op.authorPubkey || d.audience !== op.authorPubkey || !d.roles.includes(role) ||
        d.replica !== op.replica || !delegationSelfConsistent(d))
        return { ok: false, reason: "unauthorized_continuation" };
    if (d.roles.length !== 1 || !subset(d.ops, previous.ops) || d.live || d.parentId !== null ||
        d.expiresEpoch === undefined)
        return { ok: false, reason: "continuation_scope_exceeded" };
    const beacons = ctx.beacons.filter((b) => visible.has(b.opId));
    const epoch = Math.max(-1, ...beacons.map((b) => b.epoch));
    if (!Number.isSafeInteger(epoch) || epoch < 0)
        return { ok: false, reason: "invalid_continuation_epoch" };
    const claim = {
        version: 1, product: "treehouse", kind: pin.profile.kind, replica: op.replica, role: pin.profile.role,
        profileId: continuationProfileId(pin.profile), profileGenesis: pin.opId,
        holder: p.holderPubkey, holderEpoch: p.opId, successor: d.audience,
        delegationId: d.id, author: op.authorPubkey, deps: [...op.deps].sort(), epoch,
        epochBasis: beacons.filter((b) => b.epoch === epoch).map((b) => b.opId).sort(),
    };
    return { ok: true, claim, profile: pin.profile };
}
function continuationLeaseReason(d, epoch, width) {
    const upper = BigInt(epoch) + BigInt(width) - 1n;
    const maximum = upper > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : upper;
    return d.expiresEpoch !== undefined && Number.isSafeInteger(d.expiresEpoch) && d.expiresEpoch >= epoch &&
        BigInt(d.expiresEpoch) <= maximum ? undefined : "continuation_scope_exceeded";
}
function continuationRejectionReason(op, evidence, state, ctx, byId) {
    if (ctx.family === "unsupported")
        return "unsupported_authority_profile";
    if (ctx.family === "legacy")
        return "unauthorized_continuation";
    if (evidence.proof.mode !== "continuation")
        return "continuation_required";
    const cert = normalizeContinuationCertificate(evidence.proof.certificate);
    const expiry = evidence.delegation.expiresEpoch;
    if (cert === null || expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry < 0))
        return "malformed_term";
    const expected = continuationExpectedClaim(op, evidence.role, evidence.delegation, state.acquires, ctx, ancestors(op.id, byId), byId);
    if (!expected.ok)
        return expected.reason;
    if (cert.claim.epoch !== expected.claim.epoch || JSON.stringify(cert.claim.epochBasis) !== JSON.stringify(expected.claim.epochBasis))
        return "invalid_continuation_epoch";
    const leaseReason = continuationLeaseReason(evidence.delegation, expected.claim.epoch, expected.profile.maxLeaseEpochs);
    if (leaseReason !== undefined)
        return leaseReason;
    if (!verifyContinuationCertificate(cert, expected.claim, expected.profile))
        return "invalid_continuation_certificate";
    return state.acquires.at(-1)?.opId === expected.claim.holderEpoch ? undefined : "stale_continuation";
}
/** Derive only from a complete operation set already authenticated by the carrier verifier. */
export function deriveContinuationReview(schema, ops, replica, role, authorPubkey, deps, delegation) {
    const family = continuationFamily(replica);
    if (family === "unsupported")
        return { ok: false, reason: "unsupported_authority_profile" };
    if (family === "legacy")
        return { ok: false, reason: "unauthorized_continuation" };
    const byId = index(ops);
    if (ops.some((op) => op.replica !== replica || op.deps.some((id) => !byId.has(id))))
        return { ok: false, reason: "invalid_verified_history" };
    if (JSON.stringify([...frontier(ops)].sort()) !== JSON.stringify(deps))
        return { ok: false, reason: "stale_verified_state" };
    const order = canonicalOrder(ops, byId);
    const included = new Set(order);
    const analysis = analyzeAuthority(schema, ops, included, order, byId, replica);
    const ctx = continuationContext(replica, order.map((id) => byId.get(id)), analysis.security.delegations, analysis.security.root, analysis.security.validBeacons);
    const op = { id: "", replica, author: delegation.issuerRealm, authorPubkey, deps,
        kind: "authority", field: role, mutation: "write", value: delegation.audienceRealm, hash: "" };
    const expected = continuationExpectedClaim(op, role, delegation, analysis.acquiresByRole.get(role) ?? [], ctx, included, byId);
    if (!expected.ok)
        return expected;
    const reason = continuationLeaseReason(delegation, expected.claim.epoch, expected.profile.maxLeaseEpochs);
    return reason === undefined ? expected : { ok: false, reason };
}
function authorityReplicaAnchor(ops, expectedReplica) {
    if (expectedReplica !== undefined)
        return expectedReplica;
    const replicas = new Set(ops.map((op) => op.replica));
    if (replicas.size === 0)
        return undefined;
    if (replicas.size === 1)
        return replicas.values().next().value;
    throw new Error("mixed outer replica evidence");
}
/** Derive a witnessed-succession review solely from a verified local operation set. */
export function deriveWitnessedSuccessionReview(schema, ops, selector, priorReview) {
    if (selector.role !== "clerk")
        return refusedReview("unsupported_role");
    if (selector.replica.length === 0 ||
        ops.some((op) => op.replica !== selector.replica)) {
        return refusedReview("replica_mismatch");
    }
    const byId = index(ops);
    if (byId.size !== ops.length ||
        ops.some((op) => op.deps.some((dependency) => !byId.has(dependency)))) {
        return refusedReview("authority_analysis_failed");
    }
    let analysis;
    let orderedOps;
    try {
        const order = canonicalOrder(ops, byId);
        orderedOps = order.map((id) => byId.get(id));
        analysis = analyzeAuthority(schema, ops, new Set(order), order, byId, selector.replica);
    }
    catch {
        return refusedReview("authority_analysis_failed");
    }
    const currentAcquire = analysis.acquiresByRole.get(selector.role)?.at(-1);
    if (currentAcquire?.holderPubkey === undefined ||
        canonicalBase64Bytes(currentAcquire.holderPubkey, 32) === null ||
        !canonicalBase64UrlDigest(currentAcquire.opId)) {
        return refusedReview("no_current_holder");
    }
    const projection = analysis.recoveryPoliciesByRole.get(selector.role);
    if (projection === undefined)
        return refusedReview("recovery_policy_unavailable");
    const policy = normalizeWitnessedSuccessionPolicy(projection.policy);
    if (policy === null)
        return refusedReview("invalid_recovery_policy");
    const policyId = witnessedRecoveryPolicyId(policy.recovery);
    if (policyId === null)
        return refusedReview("invalid_recovery_policy");
    if (canonicalBase64Bytes(selector.witness, 32) === null ||
        !policy.recovery.witnesses.includes(selector.witness)) {
        return refusedReview("witness_not_pinned");
    }
    const review = {
        claim: {
            version: 1,
            replica: selector.replica,
            role: selector.role,
            holder: currentAcquire.holderPubkey,
            holderEpoch: currentAcquire.opId,
            successor: policy.successor,
            policyId,
        },
        policyGenesisOperationId: projection.genesisOperationId,
        witness: selector.witness,
        threshold: policy.recovery.threshold,
        verifiedFrontier: frontier(orderedOps),
    };
    if (priorReview !== null && !sameWitnessedSuccessionReview(priorReview, review)) {
        return refusedReview("stale_verified_state");
    }
    return { ok: true, review };
}
function normalizeWitnessedSuccessionPolicy(policy) {
    const candidate = policy;
    if (typeof candidate !== "object" ||
        candidate === null ||
        !exactKeys(candidate, ["mode", "successorRealm", "successor", "recovery"])) {
        return null;
    }
    const record = candidate;
    const recoveryCandidate = record.recovery;
    if (record.mode !== "witnessed" ||
        typeof record.successorRealm !== "string" ||
        canonicalBase64Bytes(record.successor, 32) === null ||
        typeof recoveryCandidate !== "object" ||
        recoveryCandidate === null) {
        return null;
    }
    const recovery = normalizeWitnessedRecoveryPolicy(recoveryCandidate);
    return recovery === null
        ? null
        : {
            mode: "witnessed",
            successorRealm: record.successorRealm,
            successor: record.successor,
            recovery,
        };
}
function sameWitnessedSuccessionReview(left, right) {
    return (claimBindingMatches(left.claim, right.claim) &&
        left.claim.policyId === right.claim.policyId &&
        left.policyGenesisOperationId === right.policyGenesisOperationId &&
        left.witness === right.witness &&
        left.threshold === right.threshold &&
        left.verifiedFrontier.length === right.verifiedFrontier.length &&
        left.verifiedFrontier.every((id, index) => id === right.verifiedFrontier[index]));
}
function refusedReview(reason) {
    return { ok: false, reason };
}
function honoredAcquire(op, evidence, holder) {
    const acquire = {
        opId: op.id,
        holder,
        holderPubkey: evidence.delegation.audience,
    };
    if (evidence.type === "genesis")
        acquire.atTick = 0;
    if (evidence.type === "transfer")
        acquire.atTick = evidence.atTick;
    if (evidence.type === "succeed" && evidence.proof.mode === "legacy") {
        acquire.atTick = evidence.proof.atTick;
    }
    if (evidence.type === "succeed" && evidence.proof.mode === "continuation" && evidence.proof.certificate !== null) {
        acquire.atTick = evidence.proof.certificate.claim.epoch;
    }
    return acquire;
}
function authorityRoleWrite(schema, op) {
    if (op.kind !== "authority" || op.mutation !== "write")
        return false;
    const spec = schema.fields[op.field];
    return spec !== undefined && isAuthorityField(spec);
}
function authorityWriteHonored(op, evidence, state, delegations, policies, honoredSuccessionIntroductions, byId) {
    if (evidence.type === "heartbeat" ||
        evidence.type === "revoke" ||
        evidence.type === "beacon") {
        return false;
    }
    const delegation = evidence.delegation;
    const validForEvent = validDelegation(delegation, delegations) ||
        (evidence.type === "transfer" &&
            candidateDelegationActivated(delegation, delegations, honoredSuccessionIntroductions, ancestors(op.id, byId), op.field, byId)) ||
        (evidence.type === "succeed" &&
            successionCandidate(delegation, delegations));
    if (delegation.audienceRealm !== op.value ||
        !delegation.roles.includes(op.field) ||
        !validForEvent) {
        return false;
    }
    if (evidence.type === "genesis") {
        return (delegation.parentId === null &&
            delegation.issuer === delegation.audience &&
            delegation.issuerRealm === op.author &&
            op.replica !== undefined &&
            replicaRootMatches(op.replica, delegation.audience));
    }
    if (evidence.type === "transfer" && evidence.role === op.field) {
        const visible = ancestors(op.id, byId);
        const predecessor = [...state.acquires]
            .reverse()
            .find((acquire) => visible.has(acquire.opId));
        return (delegation.issuerRealm === op.author &&
            predecessor?.holder === op.author &&
            state.holder === op.author &&
            (continuationFamily(op.replica) === "legacy" || predecessor?.opId === state.acquires.at(-1)?.opId));
    }
    if (evidence.type === "succeed" && evidence.role === op.field) {
        return (successionRejectionReason(op, evidence, state, delegations, policies, byId) ===
            undefined);
    }
    throw new Error(`unsupported authority event ${evidence.type} for ${op.id}`);
}
function authorityWriteRejectionReason(op, evidence, state, delegations, policies, honoredSuccessionIntroductions, byId) {
    if (evidence.type === "heartbeat" ||
        evidence.type === "revoke" ||
        evidence.type === "beacon") {
        return undefined;
    }
    const delegation = evidence.delegation;
    if (evidence.type === "genesis") {
        if (delegation.parentId !== null &&
            validDelegation(delegation, delegations)) {
            return "invalid_genesis";
        }
        if (delegation.audienceRealm === op.value &&
            delegation.roles.includes(op.field) &&
            validDelegation(delegation, delegations) &&
            delegation.issuerRealm !== op.author) {
            return "unauthorized_genesis";
        }
        return undefined;
    }
    if (evidence.type !== "transfer" || evidence.role !== op.field) {
        return evidence.type === "succeed"
            ? successionRejectionReason(op, evidence, state, delegations, policies, byId)
            : undefined;
    }
    if (delegation.audienceRealm !== op.value ||
        !delegation.roles.includes(op.field) ||
        (!validDelegation(delegation, delegations) &&
            !candidateDelegationActivated(delegation, delegations, honoredSuccessionIntroductions, ancestors(op.id, byId), op.field, byId)) ||
        delegation.issuerRealm !== op.author) {
        return "invalid_transfer";
    }
    const visible = ancestors(op.id, byId);
    const holderAtDeps = [...state.acquires]
        .reverse()
        .find((acquire) => visible.has(acquire.opId))?.holder;
    if (holderAtDeps !== op.author)
        return "transfer_not_holder";
    if (state.holder !== op.author)
        return "double_transfer";
    if (continuationFamily(op.replica) !== "legacy" &&
        [...state.acquires].reverse().find((a) => visible.has(a.opId))?.opId !== state.acquires.at(-1)?.opId)
        return "double_transfer";
    return undefined;
}
function successionRejectionReason(op, evidence, state, delegations, policies, byId) {
    const delegation = evidence.delegation;
    if (evidence.role !== op.field ||
        delegation.audienceRealm !== op.value ||
        !delegation.roles.includes(op.field) ||
        (!validDelegation(delegation, delegations) &&
            !successionCandidate(delegation, delegations)) ||
        delegation.issuerRealm !== op.author ||
        delegation.audienceRealm !== op.author) {
        return "invalid_succession";
    }
    const policy = policies.get(op.field);
    if (policy === undefined || policy.successorRealm !== op.author) {
        return "unauthorized_succession";
    }
    const visible = ancestors(op.id, byId);
    if (evidence.proof.mode === "legacy") {
        if (policy.mode !== "legacy")
            return "recovery_certificate_required";
        const lastActive = Math.max(0, ...state.acquires.flatMap((acquire) => visible.has(acquire.opId) && acquire.atTick !== undefined
            ? [acquire.atTick]
            : []), ...state.heartbeats
            .filter((heartbeat) => visible.has(heartbeat.opId))
            .map((heartbeat) => heartbeat.atTick));
        return evidence.proof.atTick < lastActive + policy.dormantTicks
            ? "premature_succession"
            : undefined;
    }
    if (evidence.proof.mode !== "witnessed")
        return "invalid_succession";
    if (policy.mode !== "witnessed") {
        return "witnessed_recovery_not_configured";
    }
    if (op.replica === undefined)
        return "recovery_claim_mismatch";
    const holderAcquire = [...state.acquires]
        .reverse()
        .find((acquire) => visible.has(acquire.opId));
    const holder = canonicalBase64Bytes(holderAcquire?.holderPubkey, 32);
    const successor = canonicalBase64Bytes(delegation.audience, 32);
    const policySuccessor = canonicalBase64Bytes(policy.successor, 32);
    if (holderAcquire?.holderPubkey === undefined ||
        state.holder !== holderAcquire.holder ||
        holder === null ||
        successor === null ||
        policySuccessor === null ||
        !equalBytes(policySuccessor, successor)) {
        return "recovery_claim_mismatch";
    }
    const policyId = witnessedRecoveryPolicyId(policy.recovery);
    if (policyId === null)
        return "invalid_recovery_policy";
    const expectedClaim = {
        version: 1,
        replica: op.replica,
        role: evidence.role,
        holder: holderAcquire.holderPubkey,
        holderEpoch: holderAcquire.opId,
        successor: delegation.audience,
        policyId,
    };
    const verification = verifyWitnessedSuccessionCertificate(evidence.proof.certificate, expectedClaim, policy.recovery);
    return verification.valid ? undefined : verification.reason;
}
export function assembleWitnessedSuccessionArtifact(claim, signature) {
    if (!validWitnessedSuccessionArtifactInput(claim, signature)) {
        throw new Error("malformed witnessed succession artifact input");
    }
    const orderedClaim = {
        version: claim.version,
        replica: claim.replica,
        role: claim.role,
        holder: claim.holder,
        holderEpoch: claim.holderEpoch,
        successor: claim.successor,
        policyId: claim.policyId,
    };
    return {
        v: 1,
        artifactId: bytesToBase64Url(sha256(canonicalBytesForWitnessedSuccessionArtifactId(orderedClaim, signature.witness))),
        claim: orderedClaim,
        witness: signature.witness,
        signature: signature.signature,
    };
}
export function exportWitnessedSuccessionArtifactJson(artifact) {
    return JSON.stringify({
        v: artifact.v,
        artifactId: artifact.artifactId,
        claim: {
            version: artifact.claim.version,
            replica: artifact.claim.replica,
            role: artifact.claim.role,
            holder: artifact.claim.holder,
            holderEpoch: artifact.claim.holderEpoch,
            successor: artifact.claim.successor,
            policyId: artifact.claim.policyId,
        },
        witness: artifact.witness,
        signature: artifact.signature,
    });
}
function validWitnessedSuccessionArtifactInput(claim, signature) {
    return (typeof claim === "object" &&
        claim !== null &&
        exactKeys(claim, [
            "version",
            "replica",
            "role",
            "holder",
            "holderEpoch",
            "successor",
            "policyId",
        ]) &&
        claim.version === 1 &&
        typeof claim.replica === "string" &&
        claim.replica.length > 0 &&
        claim.role === "clerk" &&
        canonicalBase64Bytes(claim.holder, 32) !== null &&
        canonicalBase64UrlDigest(claim.holderEpoch) &&
        canonicalBase64Bytes(claim.successor, 32) !== null &&
        canonicalBase64UrlDigest(claim.policyId) &&
        typeof signature === "object" &&
        signature !== null &&
        exactKeys(signature, ["witness", "signature"]) &&
        canonicalBase64Bytes(signature.witness, 32) !== null &&
        canonicalBase64Bytes(signature.signature, 64) !== null);
}
export function witnessedRecoveryPolicyId(policy) {
    const normalized = normalizeWitnessedRecoveryPolicy(policy);
    if (normalized === null)
        return null;
    return bytesToBase64Url(sha256(canonicalBytesForWitnessedRecoveryPolicy(normalized)));
}
export function verifyWitnessedSuccessionCertificate(certificate, expectedClaim, policy) {
    const normalized = normalizeWitnessedRecoveryPolicy(policy);
    if (normalized === null)
        return invalidWitnessed("invalid_recovery_policy");
    if (!validCertificateShape(certificate)) {
        return invalidWitnessed("malformed_recovery_certificate");
    }
    if (certificate.claim.version !== 1) {
        return invalidWitnessed("unsupported_recovery_version");
    }
    if (!claimBindingMatches(certificate.claim, expectedClaim)) {
        return invalidWitnessed("recovery_claim_mismatch");
    }
    if (certificate.claim.policyId !== expectedClaim.policyId) {
        return invalidWitnessed("recovery_policy_mismatch");
    }
    const allowed = new Set(normalized.witnesses);
    if (!certificate.signatures.every((entry) => allowed.has(entry.witness))) {
        return invalidWitnessed("unknown_recovery_witness");
    }
    const witnessIds = certificate.signatures.map((entry) => entry.witness);
    if (new Set(witnessIds).size !== witnessIds.length) {
        return invalidWitnessed("duplicate_recovery_witness");
    }
    if (!certificate.signatures.every((entry, index, entries) => index === 0 || compareBase64Evidence(entries[index - 1].witness, entry.witness) < 0)) {
        return invalidWitnessed("noncanonical_recovery_signatures");
    }
    const payload = canonicalBytesForWitnessedSuccessionClaim(certificate.claim);
    try {
        if (!certificate.signatures.every((entry) => ed25519.verify(canonicalBase64Bytes(entry.signature), payload, canonicalBase64Bytes(entry.witness, 32), { zip215: false }))) {
            return invalidWitnessed("invalid_recovery_signature");
        }
    }
    catch {
        return invalidWitnessed("invalid_recovery_signature");
    }
    return certificate.signatures.length >= normalized.threshold
        ? { valid: true }
        : invalidWitnessed("insufficient_recovery_witnesses");
}
function normalizeWitnessedRecoveryPolicy(policy) {
    const witnessEntries = Array.isArray(policy.witnesses)
        ? policy.witnesses.map((witness) => ({ witness, bytes: canonicalBase64Bytes(witness, 32) }))
        : [];
    if (!exactKeys(policy, ["mode", "version", "witnesses", "threshold"]) ||
        policy.mode !== "witnessed" ||
        policy.version !== 1 ||
        !Array.isArray(policy.witnesses) ||
        !Number.isSafeInteger(policy.threshold) ||
        policy.threshold < 1 ||
        policy.threshold > policy.witnesses.length ||
        witnessEntries.some((entry) => entry.bytes === null)) {
        return null;
    }
    const witnessIds = witnessEntries.map((entry) => entry.witness);
    if (new Set(witnessIds).size !== witnessIds.length)
        return null;
    return {
        mode: "witnessed",
        version: 1,
        witnesses: witnessEntries
            .sort((left, right) => compareBytes(left.bytes, right.bytes))
            .map((entry) => entry.witness),
        threshold: policy.threshold,
    };
}
function validCertificateShape(certificate) {
    return (certificate !== null &&
        exactKeys(certificate, ["claim", "signatures"]) &&
        validClaimShape(certificate.claim) &&
        Array.isArray(certificate.signatures) &&
        certificate.signatures.every((entry) => exactKeys(entry, ["witness", "signature"]) &&
            canonicalBase64Bytes(entry.witness, 32) !== null &&
            canonicalBase64Bytes(entry.signature) !== null));
}
function validClaimShape(claim) {
    return (exactKeys(claim, [
        "version",
        "replica",
        "role",
        "holder",
        "holderEpoch",
        "successor",
        "policyId",
    ]) &&
        Number.isSafeInteger(claim.version) &&
        claim.version >= 0 &&
        typeof claim.replica === "string" &&
        typeof claim.role === "string" &&
        canonicalBase64Bytes(claim.holder, 32) !== null &&
        typeof claim.holderEpoch === "string" &&
        canonicalBase64Bytes(claim.successor, 32) !== null &&
        typeof claim.policyId === "string");
}
function claimBindingMatches(claim, expected) {
    return (claim.version === expected.version &&
        claim.replica === expected.replica &&
        claim.role === expected.role &&
        claim.holder === expected.holder &&
        claim.holderEpoch === expected.holderEpoch &&
        claim.successor === expected.successor);
}
function invalidWitnessed(reason) {
    return { valid: false, reason };
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function equalBytes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function compareBytes(left, right) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const difference = left[index] - right[index];
        if (difference !== 0)
            return difference;
    }
    return left.length - right.length;
}
function compareBase64Evidence(left, right) {
    return compareBytes(canonicalBase64Bytes(left), canonicalBase64Bytes(right));
}
/** Succession policies are conferred only by a genesis whose delegation is valid. */
function collectPolicies(ops, delegations) {
    const policies = new Map();
    const recoveryPoliciesByRole = new Map();
    for (const op of ops) {
        const evidence = op.authority;
        if (op.kind !== "authority" ||
            evidence?.type !== "genesis" ||
            evidence.policies === undefined) {
            continue;
        }
        if (!validDelegation(evidence.delegation, delegations) ||
            evidence.delegation.parentId !== null ||
            op.replica === undefined ||
            !replicaRootMatches(op.replica, evidence.delegation.audience) ||
            evidence.delegation.issuerRealm !== op.author) {
            continue;
        }
        for (const [role, policy] of Object.entries(evidence.policies)) {
            policies.set(role, policy);
            if (policy.mode === "witnessed") {
                recoveryPoliciesByRole.set(role, {
                    policy,
                    genesisOperationId: op.id,
                });
            }
            else {
                recoveryPoliciesByRole.delete(role);
            }
        }
    }
    return { policies, recoveryPoliciesByRole };
}
function collectDelegations(ops) {
    const delegations = new Map();
    for (const op of ops) {
        const evidence = op.authority;
        if (op.kind !== "authority" ||
            evidence === undefined ||
            evidence.type === "heartbeat" ||
            evidence.type === "revoke" ||
            evidence.type === "beacon") {
            continue;
        }
        const delegation = evidence.delegation;
        const existing = delegations.get(delegation.id);
        if (!delegationSelfConsistent(delegation)) {
            const record = existing ??
                {
                    delegation: null,
                    introductionOpIds: [],
                    invalidIntroductionReasons: new Map(),
                };
            record.invalidIntroductionReasons.set(op.id, "bad_delegation_sig");
            delegations.set(delegation.id, record);
            continue;
        }
        if (existing === undefined) {
            delegations.set(delegation.id, {
                delegation,
                introductionOpIds: [op.id],
                invalidIntroductionReasons: new Map(),
            });
        }
        else if (existing.delegation === null) {
            existing.delegation = delegation;
            existing.introductionOpIds.push(op.id);
        }
        else if (delegationKey(existing.delegation) === delegationKey(delegation)) {
            existing.introductionOpIds.push(op.id);
        }
        else {
            existing.delegation = null;
        }
    }
    return delegations;
}
function validateDelegations(ops, collected, expectedReplica) {
    const genesisIds = new Set(ops.flatMap((op) => op.kind === "authority" && op.authority?.type === "genesis"
        ? [op.authority.delegation.id]
        : []));
    const successionIds = new Set(ops.flatMap((op) => op.kind === "authority" && op.authority?.type === "succeed"
        ? [op.authority.delegation.id]
        : []));
    // Replica-less Tier-A vectors predate the carrier contract. Only those
    // legacy callers may infer an anchor; paired carrier callers supply it.
    const outerReplica = expectedReplica ?? ops.find((op) => op.replica !== undefined)?.replica;
    const cache = new Map();
    const delegations = new Map();
    for (const [id, record] of collected) {
        delegations.set(id, {
            delegation: record.delegation,
            introductionOpIds: [...record.introductionOpIds],
            invalidIntroductionReasons: new Map(record.invalidIntroductionReasons),
            validation: continuationFamily(outerReplica) === "unsupported" ?
                { valid: false, reason: "unsupported_authority_profile" } : delegationValidation(id, collected, genesisIds, successionIds, outerReplica, cache, new Set()),
        });
    }
    return delegations;
}
function delegationValidation(id, delegations, genesisIds, successionIds, outerReplica, cache, visiting) {
    const cached = cache.get(id);
    if (cached !== undefined)
        return cached;
    const record = delegations.get(id);
    const delegation = record?.delegation;
    if (delegation === undefined || delegation === null) {
        return { valid: false, reason: "bad_delegation_sig" };
    }
    if (visiting.has(id))
        return { valid: false, reason: "invalid_parent" };
    visiting.add(id);
    // A capability scoped to one replica is honored only on that replica's log.
    // Matches Elixir validate_delegation/cap_ok/verify_chain: replica mismatch
    // always rejects, including on legacy unbound log names.
    if (outerReplica !== undefined && delegation.replica !== outerReplica) {
        return { valid: false, reason: "wrong_replica" };
    }
    let validation;
    if (delegation.parentId === null) {
        if (delegation.issuer !== delegation.audience) {
            validation = { valid: false, reason: "nongenesis_root" };
        }
        else if (genesisIds.has(delegation.id) &&
            (outerReplica === undefined ||
                replicaRootMatches(outerReplica, delegation.audience))) {
            validation = { valid: true };
        }
        else if (successionIds.has(delegation.id)) {
            validation = {
                valid: false,
                reason: "succession_candidate",
                successionRootId: delegation.id,
            };
        }
        else if (genesisIds.has(delegation.id)) {
            validation = { valid: false, reason: "impostor_genesis" };
        }
        else {
            validation = { valid: false, reason: "unrooted_delegation" };
        }
    }
    else {
        const parent = delegations.get(delegation.parentId);
        if (parent === undefined) {
            validation = { valid: false, reason: "missing_parent" };
        }
        else if (parent.delegation === null) {
            validation = { valid: false, reason: "invalid_parent" };
        }
        else {
            const parentValidation = delegationValidation(delegation.parentId, delegations, genesisIds, successionIds, outerReplica, cache, visiting);
            if (!delegationAttenuates(delegation, parent.delegation)) {
                validation = { valid: false, reason: "not_attenuated" };
            }
            else if (parentValidation.valid) {
                validation = { valid: true };
            }
            else if (parentValidation.reason === "succession_candidate" &&
                parentValidation.successionRootId !== undefined) {
                validation = {
                    valid: false,
                    reason: "succession_candidate",
                    successionRootId: parentValidation.successionRootId,
                };
            }
            else {
                validation = { valid: false, reason: "invalid_parent" };
            }
        }
    }
    visiting.delete(id);
    cache.set(id, validation);
    return validation;
}
function validDelegation(delegation, delegations) {
    const record = delegations.get(delegation.id);
    return (record !== undefined &&
        record.delegation !== null &&
        delegationKey(record.delegation) === delegationKey(delegation) &&
        record.validation.valid);
}
function successionCandidate(delegation, delegations) {
    const record = delegations.get(delegation.id);
    return (record !== undefined &&
        record.delegation !== null &&
        delegationKey(record.delegation) === delegationKey(delegation) &&
        !record.validation.valid &&
        record.validation.reason === "succession_candidate" &&
        record.validation.successionRootId === delegation.id);
}
function candidateDelegationActivated(delegation, delegations, honoredSuccessionIntroductions, visible, role, byId) {
    const record = delegations.get(delegation.id);
    if (record === undefined ||
        record.delegation === null ||
        delegationKey(record.delegation) !== delegationKey(delegation) ||
        record.validation.valid ||
        record.validation.reason !== "succession_candidate" ||
        record.validation.successionRootId === undefined) {
        return false;
    }
    return (honoredSuccessionIntroductions.get(record.validation.successionRootId) ?? []).some((opId) => visible.has(opId) && byId.get(opId)?.field === role);
}
function resolveRoot(ops, delegations) {
    for (const op of ops) {
        const evidence = op.authority;
        if (op.kind !== "authority" || evidence?.type !== "genesis")
            continue;
        if (!validDelegation(evidence.delegation, delegations))
            continue;
        if (op.replica !== undefined &&
            !replicaRootMatches(op.replica, evidence.delegation.audience)) {
            continue;
        }
        return {
            realm: evidence.delegation.audienceRealm,
            pubkey: evidence.delegation.audience,
        };
    }
    return null;
}
function collectRevokes(ops, delegations, root) {
    const effectiveRevokes = [];
    const unauthorizedRevokes = new Map();
    for (const op of ops) {
        const evidence = op.authority;
        if (op.kind !== "authority" || evidence?.type !== "revoke")
            continue;
        const delegation = delegations.get(evidence.delegationId)?.delegation;
        const authorized = delegation !== undefined &&
            delegation !== null &&
            (op.author === delegation.issuerRealm || op.author === root?.realm);
        if (authorized) {
            effectiveRevokes.push({
                opId: op.id,
                delegationId: evidence.delegationId,
            });
        }
        else {
            unauthorizedRevokes.set(op.id, "unauthorized_revoke");
        }
    }
    return { effectiveRevokes, unauthorizedRevokes };
}
/** Fixed portable logical-epoch horizon, independent of genesis policy. */
export const witnessedBeaconHorizon = Number.MAX_SAFE_INTEGER;
function normalizeBeaconPolicy(policy) {
    if (policy == null ||
        !exactKeys(policy, [
            "mode",
            "version",
            "witnesses",
            "threshold",
            "maxEpochStep",
        ]) ||
        policy.mode !== "witnessed" ||
        policy.version !== 1 ||
        !Array.isArray(policy.witnesses) ||
        policy.witnesses.some((key) => canonicalBase64Bytes(key, 32) === null) ||
        new Set(policy.witnesses).size !== policy.witnesses.length ||
        !Number.isSafeInteger(policy.threshold) ||
        policy.threshold < 1 ||
        policy.threshold > policy.witnesses.length ||
        !Number.isSafeInteger(policy.maxEpochStep) ||
        policy.maxEpochStep < 1 ||
        policy.maxEpochStep > 65_535)
        return null;
    return {
        ...policy,
        witnesses: [...policy.witnesses].sort(compareBase64Evidence),
    };
}
function verifyBeaconCertificate(certificate, expected, policy) {
    if (certificate === null ||
        !exactKeys(certificate, ["claim", "signatures"]) ||
        !exactKeys(certificate.claim, [
            "version",
            "replica",
            "epoch",
            "author",
            "deps",
        ]) ||
        certificate.claim.version !== expected.version ||
        certificate.claim.replica !== expected.replica ||
        certificate.claim.epoch !== expected.epoch ||
        certificate.claim.author !== expected.author ||
        !Array.isArray(certificate.claim.deps) ||
        certificate.claim.deps.length !== expected.deps.length ||
        certificate.claim.deps.some((id, index) => id !== expected.deps[index]) ||
        !Array.isArray(certificate.signatures))
        return false;
    const signatures = certificate.signatures;
    if (signatures.length < policy.threshold ||
        !signatures.every((entry) => exactKeys(entry, ["witness", "signature"]) &&
            canonicalBase64Bytes(entry.witness, 32) !== null &&
            canonicalBase64Bytes(entry.signature, 64) !== null &&
            policy.witnesses.includes(entry.witness)) ||
        !signatures.every((entry, index) => index === 0 ||
            compareBase64Evidence(signatures[index - 1].witness, entry.witness) <
                0))
        return false;
    try {
        const payload = canonicalBytesForWitnessedBeaconClaim(certificate.claim);
        return signatures.every((entry) => ed25519.verify(canonicalBase64Bytes(entry.signature, 64), payload, canonicalBase64Bytes(entry.witness, 32), { zip215: false }));
    }
    catch {
        return false;
    }
}
// Plan 149: beacons in topo order — valid iff root-authored with an integer
// epoch strictly greater than every valid beacon epoch in the op's causal
// ancestry; violators quarantine (:unauthorized_beacon / :stale_beacon) and
// confer no lapse. Mirrors Lattice.Authority.collect_beacons/3.
function collectBeacons(visible, byId, root, delegations, ancCache = new Map()) {
    const validBeacons = [];
    const invalidBeacons = new Map();
    for (const op of visible) {
        const evidence = op.authority;
        if (op.kind !== "authority" || evidence?.type !== "beacon")
            continue;
        const anc = ancestors(op.id, byId, ancCache);
        let priorMax = -1;
        for (const beacon of validBeacons) {
            if (anc.has(beacon.opId) && beacon.epoch > priorMax)
                priorMax = beacon.epoch;
        }
        if (evidence.certificate !== undefined) {
            let policy = null;
            for (const source of visible) {
                const genesis = source.authority;
                if (!anc.has(source.id) ||
                    source.kind !== "authority" ||
                    genesis?.type !== "genesis" ||
                    !validDelegation(genesis.delegation, delegations) ||
                    genesis.delegation.parentId !== null ||
                    !delegations
                        .get(genesis.delegation.id)
                        ?.introductionOpIds.includes(source.id) ||
                    source.author !== genesis.delegation.audienceRealm ||
                    genesis.delegation.audience !== root?.pubkey)
                    continue;
                const candidate = normalizeBeaconPolicy(genesis.beaconPolicy);
                if (candidate !== null)
                    policy = candidate;
            }
            const author = evidence.authorPubkey;
            const expected = {
                version: 1,
                replica: op.replica ?? "",
                epoch: evidence.epoch ?? -1,
                author: author ?? "",
                deps: [...op.deps].sort(),
            };
            if (policy === null ||
                author === undefined ||
                (author !== root?.pubkey && !policy.witnesses.includes(author)) ||
                !verifyBeaconCertificate(evidence.certificate, expected, policy)) {
                invalidBeacons.set(op.id, "unauthorized_beacon");
            }
            else if (evidence.epoch === null ||
                !Number.isSafeInteger(evidence.epoch) ||
                evidence.epoch < 0 ||
                evidence.epoch <= priorMax) {
                invalidBeacons.set(op.id, "stale_beacon");
            }
            else if (evidence.epoch > witnessedBeaconHorizon ||
                evidence.epoch > priorMax + policy.maxEpochStep) {
                invalidBeacons.set(op.id, "unauthorized_beacon");
            }
            else {
                validBeacons.push({ opId: op.id, epoch: evidence.epoch });
            }
        }
        else if (op.author !== root?.realm) {
            invalidBeacons.set(op.id, "unauthorized_beacon");
        }
        else if (evidence.epoch === null ||
            !Number.isSafeInteger(evidence.epoch) ||
            evidence.epoch < 0 ||
            evidence.epoch <= priorMax) {
            invalidBeacons.set(op.id, "stale_beacon");
        }
        else {
            validBeacons.push({ opId: op.id, epoch: evidence.epoch });
        }
    }
    return { validBeacons, invalidBeacons };
}
function delegationQuarantineReasons(delegations) {
    const reasons = new Map();
    for (const record of delegations.values()) {
        for (const [opId, reason] of record.invalidIntroductionReasons) {
            reasons.set(opId, reason);
        }
        if (!record.validation.valid &&
            record.validation.reason !== "succession_candidate" &&
            record.delegation !== null) {
            for (const opId of record.introductionOpIds) {
                reasons.set(opId, record.validation.reason);
            }
        }
    }
    return reasons;
}
function collectInvalidGenesisReasons(ops, delegations, reasons) {
    for (const op of ops) {
        const evidence = op.authority;
        if (op.kind !== "authority" || evidence?.type !== "genesis")
            continue;
        const record = delegations.get(evidence.delegation.id);
        if (record === undefined ||
            record.delegation === null ||
            delegationKey(record.delegation) !== delegationKey(evidence.delegation) ||
            record.invalidIntroductionReasons.has(op.id)) {
            continue;
        }
        if (evidence.delegation.parentId !== null) {
            reasons.set(op.id, "invalid_genesis");
        }
        else if (successionCandidate(evidence.delegation, delegations) &&
            op.replica !== undefined &&
            !replicaRootMatches(op.replica, evidence.delegation.audience)) {
            reasons.set(op.id, "impostor_genesis");
        }
    }
}
function delegationAttenuates(child, parent) {
    return (child.parentId === parent.id &&
        child.issuer === parent.audience &&
        child.replica === parent.replica &&
        subset(child.ops, parent.ops) &&
        subset(child.roles, parent.roles) &&
        (!child.live || parent.live) &&
        expiryWithin(child, parent));
}
// Plan 149: undefined = unbounded. An unbounded parent accepts anything; a
// leased parent accepts only a child leased at or before its own expiry —
// otherwise delegation launders the lease away.
function expiryWithin(child, parent) {
    if (parent.expiresEpoch === undefined)
        return true;
    if (child.expiresEpoch === undefined)
        return false;
    return child.expiresEpoch <= parent.expiresEpoch;
}
function delegationSelfConsistent(delegation) {
    if (delegation.sig === undefined)
        return false;
    try {
        const canonicalBytes = canonicalBytesForCarrierDelegation({
            replica: delegation.replica,
            issuer: delegation.issuer,
            audience: delegation.audience,
            parent_id: delegation.parentId,
            ops: delegation.ops,
            roles: delegation.roles,
            live: delegation.live,
            ...(delegation.expiresEpoch === undefined
                ? {}
                : { expires_epoch: delegation.expiresEpoch }),
        });
        const signature = canonicalBase64Bytes(delegation.sig, 64);
        const issuer = canonicalBase64Bytes(delegation.issuer, 32);
        return (signature !== null &&
            issuer !== null &&
            bytesToBase64Url(sha256(canonicalBytes)) === delegation.id &&
            ed25519.verify(signature, canonicalBytes, issuer, { zip215: false }));
    }
    catch {
        return false;
    }
}
function subset(child, parent) {
    const parentSet = new Set(parent);
    return child.every((value) => parentSet.has(value));
}
function replicaRootMatches(replica, audience) {
    const commitment = replicaRootCommitment(replica);
    if (commitment === null)
        return true;
    if (commitment === false)
        return false;
    const audienceBytes = canonicalBase64Bytes(audience, 32);
    return audienceBytes !== null && bytesToBase64Url(sha256(audienceBytes)) === commitment;
}
function replicaRootCommitment(replica) {
    const marker = "#root:";
    const offset = replica.indexOf(marker);
    if (offset === -1)
        return null;
    const commitment = replica.slice(offset + marker.length);
    return /^[A-Za-z0-9_-]{43}$/.test(commitment) ? commitment : false;
}
function canonicalBase64UrlDigest(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
        return false;
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = canonicalBase64Bytes(padded, 32);
    return decoded !== null && bytesToBase64Url(decoded) === value;
}
function bytesToBase64(value) {
    return typeof Buffer !== "undefined" ? Buffer.from(value).toString("base64") : browserBase64(value);
}
function bytesToBase64Url(value) {
    return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function browserBase64(value) {
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...value));
}
function delegationKey(delegation) {
    return JSON.stringify({
        ...delegation,
        ops: [...delegation.ops].sort(),
        roles: [...delegation.roles].sort(),
    });
}
