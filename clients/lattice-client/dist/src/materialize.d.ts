import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/**
 * Thrown by {@link materialize} when a log changes an authority role beyond its
 * establishing genesis. This is the V-01 fail-closed guard: the reducer has no
 * authority validation yet (`carrier.ts` honors any signed transfer/succeed and
 * `quarantine.ts` never gates authority ops), so a forged transfer authored by a
 * non-holder would otherwise be silently honored — inverting both the holder and
 * the quarantine set relative to the `Lattice.Sim` oracle (the V-01 STOP
 * condition). Until Plan 140 ports real validation, we refuse rather than guess.
 */
export declare class V01UnvalidatedAuthorityError extends Error {
    readonly role: string;
    readonly cause: unknown;
    constructor(role: string, writes: number, cause?: unknown);
}
export interface Materialized {
    /** field -> materialized value */
    state: Record<string, unknown>;
    /** ids of ops rejected by the quarantine predicate (never applied to state) */
    quarantine: string[];
    /** the canonical linear extension actually used */
    order: string[];
    /** field -> winning op id for LWW/authority fields (provenance) */
    winners: Record<string, string | null>;
}
/**
 * Materialize a replica from ops. `included` optionally bounds the visible set
 * (a frontier); default is all ops. This is a pure function of (schema, ops,
 * frontier) — the same inputs that `Lattice.Sim` reduces in Elixir, which is
 * why Sim can serve as the conformance oracle: for any scenario, this must
 * reproduce Sim's state, quarantine set, and order exactly.
 */
export declare function materialize(schema: ReplicaSchema, ops: Op[], included?: Set<string>): Materialized;
