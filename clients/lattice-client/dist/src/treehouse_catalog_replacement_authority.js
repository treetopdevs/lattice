// TS twin of Treehouse.CatalogReplacementAuthority (plan 316 PR 4a, section 3 step 4): the strict-prefix authority
// predicates of one replace_catalog_v1 claim. Pure over the given prefix; it reads only the public authority analysis
// (honored acquisitions, valid beacons), the continuation pin and the op bodies already in that prefix. It adds no Core
// primitive and judges nothing about the union. A passing check is not a route switch or catalog trust.
//
// The acquisition delegation is the one introduced by the honored record's own op (a transfer/grant for an ordinary
// acquisition, the succeed op's continuation delegation, parentId null, for an R04 continuation), never an id scan.
import { analyzeAuthority, resolveContinuationProfileFromFrames } from "./authority";
import { canonicalOrder, index } from "./dag";
import { compareUtf8 } from "./op";
import { treehouseSpaceSchema } from "./treehouse";
const maxSafe = Number.MAX_SAFE_INTEGER;
function refused(predicate) {
    return { reason: "catalog_authority_refused", predicate };
}
/** The delegation introduced by one authority op, when it is the single delegation with `id`. */
export function catalogReplacementAcquiredDelegation(op, id) {
    if (op === undefined || op.kind !== "authority" || op.authority === undefined)
        return null;
    const evidence = op.authority;
    const d = evidence.delegation;
    return d !== undefined && d !== null && d.id === id ? d : null;
}
function ceiling(d) {
    if (!d.ops.includes("replace_catalog_v1"))
        return "missing_permission";
    if (d.live !== false)
        return "live_capability";
    if (typeof d.expiresEpoch !== "number" || !Number.isSafeInteger(d.expiresEpoch) || d.expiresEpoch < 0 ||
        d.expiresEpoch > maxSafe)
        return "unleased";
    return null;
}
export async function checkCatalogReplacementAuthority(prefix, op, claim, spaceRoot) {
    const profile = await resolveContinuationProfileFromFrames({ replica: prefix.replica, frames: prefix.frames });
    if (!profile.ok || profile.profileGenesis !== claim.profileGenesis || profile.profileId !== claim.profileId) {
        return { reason: "wrong_catalog_scope", predicate: "profile" };
    }
    const ops = [...prefix.ops], byId = index(ops), order = canonicalOrder(ops, byId);
    const analysis = analyzeAuthority(treehouseSpaceSchema, ops, new Set(ops.map((o) => o.id)), order, byId, prefix.replica);
    const admin = analysis.acquiresByRole.get("admin") ?? [];
    const last = admin.at(-1);
    if (last === undefined || last.opId !== claim.holderEpoch || last.holderPubkey !== op.author)
        return refused("not_holder");
    const held = byId.get(last.opId);
    const evidence = held?.authority;
    if (evidence?.delegation?.id !== op.cap)
        return refused("wrong_acquisition_cap");
    const d = catalogReplacementAcquiredDelegation(held, op.cap);
    if (d === null)
        return refused("delegation_unreadable");
    const failed = ceiling(d);
    if (failed !== null)
        return refused(failed);
    const beacons = analysis.security.validBeacons;
    if (beacons.length === 0)
        return refused("no_beacon");
    const values = beacons.map((beacon) => typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch));
    const epoch = Math.max(...values);
    const basis = beacons.filter((_b, i) => values[i] === epoch).map((b) => b.opId).sort(compareUtf8);
    if (claim.epoch !== epoch || !same(claim.epochBasis, basis))
        return refused("epoch_mismatch");
    if (d.expiresEpoch < epoch)
        return refused("lease_lapsed");
    // Rows 335/356: replace_catalog_v1 in every honored admin ceiling since the latest Space-root-issued acquisition.
    const chain = admin.map((record) => {
        const introduced = byId.get(record.opId)?.authority;
        return introduced?.delegation ?? null;
    });
    let rooted = chain.length - 1;
    while (rooted >= 0 && chain[rooted] !== null && chain[rooted].issuer !== spaceRoot)
        rooted--;
    if (rooted < 0 || chain[rooted] === null ||
        chain.slice(rooted).some((x) => x === null || !x.ops.includes("replace_catalog_v1")))
        return refused("inherited_provenance");
    return null;
}
/**
 * Monotone refutation for a candidate whose causal closure is incomplete: null keeps it pending. Reads only the held
 * holder_epoch op's own delegation under claim.cap (audience, ceiling, liveness, finite lease).
 */
export function refuteCatalogReplacementWithoutClosure(ops, author, claim) {
    const op = ops.get(claim.holderEpoch);
    if (op === undefined)
        return null;
    const d = catalogReplacementAcquiredDelegation(op, claim.cap);
    if (d === null)
        return "delegation_unreadable";
    if (d.audience !== author)
        return "not_holder";
    return ceiling(d);
}
function same(left, right) {
    return left.length === right.length && left.every((value, i) => value === right[i]);
}
