import type { Op } from "./op";
import { isAuthorityField } from "./schema";
import type { ReplicaSchema } from "./schema";
import { index, depth, canonicalOrder } from "./dag";
import { isQuarantined } from "./quarantine";
import { lww, orSet, causalList } from "./crdt/reducers";
import { analyzeAuthority } from "./authority";

/**
 * Thrown by {@link materialize} when a log changes an authority role but the
 * reducer cannot fully validate that history — evidence is missing for a
 * multi-write role, or an authority event shape is unsupported. This is the
 * V-01 fail-closed guard: rather than guess a holder and silently diverge from
 * the `Lattice.Sim` oracle (the V-01 STOP condition), we refuse. Plan 140
 * ported validated reduction for genesis/transfer/succeed/heartbeat histories;
 * anything outside that vocabulary still lands here.
 */
export class V01UnvalidatedAuthorityError extends Error {
  readonly role: string;
  override readonly cause: unknown;
  constructor(role: string, writes: number, cause?: unknown) {
    super(
      `V-01 fail-closed: refusing to materialize a log that changes authority role "${role}" ` +
        `(${writes} authority writes to it). The TS reducer cannot fully validate this role's ` +
        `authority history because evidence is missing or an event is unsupported, so it will not ` +
        `honor a change it cannot prove — see plans/140.`,
    );
    this.name = "V01UnvalidatedAuthorityError";
    this.role = role;
    this.cause = cause;
  }
}

export interface Materialized {
  /** field -> materialized value */
  state: Record<string, unknown>;
  /** ids of ops rejected by the quarantine predicate (never applied to state) */
  quarantine: string[];
  /** the canonical linear extension actually used */
  order: string[];
  /** field -> winning op id for LWW/authority fields (provenance) */
  winners: Record<string, string | null>;
}

/**
 * Materialize a replica from ops. `included` optionally bounds the visible set
 * (a frontier); default is all ops. This is a pure function of (schema, ops,
 * frontier) — the same inputs that `Lattice.Sim` reduces in Elixir, which is
 * why Sim can serve as the conformance oracle: for any scenario, this must
 * reproduce Sim's state, quarantine set, and order exactly.
 */
export function materialize(
  schema: ReplicaSchema,
  ops: Op[],
  included?: Set<string>,
): Materialized {
  const byId = index(ops);
  const inc = included ?? new Set(ops.map((o) => o.id));

  const order = canonicalOrder(
    ops.filter((o) => inc.has(o.id)),
    byId,
  );
  const depthCache = new Map<string, number>();
  const depthOf = (id: string) => depth(id, byId, depthCache);
  const ancCache = new Map<string, Set<string>>();
  let authority;
  try {
    authority = analyzeAuthority(schema, ops, inc, order, byId);
  } catch (error) {
    const role = authorityFailureRole(schema, ops, inc);
    throw new V01UnvalidatedAuthorityError(role, authorityWriteCount(schema, ops, inc), error);
  }

  // 1. quarantine pass (deps-decidable, over the included set)
  const quarantine: string[] = [];
  const quarantined = new Set(authority.quarantinedWrites);
  for (const id of order) {
    const op = byId.get(id)!;
    if (quarantined.has(id)) {
      quarantine.push(id);
      continue;
    }
    const q = isQuarantined(op, schema, byId, authority.acquiresByRole, ancCache);
    if (q.quarantined) {
      quarantine.push(id);
      quarantined.add(id);
    }
  }

  // 2. per-field reduction over included, non-quarantined ops
  const state: Record<string, unknown> = {};
  const winners: Record<string, string | null> = {};
  const live = order.filter((id) => !quarantined.has(id)).map((id) => byId.get(id)!);

  for (const [field, spec] of Object.entries(schema.fields)) {
    const fieldOps = live.filter((o) => o.field === field);
    if (isAuthorityField(spec)) {
      // holder = last authority op in canonical order
      let holder: unknown = spec.default !== undefined ? spec.default : null;
      let winner: string | null = null;
      for (const o of fieldOps) {
        holder = o.value;
        winner = o.id;
      }
      state[field] = holder;
      winners[field] = winner;
    } else if (spec.merge === "lww") {
      const r = lww(fieldOps, depthOf);
      state[field] = r.winner ? r.value : spec.default;
      winners[field] = r.winner;
    } else if (spec.merge === "or_set") {
      state[field] = orSet(fieldOps, byId);
    } else if (spec.merge === "causal_list") {
      state[field] = causalList(fieldOps, depthOf);
    }
  }

  return { state, quarantine, order, winners };
}

function authorityWriteCount(
  schema: ReplicaSchema,
  ops: Op[],
  included: ReadonlySet<string>,
): number {
  return ops.filter((op) => {
    if (!included.has(op.id) || op.kind !== "authority") return false;
    const spec = schema.fields[op.field];
    return spec !== undefined && isAuthorityField(spec);
  }).length;
}

function authorityFailureRole(
  schema: ReplicaSchema,
  ops: Op[],
  included: ReadonlySet<string>,
): string {
  return (
    ops.find((op) => {
      if (!included.has(op.id) || op.kind !== "authority") return false;
      const spec = schema.fields[op.field];
      return spec !== undefined && isAuthorityField(spec);
    })?.field ?? "unknown"
  );
}
