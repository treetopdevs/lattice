import type { Op } from "./op";
import { cmpHash } from "./op";
import { ancestors, concurrent, depth } from "./dag";
import { gatedBy } from "./schema";
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
export function isQuarantined(
  op: Op,
  schema: ReplicaSchema,
  included: Set<string>,
  byId: Map<string, Op>,
  concCache = new Map<string, Set<string>>(),
  honoredAuthorityWrites?: ReadonlySet<string>,
): { quarantined: boolean; reason?: string } {
  const role = gatedBy(schema, op.field);
  if (!role) return { quarantined: false };

  const visible = ancestors(op.id, byId);
  const holder = latestAuthorityWrite(role, visible, byId, honoredAuthorityWrites);
  if (holder && holder.value !== op.author) {
    return {
      quarantined: true,
      reason: `author ${op.author} is not current ${role} holder (${String(holder.value)})`,
    };
  }

  for (const otherId of included) {
    if (otherId === op.id) continue;
    const a = byId.get(otherId);
    if (!a || a.kind !== "authority" || a.field !== role) continue;
    if (honoredAuthorityWrites && !honoredAuthorityWrites.has(a.id)) continue;
    if (a.value === op.author) continue; // holder is still the author
    if (concurrent(a.id, op.id, byId, concCache)) {
      return {
        quarantined: true,
        reason: `author ${op.author} did not observe ${a.command ?? a.id} — stale ${role} holder (now ${String(a.value)})`,
      };
    }
  }
  return { quarantined: false };
}

function latestAuthorityWrite(
  role: string,
  visible: Set<string>,
  byId: Map<string, Op>,
  honoredAuthorityWrites?: ReadonlySet<string>,
): Op | null {
  let best: Op | null = null;
  const depthCache = new Map<string, number>();

  for (const id of visible) {
    const op = byId.get(id);
    if (!op || op.kind !== "authority" || op.field !== role || op.mutation !== "write") continue;
    if (honoredAuthorityWrites && !honoredAuthorityWrites.has(op.id)) continue;

    if (
      !best ||
      depth(op.id, byId, depthCache) > depth(best.id, byId, depthCache) ||
      (depth(op.id, byId, depthCache) === depth(best.id, byId, depthCache) &&
        cmpHash(op.hash, best.hash) > 0)
    ) {
      best = op;
    }
  }

  return best;
}
