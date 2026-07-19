// The neutral op representation used by the reducer (Tier A: semantics).
//
// This is deliberately encoding-independent. Byte-identical canonical encoding
// and hashing live in codec.ts (Tier B), which is gated on the CBOR migration
// (ADR-P08). The reducer here can be conformance-tested against `Lattice.Sim`
// today, using op ids as opaque handles, without CBOR existing yet.

export type OpKind = "command" | "authority" | "inbox" | "tombstone";

// Mutations mirror the Elixir Replica DSL's absolute mutations.
export type Mutation = "write" | "append" | "add" | "remove" | "delete";

export interface AuthorityDelegationEvidence {
  id: string;
  replica: string;
  issuer: string;
  audience: string;
  issuerRealm: string;
  audienceRealm: string;
  parentId: string | null;
  ops: string[];
  roles: string[];
  live: boolean;
  /** Embedded delegation signature retained from carrier evidence when available. */
  sig?: string;
  /** Plan 149 lease — present only on leased (v3-encoded) delegations. */
  expiresEpoch?: number;
}

/** Legacy author-asserted tick policy retained for characterized POC compatibility. */
export interface LegacySuccessionPolicyEvidence {
  mode: "legacy";
  successorRealm: string;
  successor: string;
  dormantTicks: number;
}

/** Genesis-pinned governance keys whose signatures may authorize recovery. */
export interface WitnessedRecoveryPolicyEvidence {
  mode: "witnessed";
  version: number;
  witnesses: string[];
  threshold: number;
}

export interface WitnessedSuccessionPolicyEvidence {
  mode: "witnessed";
  successorRealm: string;
  successor: string;
  recovery: WitnessedRecoveryPolicyEvidence;
}

/** A malformed or mixed policy is retained only so reduction can fail closed. */
export interface InvalidSuccessionPolicyEvidence {
  mode: "invalid";
  successorRealm: string;
  successor: string;
}

/** Succession policy conferred by a valid genesis. */
export type SuccessionPolicyEvidence =
  | LegacySuccessionPolicyEvidence
  | WitnessedSuccessionPolicyEvidence
  | InvalidSuccessionPolicyEvidence;

export interface WitnessedSuccessionClaimEvidence {
  version: number;
  replica: string;
  role: string;
  holder: string;
  holderEpoch: string;
  successor: string;
  policyId: string;
}

export interface WitnessedSuccessionSignatureEvidence {
  witness: string;
  signature: string;
}

export interface WitnessedSuccessionArtifactEvidence {
  v: 1;
  artifactId: string;
  claim: WitnessedSuccessionClaimEvidence;
  witness: string;
  signature: string;
}

export interface WitnessedSuccessionCertificateEvidence {
  claim: WitnessedSuccessionClaimEvidence;
  signatures: WitnessedSuccessionSignatureEvidence[];
}

export type SuccessionProofEvidence =
  | { mode: "legacy"; atTick: number }
  | { mode: "witnessed"; certificate: WitnessedSuccessionCertificateEvidence | null }
  | { mode: "invalid" };

export type AuthorityEvidence =
  | {
      type: "genesis";
      delegation: AuthorityDelegationEvidence;
      policies?: Record<string, SuccessionPolicyEvidence>;
    }
  | { type: "grant"; delegation: AuthorityDelegationEvidence }
  | {
      type: "transfer";
      role: string;
      delegation: AuthorityDelegationEvidence;
      atTick: number;
    }
  | {
      type: "succeed";
      role: string;
      delegation: AuthorityDelegationEvidence;
      proof: SuccessionProofEvidence;
    }
  | { type: "revoke"; delegationId: string }
  | { type: "heartbeat"; role: string; atTick: number }
  | { type: "beacon"; epoch: number | null };

export interface Op {
  /** Content-address id from Elixir. In Tier A this is an opaque handle. */
  id: string;
  /** Outer replica retained from a decoded carrier frame when available. */
  replica?: string;
  /** Causal parents (ids). The DAG edges. */
  deps: string[];
  kind: OpKind;
  /** Authoring realm / DID (the signer). */
  author: string;
  /** The replica field this op targets (e.g. "summary", "posts", "clerk"). */
  field: string;
  /** Absolute mutation applied to that field. */
  mutation: Mutation;
  /** The value written / appended / added / removed. */
  value: unknown;
  /**
 * Ordering key from Elixir, used ONLY as the LWW/order tiebreak in Tier A.
 * Today this is the opaque op id because Elixir reduces by `{height, op.id}`.
 * In Tier B this is derived from the canonical encoding and must match
 * byte-for-byte.
   */
  hash: string;
  /** Optional human label for display/debug (not load-bearing). */
  command?: string;
  /** Capability id retained from carrier evidence; decoded nil is explicit null. */
  cap?: string | null;
  /** Semantic authority facts retained from the verified carrier body. */
  authority?: AuthorityEvidence;
  /** ADR 0007 co-signed consent evidence retained from the carrier command body. */
  consent?: CustodyConsentEvidence;
}

/**
 * ADR 0007 — the co-signed consent facts a `:custody_transfer` command carries
 * inside its hashed body, retained at carrier decode so the quarantine
 * predicate can recompute and verify the consent payload.
 */
export interface CustodyConsentEvidence {
  /** base64 pubkey of the declared recipient — the consenting signer. */
  toPub: string;
  /** Op id of the durable custody request this consent is bound to (the nonce). */
  requestOpId: string;
  /** base64 consent signature, or null when the body carries none. */
  sig: string | null;
  /** base64 pubkey of the op author — the consent payload's `from`. */
  authorPub: string;
}

/** Compare two opaque ordering keys. Returns >0 if a>b. */
export function cmpHash(a: string, b: string): number {
  return a > b ? 1 : a < b ? -1 : 0;
}
