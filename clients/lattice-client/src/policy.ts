// Plan 158 Wave A2 — causal application-policy context and the deterministic
// full-frontier conflict phase, TypeScript-side.
//
// Mirrors two BEAM hooks from `Lattice.Replica` (apps/lattice_core/lib/lattice/replica.ex)
// as interpreted by `Lattice.Authority.analyze/2` (apps/lattice_core/lib/lattice/authority.ex):
//
//   * `command_op_status/3` — a single command op's causal-context policy verdict.
//     Given the op, its causal-past id set (`visibleIds`), and a `context` of
//     `visibleOps`/`verdicts` restricted to exactly that causal past (built in
//     causal/canonical order, so a policy can require an honored target without
//     ever seeing a concurrent/future op or its own not-yet-decided verdict),
//     return `{ ok: true }` to honor or `{ ok: false, reason }` to quarantine.
//     Consulted last, after structural/malformed-command/capability/authority-
//     holder gates already passed (see `isQuarantined` in quarantine.ts).
//
//   * `command_conflicts/3` — one deterministic pass over the complete
//     structurally accepted DAG, run only after every op's individual verdict
//     is final. The one phase allowed to compare concurrent ops. A returned
//     loser reason applies only to an op this analysis individually honored —
//     an individually denied op is never resurrected into a conflict loser.
//
// Every schema not recognized below carries no application-policy conjunct —
// `command_op_status/3` reduces to `{ ok: true }` and `command_conflicts/3`
// reduces to no conflicts, exactly like the BEAM default callbacks.

import { concurrent } from "./dag";
import { cmpHash } from "./op";
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

export type CommandOpStatus = { ok: true } | { ok: false; reason: string };

/** True iff `schema` declares an application-policy conjunct at all. */
export function hasApplicationPolicy(schema: ReplicaSchema): boolean {
  return schema.name === "PolicyFixture";
}

/**
 * The replica's causal-context command validity conjunct (Plan 158 Wave A2's
 * `command_op_status/3`). `visibleIds` and `context` must already be bounded
 * to exactly `op`'s causal past within the current materialization's included
 * set — see `isQuarantined` in quarantine.ts, the sole caller.
 */
export function commandOpStatus(
  schema: ReplicaSchema,
  op: Op,
  visibleIds: ReadonlySet<string>,
  context: CommandOpStatusContext,
): CommandOpStatus {
  if (schema.name === "PolicyFixture") {
    return policyFixtureCommandOpStatus(op, visibleIds, context);
  }
  return { ok: true };
}

/**
 * The full-frontier command-conflict phase (Plan 158 Wave A2's
 * `command_conflicts/3`), run once per materialization over the complete
 * structurally accepted DAG bounded to `included`. `verdicts` carries every
 * included op's individual verdict (`"honored"` or its quarantine reason),
 * already final by the time this runs. Returns `{ loserId => reason }`.
 */
export function commandConflicts(
  schema: ReplicaSchema,
  included: ReadonlySet<string>,
  byId: Map<string, Op>,
  verdicts: ReadonlyMap<string, string>,
  ancCache: Map<string, Set<string>>,
): ReadonlyMap<string, string> {
  if (schema.name !== "PolicyFixture") return new Map();
  return policyFixtureCommandConflicts(included, byId, verdicts, ancCache);
}

// --- PolicyFixture (Plan 158 Wave A2 adversarial corpus fixture) -----------
//
// Mirrors Mix.Tasks.Lattice.ExportVectors.PolicyFixture and
// Lattice2.ApplicationPolicyContextTest.PolicyReplica exactly:
//
//   * `deny` is unconditionally application-denied.
//   * `reference` requires its cited target to be causally visible, honored,
//     and itself a `source` command — checked in that precedence, so every
//     non-honored target (regardless of WHY it was not honored) is uniformly
//     `application_target_quarantined`.
//   * `claim` carries no individual policy check (default `{ ok: true }`);
//     concurrent claims sharing the same key are resolved only in the
//     full-frontier phase below.

function policyFixtureCommandOpStatus(
  op: Op,
  visibleIds: ReadonlySet<string>,
  context: CommandOpStatusContext,
): CommandOpStatus {
  if (op.command === "deny") return { ok: false, reason: "application_denied" };
  if (op.command !== "reference") return { ok: true };

  const targetId = referenceTargetId(op);
  if (targetId === null || !visibleIds.has(targetId)) {
    return { ok: false, reason: "application_target_not_visible" };
  }
  const targetOp = context.visibleOps.get(targetId);
  if (targetOp === undefined) {
    return { ok: false, reason: "application_target_not_visible" };
  }
  if (context.verdicts.get(targetId) !== "honored") {
    return { ok: false, reason: "application_target_quarantined" };
  }
  if (targetOp.kind !== "command" || targetOp.command !== "source") {
    return { ok: false, reason: "application_wrong_target" };
  }
  return { ok: true };
}

/**
 * Concurrent `claim` ops sharing the same key conflict; sorted ascending by
 * id (codepoint order — NEVER `localeCompare`, which disagrees with Elixir's
 * binary compare on some ids), the first is the canonical winner and every
 * OTHER claim in the group that is concurrent with it (neither causally
 * before the other) loses as `application_conflict`. A claim causally
 * ordered against the winner (either direction) is left to co-exist — this
 * phase only ever compares against the winner, never pairwise among losers.
 * Mirrors `PolicyReplica.command_conflicts/3`'s `conflict_losers/2` exactly.
 */
function policyFixtureCommandConflicts(
  included: ReadonlySet<string>,
  byId: Map<string, Op>,
  verdicts: ReadonlyMap<string, string>,
  ancCache: Map<string, Set<string>>,
): Map<string, string> {
  const claimsByKey = new Map<string, Op[]>();
  for (const id of included) {
    const op = byId.get(id);
    if (op === undefined || op.kind !== "command" || op.command !== "claim") continue;
    if (verdicts.get(id) !== "honored") continue;
    const key = claimKey(op);
    if (key === null) continue;
    const group = claimsByKey.get(key);
    if (group === undefined) claimsByKey.set(key, [op]);
    else group.push(op);
  }

  const conflicts = new Map<string, string>();
  for (const claims of claimsByKey.values()) {
    const [winner, ...rest] = [...claims].sort((left, right) => cmpHash(left.id, right.id));
    if (winner === undefined) continue;
    for (const candidate of rest) {
      if (concurrent(winner.id, candidate.id, byId, ancCache)) {
        conflicts.set(candidate.id, "application_conflict");
      }
    }
  }
  return conflicts;
}

interface ReferenceEventValue {
  kind: "reference";
  target: string;
}

interface ClaimEventValue {
  kind: "claim";
  key: string;
  label: string;
}

function referenceTargetId(op: Op): string | null {
  const value = op.value;
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { kind?: unknown }).kind !== "reference" ||
    typeof (value as { target?: unknown }).target !== "string"
  ) {
    return null;
  }
  return (value as ReferenceEventValue).target;
}

function claimKey(op: Op): string | null {
  const value = op.value;
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { kind?: unknown }).kind !== "claim" ||
    typeof (value as { key?: unknown }).key !== "string"
  ) {
    return null;
  }
  return (value as ClaimEventValue).key;
}
