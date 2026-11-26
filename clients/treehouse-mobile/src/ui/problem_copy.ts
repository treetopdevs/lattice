import { IDENTITY_MISMATCH_REASONS } from "../session/projections/session_status";
import type { IdentityMismatchReason, SessionStatus } from "../session/projections/session_status";
import { identityMismatchCopy, phaseCopy } from "./strings";

// The problem card's first line (04 Problem screens). Pure, so Core tests run it. identity_mismatch says
// which of its three cases this phone is in (M1b.2); an unknown reason falls back to the phase line.

const isMismatchReason = (reason: string | null): reason is IdentityMismatchReason =>
  reason !== null && (IDENTITY_MISMATCH_REASONS as readonly string[]).includes(reason);

export function problemTitle(status: SessionStatus): string {
  if (status.phase === "identity_mismatch" && isMismatchReason(status.reason)) return identityMismatchCopy[status.reason];
  return phaseCopy[status.phase];
}
