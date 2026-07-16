import type { Op } from "./op";
import { index } from "./dag";

// Anti-entropy reconciliation between a client realm and a peer (the WS server
// realm from plan 010's carrier). Encoding-independent: it exchanges op ids and
// then op payloads. This is Tier A — it works against a peer that speaks the
// sync protocol regardless of whether op bytes are ETF or CBOR, because ids are
// opaque handles here. (Verifying received ops locally is Tier B.)

/** The maximal ops of a log (no local op depends on them) — the frontier tips. */
export function frontier(ops: Op[]): string[] {
  const byId = index(ops);
  const hasChild = new Set<string>();
  for (const o of ops) for (const d of o.deps) if (byId.has(d)) hasChild.add(d);
  return ops.map((o) => o.id).filter((id) => !hasChild.has(id));
}

/** Ids present in `mine` but missing from the peer's known-id set. */
export function toSend(mine: Op[], peerHas: Set<string>): string[] {
  return mine.map((o) => o.id).filter((id) => !peerHas.has(id));
}

/** Ids the peer advertised that we lack — request these, then their deps close. */
export function toRequest(mine: Op[], peerIds: string[]): string[] {
  const have = new Set(mine.map((o) => o.id));
  return peerIds.filter((id) => !have.has(id));
}

/**
 * Integrate received ops into a local log, preserving set semantics (idempotent,
 * last-write-wins on duplicate id is a no-op since ids are content addresses).
 * Returns the merged op list; the caller re-materializes.
 */
export function integrate(mine: Op[], incoming: Op[]): Op[] {
  const byId = index(mine);
  for (const o of incoming) if (!byId.has(o.id)) byId.set(o.id, o);
  return [...byId.values()];
}
