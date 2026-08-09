import type { AuthoritySecurityProjection } from "./authority";
import { ancestors } from "./dag";
import type { Op } from "./op";
import { gatedBy } from "./schema";
import type { ReplicaSchema } from "./schema";

export type CapabilityQuarantineDecision =
  | { quarantined: false }
  | { quarantined: true; reason: string };

/**
 * Validate one carrier-decoded command against the same delegation and revoke
 * evidence used by authority analysis. Legacy Tier-A ops without outer-replica
 * evidence stay on their characterized path; shipping carrier ops fail closed.
 */
export function capabilityQuarantine(
  op: Op,
  schema: ReplicaSchema,
  byId: Map<string, Op>,
  security: AuthoritySecurityProjection,
  ancCache = new Map<string, Set<string>>(),
): CapabilityQuarantineDecision {
  if (op.kind === "command" && op.commandError !== undefined) {
    return { quarantined: true, reason: op.commandError };
  }

  if (op.kind !== "command" || op.replica === undefined) {
    return { quarantined: false };
  }

  const record = op.cap === undefined || op.cap === null
    ? undefined
    : security.delegations.get(op.cap);
  if (record === undefined) {
    return { quarantined: true, reason: "no_capability" };
  }

  const delegation = record.delegation;
  if (delegation === null) {
    return { quarantined: true, reason: "invalid_capability" };
  }

  // A capability scoped to one replica is honored only on that replica's log.
  if (delegation.replica !== op.replica) {
    return { quarantined: true, reason: "wrong_replica" };
  }

  const visible = ancestors(op.id, byId, ancCache);
  const honoredSuccessionVisible =
    !record.validation.valid &&
    record.validation.reason === "succession_candidate" &&
    record.validation.successionRootId !== undefined &&
    (security.honoredSuccessionIntroductions.get(
      record.validation.successionRootId,
    ) ?? [])
      .some((opId) => visible.has(opId));
  if (!record.validation.valid && !honoredSuccessionVisible) {
    return { quarantined: true, reason: "invalid_capability" };
  }
  if (op.author !== delegation.audienceRealm) {
    return { quarantined: true, reason: "capability_wrong_audience" };
  }
  if (op.command === undefined || !delegation.ops.includes(op.command)) {
    return { quarantined: true, reason: "operation_not_granted" };
  }

  if (!record.introductionOpIds.some((opId) => visible.has(opId))) {
    return { quarantined: true, reason: "capability_not_visible" };
  }

  const role = gatedBy(schema, op.field);
  if (role !== null && !delegation.roles.includes(role)) {
    return { quarantined: true, reason: "role_not_granted" };
  }
  if (revokedAsOf(op, delegation.id, byId, security, ancCache)) {
    return { quarantined: true, reason: "revoked_capability" };
  }
  if (expiredAsOf(op, delegation.id, byId, security, ancCache)) {
    return { quarantined: true, reason: "lease_expired" };
  }

  return { quarantined: false };
}

function revokedAsOf(
  op: Op,
  delegationId: string,
  byId: Map<string, Op>,
  security: AuthoritySecurityProjection,
  ancCache: Map<string, Set<string>>,
): boolean {
  const chainIds = delegationChainIds(delegationId, security);

  return security.effectiveRevokes.some(
    (revoke) =>
      chainIds.has(revoke.delegationId) &&
      !ancestors(revoke.opId, byId, ancCache).has(op.id),
  );
}

function delegationChainIds(
  delegationId: string,
  security: AuthoritySecurityProjection,
): Set<string> {
  const ids = new Set<string>();
  let current: string | null = delegationId;

  while (current !== null && !ids.has(current)) {
    ids.add(current);
    current = security.delegations.get(current)?.delegation?.parentId ?? null;
  }

  return ids;
}

// Plan 149: op O is lease-expired iff some chain link carries expiresEpoch E
// and a valid beacon with epoch > E exists that O is not causally before —
// character-for-character the revokedAsOf shape, mirroring
// Lattice.Authority.expired_as_of?/5.
function expiredAsOf(
  op: Op,
  delegationId: string,
  byId: Map<string, Op>,
  security: AuthoritySecurityProjection,
  ancCache: Map<string, Set<string>>,
): boolean {
  for (const id of delegationChainIds(delegationId, security)) {
    const expires = security.delegations.get(id)?.delegation?.expiresEpoch;
    if (expires === undefined) continue;
    const lapsed = security.validBeacons.some(
      (beacon) =>
        beacon.epoch > expires && !ancestors(beacon.opId, byId, ancCache).has(op.id),
    );
    if (lapsed) return true;
  }

  return false;
}
