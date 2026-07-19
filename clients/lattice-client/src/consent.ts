import { ed25519 } from "@noble/curves/ed25519.js";
import { base64ToBytes, canonicalTerm } from "./carrier";
import { ancestors } from "./dag";
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

export type ConsentQuarantineDecision =
  | { quarantined: false }
  | { quarantined: true; reason: string };

const consentDomainTag = "lattice-custody-consent-v1";

/** The domain-tagged canonical bytes the recipient signs (ADR 0007). */
export function custodyConsentPayload(
  replica: string,
  requestOpId: string,
  fromPub: Uint8Array,
  toPub: Uint8Array,
): Uint8Array {
  return canonicalTerm([consentDomainTag, replica, requestOpId, fromPub, toPub]);
}

/**
 * Judge one command against the consent conjunct. Legacy Tier-A ops without
 * outer-replica evidence stay on their characterized path, exactly like
 * `capabilityQuarantine`; a carrier-decoded consent command without parseable
 * evidence fails closed as `missing_consent`.
 */
export function consentQuarantine(
  op: Op,
  schema: ReplicaSchema,
  byId: Map<string, Op>,
  ancCache = new Map<string, Set<string>>(),
): ConsentQuarantineDecision {
  if (op.kind !== "command" || op.replica === undefined) {
    return { quarantined: false };
  }
  if (op.command === undefined || !(schema.consentCommands ?? []).includes(op.command)) {
    return { quarantined: false };
  }

  const evidence = op.consent;
  if (evidence === undefined || evidence.sig === null || evidence.sig === "") {
    return { quarantined: true, reason: "missing_consent" };
  }
  if (!ancestors(op.id, byId, ancCache).has(evidence.requestOpId)) {
    return { quarantined: true, reason: "invalid_consent" };
  }

  const payload = custodyConsentPayload(
    op.replica,
    evidence.requestOpId,
    base64ToBytes(evidence.authorPub),
    base64ToBytes(evidence.toPub),
  );
  try {
    if (
      !ed25519.verify(base64ToBytes(evidence.sig), payload, base64ToBytes(evidence.toPub), {
        zip215: false,
      })
    ) {
      return { quarantined: true, reason: "invalid_consent" };
    }
  } catch {
    return { quarantined: true, reason: "invalid_consent" };
  }

  return { quarantined: false };
}
