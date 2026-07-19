import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalBytesForCarrierDelegation,
  canonicalBytesForWitnessedRecoveryPolicy,
  canonicalBytesForWitnessedSuccessionArtifactId,
  canonicalBytesForWitnessedSuccessionClaim,
} from "./codec";
import { ancestors, canonicalOrder, index } from "./dag";
import type {
  AuthorityDelegationEvidence,
  AuthorityEvidence,
  Op,
  SuccessionPolicyEvidence,
  WitnessedRecoveryPolicyEvidence,
  WitnessedSuccessionPolicyEvidence,
  WitnessedSuccessionArtifactEvidence,
  WitnessedSuccessionCertificateEvidence,
  WitnessedSuccessionClaimEvidence,
  WitnessedSuccessionSignatureEvidence,
} from "./op";
import { isAuthorityField } from "./schema";
import type { ReplicaSchema } from "./schema";
import { frontier } from "./sync";

/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
  opId: string;
  holder: string;
  holderPubkey?: string;
  atTick?: number;
}

export type DelegationValidation =
  | { valid: true }
  | { valid: false; reason: string };

export interface AuthorityDelegationRecord {
  delegation: AuthorityDelegationEvidence | null;
  introductionOpIds: readonly string[];
  invalidIntroductionReasons: ReadonlyMap<string, string>;
  validation: DelegationValidation;
}

export interface AuthorityRootEvidence {
  realm: string;
  pubkey: string;
}

export interface EffectiveBeaconEvidence {
  opId: string;
  epoch: number;
}

export interface EffectiveRevokeEvidence {
  opId: string;
  delegationId: string;
}

export interface AuthoritySecurityProjection {
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>;
  root: AuthorityRootEvidence | null;
  effectiveRevokes: readonly EffectiveRevokeEvidence[];
  /** Plan 149: valid (root-authored, ancestry-monotonic) epoch beacons. */
  validBeacons: readonly EffectiveBeaconEvidence[];
}

export interface RecoveryPolicyProjection {
  policy: WitnessedSuccessionPolicyEvidence;
  genesisOperationId: string;
}

export interface AuthorityAnalysis {
  honoredWrites: ReadonlySet<string>;
  quarantinedWrites: ReadonlySet<string>;
  quarantineReasons: ReadonlyMap<string, string>;
  /** Honored acquires per role, in the order they were honored (the oracle's timeline). */
  acquiresByRole: ReadonlyMap<string, readonly HonoredAcquire[]>;
  /** Effective witnessed recovery policy and the valid genesis operation that supplied it. */
  recoveryPoliciesByRole: ReadonlyMap<string, RecoveryPolicyProjection>;
  security: AuthoritySecurityProjection;
}

export interface WitnessedSuccessionReviewSelector {
  replica: string;
  role: "clerk";
  witness: string;
}

export interface WitnessedSuccessionReview {
  claim: WitnessedSuccessionClaimEvidence;
  policyGenesisOperationId: string;
  witness: string;
  threshold: number;
  verifiedFrontier: readonly string[];
}

export type WitnessedSuccessionReviewRefusal =
  | "unsupported_role"
  | "replica_mismatch"
  | "no_current_holder"
  | "recovery_policy_unavailable"
  | "invalid_recovery_policy"
  | "witness_not_pinned"
  | "stale_verified_state"
  | "authority_analysis_failed";

export type WitnessedSuccessionReviewResult =
  | { ok: true; review: WitnessedSuccessionReview }
  | { ok: false; reason: WitnessedSuccessionReviewRefusal };

interface RoleState {
  holder: string | null;
  acquires: HonoredAcquire[];
  heartbeats: { opId: string; atTick: number }[];
}

function emptyRoleState(): RoleState {
  return { holder: null, acquires: [], heartbeats: [] };
}

interface CollectedDelegation {
  delegation: AuthorityDelegationEvidence | null;
  introductionOpIds: string[];
  invalidIntroductionReasons: Map<string, string>;
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

  const collectedDelegations = collectDelegations(visible);
  const delegations = validateDelegations(visible, collectedDelegations);
  const { policies, recoveryPoliciesByRole } = collectPolicies(visible, delegations);
  const root = resolveRoot(visible, delegations);
  const { effectiveRevokes, unauthorizedRevokes } = collectRevokes(
    visible,
    delegations,
    root,
  );
  const { validBeacons, invalidBeacons } = collectBeacons(
    visible,
    byId as Map<string, Op>,
    root,
  );
  const states = new Map<string, RoleState>();
  const honoredWrites = new Set<string>();
  const quarantineReasons = delegationQuarantineReasons(delegations);
  for (const [opId, reason] of unauthorizedRevokes) {
    quarantineReasons.set(opId, reason);
  }
  for (const [opId, reason] of invalidBeacons) {
    quarantineReasons.set(opId, reason);
  }
  const quarantinedWrites = new Set<string>(quarantineReasons.keys());

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
    if (evidence.type === "beacon") {
      throw new Error(`beacon ${op.id} cannot write authority role ${op.field}`);
    }
    if (evidence.type === "revoke") {
      throw new Error(`revoke ${op.id} cannot write authority role ${op.field}`);
    }
    const state = states.get(op.field) ?? emptyRoleState();
    const honored = authorityWriteHonored(
      op,
      evidence,
      state,
      delegations,
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

  return {
    honoredWrites,
    quarantinedWrites,
    quarantineReasons,
    acquiresByRole,
    recoveryPoliciesByRole,
    security: { delegations, root, effectiveRevokes, validBeacons },
  };
}

/** Derive a witnessed-succession review solely from a verified local operation set. */
export function deriveWitnessedSuccessionReview(
  schema: ReplicaSchema,
  ops: Op[],
  selector: WitnessedSuccessionReviewSelector,
  priorReview: WitnessedSuccessionReview | null,
): WitnessedSuccessionReviewResult {
  if (selector.role !== "clerk") return refusedReview("unsupported_role");
  if (
    selector.replica.length === 0 ||
    ops.some((op) => op.replica !== selector.replica)
  ) {
    return refusedReview("replica_mismatch");
  }

  const byId = index(ops);
  if (
    byId.size !== ops.length ||
    ops.some((op) => op.deps.some((dependency) => !byId.has(dependency)))
  ) {
    return refusedReview("authority_analysis_failed");
  }

  let analysis: AuthorityAnalysis;
  let orderedOps: Op[];
  try {
    const order = canonicalOrder(ops, byId);
    orderedOps = order.map((id) => byId.get(id)!);
    analysis = analyzeAuthority(schema, ops, new Set(order), order, byId);
  } catch {
    return refusedReview("authority_analysis_failed");
  }

  const currentAcquire = analysis.acquiresByRole.get(selector.role)?.at(-1);
  if (
    currentAcquire?.holderPubkey === undefined ||
    canonicalBase64Bytes(currentAcquire.holderPubkey, 32) === null ||
    !canonicalBase64UrlDigest(currentAcquire.opId)
  ) {
    return refusedReview("no_current_holder");
  }

  const projection = analysis.recoveryPoliciesByRole.get(selector.role);
  if (projection === undefined) return refusedReview("recovery_policy_unavailable");

  const policy = normalizeWitnessedSuccessionPolicy(projection.policy);
  if (policy === null) return refusedReview("invalid_recovery_policy");
  const policyId = witnessedRecoveryPolicyId(policy.recovery);
  if (policyId === null) return refusedReview("invalid_recovery_policy");
  if (
    canonicalBase64Bytes(selector.witness, 32) === null ||
    !policy.recovery.witnesses.includes(selector.witness)
  ) {
    return refusedReview("witness_not_pinned");
  }

  const review: WitnessedSuccessionReview = {
    claim: {
      version: 1,
      replica: selector.replica,
      role: selector.role,
      holder: currentAcquire.holderPubkey,
      holderEpoch: currentAcquire.opId,
      successor: policy.successor,
      policyId,
    },
    policyGenesisOperationId: projection.genesisOperationId,
    witness: selector.witness,
    threshold: policy.recovery.threshold,
    verifiedFrontier: frontier(orderedOps),
  };

  if (priorReview !== null && !sameWitnessedSuccessionReview(priorReview, review)) {
    return refusedReview("stale_verified_state");
  }
  return { ok: true, review };
}

function normalizeWitnessedSuccessionPolicy(
  policy: WitnessedSuccessionPolicyEvidence,
): WitnessedSuccessionPolicyEvidence | null {
  const candidate = policy as unknown;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, ["mode", "successorRealm", "successor", "recovery"])
  ) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const recoveryCandidate = record.recovery;
  if (
    record.mode !== "witnessed" ||
    typeof record.successorRealm !== "string" ||
    canonicalBase64Bytes(record.successor, 32) === null ||
    typeof recoveryCandidate !== "object" ||
    recoveryCandidate === null
  ) {
    return null;
  }
  const recovery = normalizeWitnessedRecoveryPolicy(
    recoveryCandidate as WitnessedRecoveryPolicyEvidence,
  );
  return recovery === null
    ? null
    : {
        mode: "witnessed",
        successorRealm: record.successorRealm,
        successor: record.successor as string,
        recovery,
      };
}

function sameWitnessedSuccessionReview(
  left: WitnessedSuccessionReview,
  right: WitnessedSuccessionReview,
): boolean {
  return (
    claimBindingMatches(left.claim, right.claim) &&
    left.claim.policyId === right.claim.policyId &&
    left.policyGenesisOperationId === right.policyGenesisOperationId &&
    left.witness === right.witness &&
    left.threshold === right.threshold &&
    left.verifiedFrontier.length === right.verifiedFrontier.length &&
    left.verifiedFrontier.every((id, index) => id === right.verifiedFrontier[index])
  );
}

function refusedReview(
  reason: WitnessedSuccessionReviewRefusal,
): WitnessedSuccessionReviewResult {
  return { ok: false, reason };
}

function honoredAcquire(
  op: Op,
  evidence: Exclude<
    AuthorityEvidence,
    { type: "heartbeat" } | { type: "revoke" } | { type: "beacon" }
  >,
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
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
  policies: ReadonlyMap<string, SuccessionPolicyEvidence>,
  byId: ReadonlyMap<string, Op>,
): boolean {
  if (
    evidence.type === "heartbeat" ||
    evidence.type === "revoke" ||
    evidence.type === "beacon"
  ) {
    return false;
  }

  const delegation = evidence.delegation;
  if (
    delegation.audienceRealm !== op.value ||
    !delegation.roles.includes(op.field) ||
    !validDelegation(delegation, delegations)
  ) {
    return false;
  }

  if (evidence.type === "genesis") {
    return (
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

export function assembleWitnessedSuccessionArtifact(
  claim: WitnessedSuccessionClaimEvidence,
  signature: WitnessedSuccessionSignatureEvidence,
): WitnessedSuccessionArtifactEvidence {
  if (!validWitnessedSuccessionArtifactInput(claim, signature)) {
    throw new Error("malformed witnessed succession artifact input");
  }

  const orderedClaim: WitnessedSuccessionClaimEvidence = {
    version: claim.version,
    replica: claim.replica,
    role: claim.role,
    holder: claim.holder,
    holderEpoch: claim.holderEpoch,
    successor: claim.successor,
    policyId: claim.policyId,
  };

  return {
    v: 1,
    artifactId: bytesToBase64Url(
      sha256(canonicalBytesForWitnessedSuccessionArtifactId(orderedClaim, signature.witness)),
    ),
    claim: orderedClaim,
    witness: signature.witness,
    signature: signature.signature,
  };
}

export function exportWitnessedSuccessionArtifactJson(
  artifact: WitnessedSuccessionArtifactEvidence,
): string {
  return JSON.stringify({
    v: artifact.v,
    artifactId: artifact.artifactId,
    claim: {
      version: artifact.claim.version,
      replica: artifact.claim.replica,
      role: artifact.claim.role,
      holder: artifact.claim.holder,
      holderEpoch: artifact.claim.holderEpoch,
      successor: artifact.claim.successor,
      policyId: artifact.claim.policyId,
    },
    witness: artifact.witness,
    signature: artifact.signature,
  });
}

function validWitnessedSuccessionArtifactInput(
  claim: WitnessedSuccessionClaimEvidence,
  signature: WitnessedSuccessionSignatureEvidence,
): boolean {
  return (
    typeof claim === "object" &&
    claim !== null &&
    exactKeys(claim, [
      "version",
      "replica",
      "role",
      "holder",
      "holderEpoch",
      "successor",
      "policyId",
    ]) &&
    claim.version === 1 &&
    typeof claim.replica === "string" &&
    claim.replica.length > 0 &&
    claim.role === "clerk" &&
    canonicalBase64Bytes(claim.holder, 32) !== null &&
    canonicalBase64UrlDigest(claim.holderEpoch) &&
    canonicalBase64Bytes(claim.successor, 32) !== null &&
    canonicalBase64UrlDigest(claim.policyId) &&
    typeof signature === "object" &&
    signature !== null &&
    exactKeys(signature, ["witness", "signature"]) &&
    canonicalBase64Bytes(signature.witness, 32) !== null &&
    canonicalBase64Bytes(signature.signature, 64) !== null
  );
}

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
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
): {
  policies: Map<string, SuccessionPolicyEvidence>;
  recoveryPoliciesByRole: Map<string, RecoveryPolicyProjection>;
} {
  const policies = new Map<string, SuccessionPolicyEvidence>();
  const recoveryPoliciesByRole = new Map<string, RecoveryPolicyProjection>();

  for (const op of ops) {
    const evidence = op.authority;
    if (evidence?.type !== "genesis" || evidence.policies === undefined) continue;
    if (
      !validDelegation(evidence.delegation, delegations) ||
      op.replica === undefined ||
      !replicaRootMatches(op.replica, evidence.delegation.audience)
    ) {
      continue;
    }
    for (const [role, policy] of Object.entries(evidence.policies)) {
      policies.set(role, policy);
      if (policy.mode === "witnessed") {
        recoveryPoliciesByRole.set(role, {
          policy,
          genesisOperationId: op.id,
        });
      } else {
        recoveryPoliciesByRole.delete(role);
      }
    }
  }

  return { policies, recoveryPoliciesByRole };
}

function collectDelegations(
  ops: readonly Op[],
): Map<string, CollectedDelegation> {
  const delegations = new Map<string, CollectedDelegation>();

  for (const op of ops) {
    const evidence = op.authority;
    if (
      evidence === undefined ||
      evidence.type === "heartbeat" ||
      evidence.type === "revoke" ||
      evidence.type === "beacon"
    ) {
      continue;
    }

    const delegation = evidence.delegation;
    const existing = delegations.get(delegation.id);

    if (!delegationSelfConsistent(delegation)) {
      const record =
        existing ??
        {
          delegation: null,
          introductionOpIds: [],
          invalidIntroductionReasons: new Map<string, string>(),
        };
      record.invalidIntroductionReasons.set(op.id, "bad_delegation_sig");
      delegations.set(delegation.id, record);
      continue;
    }

    if (existing === undefined) {
      delegations.set(delegation.id, {
        delegation,
        introductionOpIds: [op.id],
        invalidIntroductionReasons: new Map(),
      });
    } else if (existing.delegation === null) {
      existing.delegation = delegation;
      existing.introductionOpIds.push(op.id);
    } else if (delegationKey(existing.delegation) === delegationKey(delegation)) {
      existing.introductionOpIds.push(op.id);
    } else {
      existing.delegation = null;
    }
  }

  return delegations;
}

function validateDelegations(
  ops: readonly Op[],
  collected: ReadonlyMap<string, CollectedDelegation>,
): Map<string, AuthorityDelegationRecord> {
  const genesisIds = new Set(
    ops.flatMap((op) =>
      op.authority?.type === "genesis" ? [op.authority.delegation.id] : [],
    ),
  );
  const outerReplica = ops.find((op) => op.replica !== undefined)?.replica;
  const cache = new Map<string, DelegationValidation>();
  const delegations = new Map<string, AuthorityDelegationRecord>();

  for (const [id, record] of collected) {
    delegations.set(id, {
      delegation: record.delegation,
      introductionOpIds: [...record.introductionOpIds],
      invalidIntroductionReasons: new Map(record.invalidIntroductionReasons),
      validation: delegationValidation(
        id,
        collected,
        genesisIds,
        outerReplica,
        cache,
        new Set(),
      ),
    });
  }

  return delegations;
}

function delegationValidation(
  id: string,
  delegations: ReadonlyMap<string, CollectedDelegation>,
  genesisIds: ReadonlySet<string>,
  outerReplica: string | undefined,
  cache: Map<string, DelegationValidation>,
  visiting: Set<string>,
): DelegationValidation {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const record = delegations.get(id);
  const delegation = record?.delegation;
  if (delegation === undefined || delegation === null) {
    return { valid: false, reason: "bad_delegation_sig" };
  }
  if (visiting.has(id)) return { valid: false, reason: "invalid_parent" };
  visiting.add(id);

  let validation: DelegationValidation;
  if (delegation.parentId === null) {
    if (delegation.issuer !== delegation.audience) {
      validation = { valid: false, reason: "nongenesis_root" };
    } else if (
      genesisIds.has(delegation.id) &&
      outerReplica !== undefined &&
      !replicaRootMatches(outerReplica, delegation.audience)
    ) {
      validation = { valid: false, reason: "impostor_genesis" };
    } else {
      validation = { valid: true };
    }
  } else {
    const parent = delegations.get(delegation.parentId);
    if (parent === undefined) {
      validation = { valid: false, reason: "missing_parent" };
    } else if (parent.delegation === null) {
      validation = { valid: false, reason: "invalid_parent" };
    } else {
      const parentValidation = delegationValidation(
        delegation.parentId,
        delegations,
        genesisIds,
        outerReplica,
        cache,
        visiting,
      );
      validation =
        !parentValidation.valid
          ? { valid: false, reason: "invalid_parent" }
          : delegationAttenuates(delegation, parent.delegation)
            ? { valid: true }
            : { valid: false, reason: "not_attenuated" };
    }
  }

  visiting.delete(id);
  cache.set(id, validation);
  return validation;
}

function validDelegation(
  delegation: AuthorityDelegationEvidence,
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
): boolean {
  const record = delegations.get(delegation.id);
  return (
    record !== undefined &&
    record.delegation !== null &&
    delegationKey(record.delegation) === delegationKey(delegation) &&
    record.validation.valid
  );
}

function resolveRoot(
  ops: readonly Op[],
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
): AuthorityRootEvidence | null {
  for (const op of ops) {
    const evidence = op.authority;
    if (evidence?.type !== "genesis") continue;
    if (!validDelegation(evidence.delegation, delegations)) continue;
    if (
      op.replica !== undefined &&
      !replicaRootMatches(op.replica, evidence.delegation.audience)
    ) {
      continue;
    }
    return {
      realm: evidence.delegation.audienceRealm,
      pubkey: evidence.delegation.audience,
    };
  }

  return null;
}

function collectRevokes(
  ops: readonly Op[],
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
  root: AuthorityRootEvidence | null,
): {
  effectiveRevokes: EffectiveRevokeEvidence[];
  unauthorizedRevokes: Map<string, string>;
} {
  const effectiveRevokes: EffectiveRevokeEvidence[] = [];
  const unauthorizedRevokes = new Map<string, string>();

  for (const op of ops) {
    const evidence = op.authority;
    if (evidence?.type !== "revoke") continue;
    const delegation = delegations.get(evidence.delegationId)?.delegation;
    const authorized =
      delegation !== undefined &&
      delegation !== null &&
      (op.author === delegation.issuerRealm || op.author === root?.realm);

    if (authorized) {
      effectiveRevokes.push({
        opId: op.id,
        delegationId: evidence.delegationId,
      });
    } else {
      unauthorizedRevokes.set(op.id, "unauthorized_revoke");
    }
  }

  return { effectiveRevokes, unauthorizedRevokes };
}

// Plan 149: beacons in topo order — valid iff root-authored with an integer
// epoch strictly greater than every valid beacon epoch in the op's causal
// ancestry; violators quarantine (:unauthorized_beacon / :stale_beacon) and
// confer no lapse. Mirrors Lattice.Authority.collect_beacons/3.
function collectBeacons(
  visible: readonly Op[],
  byId: Map<string, Op>,
  root: AuthorityRootEvidence | null,
  ancCache = new Map<string, Set<string>>(),
): {
  validBeacons: EffectiveBeaconEvidence[];
  invalidBeacons: Map<string, string>;
} {
  const validBeacons: EffectiveBeaconEvidence[] = [];
  const invalidBeacons = new Map<string, string>();

  for (const op of visible) {
    const evidence = op.authority;
    if (evidence?.type !== "beacon") continue;

    const anc = ancestors(op.id, byId, ancCache);
    let priorMax = -1;
    for (const beacon of validBeacons) {
      if (anc.has(beacon.opId) && beacon.epoch > priorMax) priorMax = beacon.epoch;
    }

    if (op.author !== root?.realm) {
      invalidBeacons.set(op.id, "unauthorized_beacon");
    } else if (
      evidence.epoch === null ||
      !Number.isSafeInteger(evidence.epoch) ||
      evidence.epoch < 0 ||
      evidence.epoch <= priorMax
    ) {
      invalidBeacons.set(op.id, "stale_beacon");
    } else {
      validBeacons.push({ opId: op.id, epoch: evidence.epoch });
    }
  }

  return { validBeacons, invalidBeacons };
}

function delegationQuarantineReasons(
  delegations: ReadonlyMap<string, AuthorityDelegationRecord>,
): Map<string, string> {
  const reasons = new Map<string, string>();

  for (const record of delegations.values()) {
    for (const [opId, reason] of record.invalidIntroductionReasons) {
      reasons.set(opId, reason);
    }
    if (!record.validation.valid && record.delegation !== null) {
      for (const opId of record.introductionOpIds) {
        reasons.set(opId, record.validation.reason);
      }
    }
  }

  return reasons;
}

function delegationAttenuates(
  child: AuthorityDelegationEvidence,
  parent: AuthorityDelegationEvidence,
): boolean {
  return (
    child.parentId === parent.id &&
    child.issuer === parent.audience &&
    child.replica === parent.replica &&
    subset(child.ops, parent.ops) &&
    subset(child.roles, parent.roles) &&
    (!child.live || parent.live) &&
    expiryWithin(child, parent)
  );
}

// Plan 149: undefined = unbounded. An unbounded parent accepts anything; a
// leased parent accepts only a child leased at or before its own expiry —
// otherwise delegation launders the lease away.
function expiryWithin(
  child: AuthorityDelegationEvidence,
  parent: AuthorityDelegationEvidence,
): boolean {
  if (parent.expiresEpoch === undefined) return true;
  if (child.expiresEpoch === undefined) return false;
  return child.expiresEpoch <= parent.expiresEpoch;
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
      ...(delegation.expiresEpoch === undefined
        ? {}
        : { expires_epoch: delegation.expiresEpoch }),
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

function canonicalBase64UrlDigest(value: unknown): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = base64ToBytes(padded);
    return decoded.length === 32 && bytesToBase64Url(decoded) === value;
  } catch {
    return false;
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
