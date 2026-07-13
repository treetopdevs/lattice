import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
    opId: string;
    holder: string;
    atTick: number;
}
export interface AuthorityAnalysis {
    honoredWrites: ReadonlySet<string>;
    quarantinedWrites: ReadonlySet<string>;
    /** Honored acquires per role, in the order they were honored (the oracle's timeline). */
    acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>;
}
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export declare function analyzeAuthority(schema: ReplicaSchema, ops: Op[], included: ReadonlySet<string>, order: readonly string[], byId: ReadonlyMap<string, Op>): AuthorityAnalysis;
