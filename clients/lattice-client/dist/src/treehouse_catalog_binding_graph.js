// TS twin of Treehouse.CatalogBindingGraph (plan 316 PR 4a): the pure binding-graph resolver for replace_catalog_v1
// (steps 1-3 and 5-9, D-270, D-275 to D-279, OD-16, OD-17, row 320, and the rows 382/383 convergence design). Not wired:
// treehouse_catalog_trust.ts does not call it yet (4c), so it changes no route, watermark or retained-client behaviour,
// and it produces no route. It adds no Core primitive, wire atom or quarantine reason. Both runtimes are pinned to the same
// hand-written label-space expectations and to each other's outputs by binding_graph_v1.json / binding_graph_ts_v1.json.
//
// One causal evaluation: a single memoized judgment covers rotations, candidates and catalogs, and every verdict reads
// only the artifact's bytes and its causal ancestry (D-279). An invalid cited prior makes a replacement raw evidence and a
// rotation a retained refusal. A catalog extends its binding's floor and no route in its own ancestry names two replicas.
// Union classification only reclassifies. The decision is derived on every call from the union and the persisted
// watermark; advanceCatalogBindingState is the merge rule over {accepted, frozen} (row 383). This module persists nothing.
import { analyzeAuthority } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { canonicalBase64Bytes, verifyCarrierOp } from "./codec";
import { ancestors, canonicalOrder, index } from "./dag";
import { materialize } from "./materialize";
import { compareUtf8 } from "./op";
import { verifyEd25519 } from "./signature";
import { treehouseCommandDecoders, treehouseSpaceSchema } from "./treehouse";
import { canonicalBytesForCatalogReplacementClaim, canonicalBytesForCatalogRotation, canonicalBytesForCatalogRotationPossession, catalogBootstrapToCarrierTerm, catalogInventoryId, verifyCatalogEnvelope, verifyCatalogReplacementPossession, } from "./treehouse_catalog_codec";
import { checkCatalogReplacementAuthority, refuteCatalogReplacementWithoutClosure } from "./treehouse_catalog_replacement_authority";
const maxSafe = Number.MAX_SAFE_INTEGER;
const extendedKeys = ["root", "genesis", "creation", "reference", "kind", "schema"];
const rank = {
    malformed_catalog: 1, control_history_limit: 1, wrong_catalog_scope: 2, trust_pending: 3, invalid_catalog_signature: 4,
    invalid_possession: 4, catalog_authority_refused: 5, invalid_catalog_transition: 6, catalog_rollback: 7, catalog_fork: 7,
    recovery_incomplete: 8,
};
/**
 * The reserved-to-none route value (row 387): a non-nullish sentinel that can never equal a replica id (replica ids are
 * hex digests). Every lookup is `has`-based, never `??`. At a JSON boundary it is `null` (BEAM `:none`).
 */
export const RESERVED = "\u0000none";
/** Encode a route map for JSON: RESERVED becomes null. */
export function encodeCatalogRoutes(routes) {
    return Object.fromEntries([...routes].sort(([a], [b]) => compareUtf8(a, b)).map(([k, v]) => [k, v === RESERVED ? null : v]));
}
/** Decode a JSON route map: null becomes RESERVED. */
export function decodeCatalogRoutes(json) {
    return new Map(Object.entries(json).map(([k, v]) => [k, v === null ? RESERVED : v]));
}
/** max(generations) + 1 within the safe-integer horizon, or null (finding 9). */
export function nextCatalogGeneration(generations) {
    if (generations.length === 0)
        return null;
    const next = Math.max(...generations) + 1;
    return Number.isSafeInteger(next) && next <= maxSafe ? next : null;
}
export function catalogBindingReasonRank(reason) {
    const value = rank[reason];
    if (value === undefined)
        throw new Error(`unknown reason ${reason}`);
    return value;
}
export async function resolveCatalogBindingGraph(input) {
    return (await resolveInfo(input)).result;
}
// The result plus the intrinsic catalog verdicts, for the authoring escape (C4).
async function resolveInfo(input) {
    const ctx = await context(input);
    if (ctx === null)
        return { result: { ok: false, reason: "malformed_catalog", detail: { ids: [] } }, ctx };
    return { result: await run(ctx), ctx };
}
// --- context ----------------------------------------------------------------------------------------------------------
// A malformed frame (decoding or verification throws) refuses as malformed input rather than rejecting the promise (PR #221
// bot finding at the old line 137).
async function context(input) {
    try {
        return await contextOf(input);
    }
    catch {
        return null;
    }
}
async function contextOf(input) {
    if (!Array.isArray(input.provenCutoffs) || !input.provenCutoffs.every(provenShape))
        return null;
    if (!acceptedShape(input.accepted))
        return null;
    const replica = input.bootstrap.record.space;
    const frames = new Map();
    for (const value of structuredClone([...input.frames])) {
        const frame = decodeCarrierOpFrame(value);
        if (frame.replica !== replica || frames.has(frame.id))
            return null;
        const checked = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, base64ToBytes(pub)) });
        if (!checked.valid)
            return null;
        frames.set(frame.id, frame);
    }
    const ops = carrierOpsToSemanticOps([...frames.values()], {}, treehouseCommandDecoders("Treehouse.Space"));
    const byId = index(ops);
    // An op's closure is complete when every dep is held and itself complete.
    const complete = new Set();
    let grew = true;
    while (grew) {
        grew = false;
        for (const op of ops) {
            if (!complete.has(op.id) && op.deps.every((dep) => complete.has(dep))) {
                complete.add(op.id);
                grew = true;
            }
        }
    }
    const completeOps = ops.filter((op) => complete.has(op.id));
    const completeById = index(completeOps);
    const reasons = materialize(treehouseSpaceSchema, completeOps, complete, null, replica).quarantineReasons;
    const candidates = new Map();
    for (const [id, frame] of frames) {
        if (frame.kind === "command" && bodyAtom(frame.body) === "replace_catalog_v1")
            candidates.set(id, { op: byId.get(id), frame });
    }
    const ctx = { input, replica, bootstrapId: input.bootstrap.id, record: input.bootstrap.record, byId, frames, complete,
        completeById, ancestorCache: new Map(), reasons, candidates,
        proven: new Set(input.provenCutoffs.map(cutoffKey)), bootHonored: false,
        memo: new Map(), visiting: new Set(), cmemo: new Map(), croutes: new Map(), cvisiting: new Set() };
    ctx.bootHonored = bootstrapHonored(ctx);
    return ctx;
}
function acceptedShape(a) {
    if (a === null)
        return true;
    if (typeof a !== "object" || a === undefined)
        return false;
    const v = a;
    return typeof v.binding === "string" && typeof v.catalog === "string" && typeof v.revision === "number" &&
        (v.routes === undefined || (typeof v.routes === "object" && v.routes !== null));
}
function bodyAtom(body) {
    if (!Array.isArray(body) || body[0] !== "tuple" || !Array.isArray(body[1]))
        return null;
    const first = body[1][0];
    return Array.isArray(first) && first[0] === "atom" && typeof first[1] === "string" ? first[1] : null;
}
function ancestorsOf(ctx, id) { return ancestors(id, ctx.completeById, ctx.ancestorCache); }
/** The complete-closure ops reachable from `seeds` (each seed included). */
function reachable(ctx, seeds) {
    const ids = new Set();
    for (const seed of seeds) {
        if (!ctx.completeById.has(seed))
            continue;
        ids.add(seed);
        for (const a of ancestorsOf(ctx, seed))
            ids.add(a);
    }
    return [...ids].map((id) => ctx.completeById.get(id));
}
function bootstrapHonored(ctx) {
    const op = ctx.completeById.get(ctx.bootstrapId);
    if (op === undefined || op.kind !== "command" || op.command !== "catalog_bootstrap_v1")
        return false;
    const held = catalogBootstrapToCarrierTerm(op.commandArgs?.[0]), want = catalogBootstrapToCarrierTerm(ctx.record);
    if (held === null || want === null || JSON.stringify(held) !== JSON.stringify(want))
        return false;
    const prefix = reachable(ctx, [ctx.bootstrapId]);
    return !materialize(treehouseSpaceSchema, prefix, new Set(prefix.map((o) => o.id)), null, ctx.replica).quarantineReasons
        .has(ctx.bootstrapId);
}
// --- run ----------------------------------------------------------------------------------------------------------------
async function run(ctx) {
    for (const id of [...ctx.input.rotations.keys(), ...ctx.candidates.keys()].sort(compareUtf8))
        await evaluate(id, ctx);
    for (const id of [...ctx.input.catalogs.keys()].sort(compareUtf8))
        await judgeCatalog(id, ctx);
    const nodesAll = new Map();
    for (const [id, verdict] of ctx.memo)
        if (verdict.t === "node")
            nodesAll.set(id, verdict.node);
    nodesAll.set(ctx.bootstrapId, bootstrapNode(ctx));
    const closed = closedSet(nodesAll);
    const outRot = closedOutRotations(nodesAll, closed);
    const outPending = closedOutPending(ctx, closed, outRot);
    const final = new Map([...nodesAll].filter(([id]) => !outRot.has(id)));
    const heads = headsOf(final);
    const floors = new Map();
    for (const [id, n] of final) {
        const f = await floorOf(n, ctx);
        if (f.t === "ok")
            floors.set(id, { entries: f.entries, routes: f.routes });
    }
    const cat = classifyCatalogs(ctx, nodesAll, closed, outRot, outPending);
    // Any held op whose closure is incomplete is a missing history page: the authority fold over the complete ops would judge
    // a smaller history. Only a candidate already refuted from its own bytes is exempt.
    const incomplete = [...ctx.byId.keys()].filter((id) => !ctx.complete.has(id) && ctx.memo.get(id)?.t !== "bad");
    const pending = [...new Set([...[...ctx.memo].filter(([id, v]) => v.t === "pending" && !outPending.has(id)).map(([id]) => id),
            ...cat.pending,
            ...incomplete])].sort(compareUtf8);
    if (heads.length > 2)
        return { ok: false, reason: "control_history_limit", detail: { ids: heads } };
    const graph = assemble(ctx, nodesAll, final, heads, closed, outRot, cat, floors);
    if (pending.length === 0)
        return { ok: true, graph };
    // Row 386, repair (a): the graph is the complete authenticated part (pending artifacts are not nodes and are never cited),
    // so its decision derives the freeze bit. It never accepts or serves anything here: serving is only the watermark's own.
    const d = graph.decision;
    return { ok: false, reason: "trust_pending", detail: { ids: pending, freeze: !d.accepted && d.block !== null && d.block.freeze,
            serving: watermarkServing(ctx.input.accepted, graph, nodesAll, closed, outRot, cat.validity) } };
}
// --- binding evaluation (intrinsic) ------------------------------------------------------------------------------------
async function evaluate(id, ctx) {
    if (id === ctx.bootstrapId)
        return { t: "node", node: bootstrapNode(ctx) };
    const known = ctx.memo.get(id);
    if (known !== undefined)
        return known;
    if (ctx.visiting.has(id))
        return { t: "bad", reason: "invalid_catalog_transition" };
    ctx.visiting.add(id);
    let verdict;
    if (ctx.input.rotations.has(id))
        verdict = await evalRotation(id, ctx);
    else if (ctx.candidates.has(id))
        verdict = await evalCandidate(id, ctx);
    else if (ctx.byId.has(id) || ctx.input.catalogs.has(id))
        verdict = { t: "not_binding" };
    else
        verdict = { t: "unknown" };
    ctx.visiting.delete(id);
    if (verdict.t !== "unknown" && verdict.t !== "not_binding")
        ctx.memo.set(id, verdict);
    return verdict;
}
function bootstrapNode(ctx) {
    const r = ctx.record;
    return { id: ctx.bootstrapId, kind: "bootstrap", generation: 0, key: r.catalogKey, serviceId: r.serviceId,
        serviceKey: r.serviceKey, origin: r.origin, parents: [], prior: [], inventory: null, refused: false, coreReason: null,
        pending: [] };
}
async function evalRotation(id, ctx) {
    const e = ctx.input.rotations.get(id), r = e.rotation;
    if (r.space !== ctx.replica || r.bootstrap !== ctx.bootstrapId)
        return { t: "bad", reason: "wrong_catalog_scope" };
    const parent = await evaluate(r.parent, ctx);
    if (parent.t === "bad" || parent.t === "not_binding")
        return { t: "bad", reason: "invalid_catalog_transition" };
    if (parent.t !== "node")
        return { t: "pending" };
    const p = parent.node;
    // Every own-bytes failure is collected and the highest-precedence one reported (plan 316 section 4: a signature or
    // possession failure, rank 4, outranks a transition, rank 6).
    const failures = [];
    if (!verifyKey(p.key, canonicalBytesForCatalogRotation(r), e.oldSignature))
        failures.push(["invalid_catalog_signature", "old"]);
    if (!verifyKey(r.newCatalogKey, canonicalBytesForCatalogRotationPossession(r), e.newSignature)) {
        failures.push(["invalid_possession", "new"]);
    }
    if (nextCatalogGeneration([p.generation]) !== r.generation)
        failures.push(["invalid_catalog_transition", "generation"]);
    if (r.newCatalogKey === p.key || r.newCatalogKey === p.serviceKey)
        failures.push(["invalid_catalog_transition", "key"]);
    const worst = lowest(failures);
    if (worst !== null)
        return { t: "bad", reason: worst[0] };
    const prior = ctx.input.catalogs.get(r.priorCatalog)?.catalog;
    if (prior === undefined)
        return { t: "pending" };
    if (prior.binding !== r.parent || catalogInventoryId(prior.entries) !== r.inventoryDigest ||
        !same(r.cutoffs.map((c) => c.replica), prior.entries.map((entry) => entry.replica))) {
        return { t: "bad", reason: "invalid_catalog_transition" };
    }
    // The prior catalog must be valid under the parent (row 382 item 3): an invalid prior makes the rotation a refusal.
    const pv = await judgeCatalog(r.priorCatalog, ctx);
    if (pv.t === "pending" || pv.t === "binding_pending")
        return { t: "pending" };
    if (pv.t !== "ok")
        return { t: "bad", reason: "invalid_catalog_transition" };
    return { t: "node", node: { id, kind: "rotation", generation: r.generation, key: r.newCatalogKey, serviceId: p.serviceId,
            serviceKey: p.serviceKey, origin: p.origin, parents: [r.parent], prior: [{ binding: r.parent, catalog: r.priorCatalog }],
            // A rotation keeps its parent's service, so it inherits the unproven recovery cutoffs, and it owes its own declared cutoffs
            // too (CatalogTrust parity).
            inventory: r.inventoryDigest, refused: p.refused, coreReason: p.coreReason, pending: uniqCutoffs([...p.pending,
                ...unproven(r.cutoffs, ctx)]) } };
}
function verifyKey(key, bytes, signature) {
    try {
        const pub = canonicalBase64Bytes(key, 32), sig = canonicalBase64Bytes(signature, 64);
        return pub !== null && sig !== null && verifyEd25519(sig, bytes, pub);
    }
    catch {
        return false;
    }
}
// Step 1: closed three-argument shape, claim codec and pinned scope.
function shape(c, ctx) {
    const args = c.op.commandArgs;
    if (c.op.command !== "replace_catalog_v1" || c.op.commandError !== undefined || !Array.isArray(args) || args.length !== 3) {
        return { ok: false, reason: "malformed_catalog" };
    }
    const [claim, catalog, service] = args;
    if (typeof catalog !== "string" || typeof service !== "string" || canonicalBase64Bytes(catalog, 64) === null ||
        canonicalBase64Bytes(service, 64) === null || claim === null)
        return { ok: false, reason: "malformed_catalog" };
    const r = ctx.record;
    if (claim.version !== 1 || claim.product !== "treehouse" || claim.space !== ctx.replica || claim.bootstrap !== ctx.bootstrapId ||
        claim.profileGenesis !== r.profileGenesis || claim.profileId !== r.profileId)
        return { ok: false, reason: "wrong_catalog_scope" };
    return { ok: true, claim, catalog, service };
}
function ownLiteral(op, claim) {
    return claim.author === op.authorPubkey && claim.cap === op.cap &&
        same(claim.deps, [...new Set(op.deps)].sort(compareUtf8));
}
function lowest(failures) {
    let best = null;
    for (const f of failures)
        if (best === null || rank[f[0]] < rank[best[0]])
            best = f;
    return best;
}
async function evalCandidate(id, ctx) {
    const c = ctx.candidates.get(id);
    const s = shape(c, ctx);
    if (!s.ok)
        return { t: "bad", reason: s.reason };
    const possession = verifyCatalogReplacementPossession(s.claim, s.catalog, s.service);
    if (!ctx.complete.has(id)) {
        // Incomplete closure: refute only from facts no missing ancestor can change.
        const failures = [];
        if (!possession)
            failures.push(["invalid_possession", "possession"]);
        const predicate = refuteCatalogReplacementWithoutClosure(ctx.byId, c.op.authorPubkey ?? "", s.claim);
        if (predicate !== null)
            failures.push(["catalog_authority_refused", predicate]);
        if (!ownLiteral(c.op, s.claim))
            failures.push(["invalid_catalog_transition", "literal_binding"]);
        const worst = lowest(failures);
        return worst === null ? { t: "pending" } : { t: "bad", reason: worst[0] };
    }
    const anc = ancestorsOf(ctx, id);
    const prefixOps = reachable(ctx, c.op.deps);
    const prefixIds = new Set(prefixOps.map((o) => o.id));
    const prefixFrames = [...ctx.frames.values()].filter((f) => prefixIds.has(f.id));
    const literal = ownLiteral(c.op, s.claim) && anc.has(s.claim.holderEpoch) && anc.has(ctx.bootstrapId) && ctx.bootHonored;
    const failures = [];
    const auth = await checkCatalogReplacementAuthority({ replica: ctx.replica, frames: prefixFrames, ops: prefixOps }, { author: c.op.authorPubkey ?? "", cap: typeof c.op.cap === "string" ? c.op.cap : "" }, s.claim, ctx.record.spaceRoot);
    if (auth !== null)
        failures.push([auth.reason, auth.predicate]);
    else {
        // Core refusing the op on its own causal closure (a revoke or lapse already in the prefix) is intrinsic; Stage A's own
        // refusal is excluded because its literal and possession checks are re-run below with their own reasons.
        const own = reachable(ctx, [id]);
        const core = materialize(treehouseSpaceSchema, own, new Set(own.map((o) => o.id)), null, ctx.replica).quarantineReasons.get(id);
        if (core !== undefined && core !== "application_invalid_catalog")
            failures.push(["catalog_authority_refused", "core_refused_at_prefix"]);
    }
    if (!literal)
        failures.push(["invalid_catalog_transition", "literal_binding"]);
    if (!possession)
        failures.push(["invalid_possession", "possession"]);
    const declared = await declaredGraph(s.claim, anc, ctx);
    failures.push(...declared.failures);
    const worst = lowest(failures);
    if (worst !== null)
        return { t: "bad", reason: worst[0] };
    if (declared.pending)
        return { t: "pending" };
    const core = ctx.reasons.get(id) ?? null;
    // D-A15: a node owes its own declared cutoffs plus those it inherits from a same-service parent.
    const inherited = declared.known.filter((n) => n.serviceId === s.claim.newServiceId && n.serviceKey === s.claim.newServiceKey)
        .flatMap((n) => [...n.pending]);
    return { t: "node", node: { id, kind: "replacement", generation: s.claim.generation, key: s.claim.newCatalogKey,
            serviceId: s.claim.newServiceId, serviceKey: s.claim.newServiceKey, origin: s.claim.newOrigin, parents: s.claim.parents,
            prior: s.claim.priorCatalogs, inventory: s.claim.inventoryDigest, refused: core !== null, coreReason: core,
            pending: uniqCutoffs([...inherited, ...unproven(s.claim.cutoffs, ctx)]) } };
}
// A proof matches a cutoff only on the whole `{replica, frontier, logDigest}` (CatalogTrust compares the complete cutoff).
function provenShape(c) {
    if (typeof c !== "object" || c === null)
        return false;
    const cut = c;
    return typeof cut.replica === "string" && typeof cut.logDigest === "string" && Array.isArray(cut.frontier) &&
        cut.frontier.every((f) => typeof f === "string");
}
function cutoffKey(cut) {
    return JSON.stringify([cut.replica, cut.frontier, cut.logDigest]);
}
function unproven(cutoffs, ctx) {
    return cutoffs.filter((cut) => !ctx.proven.has(cutoffKey(cut)))
        .map((cut) => ({ replica: cut.replica, frontier: [...cut.frontier], logDigest: cut.logDigest }));
}
function uniqCutoffs(cutoffs) {
    const seen = new Set();
    return cutoffs.filter((cut) => {
        const key = cutoffKey(cut);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
// Steps 5 and 6, intrinsic part. A cited replacement op outside the deps closure fails before it is evaluated.
async function declaredGraph(claim, anc, ctx) {
    const failures = [];
    const known = [];
    let pending = false;
    for (const parent of claim.parents) {
        if (ctx.candidates.has(parent) && !anc.has(parent)) {
            failures.push(["invalid_catalog_transition", "deps"]);
            continue;
        }
        const v = await evaluate(parent, ctx);
        if (v.t === "node")
            known.push(v.node);
        else if (v.t === "bad" || v.t === "not_binding")
            failures.push(["invalid_catalog_transition", "parent"]);
        else
            pending = true;
    }
    for (const n of known) {
        if (claim.newServiceKey !== n.serviceKey && claim.newServiceId === n.serviceId)
            failures.push(["invalid_catalog_transition", "service"]);
    }
    if (known.length === claim.parents.length && nextCatalogGeneration(known.map((n) => n.generation)) !== claim.generation) {
        failures.push(["invalid_catalog_transition", "generation"]);
    }
    for (const { binding, catalog } of claim.priorCatalogs) {
        if (!claim.parents.includes(binding))
            failures.push(["invalid_catalog_transition", "prior"]);
        else if (catalog === null)
            continue;
        else if (!ctx.input.catalogs.has(catalog))
            pending = true;
        else if (ctx.input.catalogs.get(catalog).catalog.binding !== binding)
            failures.push(["invalid_catalog_transition", "prior"]);
        else {
            // OD-17: an intrinsically invalid cited prior makes the candidate raw evidence; one whose chain is not held pends.
            const v = await judgeCatalog(catalog, ctx);
            if (v.t === "pending" || v.t === "binding_pending")
                pending = true;
            else if (v.t !== "ok")
                failures.push(["invalid_catalog_transition", "prior"]);
        }
    }
    return { failures, pending, known };
}
// --- closure and heads -------------------------------------------------------------------------------------------------
// D-275: ancestor-or-self of every parent cited by an eligible replacement node.
function closedSet(nodes) {
    return closure([...nodes.values()].filter((n) => n.kind === "replacement").flatMap((n) => [...n.parents]), nodes);
}
function closedOutRotations(nodes, closed) {
    const out = (id) => {
        const parent = nodes.get(id).parents[0];
        if (closed.has(id))
            return false;
        if (closed.has(parent))
            return true;
        return nodes.get(parent).kind === "rotation" && out(parent);
    };
    return new Set([...nodes.values()].filter((n) => n.kind === "rotation" && out(n.id)).map((n) => n.id));
}
// D-275 non-stall: a pending rotation whose rotation-parent chain reaches a closed or closed-out binding is closed-out evidence
// whatever its missing prior catalog says, so an old-key signer cannot withhold it to freeze recovery. A pending rotation under
// an open, unknown or pending replacement parent still pends.
function closedOutPending(ctx, closed, outRot) {
    const out = (id, seen) => {
        const parent = ctx.input.rotations.get(id).rotation.parent;
        if (seen.has(id))
            return false;
        if (closed.has(parent) || outRot.has(parent))
            return true;
        return ctx.input.rotations.has(parent) && ctx.memo.get(parent)?.t === "pending" && out(parent, new Set([...seen, id]));
    };
    return new Set([...ctx.memo].filter(([id, v]) => v.t === "pending" && ctx.input.rotations.has(id) && out(id, new Set()))
        .map(([id]) => id));
}
function headsOf(final) {
    const cited = closure([...final.values()].flatMap((n) => [...n.parents]), final);
    return [...final.keys()].filter((id) => !cited.has(id)).sort(compareUtf8);
}
async function judgeCatalog(id, ctx) {
    const known = ctx.cmemo.get(id);
    if (known !== undefined)
        return known;
    if (!ctx.input.catalogs.has(id))
        return { t: "pending" };
    if (ctx.cvisiting.has(id))
        return { t: "bad_chain" };
    ctx.cvisiting.add(id);
    const [v, routes] = await judgeCatalogNew(id, ctx);
    ctx.cvisiting.delete(id);
    ctx.cmemo.set(id, v);
    if (v.t === "ok")
        ctx.croutes.set(id, routes);
    return v;
}
async function judgeCatalogNew(id, ctx) {
    const e = ctx.input.catalogs.get(id), c = e.catalog;
    if (c.space !== ctx.replica || c.bootstrap !== ctx.bootstrapId)
        return [{ t: "refused", reason: "wrong_catalog_scope" }, null];
    const b = await evaluate(c.binding, ctx);
    if (b.t === "bad" || b.t === "not_binding")
        return [{ t: "refused", reason: "invalid_catalog_transition" }, null];
    if (b.t !== "node")
        return [{ t: "binding_pending" }, null];
    const n = b.node;
    // Scope outranks signature (plan 316 section 4: wrong_catalog_scope rank 2 before invalid_catalog_signature rank 4).
    if (c.entries.some((entry) => entry.serviceId !== n.serviceId || entry.serviceKey !== n.serviceKey)) {
        return [{ t: "refused", reason: "wrong_catalog_scope" }, null];
    }
    if (!verifyCatalogEnvelope(e, n.key))
        return [{ t: "refused", reason: "invalid_catalog_signature" }, null];
    if (c.previous === null) {
        // First-catalog checks: revision 0 for a replacement, the declared inventory, the replacement's cutoffs covering every
        // entry (D-A15), extension of the binding's floor, and the route rule.
        const floor = await floorOf(n, ctx);
        if (floor.t === "pending")
            return [{ t: "pending" }, null];
        if (floor.t === "bad")
            return [{ t: "bad_chain" }, null];
        const uncovered = n.kind === "replacement" && !same(claimOf(ctx, n.id).cutoffs.map((cut) => cut.replica), c.entries.map((entry) => entry.replica).sort(compareUtf8));
        if ((n.kind === "replacement" && c.revision !== 0) ||
            (n.inventory !== null && catalogInventoryId(c.entries) !== n.inventory) || uncovered ||
            !admit(floor, c.entries))
            return [{ t: "bad_chain" }, null];
        return withRoutes(floor.routes, c.entries);
    }
    if (!ctx.input.catalogs.has(c.previous))
        return [{ t: "pending" }, null];
    const prev = await judgeCatalog(c.previous, ctx);
    const prior = ctx.input.catalogs.get(c.previous).catalog;
    if (prev.t === "pending" || prev.t === "binding_pending")
        return [{ t: "pending" }, null];
    if (prev.t !== "ok" || prior.binding !== c.binding)
        return [{ t: "bad_chain" }, null];
    if (nextCatalogGeneration([prior.revision]) !== c.revision || !extendsEntries(prior.entries, c.entries)) {
        return [{ t: "bad_chain" }, null];
    }
    return withRoutes(ctx.croutes.get(c.previous), c.entries);
}
// Route rule: within a catalog's own ancestry plus its entries, a route names one replica.
function withRoutes(routes, entries) {
    const out = addRoutes(routes, entries);
    return out === null ? [{ t: "bad_chain" }, null] : [{ t: "ok" }, out];
}
// A route conflicts when it is held and maps to anything but this replica (RESERVED included). `has`-based: never `??`.
function routeConflict(routes, e) {
    return routes.has(e.route) ? routes.get(e.route) !== e.replica : false;
}
function addRoutes(routes, entries) {
    const out = new Map(routes);
    for (const e of entries) {
        if (routeConflict(out, e))
            return null;
        out.set(e.route, e.replica);
    }
    return out;
}
// Admit(F, entries): the entries extend the floor's entries and add no route conflict (an entry on a RESERVED route, or on a
// route mapped to another replica, conflicts). Shared by first-catalog validity and authoring coverage (row 387).
function admit(floor, entries) {
    return extendsEntries(floor.entries, entries) && addRoutes(floor.routes, entries) !== null;
}
// Floor(N): Floor(bootstrap) = [], Floor(T) = entries(T.priorCatalog), and for a replacement the union over its cited {P, K}
// of entries(K), or Floor(P) when K is null, so a null citation of a node without a valid catalog still carries P's floor.
async function floorOf(n, ctx) {
    if (n.kind === "bootstrap")
        return { t: "ok", entries: [], routes: new Map() };
    let acc = { t: "ok", entries: [], routes: new Map() };
    for (const { binding, catalog } of n.prior) {
        if (acc.t === "bad")
            return acc;
        let part;
        if (catalog === null) {
            const p = await evaluate(binding, ctx);
            part = p.t === "node" ? await floorOf(p.node, ctx) : { t: "pending" };
        }
        else {
            const v = await judgeCatalog(catalog, ctx);
            part = v.t === "ok" ? { t: "ok", entries: [...ctx.input.catalogs.get(catalog).catalog.entries], routes: ctx.croutes.get(catalog) }
                : v.t === "pending" || v.t === "binding_pending" ? { t: "pending" } : { t: "bad" };
        }
        acc = mergeFloor(acc, part);
    }
    return acc;
}
// Row 387: the join never fails on routes. A route the sides map to different replicas (or that either side reserves) becomes
// RESERVED: no first catalog under the node may use it, but its replicas may move onto fresh routes.
function mergeFloor(a, b) {
    if (a.t === "bad" || b.t === "bad")
        return { t: "bad" };
    if (a.t === "pending" || b.t === "pending")
        return { t: "pending" };
    const routes = new Map(a.routes);
    for (const [route, replica] of b.routes) {
        routes.set(route, routes.has(route) && (routes.get(route) !== replica || replica === RESERVED) ? RESERVED : replica);
    }
    return { t: "ok", entries: [...a.entries, ...b.entries], routes };
}
// Status classifies an intrinsic verdict: current under an open binding; covered / closed_out / uncovered under a closed one;
// refused with a reason; pending. A citation never makes an invalid catalog valid.
function classifyCatalogs(ctx, nodesAll, closed, outRot, outPending) {
    const cites = citations(nodesAll, closed);
    const previous = new Map([...ctx.input.catalogs].map(([id, e]) => [id, e.catalog.previous]));
    const validity = ctx.cmemo;
    const acc = { status: new Map(), refusals: new Map(), pending: [], cites, previous, validity, outPending };
    const refuse = (id, reason, core) => {
        acc.refusals.set(id, { reason, coreReason: core });
        return "refused";
    };
    const statusOf = (id) => {
        const c = ctx.input.catalogs.get(id).catalog, n = nodesAll.get(c.binding), v = validity.get(id);
        if (v.t === "refused")
            return refuse(id, v.reason, null);
        if (v.t === "binding_pending")
            return outPending.has(c.binding) ? "closed_out" : "pending";
        // A chain-invalid catalog keeps its own reason under a union-refused node (PR #221 bot finding at the BEAM twin's old
        // line 1048): it takes the intrinsic path, not the inherited catalog_authority_refused the preflight filters out.
        if (n.refused && v.t !== "bad_chain") {
            // A catalog under a union-refused node authorizes nothing, but under a closed binding a chain-valid one is still a
            // citable catalog head (D-A13): omitted by the citations, it is an uncovered head (a fork). It keeps its refusal.
            refuse(id, "catalog_authority_refused", n.coreReason);
            return v.t === "ok" && closed.has(c.binding) && !outRot.has(c.binding) && closedStatus(id, c.binding, v) === "uncovered"
                ? "uncovered" : "refused";
        }
        if (outRot.has(c.binding))
            return "closed_out";
        if (closed.has(c.binding))
            return closedStatus(id, c.binding, v);
        if (v.t === "pending")
            return "pending";
        if (v.t === "bad_chain")
            return refuse(id, "invalid_catalog_transition", null);
        return "current";
    };
    // Under a closed binding: covered when ancestor-or-self of a valid cited catalog, closed out when a strict descendant of a
    // cited catalog or when the binding was cited with null, otherwise an omitted head (uncovered, a fork). A catalog on a cited
    // chain is refused when invalid and pending when its chain is. Only a chain-valid catalog can be an omitted head: an uncited
    // invalid one is refused and an uncited one whose chain is not held is closed-out evidence (D-A16 for catalogs).
    const closedStatus = (id, binding, v) => {
        const cited = cites.get(binding) ?? [];
        const real = cited.filter((c) => c !== null);
        const validCited = real.filter((c) => { const cv = validity.get(c); return cv?.t === "ok" || cv?.t === "pending"; });
        if (v.t === "bad_chain" && real.some((c) => onChain(id, c, previous)))
            return refuse(id, "invalid_catalog_transition", null);
        if (validCited.some((c) => onChain(id, c, previous)))
            return v.t === "pending" ? "pending" : "covered";
        if (real.some((c) => c !== id && onChain(c, id, previous)))
            return "closed_out";
        if (cited.includes(null))
            return "closed_out";
        if (v.t === "bad_chain")
            return refuse(id, "invalid_catalog_transition", null);
        if (v.t === "pending")
            return "closed_out";
        return "uncovered";
    };
    for (const id of [...ctx.input.catalogs.keys()].sort(compareUtf8))
        acc.status.set(id, statusOf(id));
    acc.pending = [...acc.status].filter(([, s]) => s === "pending").map(([id]) => id);
    return acc;
}
function onChain(a, b, previous) {
    const seen = new Set();
    let cursor = b;
    while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
        if (cursor === a)
            return true;
        seen.add(cursor);
        cursor = previous.get(cursor) ?? null;
    }
    return false;
}
function citations(nodes, closed) {
    const acc = new Map();
    for (const n of nodes.values()) {
        if (!(n.kind === "replacement" || (n.kind === "rotation" && closed.has(n.id))))
            continue;
        for (const { binding, catalog } of n.prior)
            acc.set(binding, [...(acc.get(binding) ?? []), catalog]);
    }
    return acc;
}
function extendsEntries(before, next) {
    return before.every((entry) => {
        const other = next.find((item) => item.replica === entry.replica);
        return other !== undefined && extendedKeys.every((key) => entry[key] === other[key]);
    });
}
function routeCompat(routes, entries) {
    return entries.every((e) => (Object.hasOwn(routes, e.route) ? routes[e.route] : e.replica) === e.replica);
}
// --- forks, assembly and decision ----------------------------------------------------------------------------------------
function catalogHeadsOf(ctx, final, closed, cat) {
    return headsAmong(ctx, final, closed, [...cat.status].filter(([, s]) => s === "current").map(([id]) => id));
}
// The catalog heads a resolution must cite per open binding (authoring coverage): the current heads plus, under a
// union-refused node, the chain-valid catalogs refused only because that node authorizes nothing (C13: R2 cites {R1, K1}).
function citableCatalogHeadsOf(ctx, final, closed, cat) {
    return headsAmong(ctx, final, closed, [...cat.status].filter(([id, s]) => s === "current" ||
        (s === "refused" && cat.validity.get(id)?.t === "ok" && cat.refusals.get(id)?.reason === "catalog_authority_refused"))
        .map(([id]) => id));
}
function headsAmong(ctx, final, closed, current) {
    const successors = new Set(current.map((id) => ctx.input.catalogs.get(id).catalog.previous).filter((p) => p !== null));
    const heads = new Map();
    for (const id of current) {
        const binding = ctx.input.catalogs.get(id).catalog.binding;
        if (successors.has(id) || !final.has(binding) || closed.has(binding))
            continue;
        heads.set(binding, [...(heads.get(binding) ?? []), id].sort(compareUtf8));
    }
    return heads;
}
function claimOf(ctx, id) {
    return ctx.candidates.get(id).op.commandArgs[0];
}
// C1: a final rotation T whose parent P is not closed forks with any chain-valid catalog under P that strictly descends from
// T's prior catalog (CatalogTrust rotationForks); a pending descendant is already pending under the open P.
function rotationForksOf(ctx, final, closed, cat) {
    const out = [];
    for (const t of final.values()) {
        if (t.kind !== "rotation")
            continue;
        const { binding: p, catalog: prior } = t.prior[0];
        if (closed.has(p) || prior === null)
            continue;
        const descendants = [...ctx.input.catalogs].filter(([cid, e]) => e.catalog.binding === p && cid !== prior &&
            cat.validity.get(cid)?.t === "ok" && onChain(prior, cid, cat.previous)).map(([cid]) => cid).sort(compareUtf8);
        if (descendants.length > 0)
            out.push({ rotation: t.id, binding: p, catalogs: descendants, prior });
    }
    return out.sort((a, b) => compareUtf8(a.rotation, b.rotation));
}
function forksOf(ctx, final, heads, closed, cat, catHeads, rotationForks) {
    const forks = [];
    if (heads.length > 1)
        forks.push({ kind: "heads", binding: null, ids: heads });
    // Differing claims sharing a nonce fork, sequential reuse included (a child reusing its closed parent's nonce). A group
    // whose members are all closed has been resolved by a later citation, so it no longer forks.
    const byNonce = new Map();
    for (const n of final.values()) {
        if (n.kind !== "replacement")
            continue;
        const nonce = claimOf(ctx, n.id).nonce;
        byNonce.set(nonce, [...(byNonce.get(nonce) ?? []), n.id]);
    }
    for (const ids of byNonce.values()) {
        const bytes = new Set(ids.map((id) => JSON.stringify([...canonicalBytesForCatalogReplacementClaim(claimOf(ctx, id))])));
        if (bytes.size > 1 && ids.some((id) => !closed.has(id)))
            forks.push({ kind: "nonce", binding: null, ids: [...ids].sort(compareUtf8) });
    }
    for (const [binding, ids] of catHeads)
        if (ids.length > 1)
            forks.push({ kind: "catalog", binding, ids });
    const uncovered = new Map();
    for (const [id, s] of cat.status) {
        if (s !== "uncovered")
            continue;
        const binding = ctx.input.catalogs.get(id).catalog.binding;
        uncovered.set(binding, [...(uncovered.get(binding) ?? []), id]);
    }
    for (const [binding, ids] of uncovered)
        forks.push({ kind: "catalog", binding, ids: ids.sort(compareUtf8) });
    for (const f of rotationForks)
        forks.push({ kind: "rotation", binding: f.binding, ids: [f.prior, ...f.catalogs].sort(compareUtf8) });
    const key = (f) => `${f.kind}\u0000${f.binding ?? ""}\u0000${f.ids.join("\u0000")}`;
    return forks.sort((a, b) => compareUtf8(key(a), key(b)));
}
function assemble(ctx, nodesAll, final, heads, closed, outRot, cat, floors) {
    const closedOut = new Map();
    for (const id of [...outRot, ...cat.outPending])
        closedOut.set(id, "catalog_rollback");
    for (const [id, s] of cat.status)
        if (s === "closed_out")
            closedOut.set(id, "catalog_rollback");
    const catHeads = catalogHeadsOf(ctx, final, closed, cat);
    const rotationForks = rotationForksOf(ctx, final, closed, cat);
    const raw = new Map();
    const refusals = new Map(cat.refusals);
    for (const [id, v] of ctx.memo) {
        if (v.t !== "bad")
            continue;
        if (ctx.candidates.has(id))
            raw.set(id, v.reason);
        else if (ctx.input.rotations.has(id))
            refusals.set(id, { reason: v.reason, coreReason: null });
    }
    for (const n of final.values()) {
        if (n.kind === "rotation" && n.refused)
            refusals.set(n.id, { reason: "catalog_authority_refused", coreReason: n.coreReason });
    }
    const forkBindings = [...new Set([...[...cat.status].filter(([, s]) => s === "uncovered")
                .map(([id]) => ctx.input.catalogs.get(id).catalog.binding), ...rotationForks.map((f) => f.binding)])].sort(compareUtf8);
    const catParent = new Map();
    for (const [id, e] of ctx.input.catalogs) {
        const n = nodesAll.get(e.catalog.binding);
        catParent.set(id, e.catalog.previous ?? (n?.kind === "rotation" ? n.prior[0].catalog : null));
    }
    const graph = { nodes: final, heads, closed: [...closed].sort(compareUtf8), closedOut,
        pending: [...final.values()].filter((n) => n.pending.length > 0).map((n) => n.id).sort(compareUtf8), rawEvidence: raw,
        refusals, catalogHeads: catHeads, citableCatalogHeads: citableCatalogHeadsOf(ctx, final, closed, cat),
        catalogStatus: cat.status, citations: cat.cites, previous: cat.previous,
        forks: forksOf(ctx, final, heads, closed, cat, catHeads, rotationForks), rotationForks, forkBindings, floors,
        catalogRoutes: new Map(ctx.croutes), catParent,
        catalogs: new Map([...ctx.input.catalogs].map(([id, e]) => [id, e.catalog])),
        decision: undefined };
    graph.decision = decide(ctx.input.accepted, graph, nodesAll, closed, outRot, cat.validity);
    return graph;
}
function closure(seeds, nodes) {
    const acc = new Set(), stack = [...seeds];
    while (stack.length > 0) {
        const id = stack.pop();
        if (acc.has(id) || !nodes.has(id))
            continue;
        acc.add(id);
        stack.push(...nodes.get(id).parents);
    }
    return acc;
}
// Is `a` ancestor-or-self of `b` along CatLineage (previous, and a rotation's first catalog to the rotation's prior)?
function catLineage(a, b, parent) {
    return onChain(a, b, parent);
}
function routesOf(a) { return a?.routes ?? {}; }
// The watermark against the graph. Changed (C6): its binding refused or closed out, or (with the binding held) its catalog
// refused, closed out or uncovered. A missing watermark artifact blocks acceptance but no longer masks a changed binding. A
// watermark catalog whose own chain is pending is missing whatever union class it was given (row 386 lemma, path (2)).
function watermarkChange(a, graph, nodesAll, closed, outRot, validity) {
    const abs = a === null ? "missing" : outRot.has(a.binding) ? "closed_out" :
        !nodesAll.has(a.binding) ? "missing" : nodesAll.get(a.binding).refused ? "refused" : closed.has(a.binding) ? "closed" : "current";
    const v = a === null ? undefined : validity.get(a.catalog)?.t;
    const s = a === null || v === "pending" || v === "binding_pending" ? undefined : graph.catalogStatus.get(a.catalog);
    const acs = a === null ? "missing" : s === "covered" ? "ancestor_of_cited" :
        s === "closed_out" || s === "uncovered" ? "closed_out" : s === "current" ? "current" : s === "refused" ? "refused" : "missing";
    const missing = a !== null && (abs === "missing" || acs === "missing");
    const changed = a !== null && (abs === "refused" || abs === "closed_out" ||
        (abs !== "missing" && (acs === "refused" || acs === "closed_out")));
    return { abs, acs, missing, changed };
}
// Serving_c(A): the watermark catalog while present and unchanged, its binding an unclosed node, nothing forks and RouteCompat
// holds; shared by the ok and the pending paths.
function watermarkServing(a, graph, nodesAll, closed, outRot, validity) {
    const w = watermarkChange(a, graph, nodesAll, closed, outRot, validity);
    return w.missing || w.changed ? null : serving(a, graph, closed);
}
function decide(a, graph, nodesAll, closed, outRot, validity) {
    const { abs, acs, missing, changed } = watermarkChange(a, graph, nodesAll, closed, outRot, validity);
    const base = { accepted: false, reason: null, block: null, head: null, catalog: null, generation: null,
        revision: null, clearsAuthorityChanged: false, serving: null, acceptedBindingStatus: abs, acceptedCatalogStatus: acs };
    if (graph.forks.length > 0) {
        const ids = [...new Set(graph.forks.flatMap((f) => [...f.ids]))].sort(compareUtf8);
        return { ...base, reason: "catalog_fork", block: { reason: "catalog_fork", ids, freeze: changed } };
    }
    const id = graph.heads[0];
    if (missing)
        return { ...base, head: id, reason: "authority_changed", block: { reason: "authority_changed", ids: [id], freeze: changed } };
    const node = graph.nodes.get(id);
    const ready = graph.catalogHeads.get(id)?.[0] ?? null;
    const held = { ...base, head: id, serving: changed ? null : serving(a, graph, closed) };
    const promotable = !node.refused && node.pending.length === 0 && ready !== null;
    const covered = promotable && a !== null ? covers(a, id, ready, graph, nodesAll) : null;
    if (promotable && covered === null) {
        return { ...held, accepted: true, catalog: ready, generation: node.generation, revision: graph.catalogs.get(ready).revision,
            clearsAuthorityChanged: clears(a, id, nodesAll), serving: ready };
    }
    if (changed)
        return { ...held, reason: "authority_changed", block: { reason: "authority_changed", ids: [id], freeze: true } };
    if (promotable)
        return { ...held, reason: covered };
    if (node.refused) {
        return { ...held, reason: "catalog_authority_refused", block: { reason: "catalog_authority_refused", ids: [id], freeze: false } };
    }
    if (node.pending.length > 0) {
        return { ...held, reason: "recovery_incomplete", block: { reason: "recovery_incomplete", ids: [id], freeze: false } };
    }
    return held;
}
// Covers(H, K | A): under the watermark's own binding a previous-chain descendant at no lower revision; otherwise Seen and
// Carry; in both cases RouteCompat (no entry re-points a route ever served). Returns null when covered, else the reason:
// every failure is relative to this client's watermark, so it is catalog_rollback, never the intrinsic
// invalid_catalog_transition (D-279).
function covers(a, h, k, graph, nodesAll) {
    const kc = graph.catalogs.get(k);
    if (!routeCompat(routesOf(a), kc.entries))
        return "catalog_rollback";
    if (h === a.binding)
        return onChain(a.catalog, k, graph.previous) && kc.revision >= a.revision ? null : "catalog_rollback";
    if (!seen(a, h, graph, nodesAll))
        return "catalog_rollback";
    if (!extendsEntries(graph.catalogs.get(a.catalog).entries, kc.entries))
        return "catalog_rollback";
    return null;
}
function seen(a, h, graph, nodesAll) {
    const lineage = closure([h], nodesAll);
    const cited = [...lineage].flatMap((id) => nodesAll.get(id).prior.flatMap((p) => p.catalog === null ? [] : [p.catalog]));
    if (cited.some((c) => catLineage(a.catalog, c, graph.catParent)))
        return true;
    // Some replacement in H's lineage strictly descends from a closer of the watermark catalog: an eligible replacement citing
    // the watermark binding (or, for a closed-out rotation, its nearest closed ancestor) with null or a strict CatLineage ancestor.
    const closedSet = new Set(graph.closed);
    let target = a.binding;
    for (let n = nodesAll.get(target); n?.kind === "rotation" && !closedSet.has(target); n = nodesAll.get(target))
        target = n.parents[0];
    const closers = [...nodesAll.values()].filter((n) => n.kind === "replacement" && n.prior.some((p) => p.binding === target &&
        (p.catalog === null || (p.catalog !== a.catalog && catLineage(p.catalog, a.catalog, graph.catParent))))).map((n) => n.id);
    return [...lineage].some((y) => nodesAll.get(y).kind === "replacement" &&
        closers.some((x) => x !== y && closure([y], nodesAll).has(x)));
}
// An honored replacement in H's lineage that the watermark binding did not descend from.
function clears(a, h, nodesAll) {
    if (a === null)
        return false;
    const before = closure([a.binding], nodesAll);
    return [...closure([h], nodesAll)].some((x) => {
        const n = nodesAll.get(x);
        return n.kind === "replacement" && !n.refused && !before.has(x);
    });
}
// Without promotion the watermark catalog may keep being served only while held, unchanged, its binding open, nothing forks and
// its routes agree with the routes served (the caller passes changed watermarks as null).
function serving(a, graph, closed) {
    if (a === null || graph.forks.length > 0 || !graph.nodes.has(a.binding) || closed.has(a.binding))
        return null;
    return routeCompat(routesOf(a), graph.catalogs.get(a.catalog).entries) ? a.catalog : null;
}
/**
 * The merge rule over the persisted {accepted, frozen} (row 383; BEAM CatalogBindingGraph.advance/2). Only an accepting decision
 * that clears (or any accepting decision while not frozen) moves the watermark, adds its catalog's routes to the cumulative
 * routes and lifts frozen; a block with freeze sets frozen; nothing is served while frozen. On trust_pending the detail's freeze
 * (derived only from the complete authenticated part) is ORed into frozen and its serving is served unless frozen; any other
 * error, or a trust_pending without those fields, keeps the state and serves nothing.
 */
export function advanceCatalogBindingState(state, result) {
    if (!result.ok) {
        const { freeze, serving: watermark } = result.detail;
        // Row 386, repair (a): the complete part's freeze is ORed in; a detail without the fields (a page-level refusal) keeps
        // frozen and serves nothing, as does every other error. Pending evidence never lifts a freeze.
        if (result.reason !== "trust_pending" || typeof freeze !== "boolean" || watermark === undefined) {
            return { accepted: state.accepted, frozen: state.frozen, serving: null };
        }
        const frozen = state.frozen || freeze;
        return { accepted: state.accepted, frozen, serving: frozen ? null : watermark };
    }
    const d = result.graph.decision;
    if (d.accepted && (!state.frozen || d.clearsAuthorityChanged)) {
        const routes = { ...routesOf(state.accepted) };
        for (const e of result.graph.catalogs.get(d.catalog).entries)
            routes[e.route] = e.replica;
        return { accepted: { binding: d.head, generation: d.generation, catalog: d.catalog, revision: d.revision, routes },
            frozen: false, serving: d.serving };
    }
    if (d.block?.freeze === true)
        return { accepted: state.accepted, frozen: true, serving: null };
    return { accepted: state.accepted, frozen: state.frozen, serving: state.frozen ? null : d.serving };
}
/**
 * The authoring resolve for one claim (design section 2.7): as resolveCatalogBindingGraph, except that a control_history_limit
 * whose heads all reduce to head roots the claim cites is re-resolved without the rotations under those roots and the
 * catalogs bound to them (exactly the rotations the claim closes out). The verifier keeps its head limit.
 */
export async function resolveCatalogBindingGraphForClaim(input, claim) {
    const first = await resolveCatalogBindingGraph(input);
    if (first.ok)
        return first;
    if (first.reason === "trust_pending")
        return escapePending(input, claim);
    if (first.reason !== "control_history_limit")
        return first;
    const rotations = input.rotations;
    const root = (id) => {
        const seen = new Set();
        let cursor = id;
        while (rotations.has(cursor) && !seen.has(cursor)) {
            seen.add(cursor);
            cursor = rotations.get(cursor).rotation.parent;
        }
        return cursor;
    };
    if (!first.detail.ids.every((h) => claim.parents.includes(root(h))))
        return first;
    const dropped = new Set([...rotations.keys()].filter((id) => underClaim(id, rotations, claim.parents)));
    for (let grew = true; grew;) {
        grew = false;
        for (const [id, e] of rotations)
            if (!dropped.has(id) && dropped.has(e.rotation.parent)) {
                dropped.add(id);
                grew = true;
            }
    }
    return escapePending({ ...input, rotations: new Map([...rotations].filter(([id]) => !dropped.has(id))),
        catalogs: new Map([...input.catalogs].filter(([, e]) => !dropped.has(e.catalog.binding))) }, claim);
}
// Is rotation `id` under a claim parent along its rotation-parent chain?
function underClaim(id, rotations, parents) {
    const seen = new Set();
    let cursor = id;
    while (!seen.has(cursor)) {
        if (parents.includes(cursor))
            return false;
        seen.add(cursor);
        const parent = rotations.get(cursor).rotation.parent;
        if (parents.includes(parent))
            return true;
        if (!rotations.has(parent))
            return false;
        cursor = parent;
    }
    return false;
}
// Row 386 (C4): a trust_pending whose every pending id the claim closes out once its parents are closed (a rotation under a
// claim parent, a catalog bound to such a rotation, or a chain-pending catalog bound to a claim parent) is re-resolved with
// exactly those ids dropped; any other pending id keeps trust_pending.
async function escapePending(input, claim) {
    const { result, ctx } = await resolveInfo(input);
    if (result.ok || result.reason !== "trust_pending" || ctx === null)
        return result;
    const ids = result.detail.ids;
    const rot = new Set(ids.filter((id) => input.rotations.has(id) && underClaim(id, input.rotations, claim.parents)));
    const escapable = (id) => {
        if (rot.has(id))
            return true;
        const e = input.catalogs.get(id);
        if (e === undefined)
            return false;
        return rot.has(e.catalog.binding) || (ctx.cmemo.get(id)?.t === "pending" && claim.parents.includes(e.catalog.binding));
    };
    if (ids.length === 0 || !ids.every(escapable))
        return result;
    const drop = new Set(ids);
    return resolveCatalogBindingGraph({ ...input, rotations: new Map([...input.rotations].filter(([id]) => !drop.has(id))),
        catalogs: new Map([...input.catalogs].filter(([id]) => !drop.has(id))) });
}
// --- authoring coverage ----------------------------------------------------------------------------------------------------
/**
 * Check a candidate claim against a resolved graph for the authoring preflight (rows 352, 354, 356 and the convergence design):
 * pending first, then transition failures, then an omitted head, fork binding or rotation-fork rotation, or an omitted catalog
 * head (catalog_fork), then a prior that is not expected, entries that do not extend every cited prior and every null-cited
 * parent's floor, and a route that a held catalog maps to another replica. Returns null when covered.
 */
export function coverCatalogReplacementClaim(graph, claim, entries) {
    const unknown = claim.parents.filter((p) => !graph.nodes.has(p));
    const dead = (id) => graph.rawEvidence.has(id) || graph.closedOut.has(id) || graph.refusals.has(id);
    const expected = claim.parents.flatMap((binding) => {
        const heads = graph.forkBindings.includes(binding) && !graph.citableCatalogHeads.has(binding)
            ? [...graph.catalogStatus].filter(([cid, st]) => st === "uncovered" && graph.catalogs.get(cid).binding === binding)
                .map(([cid]) => cid).sort(compareUtf8)
            : graph.citableCatalogHeads.get(binding) ?? [];
        return heads.length === 0 ? [{ binding, catalog: null }] : heads.map((catalog) => ({ binding, catalog }));
    });
    const has = (list, item) => list.some((x) => x.binding === item.binding && x.catalog === item.catalog);
    if (unknown.some((id) => !dead(id)))
        return "trust_pending";
    if (claim.priorCatalogs.some((p) => p.catalog !== null && !graph.catalogs.has(p.catalog)))
        return "trust_pending";
    if (unknown.length > 0)
        return "invalid_catalog_transition";
    if (nextCatalogGeneration(claim.parents.map((p) => graph.nodes.get(p).generation)) !== claim.generation) {
        return "invalid_catalog_transition";
    }
    if (claim.parents.some((p) => {
        const n = graph.nodes.get(p);
        return claim.newServiceKey !== n.serviceKey && claim.newServiceId === n.serviceId;
    }))
        return "invalid_catalog_transition";
    if ([...graph.heads, ...graph.forkBindings, ...graph.rotationForks.map((f) => f.rotation)].some((h) => !claim.parents.includes(h))) {
        return "catalog_fork";
    }
    if (expected.some((p) => !has(claim.priorCatalogs, p)))
        return "catalog_fork";
    if (claim.priorCatalogs.some((p) => !has(expected, p)))
        return "invalid_catalog_transition";
    // Admit(ClaimFloor(claim), entries): the floor the claimed node would have, the same check its first catalog must pass
    // (rows 382 item 2 and 387). A floor or route map the graph does not hold fails closed.
    let floor = { t: "ok", entries: [], routes: new Map() };
    for (const p of claim.priorCatalogs) {
        const f = p.catalog === null ? graph.floors.get(p.binding) : undefined;
        const routes = p.catalog === null ? f?.routes : graph.catalogRoutes.get(p.catalog);
        const part = routes === undefined ? { t: "bad" } : { t: "ok", entries: p.catalog === null ? [...f.entries]
                : [...graph.catalogs.get(p.catalog).entries], routes: new Map(routes) };
        floor = mergeFloor(floor, part);
    }
    if (floor.t !== "ok" || !admit(floor, entries))
        return "invalid_catalog_transition";
    // The author cannot see a client's served routes, but every served route was in some held catalog. An entry a cited prior
    // already maps the same way is carried, not new, so a closed-out old-key catalog (D-A10) cannot veto carrying it.
    const carried = new Set(claim.priorCatalogs.flatMap((p) => p.catalog === null ? []
        : graph.catalogs.get(p.catalog).entries.map((x) => JSON.stringify([x.route, x.replica]))));
    if (entries.some((e) => !carried.has(JSON.stringify([e.route, e.replica])) && [...graph.catalogs.values()].some((c) => c.entries.some((x) => x.route === e.route && x.replica !== e.replica)))) {
        return "invalid_catalog_transition";
    }
    return null;
}
function same(left, right) {
    return left.length === right.length && left.every((value, i) => value === right[i]);
}
