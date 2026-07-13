import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytesForCarrierDelegation } from "./codec";
import { ancestors } from "./dag";
import type {
  AuthorityDelegationEvidence,
  AuthorityEvidence,
  Op,
  SuccessionPolicyEvidence,
} from "./op";
import { isAuthorityField } from "./schema";
import type { ReplicaSchema } from "./schema";

/** One honored role acquisition, in processing (canonical) order. */
export interface HonoredAcquire {
  opId: string;
  holder: string;
  atTick: number;
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
      const atTick =
        evidence.type === "transfer" || evidence.type === "succeed" ? evidence.atTick : 0;
      state.holder = holder;
      state.acquires.push({ opId: op.id, holder, atTick });
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
    const lastActive = Math.max(
      0,
      ...state.acquires.filter((a) => visible.has(a.opId)).map((a) => a.atTick),
      ...state.heartbeats.filter((h) => visible.has(h.opId)).map((h) => h.atTick),
    );

    return evidence.atTick >= lastActive + policy.dormantTicks;
  }

  throw new Error(`unsupported authority event ${evidence.type} for ${op.id}`);
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
    if (!validDelegation(evidence.delegation, delegations, delegationValidity, new Set())) {
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
  return commitment === null || bytesToBase64Url(sha256(base64ToBytes(audience))) === commitment;
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

function bytesToBase64Url(value: Uint8Array): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(value).toString("base64")
      : browserBase64(value);

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
