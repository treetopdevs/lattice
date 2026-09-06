import type { Op } from "./op";
import { ancestors } from "./dag";
import { gatedBy } from "./schema";
import type { ReplicaSchema } from "./schema";
import type { AuthorityAnalysis } from "./authority";
import { capabilityQuarantine } from "./capability";
import { consentQuarantine } from "./consent";
import { commandOpStatus, hasApplicationPolicy } from "./policy";

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
export function isQuarantined(
  op: Op,
  schema: ReplicaSchema,
  byId: Map<string, Op>,
  authority: AuthorityAnalysis,
  ancCache = new Map<string, Set<string>>(),
  policyScope?: CommandPolicyScope,
): { quarantined: boolean; reason?: string } {
  if (op.structuralError !== undefined) {
    return { quarantined: true, reason: op.structuralError };
  }
  if (op.authorityInputReason !== undefined) {
    return { quarantined: true, reason: op.authorityInputReason };
  }

  const capability = capabilityQuarantine(op, schema, byId, authority.security, ancCache);
  if (capability.quarantined) return capability;

  const role = gatedBy(schema, op.field);
  if (role) {
    const acquires = authority.acquiresByRole.get(role) ?? [];
    const visible = ancestors(op.id, byId, ancCache);

    let holderAtDeps: string | undefined;
    let lastOwnIndex = -1;
    for (let i = 0; i < acquires.length; i++) {
      const acquire = acquires[i]!;
      if (!visible.has(acquire.opId)) continue;
      holderAtDeps = acquire.holder;
      if (acquire.holder === op.author) lastOwnIndex = i;
    }

    if (holderAtDeps !== op.author) {
      return { quarantined: true, reason: "not_holder" };
    }

    const next = lastOwnIndex >= 0 ? acquires[lastOwnIndex + 1] : undefined;
    if (next !== undefined && !ancestors(next.opId, byId, ancCache).has(op.id)) {
      return { quarantined: true, reason: "stale_holder" };
    }
  }

  // ADR 0007: the replica's co-signed consent conjunct, judged next — consent
  // never rescues an op the capability or holder gates already rejected.
  const consent = consentQuarantine(op, schema, byId, ancCache);
  if (consent.quarantined) return consent;

  // Plan 158 Wave A2: the replica's causal-context application-policy
  // conjunct, judged last. visibleIds/verdicts cover exactly op's causal past
  // (bounded to policyScope.included), in causal order, so every ancestor's
  // own verdict — including one decided earlier in this very walk — is
  // already final by the time a policy consults it.
  if (policyScope !== undefined && hasApplicationPolicy(schema)) {
    const visibleIds = new Set(
      [...ancestors(op.id, byId, ancCache)].filter((id) => policyScope.included.has(id)),
    );
    const visibleOps = new Map<string, Op>();
    const verdicts = new Map<string, string>();
    for (const id of visibleIds) {
      visibleOps.set(id, byId.get(id)!);
      verdicts.set(id, policyScope.reasonsSoFar.get(id) ?? "honored");
    }
    const status = commandOpStatus(schema, op, visibleIds, { visibleOps, verdicts });
    if (!status.ok) return { quarantined: true, reason: status.reason };
  }

  return { quarantined: false };
}
