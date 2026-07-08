import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
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
