import { carrierDelegationsFromFrames, frontier } from "@treetopdevs/lattice-client";
import type { FeedState } from "@treetopdevs/lattice-shell-kit/sync";
import type { ReplicaView } from "./replica_view";

// AuditView (03): everything, unfiltered. Quarantine reasons are the judge's raw strings (the closed union
// the UI uses elsewhere would collapse some of them). A grant is `live` when an op authored now could cite
// it; otherwise `not_live` (revoked or lapsed: lattice-client does not export which, so neither is guessed).

export interface AuditGrant {
  id: string;
  audience: string;
  roles: string[];
  ops: string[];
  state: "live" | "not_live";
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
const perView = new WeakMap<ReplicaView, { delegations: ReturnType<typeof carrierDelegationsFromFrames>; frontier: string[] }>();
function heldFacts(view: ReplicaView) {
  let facts = perView.get(view);
  if (!facts) {
    facts = { delegations: carrierDelegationsFromFrames([...view.frames]), frontier: [...frontier(view.ops)].sort() };
    perView.set(view, facts);
  }
  return facts;
}

export function projectAuditView(inputs: AuditViewInputs): AuditView {
  const replicas = inputs.views.map((view): AuditReplica => {
    const route = inputs.feed.routes.find((r) => r.replica === view.replica);
    const live = new Set(view.live.map((d) => d.id));
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
        state: live.has(d.id) ? "live" : "not_live",
      })),
      frontier: [...facts.frontier],
      generation: route?.generation ?? null,
      matchesRelay: route?.matchesRelay ?? null,
    };
  });
  return { replicas };
}
