import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/**
 * Plan 158 Wave A2 causal context: `visibleOps`/`verdicts` restricted to
 * exactly a command op's causal past, in causal/canonical order — the literal
 * TS shape of `Lattice.Replica.command_op_status/3`'s `context` argument.
 */
export interface CommandOpStatusContext {
    visibleOps: ReadonlyMap<string, Op>;
    /** Each visible op's deterministic verdict: `"honored"` or its quarantine reason. */
    verdicts: ReadonlyMap<string, string>;
}
export type CommandOpStatus = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** True iff `schema` declares an application-policy conjunct at all. */
export declare function hasApplicationPolicy(schema: ReplicaSchema): boolean;
/**
 * The replica's causal-context command validity conjunct (Plan 158 Wave A2's
 * `command_op_status/3`). `visibleIds` and `context` must already be bounded
 * to exactly `op`'s causal past within the current materialization's included
 * set — see `isQuarantined` in quarantine.ts, the sole caller.
 */
export declare function commandOpStatus(schema: ReplicaSchema, op: Op, visibleIds: ReadonlySet<string>, context: CommandOpStatusContext): CommandOpStatus;
/**
 * The full-frontier command-conflict phase (Plan 158 Wave A2's
 * `command_conflicts/3`), run once per materialization over the complete
 * structurally accepted DAG bounded to `included`. `verdicts` carries every
 * included op's individual verdict (`"honored"` or its quarantine reason),
 * already final by the time this runs. Returns `{ loserId => reason }`.
 */
export declare function commandConflicts(schema: ReplicaSchema, included: ReadonlySet<string>, byId: Map<string, Op>, verdicts: ReadonlyMap<string, string>, ancCache: Map<string, Set<string>>): ReadonlyMap<string, string>;
