import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
import type { AuthorityAnalysis } from "./authority";
/**
 * Plan 158 Wave A2 — the current materialization's log view, for the causal
 * application-policy conjunct: `included` bounds `visibleIds`/`visibleOps` to
 * exactly the ops actually in scope (mirrors `Log.ops(log)`, so a partial
 * frontier never treats an unsynced op as causally visible), and
 * `reasonsSoFar` carries every included id's own verdict already decided
 * earlier in the SAME canonical walk (topo order guarantees every ancestor of
 * the op under judgment was already visited).
 */
export interface CommandPolicyScope {
    included: ReadonlySet<string>;
    reasonsSoFar: ReadonlyMap<string, string>;
}
/**
 * The ONE quarantine predicate (V-01).
 *
 * A carrier-decoded command first passes capability/revocation validation, then
 * any authority-gated mutation is judged against the honored acquire timeline:
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
 *
 * `policyScope`, when supplied, additionally judges the op against the
 * replica's causal-context application-policy conjunct (Plan 158 Wave A2's
 * `command_op_status/3`) — consulted last, after every gate above, so it
 * never rescues an op those gates already rejected.
 */
export declare function isQuarantined(op: Op, schema: ReplicaSchema, byId: Map<string, Op>, authority: AuthorityAnalysis, ancCache?: Map<string, Set<string>>, policyScope?: CommandPolicyScope): {
    quarantined: boolean;
    reason?: string;
};
