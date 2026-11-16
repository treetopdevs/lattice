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
// case, so C10 to C15 stay open. Once a replacement op exists the graph, not a trust block, decides what is served, so an
// old-key catalog fork cannot stop an accepted replacement.
import { treehouseCatalogBootstrapsFromFrames } from "./treehouse";
import { advanceCatalogBindingState, resolveCatalogBindingGraph } from "./treehouse_catalog_binding_graph";
import { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogRotationId, catalogServiceRealm, transportCatalogId } from "./treehouse_catalog_codec";
import { parseCatalogArtifactJson } from "./treehouse_catalog_json";
import { compareUtf8 } from "./op";
import { evaluateTreehouseCatalogTrust, prepareTreehouseCatalogInstallation } from "./treehouse_catalog_trust";
const emptyBinding = () => ({ accepted: null, frozen: false });
/** Wrap a bare trust state as an installed state with nothing served yet. */
export function wrapReplacementTrust(trust) {
    return { trust, binding: emptyBinding(), extra: { catalogs: [] }, routes: [] };
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
        return mirrored(installed, decision, extra);
    try {
        return await composed(installed, decision, extra, ops);
    }
    catch {
        return recovery("malformed_catalog");
    }
}
// --- no replacement op: the trust decision, plus the mirrored watermark -------------------------------------------------
function mirrored(installed, decision, extra) {
    const binding = mirror(installed.binding, decision);
    const kind = decision.kind === "unchanged" && !same(extra, installed.extra) ? "propose" : decision.kind;
    const waiting = extra.catalogs.length > 0;
    return { kind, reason: decision.reason ?? (waiting ? "trust_pending" : null), refused: {},
        next: { ...installed, trust: decision.next, binding, extra, routes: decision.routes }, routes: decision.routes,
        servedOrigin: originOf(decision.routes), trustDecision: decision };
}
function mirror(binding, decision) {
    const accepted = decision.next.accepted;
    if (accepted === null)
        return binding;
    const routes = { ...(binding.accepted?.routes ?? {}) };
    for (const r of decision.routes)
        routes[r.path] = r.replica;
    return { ...binding, accepted: { ...accepted, routes } };
}
// --- a replacement op exists: the graph decides -------------------------------------------------------------------------
async function composed(installed, decision, extra, ops) {
    const trust = decision.next;
    const ready = extra.catalogs.filter((json) => { const e = decodeCatalog(json); return e !== null && ops.has(e.catalog.binding); });
    const waiting = extra.catalogs.length - ready.length;
    const input = await graphInput(installed, trust, ready);
    if (input === null)
        return recovery("trust_recovery_required");
    const result = await resolveCatalogBindingGraph(input);
    const advanced = advanceCatalogBindingState(installed.binding, result);
    const routes = serve(result, advanced, installed);
    const binding = { accepted: advanced.accepted, frozen: advanced.frozen };
    const next = { trust, binding, extra, routes: advanced.serving === null ? installed.routes : routes };
    return { kind: same(next, installed) ? "unchanged" : "propose", reason: reasonOf(result) ?? (waiting > 0 ? "trust_pending" : null),
        refused: result.ok ? Object.fromEntries(result.graph.rawEvidence) : {}, next, routes, servedOrigin: originOf(routes),
        trustDecision: decision };
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
    if (f.kind !== "command" || !Array.isArray(f.body) || f.body[0] !== "tuple" || !Array.isArray(f.body[1]))
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
