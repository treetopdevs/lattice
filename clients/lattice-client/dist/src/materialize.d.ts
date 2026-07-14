import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/**
 * Thrown by {@link materialize} when a log changes an authority role but the
 * reducer cannot fully validate that history — evidence is missing for a
 * multi-write role, or an authority event shape is unsupported. This is the
 * V-01 fail-closed guard: rather than guess a holder and silently diverge from
 * the `Lattice.Sim` oracle (the V-01 STOP condition), we refuse. Plan 140
 * ported validated reduction for genesis/transfer/succeed/heartbeat histories;
 * anything outside that vocabulary still lands here.
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
 * (a frontier); default is all ops. `externallyQuarantined` seeds decisions from
 * an external authority oracle while retaining those ops in canonical order.
 * This is a pure function of its inputs, so Sim can remain the conformance
 * oracle for state, quarantine, and order.
 */
export declare function materialize(schema: ReplicaSchema, ops: Op[], included?: ReadonlySet<string>, externallyQuarantined?: ReadonlySet<string>): Materialized;
