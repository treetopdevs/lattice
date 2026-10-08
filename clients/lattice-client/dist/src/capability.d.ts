import type { AuthoritySecurityProjection } from "./authority";
import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
export type CapabilityQuarantineDecision = {
    quarantined: false;
} | {
    quarantined: true;
    reason: string;
};
/**
 * Validate one carrier-decoded command against the same delegation and revoke
 * evidence used by authority analysis. Legacy Tier-A ops without outer-replica
 * evidence stay on their characterized path; shipping carrier ops fail closed.
 */
export declare function capabilityQuarantine(op: Op, schema: ReplicaSchema, byId: Map<string, Op>, security: AuthoritySecurityProjection, ancCache?: Map<string, Set<string>>): CapabilityQuarantineDecision;
/**
 * Why an op authored now, at the log's frontier, could not cite `delegationId`: such an op is causally
 * before nothing, so every effective revoke on the chain applies, and so does every valid beacon past a
 * chain link's lease. This is `revokedAsOf`/`expiredAsOf` evaluated at the frontier.
 */
export declare function delegationFrontierRefusal(delegationId: string, security: AuthoritySecurityProjection): "revoked_capability" | "lease_expired" | null;
export declare function revokedAsOf(op: Op, delegationId: string, byId: Map<string, Op>, security: AuthoritySecurityProjection, ancCache: Map<string, Set<string>>): boolean;
