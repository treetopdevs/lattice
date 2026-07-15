import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalBytesForCarrierDelegation,
  canonicalBytesForWitnessedRecoveryPolicy,
  canonicalBytesForWitnessedSuccessionClaim,
} from "./codec";
import { ancestors } from "./dag";
import type {
  AuthorityDelegationEvidence,
  AuthorityEvidence,
  Op,
  SuccessionPolicyEvidence,
  WitnessedRecoveryPolicyEvidence,
  WitnessedSuccessionCertificateEvidence,
  WitnessedSuccessionClaimEvidence,
} from "./op";
import { isAuthorityField } from "./schema";
import type { ReplicaSchema } from "./schema";

/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
  opId: string;
  holder: string;
  holderPubkey?: string;
  atTick?: number;
}

export interface AuthorityAnalysis {
  honoredWrites: ReadonlySet<string>;
  quarantinedWrites: ReadonlySet<string>;
  /** Honored acquires per role, in the order they were honored (the oracle's timeline). */
  acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>;
}

interface RoleState {
  holder: string | null;
  acquires: HonoredAcquire[];
  heartbeats: { opId: string; atTick: number }[];
}

function emptyRoleState(): RoleState {
  return { holder: null, acquires: [], heartbeats: [] };
}

/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export function analyzeAuthority(
  schema: ReplicaSchema,
  ops: Op[],
  included: ReadonlySet<string>,
  order: readonly string[],
  byId: ReadonlyMap<string, Op>,
): AuthorityAnalysis {
  const visible = order.map((id) => byId.get(id)!);
  const writesPerRole = new Map<string, number>();

  for (const op of visible) {
    if (!authorityRoleWrite(schema, op)) continue;
    writesPerRole.set(op.field, (writesPerRole.get(op.field) ?? 0) + 1);
  }

  const delegations = collectDelegations(visible);
  const delegationValidity = new Map<string, boolean>();
  const policies = collectPolicies(visible, delegations, delegationValidity);
  const states = new Map<string, RoleState>();
  const honoredWrites = new Set<string>();
  const quarantinedWrites = new Set<string>();

  for (const op of visible) {
    if (op.authority?.type === "heartbeat") {
      // Heartbeats never write a field: they only refresh the holder's
      // last-active tick, and only when the author holds the role at its deps.
      const heartbeat = op.authority;
      const state = states.get(heartbeat.role) ?? emptyRoleState();
      const anc = ancestors(op.id, byId as Map<string, Op>);
      const holderAtDeps = [...state.acquires]
        .reverse()
        .find((acquire) => anc.has(acquire.opId))?.holder;
      if (holderAtDeps === op.author) {
        state.heartbeats.push({ opId: op.id, atTick: heartbeat.atTick });
      }
      states.set(heartbeat.role, state);
      continue;
    }

    if (!authorityRoleWrite(schema, op)) continue;

    const writeCount = writesPerRole.get(op.field) ?? 0;
    if (op.authority === undefined) {
      if (writeCount > 1) throw new Error(`missing authority evidence for ${op.id}`);
      const state = states.get(op.field) ?? emptyRoleState();
      if (typeof op.value === "string") {
        state.holder = op.value;
        state.acquires.push({ opId: op.id, holder: op.value, atTick: 0 });
        states.set(op.field, state);
      }
      honoredWrites.add(op.id);
      continue;
    }

    const evidence = op.authority;
    const state = states.get(op.field) ?? emptyRoleState();
    const honored = authorityWriteHonored(
      op,
      evidence,
      state,
      delegations,
      delegationValidity,
      policies,
      byId,
    );

    if (honored) {
      const holder = evidence.delegation.audienceRealm;
      state.holder = holder;
      state.acquires.push(honoredAcquire(op, evidence, holder));
      states.set(op.field, state);
      honoredWrites.add(op.id);
    } else {
      quarantinedWrites.add(op.id);
    }
  }

  for (const op of ops) {
    if (!included.has(op.id)) continue;
    if (!authorityRoleWrite(schema, op)) continue;
    if (!honoredWrites.has(op.id) && !quarantinedWrites.has(op.id)) {
      throw new Error(`authority write ${op.id} was not decided`);
    }
  }

  const acquiresByRole = new Map<string, readonly HonoredAcquire[]>(
    [...states].map(([role, state]) => [role, state.acquires]),
  );

  return { honoredWrites, quarantinedWrites, acquiresByRole };
}

function honoredAcquire(
  op: Op,
  evidence: Exclude<AuthorityEvidence, { type: "heartbeat" }>,
  holder: string,
): HonoredAcquire {
  const acquire: HonoredAcquire = {
    opId: op.id,
    holder,
    holderPubkey: evidence.delegation.audience,
  };

  if (evidence.type === "genesis") acquire.atTick = 0;
  if (evidence.type === "transfer") acquire.atTick = evidence.atTick;
  if (evidence.type === "succeed" && evidence.proof.mode === "legacy") {
    acquire.atTick = evidence.proof.atTick;
  }

  return acquire;
}

function authorityRoleWrite(schema: ReplicaSchema, op: Op): boolean {
  if (op.kind !== "authority" || op.mutation !== "write") return false;
  const spec = schema.fields[op.field];
  return spec !== undefined && isAuthorityField(spec);
}

function authorityWriteHonored(
  op: Op,
  evidence: AuthorityEvidence,
  state: RoleState,
  delegations: ReadonlyMap<string, AuthorityDelegationEvidence | null>,
  delegationValidity: Map<string, boolean>,
  policies: ReadonlyMap<string, SuccessionPolicyEvidence>,
  byId: ReadonlyMap<string, Op>,
): boolean {
  if (evidence.type === "heartbeat") return false;

  const delegation = evidence.delegation;
  if (
    delegation.audienceRealm !== op.value ||
    !delegation.roles.includes(op.field) ||
    !validDelegation(delegation, delegations, delegationValidity, new Set())
  ) {
    return false;
  }

  if (evidence.type === "genesis") {
    return (
      state.holder === null &&
      delegation.parentId === null &&
      delegation.issuer === delegation.audience &&
      delegation.issuerRealm === op.author &&
      op.replica !== undefined &&
      replicaRootMatches(op.replica, delegation.audience)
    );
  }

  if (evidence.type === "transfer" && evidence.role === op.field) {
    const visible = ancestors(op.id, byId as Map<string, Op>);
    const holderAtDeps = [...state.acquires]
      .reverse()
      .find((acquire) => visible.has(acquire.opId))?.holder;

    return (
      delegation.issuerRealm === op.author &&
      holderAtDeps === op.author &&
      state.holder === op.author
    );
  }

  if (evidence.type === "succeed" && evidence.role === op.field) {
    const policy = policies.get(op.field);
    if (
      delegation.issuerRealm !== op.author ||
      delegation.audienceRealm !== op.author ||
      policy === undefined ||
      policy.successorRealm !== op.author
    ) {
      return false;
    }

    const visible = ancestors(op.id, byId as Map<string, Op>);
    if (evidence.proof.mode === "legacy") {
      if (policy.mode !== "legacy") return false;
      const lastActive = Math.max(
        0,
        ...state.acquires.flatMap((acquire) =>
          visible.has(acquire.opId) && acquire.atTick !== undefined ? [acquire.atTick] : [],
        ),
        ...state.heartbeats.filter((heartbeat) => visible.has(heartbeat.opId)).map((heartbeat) => heartbeat.atTick),
      );

      return evidence.proof.atTick >= lastActive + policy.dormantTicks;
    }

    if (evidence.proof.mode === "witnessed") {
      if (policy.mode !== "witnessed" || op.replica === undefined) return false;
      const holderAcquire = [...state.acquires]
        .reverse()
        .find((acquire) => visible.has(acquire.opId));
      const holder = canonicalBase64Bytes(holderAcquire?.holderPubkey, 32);
      const successor = canonicalBase64Bytes(delegation.audience, 32);
      const policySuccessor = canonicalBase64Bytes(policy.successor, 32);
      if (
        holderAcquire?.holderPubkey === undefined ||
        state.holder !== holderAcquire.holder ||
        holder === null ||
        successor === null ||
        policySuccessor === null ||
        !equalBytes(policySuccessor, successor)
      ) {
        return false;
      }

      const policyId = witnessedRecoveryPolicyId(policy.recovery);
      if (policyId === null) return false;
      const expectedClaim: WitnessedSuccessionClaimEvidence = {
        version: 1,
        replica: op.replica,
        role: evidence.role,
        holder: holderAcquire.holderPubkey,
        holderEpoch: holderAcquire.opId,
        successor: delegation.audience,
        policyId,
      };

      return verifyWitnessedSuccessionCertificate(
        evidence.proof.certificate,
        expectedClaim,
        policy.recovery,
      ).valid;
    }

    return false;
  }

  throw new Error(`unsupported authority event ${evidence.type} for ${op.id}`);
}

export type WitnessedSuccessionVerificationReason =
  | "invalid_recovery_policy"
  | "malformed_recovery_certificate"
  | "unsupported_recovery_version"
  | "recovery_claim_mismatch"
  | "recovery_policy_mismatch"
  | "unknown_recovery_witness"
  | "duplicate_recovery_witness"
  | "noncanonical_recovery_signatures"
  | "invalid_recovery_signature"
  | "insufficient_recovery_witnesses";

export type WitnessedSuccessionVerification =
  | { valid: true }
  | { valid: false; reason: WitnessedSuccessionVerificationReason };

export function witnessedRecoveryPolicyId(
  policy: WitnessedRecoveryPolicyEvidence,
): string | null {
  const normalized = normalizeWitnessedRecoveryPolicy(policy);
  if (normalized === null) return null;
  return bytesToBase64Url(sha256(canonicalBytesForWitnessedRecoveryPolicy(normalized)));
}

export function verifyWitnessedSuccessionCertificate(
  certificate: WitnessedSuccessionCertificateEvidence | null,
  expectedClaim: WitnessedSuccessionClaimEvidence,
  policy: WitnessedRecoveryPolicyEvidence,
): WitnessedSuccessionVerification {
  const normalized = normalizeWitnessedRecoveryPolicy(policy);
  if (normalized === null) return invalidWitnessed("invalid_recovery_policy");
  if (!validCertificateShape(certificate)) {
    return invalidWitnessed("malformed_recovery_certificate");
  }
  if (certificate.claim.version !== 1) {
    return invalidWitnessed("unsupported_recovery_version");
  }
  if (!claimBindingMatches(certificate.claim, expectedClaim)) {
    return invalidWitnessed("recovery_claim_mismatch");
  }
  if (certificate.claim.policyId !== expectedClaim.policyId) {
    return invalidWitnessed("recovery_policy_mismatch");
  }

  const allowed = new Set(normalized.witnesses);
  if (!certificate.signatures.every((entry) => allowed.has(entry.witness))) {
    return invalidWitnessed("unknown_recovery_witness");
  }

  const witnessIds = certificate.signatures.map((entry) => entry.witness);
  if (new Set(witnessIds).size !== witnessIds.length) {
    return invalidWitnessed("duplicate_recovery_witness");
  }
  if (!certificate.signatures.every((entry, index, entries) =>
    index === 0 || compareBase64Evidence(entries[index - 1]!.witness, entry.witness) < 0
  )) {
    return invalidWitnessed("noncanonical_recovery_signatures");
  }

  const payload = canonicalBytesForWitnessedSuccessionClaim(certificate.claim);
  try {
    if (!certificate.signatures.every((entry) =>
      ed25519.verify(
        canonicalBase64Bytes(entry.signature)!,
        payload,
        canonicalBase64Bytes(entry.witness, 32)!,
        { zip215: false },
      )
    )) {
      return invalidWitnessed("invalid_recovery_signature");
    }
  } catch {
    return invalidWitnessed("invalid_recovery_signature");
  }

  return certificate.signatures.length >= normalized.threshold
    ? { valid: true }
    : invalidWitnessed("insufficient_recovery_witnesses");
}

function normalizeWitnessedRecoveryPolicy(
  policy: WitnessedRecoveryPolicyEvidence,
): WitnessedRecoveryPolicyEvidence | null {
  const witnessEntries = Array.isArray(policy.witnesses)
    ? policy.witnesses.map((witness) => ({ witness, bytes: canonicalBase64Bytes(witness, 32) }))
    : [];

  if (
    !exactKeys(policy, ["mode", "version", "witnesses", "threshold"]) ||
    policy.mode !== "witnessed" ||
    policy.version !== 1 ||
    !Array.isArray(policy.witnesses) ||
    !Number.isSafeInteger(policy.threshold) ||
    policy.threshold < 1 ||
    policy.threshold > policy.witnesses.length ||
    witnessEntries.some((entry) => entry.bytes === null)
  ) {
    return null;
  }

  const witnessIds = witnessEntries.map((entry) => entry.witness);
  if (new Set(witnessIds).size !== witnessIds.length) return null;

  return {
    mode: "witnessed",
    version: 1,
    witnesses: witnessEntries
      .sort((left, right) => compareBytes(left.bytes!, right.bytes!))
      .map((entry) => entry.witness),
    threshold: policy.threshold,
  };
}

function validCertificateShape(
  certificate: WitnessedSuccessionCertificateEvidence | null,
): certificate is WitnessedSuccessionCertificateEvidence {
  return (
    certificate !== null &&
    exactKeys(certificate, ["claim", "signatures"]) &&
    validClaimShape(certificate.claim) &&
    Array.isArray(certificate.signatures) &&
    certificate.signatures.every((entry) =>
      exactKeys(entry, ["witness", "signature"]) &&
      canonicalBase64Bytes(entry.witness, 32) !== null &&
      canonicalBase64Bytes(entry.signature) !== null
    )
  );
}

function validClaimShape(claim: WitnessedSuccessionClaimEvidence): boolean {
  return (
    exactKeys(claim, [
      "version",
      "replica",
      "role",
      "holder",
      "holderEpoch",
      "successor",
      "policyId",
    ]) &&
    Number.isSafeInteger(claim.version) &&
    claim.version >= 0 &&
    typeof claim.replica === "string" &&
    typeof claim.role === "string" &&
    canonicalBase64Bytes(claim.holder, 32) !== null &&
    typeof claim.holderEpoch === "string" &&
    canonicalBase64Bytes(claim.successor, 32) !== null &&
    typeof claim.policyId === "string"
  );
}

function claimBindingMatches(
  claim: WitnessedSuccessionClaimEvidence,
  expected: WitnessedSuccessionClaimEvidence,
): boolean {
  return (
    claim.version === expected.version &&
    claim.replica === expected.replica &&
    claim.role === expected.role &&
    claim.holder === expected.holder &&
    claim.holderEpoch === expected.holderEpoch &&
    claim.successor === expected.successor
  );
}

function invalidWitnessed(
  reason: WitnessedSuccessionVerificationReason,
): WitnessedSuccessionVerification {
  return { valid: false, reason };
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareBase64Evidence(left: string, right: string): number {
  return compareBytes(canonicalBase64Bytes(left)!, canonicalBase64Bytes(right)!);
}

/** Succession policies are conferred only by a genesis whose delegation is valid. */
function collectPolicies(
  ops: readonly Op[],
  delegations: ReadonlyMap<string, AuthorityDelegationEvidence | null>,
  delegationValidity: Map<string, boolean>,
): Map<string, SuccessionPolicyEvidence> {
  const policies = new Map<string, SuccessionPolicyEvidence>();

  for (const op of ops) {
    const evidence = op.authority;
    if (evidence?.type !== "genesis" || evidence.policies === undefined) continue;
    if (
      !validDelegation(evidence.delegation, delegations, delegationValidity, new Set()) ||
      op.replica === undefined ||
      !replicaRootMatches(op.replica, evidence.delegation.audience)
    ) {
      continue;
    }
    for (const [role, policy] of Object.entries(evidence.policies)) {
      policies.set(role, policy);
    }
  }

  return policies;
}

function collectDelegations(
  ops: readonly Op[],
): Map<string, AuthorityDelegationEvidence | null> {
  const delegations = new Map<string, AuthorityDelegationEvidence | null>();

  for (const op of ops) {
    const evidence = op.authority;
    if (evidence === undefined || evidence.type === "heartbeat") continue;
    const delegation = evidence.delegation;
    if (!delegationSelfConsistent(delegation)) continue;
    const existing = delegations.get(delegation.id);
    if (existing === undefined) {
      delegations.set(delegation.id, delegation);
    } else if (existing === null || delegationKey(existing) !== delegationKey(delegation)) {
      delegations.set(delegation.id, null);
    }
  }

  return delegations;
}

function validDelegation(
  delegation: AuthorityDelegationEvidence,
  delegations: ReadonlyMap<string, AuthorityDelegationEvidence | null>,
  cache: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  if (!delegationSelfConsistent(delegation)) return false;

  const cached = cache.get(delegation.id);
  if (cached !== undefined) return cached;
  const collected = delegations.get(delegation.id);
  if (collected === undefined || collected === null || delegationKey(collected) !== delegationKey(delegation)) {
    cache.set(delegation.id, false);
    return false;
  }
  if (visiting.has(delegation.id)) return false;
  visiting.add(delegation.id);

  let valid: boolean;
  if (delegation.parentId === null) {
    valid = delegation.issuer === delegation.audience;
  } else {
    const parent = delegations.get(delegation.parentId);
    valid =
      parent !== undefined &&
      parent !== null &&
      validDelegation(parent, delegations, cache, visiting) &&
      delegation.issuer === parent.audience &&
      delegation.replica === parent.replica &&
      subset(delegation.ops, parent.ops) &&
      subset(delegation.roles, parent.roles) &&
      (!delegation.live || parent.live);
  }

  visiting.delete(delegation.id);
  cache.set(delegation.id, valid);
  return valid;
}

function delegationSelfConsistent(delegation: AuthorityDelegationEvidence): boolean {
  if (delegation.sig === undefined) return false;

  try {
    const canonicalBytes = canonicalBytesForCarrierDelegation({
      replica: delegation.replica,
      issuer: delegation.issuer,
      audience: delegation.audience,
      parent_id: delegation.parentId,
      ops: delegation.ops,
      roles: delegation.roles,
      live: delegation.live,
    });

    return (
      bytesToBase64Url(sha256(canonicalBytes)) === delegation.id &&
      ed25519.verify(
        base64ToBytes(delegation.sig),
        canonicalBytes,
        base64ToBytes(delegation.issuer),
        { zip215: false },
      )
    );
  } catch {
    return false;
  }
}

function subset(child: readonly string[], parent: readonly string[]): boolean {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
}

function replicaRootMatches(replica: string, audience: string): boolean {
  const commitment = replicaRootCommitment(replica);
  if (commitment === null) return true;
  const audienceBytes = canonicalBase64Bytes(audience, 32);
  return audienceBytes !== null && bytesToBase64Url(sha256(audienceBytes)) === commitment;
}

function replicaRootCommitment(replica: string): string | null {
  const marker = "#root:";
  const offset = replica.indexOf(marker);
  if (offset === -1) return null;

  const commitment = replica.slice(offset + marker.length);
  return commitment.length > 0 ? commitment : null;
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));

  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function canonicalBase64Bytes(value: unknown, length?: number): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    const decoded = base64ToBytes(value);
    if (bytesToBase64(decoded) !== value) return null;
    return length === undefined || decoded.length === length ? decoded : null;
  } catch {
    return null;
  }
}

function bytesToBase64(value: Uint8Array): string {
  return typeof Buffer !== "undefined" ? Buffer.from(value).toString("base64") : browserBase64(value);
}

function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function browserBase64(value: Uint8Array): string {
  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...value));
}

function delegationKey(delegation: AuthorityDelegationEvidence): string {
  return JSON.stringify({
    ...delegation,
    ops: [...delegation.ops].sort(),
    roles: [...delegation.roles].sort(),
  });
}
