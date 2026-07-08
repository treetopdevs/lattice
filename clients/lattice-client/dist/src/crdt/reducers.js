import { cmpHash } from "../op";
import { ancestors } from "../dag";
/**
 * LWW register: keep the max writer by (lamport depth, hash). Order-independent
 * — this is the CRDT semantics, not "last op applied wins" — so concurrent
 * writes resolve to one deterministic value on every realm, no coordinator.
 * Returns the winning value plus the winning op id (for provenance/highlighting).
 */
export function lww(writers, depthOf) {
    let best = null;
    for (const o of writers) {
        if (o.mutation !== "write")
            continue;
        const d = depthOf(o.id);
        if (!best ||
            d > best.d ||
            (d === best.d && cmpHash(o.hash, best.h) > 0)) {
            best = { id: o.id, d, h: o.hash, v: o.value };
        }
    }
    return best ? { value: best.v, winner: best.id } : { value: undefined, winner: null };
}
/** OR-set: add-wins observed-remove set, with add ops as tags. */
export function orSet(fieldOps, byId) {
    const addTags = new Map();
    const values = new Map();
    const removed = new Set();
    const ancestorCache = new Map();
    for (const o of fieldOps) {
        if (o.mutation !== "add")
            continue;
        const key = valueKey(o.value);
        values.set(key, o.value);
        const tags = addTags.get(key) ?? new Set();
        tags.add(o.id);
        addTags.set(key, tags);
    }
    for (const o of fieldOps) {
        if (o.mutation !== "remove")
            continue;
        const tags = addTags.get(valueKey(o.value)) ?? new Set();
        const observed = ancestors(o.id, byId, ancestorCache);
        for (const tag of tags) {
            if (observed.has(tag))
                removed.add(tag);
        }
    }
    return [...values.entries()]
        .filter(([, value]) => {
        const tags = addTags.get(valueKey(value)) ?? new Set();
        return [...tags].some((tag) => !removed.has(tag));
    })
        .map(([, value]) => value)
        .sort(compareValues);
}
/** Causal list: appended values in canonical causal order. */
export function causalList(fieldOps, order) {
    const orderIdx = new Map(order.map((id, i) => [id, i]));
    return [...fieldOps]
        .filter((o) => o.mutation === "append")
        .sort((a, b) => (orderIdx.get(a.id) - orderIdx.get(b.id)))
        .map((o) => o.value);
}
function valueKey(value) {
    return typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
}
function compareValues(a, b) {
    const ka = typeof a === "string" ? a : JSON.stringify(a);
    const kb = typeof b === "string" ? b : JSON.stringify(b);
    return ka > kb ? 1 : ka < kb ? -1 : 0;
}
