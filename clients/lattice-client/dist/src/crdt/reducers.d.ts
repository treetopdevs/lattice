import type { Op } from "../op";
/**
 * LWW register: keep the max writer by (lamport depth, hash). Order-independent
 * — this is the CRDT semantics, not "last op applied wins" — so concurrent
 * writes resolve to one deterministic value on every realm, no coordinator.
 * Returns the winning value plus the winning op id (for provenance/highlighting).
 */
export declare function lww(writers: Op[], depthOf: (id: string) => number): {
    value: unknown;
    winner: string | null;
};
/** OR-set: add-wins observed-remove set, with add ops as tags. */
export declare function orSet(fieldOps: Op[], byId: Map<string, Op>): unknown[];
/** Causal list: appended values in canonical causal order. */
export declare function causalList(fieldOps: Op[], order: string[]): unknown[];
