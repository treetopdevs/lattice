import { carrierOpsToSemanticOps, observeTreehouse, treehouseCommandDecoders, treehouseDelegationStates } from "@treetopdevs/lattice-client";
import type { CarrierDelegation, CarrierOpFrame, Op, TreehouseProduct } from "@treetopdevs/lattice-client";

// One decoded and judged replica, shared by every projection (03: recomputed once per change of its
// inputs, never per render). Everything here is a lattice-client result: decoding, the judge's state and
// quarantine (via observeTreehouse, which materializes), the post observation and the live delegations.
// It is an internal input, not a read model, so it may hold Maps.

export interface ReplicaView {
  replica: string;
  product: TreehouseProduct;
  frames: readonly CarrierOpFrame[];
  ops: Op[];
  byId: ReadonlyMap<string, Op>;
  /** The judge's materialized state. */
  state: Record<string, unknown>;
  /** The judge's raw reason per quarantined op id. */
  quarantine: ReadonlyMap<string, string>;
  /** The canonical linear extension the judge used. */
  order: readonly string[];
  /** Visible posts in timeline order with their winning text (Thread only). */
  posts: readonly { id: string; author: string; text: unknown }[];
  /**
   * Delegations an op authored now can cite: honored, unrevoked, unexpired. Computed on first read, because
   * lattice-client derives it with a second materialize and a timeline does not need it.
   */
  readonly live: readonly CarrierDelegation[];
  /**
   * Every delegation the judge honors here, once each, with lattice-client's reason an op authored now could
   * not cite it (null when usable; `live` is that subset). A delegation absent here was never honored.
   */
  readonly delegationStates: ReadonlyMap<string, { delegation: CarrierDelegation; refusal: "revoked_capability" | "lease_expired" | null }>;
}

export function viewReplica(replica: string, product: TreehouseProduct, frames: readonly CarrierOpFrame[]): ReplicaView {
  const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders(product));
  const observed = observeTreehouse(product, ops);
  let live: readonly CarrierDelegation[] | null = null;
  let states: ReplicaView["delegationStates"] | null = null;
  const delegationStates = () => (states ??= new Map(treehouseDelegationStates(product, frames, replica).map((s) => [s.delegation.id, s])));
  return {
    replica,
    product,
    frames,
    ops,
    byId: new Map(ops.map((op) => [op.id, op])),
    state: observed.state,
    quarantine: observed.quarantineReasons,
    order: observed.order,
    posts: observed.posts,
    get live() {
      live ??= [...delegationStates().values()].filter((s) => s.refusal === null).map((s) => s.delegation);
      return live;
    },
    get delegationStates() {
      return delegationStates();
    },
  };
}

/** The author key of an op: the frame's public key (no realm map is applied in the app). */
export const authorOf = (op: Op): string => op.authorPubkey ?? op.author;

/** Honored command ops of one name, in the judge's canonical order. */
export function honoredCommands(view: ReplicaView, command: string): Op[] {
  return view.order
    .map((id) => view.byId.get(id))
    .filter((op): op is Op => op !== undefined && op.kind === "command" && op.command === command && !view.quarantine.has(op.id));
}
