import { carrierDelegationsFromFrames, frontier } from "@treetopdevs/lattice-client";
import type { FeedState } from "@treetopdevs/lattice-shell-kit/sync";
import type { ReplicaView } from "./replica_view";

// AuditView (03): everything, unfiltered. Quarantine reasons are the judge's raw strings (the closed union
// the UI uses elsewhere would collapse some of them). A grant's state (04: usable, revoked, lapsed, M1b.7) is
// lattice-client's treehouseDelegationStates answer for a delegation the judge honors: `usable` (no refusal),
// `revoked` (revoked_capability) or `lapsed` (lease_expired). A delegation the judge never honored (an invalid
// record, or one introduced only by a refused frame) is absent there and reads `not_usable`, whatever its
// parent's fate; nothing is guessed in the app.

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
  matchesRelay: boolean | null;
}

export interface AuditView {
  replicas: AuditReplica[];
}

export interface AuditViewInputs {
  views: readonly ReplicaView[];
  feed: FeedState;
}

/** Delegations and frontier per judged view: decoded once, not on every link or local change. */
const perView = new WeakMap<ReplicaView, { delegations: ReturnType<typeof carrierDelegationsFromFrames>; frontier: string[]; states: Map<string, GrantState> }>();
const STATE_OF = { revoked_capability: "revoked", lease_expired: "lapsed" } as const;
function heldFacts(view: ReplicaView) {
  let facts = perView.get(view);
  if (!facts) {
    const delegations = carrierDelegationsFromFrames([...view.frames]);
    const states = new Map<string, GrantState>();
    for (const d of delegations) {
      const honored = view.delegationStates.get(d.id);
      states.set(d.id, honored === undefined ? "not_usable" : honored.refusal === null ? "usable" : STATE_OF[honored.refusal]);
    }
    facts = { delegations, frontier: [...frontier(view.ops)].sort(), states };
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
      grants: facts.delegations.map((d) => ({
        id: d.id,
        audience: d.audience,
        roles: [...d.roles],
        ops: [...d.ops],
        state: facts.states.get(d.id)!,
      })),
      frontier: [...facts.frontier],
      generation: route?.generation ?? null,
      matchesRelay: route?.matchesRelay ?? null,
    };
  });
  return { replicas };
}
