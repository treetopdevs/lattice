import { cmpHash, effectElementId } from "../op";
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
            (d === best.d && cmpHash(o.hash, best.h) > 0) ||
            (d === best.d && o.hash === best.h && (o.effectIndex ?? 0) > best.index)) {
            best = { id: o.id, d, h: o.hash, v: o.value, index: o.effectIndex ?? 0 };
        }
    }
    return best ? { value: best.v, winner: best.id } : { value: undefined, winner: null };
}
/** OR-set: add-wins observed-remove set, with add ops as tags. */
export function orSet(fieldOps, byId, compare = compareValues) {
    const counts = insertCounts(fieldOps);
    const addTags = new Map();
    const addsByValue = new Map();
    const values = new Map();
    const removed = new Set();
    const ancestorCache = new Map();
    for (const o of fieldOps) {
        if (o.mutation !== "add")
            continue;
        const key = valueKey(o.value);
        values.set(key, o.value);
        const tags = addTags.get(key) ?? new Set();
        tags.add(effectElementId(o, counts));
        addTags.set(key, tags);
        const adds = addsByValue.get(key) ?? [];
        adds.push(o);
        addsByValue.set(key, adds);
    }
    for (const o of fieldOps) {
        if (o.mutation !== "remove")
            continue;
        const tags = addTags.get(valueKey(o.value)) ?? new Set();
        const observed = ancestors(o.id, byId, ancestorCache);
        for (const add of addsByValue.get(valueKey(o.value)) ?? []) {
            const tag = effectElementId(add, counts);
            if (tags.has(tag) && (observed.has(add.id) || (add.id === o.id && (add.effectIndex ?? 0) < (o.effectIndex ?? 0))))
                removed.add(tag);
        }
    }
    return [...values.entries()]
        .filter(([, value]) => {
        const tags = addTags.get(valueKey(value)) ?? new Set();
        return [...tags].some((tag) => !removed.has(tag));
    })
        .map(([, value]) => value)
        .sort(compare);
}
/** Causal list: appended values ordered by `{causal height, op id}` (Sim's sort key). */
export function causalList(fieldOps, depthOf) {
    const counts = insertCounts(fieldOps);
    const deleted = new Set(fieldOps.filter((op) => op.mutation === "delete").map((op) => op.value));
    const editsByTarget = new Map();
    for (const op of fieldOps) {
        if (op.mutation !== "edit")
            continue;
        const edit = op.value;
        const edits = editsByTarget.get(edit.target) ?? [];
        edits.push({ ...op, mutation: "write", value: edit.value });
        editsByTarget.set(edit.target, edits);
    }
    const editedValues = new Map([...editsByTarget].map(([target, edits]) => [target, lww(edits, depthOf)]));
    return [...fieldOps]
        .filter((o) => ["append", "insert"].includes(o.mutation) && !deleted.has(effectElementId(o, counts)))
        .sort((a, b) => depthOf(a.id) - depthOf(b.id) || cmpHash(a.id, b.id) || (a.effectIndex ?? 0) - (b.effectIndex ?? 0))
        .map((o) => {
        const result = editedValues.get(effectElementId(o, counts));
        return result === undefined || result.winner === null ? o.value : result.value;
    });
}
function insertCounts(ops) {
    const counts = new Map();
    for (const op of ops) {
        if (["add", "append", "insert"].includes(op.mutation))
            counts.set(op.id, (counts.get(op.id) ?? 0) + 1);
    }
    return counts;
}
function valueKey(value) {
    return typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
}
function compareValues(a, b) {
    const ka = typeof a === "string" ? a : JSON.stringify(a);
    const kb = typeof b === "string" ? b : JSON.stringify(b);
    return ka > kb ? 1 : ka < kb ? -1 : 0;
}
