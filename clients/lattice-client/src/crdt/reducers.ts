import { cmpHash } from "../op";
import { ancestors } from "../dag";
import type { Op } from "../op";

/**
 * LWW register: keep the max writer by (lamport depth, hash). Order-independent
 * — this is the CRDT semantics, not "last op applied wins" — so concurrent
 * writes resolve to one deterministic value on every realm, no coordinator.
 * Returns the winning value plus the winning op id (for provenance/highlighting).
 */
export function lww(
  writers: Op[],
  depthOf: (id: string) => number,
): { value: unknown; winner: string | null } {
  let best: { id: string; d: number; h: string; v: unknown } | null = null;
  for (const o of writers) {
    if (o.mutation !== "write") continue;
    const d = depthOf(o.id);
    if (
      !best ||
      d > best.d ||
      (d === best.d && cmpHash(o.hash, best.h) > 0)
    ) {
      best = { id: o.id, d, h: o.hash, v: o.value };
    }
  }
  return best ? { value: best.v, winner: best.id } : { value: undefined, winner: null };
}

/** OR-set: add-wins observed-remove set, with add ops as tags. */
export function orSet(fieldOps: Op[], byId: Map<string, Op>): unknown[] {
  const addTags = new Map<string, Set<string>>();
  const values = new Map<string, unknown>();
  const removed = new Set<string>();
  const ancestorCache = new Map<string, Set<string>>();

  for (const o of fieldOps) {
    if (o.mutation !== "add") continue;
    const key = valueKey(o.value);
    values.set(key, o.value);
    const tags = addTags.get(key) ?? new Set<string>();
    tags.add(o.id);
    addTags.set(key, tags);
  }

  for (const o of fieldOps) {
    if (o.mutation !== "remove") continue;
    const tags = addTags.get(valueKey(o.value)) ?? new Set<string>();
    const observed = ancestors(o.id, byId, ancestorCache);
    for (const tag of tags) {
      if (observed.has(tag)) removed.add(tag);
    }
  }

  return [...values.entries()]
    .filter(([, value]) => {
      const tags = addTags.get(valueKey(value)) ?? new Set<string>();
      return [...tags].some((tag) => !removed.has(tag));
    })
    .map(([, value]) => value)
    .sort(compareValues);
}

/** Causal list: appended values in canonical causal order. */
export function causalList(fieldOps: Op[], order: string[]): unknown[] {
  const orderIdx = new Map(order.map((id, i) => [id, i]));
  return [...fieldOps]
    .filter((o) => o.mutation === "append")
    .sort((a, b) => (orderIdx.get(a.id)! - orderIdx.get(b.id)!))
    .map((o) => o.value);
}

function valueKey(value: unknown): string {
  return typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
}

function compareValues(a: unknown, b: unknown): number {
  const ka = typeof a === "string" ? a : JSON.stringify(a);
  const kb = typeof b === "string" ? b : JSON.stringify(b);
  return ka > kb ? 1 : ka < kb ? -1 : 0;
}
