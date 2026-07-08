import { cmpHash } from "./op";
/** Index ops by id for O(1) lookup. */
export function index(ops) {
    const m = new Map();
    for (const o of ops)
        m.set(o.id, o);
    return m;
}
/** Transitive causal ancestors of `id` (exclusive of `id`). Memoized per call set. */
export function ancestors(id, byId, cache = new Map()) {
    const hit = cache.get(id);
    if (hit)
        return hit;
    const acc = new Set();
    const op = byId.get(id);
    if (op) {
        for (const d of op.deps) {
            if (!acc.has(d)) {
                acc.add(d);
                for (const a of ancestors(d, byId, cache))
                    acc.add(a);
            }
        }
    }
    cache.set(id, acc);
    return acc;
}
/** Two ops are concurrent iff neither is an ancestor of the other. */
export function concurrent(a, b, byId, cache = new Map()) {
    return !ancestors(a, byId, cache).has(b) && !ancestors(b, byId, cache).has(a);
}
/** Lamport depth = longest path from a root. Deterministic; used as the LWW clock. */
export function depth(id, byId, cache = new Map()) {
    const hit = cache.get(id);
    if (hit !== undefined)
        return hit;
    const op = byId.get(id);
    const ds = op ? op.deps : [];
    const d = ds.length ? Math.max(...ds.map((x) => depth(x, byId, cache))) + 1 : 0;
    cache.set(id, d);
    return d;
}
/**
 * Canonical linear extension of the DAG: a deterministic topological sort with
 * ascending-hash tiebreak among ready ops. This is the same order the reducer
 * and byte-identical replay use, so scrubbing/replay is well-defined.
 */
export function canonicalOrder(ops, byId = index(ops)) {
    const incoming = new Map();
    const children = new Map();
    for (const o of ops) {
        incoming.set(o.id, 0);
        children.set(o.id, []);
    }
    for (const o of ops) {
        for (const d of o.deps) {
            if (!byId.has(d))
                continue; // dep outside this op set: treat as satisfied
            incoming.set(o.id, (incoming.get(o.id) ?? 0) + 1);
            children.get(d).push(o.id);
        }
    }
    // ready = incoming 0, ordered by ascending hash
    const ready = ops.filter((o) => (incoming.get(o.id) ?? 0) === 0).map((o) => o.id);
    const out = [];
    const cmp = (x, y) => cmpHash(byId.get(x).hash, byId.get(y).hash);
    ready.sort(cmp);
    while (ready.length) {
        const id = ready.shift();
        out.push(id);
        for (const c of children.get(id) ?? []) {
            incoming.set(c, (incoming.get(c) ?? 0) - 1);
            if ((incoming.get(c) ?? 0) === 0) {
                // insert keeping ascending-hash order
                const h = byId.get(c).hash;
                let i = 0;
                while (i < ready.length) {
                    const rid = ready[i];
                    if (rid === undefined || cmpHash(byId.get(rid).hash, h) >= 0)
                        break;
                    i++;
                }
                ready.splice(i, 0, c);
            }
        }
    }
    return out;
}
