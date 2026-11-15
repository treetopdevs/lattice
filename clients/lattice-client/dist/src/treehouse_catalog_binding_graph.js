// TS twin of Treehouse.CatalogBindingGraph (plan 316 PR 4a): the pure binding-graph resolver for replace_catalog_v1
// (steps 1-3 and 5-9, D-270, D-275 to D-279, OD-16, OD-17, row 320). Not wired: treehouse_catalog_trust.ts does not call
// it yet (4c), so it changes no route, watermark or retained-client behaviour, and it produces no route. It adds no Core
// primitive, wire atom or quarantine reason. Both runtimes are pinned to the same hand-written label-space expectations
// and to each other's outputs by binding_graph_v1.json / binding_graph_ts_v1.json.
//
// Intrinsic verdicts: every Space replace_catalog_v1 op is an eligible node (refused when the full union refuses it),
// raw evidence (any intrinsic failure; no head, no closure) or pending. A candidate whose closure is incomplete is refuted
// early only from facts no missing ancestor can change; otherwise it stays pending. Rotations are nodes when their chain
// checks pass under their parent node. Union classification only reclassifies. Catalog failures are retained refusals.
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
    const ctx = await context(input);
    if (ctx === null)
        return { ok: false, reason: "malformed_catalog", detail: { ids: [] } };
    return run(ctx);
}
// --- context ----------------------------------------------------------------------------------------------------------
async function context(input) {
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
        proven: new Set(input.provenCutoffs.map((c) => `${c.replica}\u0000${c.logDigest}`)), bootHonored: false,
        memo: new Map(), visiting: new Set() };
    ctx.bootHonored = bootstrapHonored(ctx);
    return ctx;
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
    const nodesAll = new Map();
    for (const [id, verdict] of ctx.memo)
        if (verdict.t === "node")
            nodesAll.set(id, verdict.node);
    nodesAll.set(ctx.bootstrapId, bootstrapNode(ctx));
    const closed = closedSet(nodesAll);
    const outRot = closedOutRotations(nodesAll, closed);
    const final = new Map([...nodesAll].filter(([id]) => !outRot.has(id)));
    const heads = headsOf(final);
    const cat = classifyCatalogs(ctx, nodesAll, closed, outRot);
    // Any held op whose closure is incomplete is a missing history page: the authority fold over the complete ops would judge
    // a smaller history. Only a candidate already refuted from its own bytes is exempt.
    const incomplete = [...ctx.byId.keys()].filter((id) => !ctx.complete.has(id) && ctx.memo.get(id)?.t !== "bad");
    const pending = [...new Set([...[...ctx.memo].filter(([, v]) => v.t === "pending").map(([id]) => id), ...cat.pending,
            ...incomplete])].sort(compareUtf8);
    if (heads.length > 2)
        return { ok: false, reason: "control_history_limit", detail: { ids: heads } };
    if (pending.length > 0)
        return { ok: false, reason: "trust_pending", detail: { ids: pending } };
    return { ok: true, graph: assemble(ctx, nodesAll, final, heads, closed, outRot, cat) };
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
    if (nextCatalogGeneration([p.generation]) !== r.generation)
        return { t: "bad", reason: "invalid_catalog_transition" };
    if (r.newCatalogKey === p.key || r.newCatalogKey === p.serviceKey)
        return { t: "bad", reason: "invalid_catalog_transition" };
    if (!verifyKey(p.key, canonicalBytesForCatalogRotation(r), e.oldSignature))
        return { t: "bad", reason: "invalid_catalog_signature" };
    if (!verifyKey(r.newCatalogKey, canonicalBytesForCatalogRotationPossession(r), e.newSignature)) {
        return { t: "bad", reason: "invalid_possession" };
    }
    const prior = ctx.input.catalogs.get(r.priorCatalog)?.catalog;
    if (prior === undefined)
        return { t: "pending" };
    if (prior.binding !== r.parent || catalogInventoryId(prior.entries) !== r.inventoryDigest ||
        !same(r.cutoffs.map((c) => c.replica), prior.entries.map((entry) => entry.replica))) {
        return { t: "bad", reason: "invalid_catalog_transition" };
    }
    return { t: "node", node: { id, kind: "rotation", generation: r.generation, key: r.newCatalogKey, serviceId: p.serviceId,
            serviceKey: p.serviceKey, origin: p.origin, parents: [r.parent], prior: [{ binding: r.parent, catalog: r.priorCatalog }],
            // A rotation keeps its parent's service, so it inherits the unproven recovery cutoffs.
            inventory: r.inventoryDigest, refused: p.refused, coreReason: p.coreReason, pending: p.pending } };
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
    return { t: "node", node: { id, kind: "replacement", generation: s.claim.generation, key: s.claim.newCatalogKey,
            serviceId: s.claim.newServiceId, serviceKey: s.claim.newServiceKey, origin: s.claim.newOrigin, parents: s.claim.parents,
            prior: s.claim.priorCatalogs, inventory: s.claim.inventoryDigest, refused: core !== null, coreReason: core,
            pending: s.claim.cutoffs.filter((cut) => !ctx.proven.has(`${cut.replica}\u0000${cut.logDigest}`))
                .map((cut) => ({ replica: cut.replica, logDigest: cut.logDigest })) } };
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
    }
    return { failures, pending };
}
// --- closure and heads -------------------------------------------------------------------------------------------------
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
function headsOf(final) {
    const cited = closure([...final.values()].flatMap((n) => [...n.parents]), final);
    return [...final.keys()].filter((id) => !cited.has(id)).sort(compareUtf8);
}
// Two passes: validity, then status (current under an open binding; covered / closed_out / uncovered under a closed one;
// refused with a reason; pending).
function classifyCatalogs(ctx, nodesAll, closed, outRot) {
    const cites = citations(nodesAll, closed);
    const previous = new Map([...ctx.input.catalogs].map(([id, e]) => [id, e.catalog.previous]));
    const validity = new Map();
    const acc = { status: new Map(), refusals: new Map(), pending: [], cites, previous, validity };
    const refuse = (id, reason, core) => {
        acc.refusals.set(id, { reason, coreReason: core });
        return "refused";
    };
    const valid = (id) => {
        const known = validity.get(id);
        if (known !== undefined)
            return known;
        const value = validityOf(id);
        validity.set(id, value);
        return value;
    };
    const isPending = (v) => v.t === "pending" || v.t === "binding_pending";
    const validityOf = (id) => {
        const e = ctx.input.catalogs.get(id), c = e.catalog, n = nodesAll.get(c.binding);
        if (c.space !== ctx.replica || c.bootstrap !== ctx.bootstrapId)
            return { t: "refused", reason: "wrong_catalog_scope" };
        if (n === undefined) {
            if (ctx.candidates.has(c.binding) || ctx.input.rotations.has(c.binding)) {
                return ctx.memo.get(c.binding)?.t === "bad" ? { t: "refused", reason: "invalid_catalog_transition" } : { t: "binding_pending" };
            }
            if (ctx.byId.has(c.binding) || ctx.input.catalogs.has(c.binding))
                return { t: "refused", reason: "invalid_catalog_transition" };
            return { t: "binding_pending" };
        }
        if (!verifyCatalogEnvelope(e, n.key))
            return { t: "refused", reason: "invalid_catalog_signature" };
        if (c.entries.some((entry) => entry.serviceId !== n.serviceId || entry.serviceKey !== n.serviceKey)) {
            return { t: "refused", reason: "wrong_catalog_scope" };
        }
        if (c.previous === null) {
            // Replacement-dependent first-catalog checks: revision 0, the declared inventory, and extension of every cited prior,
            // which must itself be valid. A bootstrap or rotation first catalog takes any revision, as in CatalogTrust.
            const priors = n.kind === "replacement" ? n.prior.flatMap((p) => p.catalog === null ? [] : [p.catalog]) : [];
            const priorVs = priors.map((k) => ctx.input.catalogs.has(k) ? valid(k) : { t: "pending" });
            const extendsAll = priors.every((k) => {
                const prior = ctx.input.catalogs.get(k);
                return prior === undefined || extendsEntries(prior.catalog.entries, c.entries);
            });
            if ((n.kind === "replacement" && c.revision !== 0) ||
                (n.inventory !== null && catalogInventoryId(c.entries) !== n.inventory) || !extendsAll ||
                priorVs.some((v) => v.t !== "ok" && !isPending(v)))
                return { t: "bad_chain" };
            if (priorVs.some((v) => v.t !== "ok"))
                return { t: "pending" };
            return { t: "ok" };
        }
        if (!ctx.input.catalogs.has(c.previous))
            return { t: "pending" };
        const prev = valid(c.previous);
        const prior = ctx.input.catalogs.get(c.previous).catalog;
        if (isPending(prev))
            return { t: "pending" };
        if (prev.t !== "ok" || prior.binding !== c.binding)
            return { t: "bad_chain" };
        if (nextCatalogGeneration([prior.revision]) !== c.revision || !extendsEntries(prior.entries, c.entries))
            return { t: "bad_chain" };
        return { t: "ok" };
    };
    const statusOf = (id) => {
        const c = ctx.input.catalogs.get(id).catalog, n = nodesAll.get(c.binding), v = validity.get(id);
        if (v.t === "refused")
            return refuse(id, v.reason, null);
        if (v.t === "binding_pending")
            return "pending";
        if (n.refused)
            return refuse(id, "catalog_authority_refused", n.coreReason);
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
    // chain is refused when invalid and pending when its chain is; an uncited old-key catalog is never pending.
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
        return "uncovered";
    };
    const ids = [...ctx.input.catalogs.keys()].sort(compareUtf8);
    for (const id of ids)
        valid(id);
    for (const id of ids)
        acc.status.set(id, statusOf(id));
    // Across every current or covered catalog a route names one replica; a later conflicting one (id order) is refused.
    // Closed-out and uncovered old-key catalogs reserve no route, so they cannot refuse an honest head.
    const used = new Map();
    for (const id of ids) {
        const s = acc.status.get(id);
        if (s !== "current" && s !== "covered")
            continue;
        const entries = ctx.input.catalogs.get(id).catalog.entries;
        if (entries.some((entry) => (used.get(entry.route) ?? entry.replica) !== entry.replica)) {
            refuse(id, "invalid_catalog_transition", null);
            acc.status.set(id, "refused");
        }
        else
            for (const entry of entries)
                used.set(entry.route, entry.replica);
    }
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
function forksOf(ctx, final, heads, closed, cat, catHeads) {
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
    const key = (f) => `${f.kind}\u0000${f.binding ?? ""}\u0000${f.ids.join("\u0000")}`;
    return forks.sort((a, b) => compareUtf8(key(a), key(b)));
}
function assemble(ctx, nodesAll, final, heads, closed, outRot, cat) {
    const closedOut = new Map();
    for (const id of outRot)
        closedOut.set(id, "catalog_rollback");
    for (const [id, s] of cat.status)
        if (s === "closed_out")
            closedOut.set(id, "catalog_rollback");
    const catHeads = catalogHeadsOf(ctx, final, closed, cat);
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
    const graph = { nodes: final, heads, closed: [...closed].sort(compareUtf8), closedOut,
        pending: [...final.values()].filter((n) => n.pending.length > 0).map((n) => n.id).sort(compareUtf8), rawEvidence: raw,
        refusals, catalogHeads: catHeads, citableCatalogHeads: citableCatalogHeadsOf(ctx, final, closed, cat),
        catalogStatus: cat.status, citations: cat.cites, previous: cat.previous,
        forks: forksOf(ctx, final, heads, closed, cat, catHeads),
        catalogs: new Map([...ctx.input.catalogs].map(([id, e]) => [id, e.catalog])),
        decision: undefined };
    graph.decision = decide(ctx, graph, nodesAll, closed, outRot);
    return graph;
}
function decide(ctx, graph, nodesAll, closed, outRot) {
    const a = ctx.input.accepted;
    const abs = a === null ? "missing" : outRot.has(a.binding) ? "closed_out" :
        !nodesAll.has(a.binding) ? "missing" : nodesAll.get(a.binding).refused ? "refused" : closed.has(a.binding) ? "closed" : "current";
    const s = a === null ? undefined : graph.catalogStatus.get(a.catalog);
    const acs = a === null ? "missing" : s === "covered" ? "ancestor_of_cited" :
        s === "closed_out" || s === "uncovered" ? "closed_out" : s === "current" ? "current" : s === "refused" ? "refused" : "missing";
    const base = { accepted: false, reason: null, block: null, head: null, catalog: null, generation: null,
        revision: null, clearsAuthorityChanged: false, acceptedBindingStatus: abs, acceptedCatalogStatus: acs };
    if (graph.forks.length > 0) {
        const ids = [...new Set(graph.forks.flatMap((f) => [...f.ids]))].sort(compareUtf8);
        return { ...base, reason: "catalog_fork", block: { reason: "catalog_fork", triggers: ids } };
    }
    const id = graph.heads[0], node = graph.nodes.get(id);
    const ready = graph.catalogHeads.get(id)?.[0] ?? null;
    const held = { ...base, head: id };
    const promotable = !node.refused && node.pending.length === 0 && ready !== null;
    // With an accepted state, an accepted binding or catalog absent from the input fails closed as a trigger.
    const trigger = a !== null && (abs === "refused" || abs === "closed_out" || abs === "missing" || acs === "closed_out" ||
        acs === "refused" || acs === "missing");
    const promote = (clears) => {
        const revision = graph.catalogs.get(ready).revision;
        if (a !== null && (node.generation < a.generation || (id === a.binding && revision < a.revision))) {
            return { ...held, reason: "catalog_rollback" };
        }
        return { ...held, accepted: true, catalog: ready, generation: node.generation, revision, clearsAuthorityChanged: clears };
    };
    if (promotable && row320(ctx, graph, id))
        return promote(true);
    if (promotable && abs === "refused" && node.kind === "replacement" && a !== null && graph.closed.includes(a.binding) &&
        (graph.citations.get(a.binding) ?? []).some((c) => c !== null && onChain(a.catalog, c, graph.previous)))
        return promote(false);
    // A standing authority_changed block keeps its triggers, so a resolution delivered before its first catalog stays fresh.
    const standing = ctx.input.blocked?.reason === "authority_changed" ? [...ctx.input.blocked.triggers] : [id];
    if (trigger)
        return { ...held, reason: "authority_changed", block: { reason: "authority_changed", triggers: standing } };
    if (node.refused)
        return { ...held, reason: "catalog_authority_refused" };
    if (node.pending.length > 0)
        return { ...held, reason: "recovery_incomplete" };
    if (ready === null)
        return held;
    return promote(false);
}
// Row 320: after an authority_changed block, a fresh honored admin resolution (not a block trigger) that closes every
// trigger, as the sole head, clears it.
function row320(ctx, graph, id) {
    const b = ctx.input.blocked;
    if (b === null || b.reason !== "authority_changed" || graph.nodes.get(id)?.kind !== "replacement" || b.triggers.includes(id)) {
        return false;
    }
    return b.triggers.every((t) => graph.closed.includes(t));
}
// --- authoring coverage ----------------------------------------------------------------------------------------------------
/**
 * Check a candidate claim against a resolved graph for the authoring preflight (rows 352, 354, 356): pending first, then
 * transition failures, then an omitted head or catalog head (catalog_fork), then a prior that is not a catalog head and
 * first-catalog extension of every cited prior against `entries`. Returns null when covered.
 */
export function coverCatalogReplacementClaim(graph, claim, entries) {
    const unknown = claim.parents.filter((p) => !graph.nodes.has(p));
    const dead = (id) => graph.rawEvidence.has(id) || graph.closedOut.has(id) || graph.refusals.has(id);
    const expected = claim.parents.flatMap((binding) => {
        const heads = graph.citableCatalogHeads.get(binding) ?? [];
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
    if (graph.heads.some((h) => !claim.parents.includes(h)))
        return "catalog_fork";
    if (expected.some((p) => !has(claim.priorCatalogs, p)))
        return "catalog_fork";
    if (claim.priorCatalogs.some((p) => !has(expected, p)))
        return "invalid_catalog_transition";
    if (claim.priorCatalogs.some((p) => p.catalog !== null && !extendsEntries(graph.catalogs.get(p.catalog).entries, entries))) {
        return "invalid_catalog_transition";
    }
    return null;
}
function same(left, right) {
    return left.length === right.length && left.every((value, i) => value === right[i]);
}
