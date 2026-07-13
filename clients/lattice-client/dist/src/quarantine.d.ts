import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/**
 * The ONE quarantine predicate (V-01).
 *
 * An authority-gated command is quarantined iff a concurrent authority op moved
 * the gating role's holder away from the command's author. This is purely
 * deps-decidable: it depends only on the DAG shape and the ops' authors, so it
 * yields identical quarantine sets on every realm (property d), and it is the
 * SAME function that answers both "stale holder" and "revocation" — there is no
 * second implementation to drift from it.
 *
 * `included` bounds the visible op set (a frontier). `byId` and the concurrency
 * cache are passed in so the materializer computes them once.
 */
export declare function isQuarantined(op: Op, schema: ReplicaSchema, included: Set<string>, byId: Map<string, Op>, concCache?: Map<string, Set<string>>, honoredAuthorityWrites?: ReadonlySet<string>): {
    quarantined: boolean;
    reason?: string;
};
