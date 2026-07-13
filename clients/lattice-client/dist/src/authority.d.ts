import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
export interface AuthorityAnalysis {
    honoredWrites: ReadonlySet<string>;
    quarantinedWrites: ReadonlySet<string>;
}
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export declare function analyzeAuthority(schema: ReplicaSchema, ops: Op[], included: ReadonlySet<string>, order: readonly string[], byId: ReadonlyMap<string, Op>): AuthorityAnalysis;
