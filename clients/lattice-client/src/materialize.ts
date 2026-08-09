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

export interface CarrierAuthorityReportDiagnostic {
  /** Complete carrier report domain after frame verification. */
  opIds: ReadonlySet<string>;
  /** Carrier-reported authority quarantine, used only for comparison. */
  quarantinedIds: ReadonlySet<string>;
}

export class CarrierAuthorityReportDivergenceError extends Error {
  readonly localIds: string[];
  readonly reportedIds: string[];

  constructor(localIds: readonly string[], reportedIds: readonly string[]) {
    const sortedLocalIds = sortedIds(localIds);
    const sortedReportedIds = sortedIds(reportedIds);
    super(
      "carrier_authority_report_divergence: locally computed authority quarantine " +
        `${JSON.stringify(sortedLocalIds)} does not match carrier report ` +
        JSON.stringify(sortedReportedIds),
    );
    this.name = "CarrierAuthorityReportDivergenceError";
    this.localIds = sortedLocalIds;
    this.reportedIds = sortedReportedIds;
  }
}

export interface Materialized {
  /** field -> materialized value */
  state: Record<string, unknown>;
  /** ids of ops rejected by the quarantine predicate (never applied to state) */
  quarantine: string[];
  /** Locally decided BEAM-compatible reason for each attributed quarantine id. */
  quarantineReasons: ReadonlyMap<string, string>;
  /** the canonical linear extension actually used */
  order: string[];
  /** field -> winning op id for LWW/authority fields (provenance) */
  winners: Record<string, string | null>;
}

/**
 * Materialize a replica from ops. `included` optionally bounds the visible set
 * (a frontier); default is all ops. `carrierAuthorityReport` is an optional,
 * domain-bounded diagnostic: local analysis always decides authority and applied
 * quarantine, then a mismatched carrier report fails closed. `expectedReplica`
 * pins authority analysis to a caller-established replica; omitted values retain
 * the legacy vector fallback.
 * This is a pure function of its inputs, so Sim can remain the conformance
 * oracle for state, quarantine, and order.
 */
export function materialize(
  schema: ReplicaSchema,
  ops: Op[],
  included?: ReadonlySet<string>,
  carrierAuthorityReport: CarrierAuthorityReportDiagnostic | null = null,
  expectedReplica?: string,
): Materialized {
  const byId = index(ops);
  const inc = included ?? new Set(ops.map((o) => o.id));

  const order = canonicalOrder(
    ops.filter((o) => inc.has(o.id)),
    byId,
  );
  const structurallyQuarantined = new Set(
    ops
      .filter(
        (op) =>
          inc.has(op.id) &&
          op.structuralError !== undefined,
      )
      .map((op) => op.id),
  );
  const authorityIncluded = new Set(
    [...inc].filter((id) => !structurallyQuarantined.has(id)),
  );
  const authorityOrder = order.filter((id) => authorityIncluded.has(id));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string) => depth(id, byId, depthCache);
  const ancCache = new Map<string, Set<string>>();
  let authority;
  try {
    authority = analyzeAuthority(
      schema,
      ops,
      authorityIncluded,
      authorityOrder,
      byId,
      expectedReplica,
    );
  } catch (error) {
    const role = authorityFailureRole(schema, ops, authorityIncluded);
    throw new V01UnvalidatedAuthorityError(
      role,
      authorityWriteCount(schema, ops, authorityIncluded),
      error,
    );
  }

  // 1. quarantine pass (deps-decidable, over the included set)
  const quarantine: string[] = [];
  const quarantineReasons = new Map(authority.quarantineReasons);
  for (const id of structurallyQuarantined) {
    quarantineReasons.set(id, "malformed_term");
  }
  const quarantined = new Set([
    ...authority.quarantinedWrites,
    ...structurallyQuarantined,
  ]);
  for (const id of order) {
    const op = byId.get(id)!;
    if (quarantined.has(id)) {
      quarantine.push(id);
      continue;
    }
    const q = isQuarantined(op, schema, byId, authority, ancCache);
    if (q.quarantined) {
      quarantine.push(id);
      quarantined.add(id);
      if (q.reason !== undefined) quarantineReasons.set(id, q.reason);
    }
  }

  if (carrierAuthorityReport !== null) {
    const localIds = quarantine.filter(
      (id) =>
        carrierAuthorityReport.opIds.has(id) &&
        !structurallyQuarantined.has(id),
    );
    const reportedIds = [...carrierAuthorityReport.quarantinedIds].filter(
      (id) => !structurallyQuarantined.has(id),
    );
    if (!sameIds(localIds, reportedIds)) {
      throw new CarrierAuthorityReportDivergenceError(localIds, reportedIds);
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

  return { state, quarantine, quarantineReasons, order, winners };
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sortedIds(left);
  const sortedRight = sortedIds(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((id, index) => id === sortedRight[index])
  );
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
