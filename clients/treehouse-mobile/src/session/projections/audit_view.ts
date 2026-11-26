import { carrierDelegationsFromFrames, frontier } from "@treetopdevs/lattice-client";
import type { FeedState } from "@treetopdevs/lattice-shell-kit/sync";
import type { ReplicaView } from "./replica_view";

// AuditView (03): everything, unfiltered. Quarantine reasons are the judge's raw strings (the closed union
// the UI uses elsewhere would collapse some of them). A grant's state (04: usable, revoked, lapsed, M1b.7) is
// lattice-client's treehouseDelegationStates answer for a delegation the judge honors: `usable` (no refusal),
// `revoked` (revoked_capability) or `lapsed` (lease_expired). A delegation the judge never honored (an invalid
// record, or one introduced only by a refused frame) is absent there and reads `not_usable`, whatever its
// parent's fate; nothing is guessed in the app. A raw record that only borrows an honored id is not_usable.

export type GrantState = "usable" | "revoked" | "lapsed" | "not_usable";

export interface AuditGrant {
  id: string;
  audience: string;
  roles: string[];
  ops: string[];
  state: GrantState;
}

export interface AuditReplica {
  replica: string;
  product: string;
  opCount: number;
  quarantined: { id: string; reason: string }[];
  grants: AuditGrant[];
  frontier: string[];
  generation: number | null;
  /** shell-kit's result of the last completed sync for this route; null before the first one. */
  matchesRelay: boolean | null;
  /**
   * Whether a "matches" result can still be shown (closing review, Codex): true for a "does not match", and
   * for a match only while the route is live and nothing this phone authored is waiting. A local post, or a
   * sync that failed (shell-kit keeps the old result), makes a match not current until the next completed sync.
   */
  comparisonCurrent: boolean;
}

export interface AuditView {
  replicas: AuditReplica[];
}

export interface AuditViewInputs {
  views: readonly ReplicaView[];
  feed: FeedState;
}

/** Delegations and frontier per judged view: decoded once, not on every link or local change. */
const perView = new WeakMap<ReplicaView, { delegations: ReturnType<typeof carrierDelegationsFromFrames>; frontier: string[]; states: GrantState[] }>();
const STATE_OF = { revoked_capability: "revoked", lease_expired: "lapsed" } as const;

/** Key-order-independent JSON, for comparing two decoded records field by field. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(value);
const sameRecord = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function heldFacts(view: ReplicaView) {
  let facts = perView.get(view);
  if (!facts) {
    const delegations = carrierDelegationsFromFrames([...view.frames]);
    // A raw record takes the judge's state only when it is the judge's own record, not merely its id (closing
    // review, Codex): a record that borrows an honored id with its own audience or operations is not_usable.
    const stateOf = (d: (typeof delegations)[number]): GrantState => {
      const honored = view.delegationStates.get(d.id);
      if (honored === undefined || !sameRecord(honored.delegation, d)) return "not_usable";
      return honored.refusal === null ? "usable" : STATE_OF[honored.refusal];
    };
    facts = { delegations, frontier: [...frontier(view.ops)].sort(), states: delegations.map(stateOf) };
    perView.set(view, facts);
  }
  return facts;
}

export function projectAuditView(inputs: AuditViewInputs): AuditView {
  const replicas = inputs.views.map((view): AuditReplica => {
    const route = inputs.feed.routes.find((r) => r.replica === view.replica);
    const facts = heldFacts(view);
    return {
      replica: view.replica,
      product: view.product,
      opCount: view.ops.length,
      quarantined: view.order.filter((id) => view.quarantine.has(id)).map((id) => ({ id, reason: view.quarantine.get(id)! })),
      grants: facts.delegations.map((d, i) => ({
        id: d.id,
        audience: d.audience,
        roles: [...d.roles],
        ops: [...d.ops],
        state: facts.states[i]!,
      })),
      frontier: [...facts.frontier],
      generation: route?.generation ?? null,
      matchesRelay: route?.matchesRelay ?? null,
      // Only a retained "Yes" is doubted: a "No" stays "No" (a relay-refused op counts as pending, and syncing
      // would not clear it), so the screen never hides a mismatch behind "changed since".
      comparisonCurrent:
        route !== undefined && route.matchesRelay !== null && (route.matchesRelay === false || (route.connection === "live" && route.pending === 0)),
    };
  });
  return { replicas };
}
