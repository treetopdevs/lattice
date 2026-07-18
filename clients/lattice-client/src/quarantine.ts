import type { Op } from "./op";
import { ancestors } from "./dag";
import { gatedBy } from "./schema";
import type { ReplicaSchema } from "./schema";
import type { AuthorityAnalysis } from "./authority";
import { capabilityQuarantine } from "./capability";
import { consentQuarantine } from "./consent";

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
 */
export function isQuarantined(
  op: Op,
  schema: ReplicaSchema,
  byId: Map<string, Op>,
  authority: AuthorityAnalysis,
  ancCache = new Map<string, Set<string>>(),
): { quarantined: boolean; reason?: string } {
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

  // ADR 0007: the replica's op-aware validity conjunct, judged last — consent
  // never rescues an op the capability or holder gates already rejected.
  return consentQuarantine(op, schema, byId, ancCache);
}
