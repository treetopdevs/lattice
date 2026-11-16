// TS twin of Treehouse.CatalogEntries.observe_with_detail/2 (plan 316 PR 4a, row 390 repair (c)): authenticated
// observations of the actual history a transport catalog's entries name. Every supplied history is authenticated (each frame
// verified and the cutoff derived) before any entry is judged, so a missing page cannot mask a detectable forgery. Each entry
// is bound to its bounded Space/Thread family, the bootstrap's service pair, its history's root, a root genesis, a creation
// command descending from it, and a reference (the Space itself, or a Space `create_thread` of that replica); a target the
// history's own Core judgment quarantines refuses the catalog. Invalid outranks pending. It establishes no trusted catalog
// signer, installed pin, usable route, membership permission, or completeness of unseen history.
//
// The CatalogTrust entry-proof code (treehouse_catalog_trust.ts) keeps its own private copy; this module is the callable twin
// the binding-graph resolver uses, written against the BEAM module's semantics.
import { analyzeAuthority, continuationFamily } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { verifyCarrierOp } from "./codec";
import { canonicalOrder, index } from "./dag";
import { materialize } from "./materialize";
import { compareUtf8 } from "./op";
import { verifyEd25519 } from "./signature";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceSchema, treehouseThreadSchema } from "./treehouse";
import { normalizeCatalogBootstrap } from "./treehouse_catalog_codec";
import { deriveTreehouseCatalogCutoff } from "./treehouse_catalog_cutoff";
/** The catalog's entry facts against `histories` (replica -> authenticated frames), as the BEAM `observe_with_detail/2`. */
export async function observeTreehouseCatalogEntries(catalog, histories) {
    const observed = await authenticate(histories);
    if (typeof observed === "string")
        return { ok: false, reason: observed, refused: [] };
    const space = observed.get(catalog.space);
    if (space === undefined)
        return { ok: false, reason: "trust_pending", refused: [] };
    if (!space.byId.has(catalog.bootstrap))
        return { ok: false, reason: "trust_pending", refused: [] };
    const boots = await treehouseCatalogBootstrapsFromFrames({ replica: catalog.space, frames: [...histories.get(catalog.space)] });
    if (!boots.ok)
        return { ok: false, reason: boots.reason, refused: [] };
    const bootstrap = boots.bootstraps.find((b) => b.id === catalog.bootstrap);
    if (bootstrap === undefined)
        return { ok: false, reason: "invalid_catalog_transition", refused: [] };
    const results = catalog.entries.map((entry) => {
        const refused = [];
        // A missing page must not conceal already available invalid entry proof.
        const result = combine([...entryChecks(entry, observed, space, bootstrap.record, refused)]);
        return { result, refused: [...new Set(refused)].sort(compareUtf8) };
    });
    const verdicts = results.map(({ result, refused }) => refused.length > 0 ? { reason: "invalid_catalog_transition", refused } : { reason: result, refused: [] });
    const failure = verdicts.find((v) => v.reason !== "ok" && v.reason !== "trust_pending") ??
        verdicts.find((v) => v.reason === "trust_pending");
    if (failure !== undefined)
        return { ok: false, reason: failure.reason, refused: failure.refused };
    return { ok: true, entries: catalog.entries.map((e) => ({ ...e })), bootstrap };
}
/** Structural completeness only (BEAM `structure_status/2`): no quarantine is read and the bootstrap need not be honored. */
export async function treehouseCatalogEntriesStructureStatus(catalog, histories) {
    const observed = await authenticate(histories);
    if (typeof observed === "string")
        return "invalid";
    const space = observed.get(catalog.space);
    if (space === undefined)
        return "pending";
    const op = space.byId.get(catalog.bootstrap);
    if (op === undefined)
        return "pending";
    const record = op.kind === "command" && op.command === "catalog_bootstrap_v1" ? normalizeCatalogBootstrap(op.commandArgs?.[0]) : null;
    if (record === null)
        return "invalid";
    const result = combine(catalog.entries.map((entry) => combine([...entryChecks(entry, observed, space, record, [])])));
    return result === "ok" ? "complete" : result === "trust_pending" ? "pending" : "invalid";
}
// Authenticate the entire supplied set before portability or pending classification.
async function authenticate(histories) {
    const observed = new Map();
    for (const [replica, frames] of histories) {
        const o = await observe(replica, frames);
        if (typeof o === "string")
            return o;
        observed.set(replica, o);
    }
    return observed;
}
function combine(checks) {
    return checks.find((c) => c !== "ok" && c !== "trust_pending") ?? (checks.includes("trust_pending") ? "trust_pending" : "ok");
}
function* entryChecks(entry, observed, space, record, refused) {
    if (continuationFamily(entry.replica) !== entry.kind || entry.serviceId !== record.serviceId ||
        entry.serviceKey !== record.serviceKey) {
        yield "invalid_catalog_transition";
        return;
    }
    const h = observed.get(entry.replica);
    if (h === undefined) {
        yield "trust_pending";
        return;
    }
    yield h.root === entry.root ? "ok" : "invalid_catalog_transition";
    const genesis = h.byId.get(entry.genesis), creation = h.byId.get(entry.creation);
    if (genesis === undefined)
        yield "trust_pending";
    else {
        const d = genesis.kind === "authority" && genesis.authority?.type === "genesis" ? genesis.authority.delegation : undefined;
        yield d !== undefined && h.root === entry.root && genesis.authorPubkey === h.root && d.issuer === h.root &&
            d.audience === h.root && d.parentId === null && h.delegationValid(d.id) ? "ok" : "invalid_catalog_transition";
    }
    if (creation === undefined)
        yield "trust_pending";
    else
        yield creation.kind === "command" && creation.command === (entry.kind === "space" ? "create_space" : "create_thread") &&
            (genesis === undefined || ancestor(genesis.id, creation.id, h.byId)) ? "ok" : "invalid_catalog_transition";
    if (entry.kind === "space") {
        yield entry.replica === space.replica && entry.replica === record.space && entry.root === record.spaceRoot
            ? "ok" : "invalid_catalog_transition";
    }
    else {
        const reference = space.byId.get(entry.reference);
        if (reference === undefined)
            yield "trust_pending";
        else
            yield reference.kind === "command" && reference.command === "create_thread" &&
                reference.commandArgs?.[0] === entry.replica ? "ok" : "invalid_catalog_transition";
    }
    for (const [history, id] of [[h, entry.genesis], [h, entry.creation], [space, entry.reference]]) {
        if (history.byId.has(id) && history.quarantine.has(id))
            refused.push(id);
    }
}
function ancestor(older, newer, by) {
    const seen = new Set(), pending = [...(by.get(newer)?.deps ?? [])];
    while (pending.length > 0) {
        const id = pending.pop();
        if (id === older)
            return true;
        if (seen.has(id))
            continue;
        seen.add(id);
        pending.push(...(by.get(id)?.deps ?? []));
    }
    return false;
}
async function observe(replica, raw) {
    const family = continuationFamily(replica);
    const frames = [];
    try {
        for (const value of structuredClone([...raw])) {
            const frame = decodeCarrierOpFrame(value);
            const checked = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, base64ToBytes(pub)) });
            if (frame.replica !== replica || !checked.valid)
                return "invalid_verified_history";
            frames.push(frame);
        }
    }
    catch {
        return "invalid_verified_history";
    }
    const cutoff = await deriveTreehouseCatalogCutoff({ replica, frames, rejected: [] });
    if (!cutoff.ok)
        return cutoff.reason;
    const product = family === "thread" ? "Treehouse.Thread" : "Treehouse.Space";
    const schema = family === "thread" ? treehouseThreadSchema : treehouseSpaceSchema;
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders(product));
    const byId = index(ops), order = canonicalOrder(ops, byId), ids = new Set(ops.map((op) => op.id));
    const analysis = analyzeAuthority(schema, ops, ids, order, byId, replica);
    const projection = materialize(schema, ops, ids, null, replica);
    return { replica, byId, root: analysis.security.root?.pubkey, quarantine: new Set(projection.quarantineReasons.keys()),
        delegationValid: (id) => analysis.security.delegations.get(id)?.validation.valid === true };
}
