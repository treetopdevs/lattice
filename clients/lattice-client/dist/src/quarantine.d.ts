import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
import type { HonoredAcquire } from "./authority";
/**
 * The ONE quarantine predicate (V-01).
 *
 * An authority-gated command is quarantined iff, judged against the honored
 * acquire timeline for the gating role (the oracle's `holder_from_acquires`):
 *
 *   1. the last acquire visible from the command's deps does not name the
 *      command's author as holder (`:not_holder`), or
 *   2. the acquire immediately after the author's last visible acquire never
 *      saw the command — a concurrent away-move (`:stale_holder`).
 *
 * This is purely deps-decidable over the honored timeline, so it yields
 * identical quarantine sets on every realm (property d), and it is the SAME
 * function that answers both "stale holder" and "revocation" — there is no
 * second implementation to drift from it.
 */
export declare function isQuarantined(op: Op, schema: ReplicaSchema, byId: Map<string, Op>, acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>, ancCache?: Map<string, Set<string>>): {
    quarantined: boolean;
    reason?: string;
};
