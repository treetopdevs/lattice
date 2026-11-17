// TS twin of Treehouse.CatalogReplacementTrust (plan 316 row 316): a composed evaluator that lets a client which already
// trusts a Treehouse catalog accept a replacement catalog signed by an authorized admin, without the old catalog signer's
// key. It has no production caller and nothing dials the routes it returns. Import it by path; it is not exported from
// index.ts.
//
// It is built by composition in a new file. evaluateTreehouseCatalogTrust still owns every page that has no replacement in
// it (row 381 keeps the internal hook open). This file adds a sidecar of replacement-bound catalogs (which the trust
// evaluator refuses as trust_pending), resolveCatalogBindingGraph + advanceCatalogBindingState as the authority on what is
// accepted and served once the Space history holds a replace_catalog_v1 op, and a route builder that reads the origin and
// service pair from the serving binding's graph node, not from the bootstrap.
//
// A catalog whose binding is neither the bootstrap nor a held rotation is replacement-bound and is kept in the sidecar, so a
// first catalog may arrive before its op. With a replace_catalog_v1 op held, the graph sees only the sidecar catalogs whose
// binding is a held op: a catalog bound to an unheld id waits and cannot pin the client. Its reason is trust_pending when a
// sidecar catalog waits and nothing else explains the result. A page that cannot be scanned is judged by the trust
// evaluator; an exception in the composed path is a malformed_catalog reject that changes nothing.
//
// Limits, all deliberate: a rotation under a replacement goes to the trust evaluator, which refuses the page as
// trust_pending; the sidecar has no byte budget (row 355) and no saved-state validation (row 395); an incomplete Space
// closure serves nothing new; and the authority check is the graph's, which for a leased admin is not the C10 R04-successor
// case, so C10 to C15 stay open.
//
// Block rule (D-689): the mere presence of a replacement-shaped op never widens what is served. Composition engages only when
// the resolver treats an op as a replacement node or as raw refusal evidence; a malformed or unauthorized op that is neither
// changes nothing. While the trust state is blocked its decision stands and nothing is served, except that a replacement the
// graph honors, whose first catalog it accepts with the serving node bound to that replacement, supersedes the block (so an
// old-key catalog fork cannot stop an accepted replacement). Only the block classes the graph resolves can be superseded (D-882):
// an authority_changed block or a catalog_fork among catalogs. A block that names an unreviewed bootstrap, a page whose Space
// shows one, a control_history_limit block and a block carrying overflow triggers are never superseded, because the graph
// judges only the reviewed bootstrap and does not resolve a truncated control history. A sidecar catalog bound to a held replacement op is admitted only
// if its signature verifies against that op's claimed catalog key, once per catalog id. wrapReplacementTrust carries the trust
// state's accepted watermark and cumulative routes into the graph state.
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders } from "./treehouse";
import { advanceCatalogBindingState, resolveCatalogBindingGraph } from "./treehouse_catalog_binding_graph";
import { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogRotationId, catalogServiceRealm, transportCatalogId, verifyCatalogEnvelope } from "./treehouse_catalog_codec";
import { parseCatalogArtifactJson } from "./treehouse_catalog_json";
import { compareUtf8 } from "./op";
import { evaluateTreehouseCatalogTrust, prepareTreehouseCatalogInstallation } from "./treehouse_catalog_trust";
const emptyBinding = () => ({ accepted: null, frozen: false });
/** Wrap a bare trust state as an installed state with nothing served yet. */
export function wrapReplacementTrust(trust) {
    return { trust, binding: { ...emptyBinding(), accepted: watermark(trust) }, extra: { catalogs: [] }, routes: [] };
}
// The trust state's accepted watermark with the cumulative route table of every catalog on the accepted chain (D-881), so a
// later replacement is judged against every route the client already accepted. The chain is walked as the trust state's
// accepted support is: the accepted catalog's previous chain, then for each rotation from the accepted binding up to the
// bootstrap, its prior catalog's previous chain. If two catalogs map one route to different replicas, the newer catalog's
// replica is kept. A link the trust state does not hold ends that branch.
function watermark(trust) {
    const accepted = trust.accepted;
    if (accepted === null)
        return null;
    const catalogs = new Map();
    for (const record of trust.catalogs) {
        const envelope = decodeCatalog(record.json);
        if (envelope !== null)
            catalogs.set(record.id, envelope.catalog);
    }
    const rotations = new Map();
    for (const record of trust.rotations) {
        const envelope = decodeRotation(record.json);
        if (envelope !== null)
            rotations.set(record.id, envelope.rotation);
    }
    const starts = [accepted.catalog];
    for (let binding = accepted.binding, visited = new Set(); !visited.has(binding);) {
        const rotation = rotations.get(binding);
        if (rotation === undefined)
            break;
        visited.add(binding);
        starts.push(rotation.priorCatalog);
        binding = rotation.parent;
    }
    const routes = {};
    const seen = new Set();
    for (const start of starts) {
        for (let id = start; id !== null && !seen.has(id);) {
            const catalog = catalogs.get(id);
            if (catalog === undefined)
                break;
            seen.add(id);
            for (const e of catalog.entries)
                if (!Object.hasOwn(routes, e.route))
                    routes[e.route] = e.replica;
            id = catalog.previous;
        }
    }
    return { ...accepted, routes };
}
/** As prepareTreehouseCatalogInstallation, with the proposed state wrapped. */
export async function prepareReplacementTrustInstallation(input) {
    const decision = await prepareTreehouseCatalogInstallation(input);
    return { decision, next: decision.kind === "reject" ? null : wrapReplacementTrust(decision.next) };
}
export async function evaluateReplacementTrust(input) {
    const { installed, expected, incoming } = input;
    const { legacy, bound } = split(installed, incoming);
    const extra = { catalogs: [...new Set([...installed.extra.catalogs, ...bound])].sort(compareUtf8) };
    const decision = await evaluateTreehouseCatalogTrust({ installed: installed.trust, expected, incoming: legacy });
    if (decision.kind === "reject")
        return decision;
    const ops = replaceIds(decision.next);
    if (ops.size === 0)
        return mirrored(installed, decision, extra, ops);
    try {
        return await composed(installed, decision, extra, ops);
    }
    catch {
        return recovery("malformed_catalog");
    }
}
// --- no replacement op: the trust decision, plus the mirrored watermark -------------------------------------------------
function mirrored(installed, decision, extra, ops) {
    const binding = mirror(installed.binding, decision, ops);
    const kind = decision.kind === "unchanged" && !same(extra, installed.extra) ? "propose" : decision.kind;
    const waiting = extra.catalogs.length > 0;
    return { kind, reason: decision.reason ?? (waiting ? "trust_pending" : null), refused: {},
        next: { ...installed, trust: decision.next, binding, extra, routes: decision.routes }, routes: decision.routes,
        servedOrigin: originOf(decision.routes), trustDecision: decision };
}
function mirror(binding, decision, ops) {
    const accepted = watermark(decision.next);
    if (accepted === null)
        return binding;
    // A watermark the graph holds on a replacement binding is the graph's; the trust state's accepted catalog never overwrites it.
    if (binding.accepted !== null && ops.has(binding.accepted.binding))
        return binding;
    // The accepted chain's routes too, so a route moved by several catalogs on one page stays reserved (D-881).
    const routes = { ...(binding.accepted?.routes ?? {}), ...accepted.routes };
    for (const r of decision.routes)
        routes[r.path] = r.replica;
    return { ...binding, accepted: { ...accepted, routes } };
}
// --- a replacement op exists: the graph decides -------------------------------------------------------------------------
async function composed(installed, decision, extra, ops) {
    const trust = decision.next;
    const { ready, waiting, kept } = readyCatalogs(extra.catalogs, ops, catalogKeys(trust));
    extra = { catalogs: kept };
    const input = await graphInput(installed, trust, ready);
    if (input === null)
        return recovery("trust_recovery_required");
    const result = await resolveCatalogBindingGraph(input);
    const advanced = advanceCatalogBindingState(installed.binding, result);
    const routes = serve(result, advanced, installed);
    // A replace-shaped op engages composition only when the resolver treats it as a replacement node or as raw refusal
    // evidence; a malformed or unauthorized op that is neither changes nothing.
    if (!engaged(result))
        return mirrored(installed, decision, extra, ops);
    // A trust block is superseded only by the serving catalog of a replacement node the graph honors.
    if (trust.blocked !== null && !(supersedable(trust, decision) && supersedes(result, advanced, routes))) {
        return { ...mirrored(installed, decision, extra, ops), refused: result.ok ? Object.fromEntries(result.graph.rawEvidence) : {} };
    }
    const binding = { accepted: advanced.accepted, frozen: advanced.frozen };
    const next = { trust, binding, extra, routes: advanced.serving === null ? installed.routes : routes };
    return { kind: same(next, installed) ? "unchanged" : "propose", reason: reasonOf(result) ?? (waiting > 0 ? "trust_pending" : null),
        refused: result.ok ? Object.fromEntries(result.graph.rawEvidence) : {}, next, routes, servedOrigin: originOf(routes),
        trustDecision: decision };
}
function engaged(result) {
    if (!result.ok)
        return true;
    return [...result.graph.nodes.values()].some((n) => n.kind === "replacement") || result.graph.rawEvidence.size > 0;
}
// Only the block classes the replacement graph resolves may be superseded (D-882); see the file header.
function supersedable(trust, decision) {
    const block = trust.blocked;
    if (block === null || (block.reason !== "authority_changed" && block.reason !== "catalog_fork"))
        return false;
    if (block.bootstrapIds.length > 0 || block.triggers.length > 0)
        return false;
    return decision.observed.bootstrapIds.every((id) => trust.review.observedBootstrapIds.includes(id));
}
function supersedes(result, advanced, routes) {
    if (!result.ok || advanced.serving === null || routes.length === 0)
        return false;
    const catalog = result.graph.catalogs.get(advanced.serving);
    return catalog !== undefined && result.graph.nodes.get(catalog.binding)?.kind === "replacement";
}
// Sidecar catalogs whose binding is a held replacement op reach the graph, and only after their signature verifies against that
// op's catalog key: an unverifiable variant is dropped for good and a catalog id is admitted once (the graph input is keyed by
// catalog id, which excludes the signature). A catalog bound to an op that is not held waits, unverified.
function readyCatalogs(jsons, ops, keys) {
    const ready = [], waiting = [], seen = new Set();
    for (const json of jsons) {
        const envelope = decodeCatalog(json);
        if (envelope === null || !ops.has(envelope.catalog.binding)) {
            waiting.push(json);
            continue;
        }
        const key = keys.get(envelope.catalog.binding);
        if (key === undefined || !verifyCatalogEnvelope(envelope, key))
            continue;
        const id = transportCatalogId(envelope.catalog);
        if (!seen.has(id)) {
            seen.add(id);
            ready.push(json);
        }
    }
    return { ready, waiting: waiting.length, kept: [...ready, ...waiting].sort(compareUtf8) };
}
// The catalog key each replacement op claims, for ops whose claim decodes. The command decoder requires three arguments, so a
// catalog bound to an op of any other arity has no key and is dropped; the Elixir twin matches `[claim, _, _]` (D-881).
function catalogKeys(trust) {
    const keys = new Map();
    try {
        const space = trust.histories.find((h) => h.replica === trust.review.space);
        if (space === undefined)
            return keys;
        const frames = space.frames.map((f) => decodeCarrierOpFrame(structuredClone(f)));
        for (const op of carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"))) {
            if (op.command !== "replace_catalog_v1" || op.commandError !== undefined || !Array.isArray(op.commandArgs))
                continue;
            const claim = op.commandArgs[0];
            if (claim !== null && claim !== undefined && typeof claim.newCatalogKey === "string")
                keys.set(op.id, claim.newCatalogKey);
        }
    }
    catch { /* an undecodable history yields no keys; the graph then refuses the page as malformed input */ }
    return keys;
}
function recovery(reason) {
    return { kind: "reject", reason, detail: { ids: [], coreReason: null, pendingProofIds: [] } };
}
function reasonOf(result) {
    if (!result.ok)
        return result.reason;
    const d = result.graph.decision;
    return d.block?.reason ?? d.reason;
}
// The serving catalog's routes from its graph node; on a pending delivery the stored table, and only while it is still the
// accepted catalog's.
function serve(result, advanced, installed) {
    const serving = advanced.serving;
    if (serving === null)
        return [];
    if (result.ok) {
        const catalog = result.graph.catalogs.get(serving);
        const node = catalog && result.graph.nodes.get(catalog.binding);
        if (catalog && node)
            return build(serving, catalog, node.origin);
    }
    return advanced.accepted?.catalog === serving ? installed.routes : [];
}
function build(id, catalog, origin) {
    return catalog.entries.map((e) => ({ replica: e.replica, kind: e.kind, schema: e.schema, root: e.root, genesis: e.genesis,
        creation: e.creation, reference: e.reference, binding: catalog.binding, catalog: id, revision: catalog.revision, origin,
        path: e.route, url: origin + e.route, serviceId: e.serviceId, serviceKey: e.serviceKey, realm: catalogServiceRealm(e.serviceId) }));
}
const originOf = (routes) => routes[0]?.origin ?? null;
// --- the graph's input, rebuilt from the retained evidence ------------------------------------------------------------
async function graphInput(installed, trust, ready) {
    const space = trust.histories.find((h) => h.replica === trust.review.space);
    if (space === undefined)
        return null;
    const observed = await treehouseCatalogBootstrapsFromFrames(space);
    if (!observed.ok)
        return null;
    const bootstrap = observed.bootstraps.find((b) => b.id === trust.review.bootstrapId);
    if (bootstrap === undefined)
        return null;
    const catalogs = new Map();
    for (const json of [...trust.catalogs.map((c) => c.json), ...ready]) {
        const envelope = decodeCatalog(json);
        if (envelope === null)
            return null;
        catalogs.set(transportCatalogId(envelope.catalog), envelope);
    }
    const rotations = new Map();
    for (const record of trust.rotations) {
        const envelope = decodeRotation(record.json);
        if (envelope === null)
            return null;
        rotations.set(record.id, envelope);
    }
    const histories = {};
    for (const h of trust.histories)
        if (h.replica !== trust.review.space)
            histories[h.replica] = h.frames;
    return { bootstrap, frames: space.frames, rotations, catalogs, provenCutoffs: trust.cutoffProofs.map((p) => p.cutoff),
        accepted: installed.binding.accepted, histories };
}
function decodeCatalog(json) {
    const parsed = parseCatalogArtifactJson(json);
    return parsed.ok ? catalogEnvelopeFromCarrierTerm(parsed.value) : null;
}
function decodeRotation(json) {
    const parsed = parseCatalogArtifactJson(json);
    return parsed.ok ? catalogRotationEnvelopeFromCarrierTerm(parsed.value) : null;
}
// --- partition: the legacy part to the trust evaluator, replacement-bound catalogs to the sidecar ------------------
/** The ids of replace_catalog_v1 ops in the retained Space history. */
function replaceIds(trust) {
    const ids = new Set();
    for (const h of trust.histories) {
        if (h.replica !== trust.review.space)
            continue;
        for (const frame of h.frames)
            if (isReplaceFrame(frame))
                ids.add(frame.id);
    }
    return ids;
}
function isReplaceFrame(frame) {
    const f = frame;
    // As the Elixir `{:replace_catalog_v1, _}` match: a 2-tuple whose first element is the atom (D-881).
    if (f.kind !== "command" || !Array.isArray(f.body) || f.body[0] !== "tuple" || !Array.isArray(f.body[1]) ||
        f.body[1].length !== 2)
        return false;
    const first = f.body[1][0];
    return Array.isArray(first) && first[0] === "atom" && first[1] === "replace_catalog_v1";
}
function split(installed, incoming) {
    try {
        const known = new Set([installed.trust.review.bootstrapId, ...installed.trust.rotations.map((r) => r.id)]);
        for (const json of incoming.rotations) {
            const envelope = decodeRotation(json);
            if (envelope !== null)
                known.add(catalogRotationId(envelope));
        }
        const legacy = [], bound = [];
        for (const json of incoming.catalogs) {
            const envelope = decodeCatalog(json);
            (envelope === null || known.has(envelope.catalog.binding) ? legacy : bound).push(json);
        }
        return { legacy: { ...incoming, catalogs: legacy }, bound };
    }
    catch {
        // A page that cannot be scanned is the trust evaluator's to refuse, whole.
        return { legacy: incoming, bound: [] };
    }
}
function same(a, b) { return canonical(a) === canonical(b); }
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined)
            .sort(([x], [y]) => compareUtf8(x, y));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
