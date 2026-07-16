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
