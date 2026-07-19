import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
/**
 * ADR 0007 — the co-signed consent conjunct, TS reduction.
 *
 * A command named in `schema.consentCommands` is honored only if the consent
 * evidence retained from its carrier-decoded body verifies: the declared
 * recipient's Ed25519 signature over the domain-tagged canonical payload
 * (whose `from` is the op author by construction) AND the cited request op in
 * the command's causal past. The check order is pinned — missing, then causal
 * presence, then signature — so every realm reports the same reason as the
 * `Lattice.Sim` oracle (property d). Consent confers no authority: this runs
 * only after the capability and holder gates in `isQuarantined`.
 */
export type ConsentQuarantineDecision = {
    quarantined: false;
} | {
    quarantined: true;
    reason: string;
};
/** The domain-tagged canonical bytes the recipient signs (ADR 0007). */
export declare function custodyConsentPayload(replica: string, requestOpId: string, fromPub: Uint8Array, toPub: Uint8Array): Uint8Array;
/**
 * Judge one command against the consent conjunct. Legacy Tier-A ops without
 * outer-replica evidence stay on their characterized path, exactly like
 * `capabilityQuarantine`; a carrier-decoded consent command without parseable
 * evidence fails closed as `missing_consent`.
 */
export declare function consentQuarantine(op: Op, schema: ReplicaSchema, byId: Map<string, Op>, ancCache?: Map<string, Set<string>>): ConsentQuarantineDecision;
