import type { Op } from "./op";
/** Index ops by id for O(1) lookup. */
export declare function index(ops: Op[]): Map<string, Op>;
/** Transitive causal ancestors of `id` (exclusive of `id`). Memoized per call set. */
export declare function ancestors(id: string, byId: Map<string, Op>, cache?: Map<string, Set<string>>): Set<string>;
/** Two ops are concurrent iff neither is an ancestor of the other. */
export declare function concurrent(a: string, b: string, byId: Map<string, Op>, cache?: Map<string, Set<string>>): boolean;
/**
 * Lamport depth = longest path from a root. Deterministic; used as the LWW clock.
 * A dep absent from `byId` (pruned/partial log) counts as −1 so an op whose deps
 * are all missing sits at height 0 — the same base as `dag.ex`.
 */
export declare function depth(id: string, byId: Map<string, Op>, cache?: Map<string, number>): number;
/**
 * Canonical linear extension of the DAG: a deterministic topological sort with
 * ascending-hash tiebreak among ready ops. This is the same order the reducer
 * and byte-identical replay use, so scrubbing/replay is well-defined.
 */
export declare function canonicalOrder(ops: Op[], byId?: Map<string, Op>): string[];
