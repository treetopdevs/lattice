import type { Op } from "./op";
/** The maximal ops of a log (no local op depends on them) — the frontier tips. */
export declare function frontier(ops: Op[]): string[];
/** Ids present in `mine` but missing from the peer's known-id set. */
export declare function toSend(mine: Op[], peerHas: Set<string>): string[];
/** Ids the peer advertised that we lack — request these, then their deps close. */
export declare function toRequest(mine: Op[], peerIds: string[]): string[];
/**
 * Integrate received ops into a local log, preserving set semantics (idempotent,
 * last-write-wins on duplicate id is a no-op since ids are content addresses).
 * Returns the merged op list; the caller re-materializes.
 */
export declare function integrate(mine: Op[], incoming: Op[]): Op[];
