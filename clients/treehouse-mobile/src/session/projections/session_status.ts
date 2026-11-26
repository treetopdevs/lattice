import type { HeldProfile } from "@treetopdevs/lattice-shell-kit/sync";
import { groupMemberKeys } from "./group_summary";
import { authorOf, honoredCommands } from "./replica_view";
import type { ReplicaView } from "./replica_view";

// SessionStatus (03): one phase for the whole session, checked in this order.
//   history_invalid    verify-on-open failed or the store could not open (reason and replica reported)
//   identity_mismatch  custody holds a key it cannot read (key_unavailable, with or without history), history
//                      is held but custody holds no key (key_missing), or this phone's outbox holds ops
//                      authored by another key (outbox_other_key). Never resolved by creating a key (03,
//                      Lifecycle); signing and transport stop (02 Invariant 8).
//   no_key             no key, nothing held
//   key_only           a key, and no Space held (or a Space that neither admits nor invites this key)
//   member             this key is the root, a role holder or an admitted member of the held Space
//   removed            the Space's honored membership events remove this key and it is not a member now
//   joining            the Space holds an honored, unrevoked invitation for this key, not yet admitted
// A saved ceremony state replaces the joining inference when the enrollment ceremony lands (M2).

export type SessionPhase = "no_key" | "key_only" | "joining" | "member" | "removed" | "identity_mismatch" | "history_invalid";

/** Why the phase is identity_mismatch (M1b.2: the problem screen says which). */
export const IDENTITY_MISMATCH_REASONS = ["key_unavailable", "key_missing", "outbox_other_key"] as const;
export type IdentityMismatchReason = (typeof IDENTITY_MISMATCH_REASONS)[number];

export interface SessionStatus {
  phase: SessionPhase;
  /** history_invalid: the verify or open failure; identity_mismatch: why. Null otherwise. */
  reason: string | null;
  /** The replica that failed verification, when one did. */
  replica: string | null;
}

export type HistoryCheck = { ok: true } | { ok: false; replica: string | null; reason: string };

export interface SessionStatusInputs {
  custody: "none" | "available" | "unavailable";
  myKey: string | null;
  history: HistoryCheck;
  space: ReplicaView | null;
  held: readonly { replica: string; profile: HeldProfile | undefined }[];
}

const status = (phase: SessionPhase, reason: IdentityMismatchReason | string | null = null, replica: string | null = null): SessionStatus => ({ phase, reason, replica });

export function projectSessionStatus(inputs: SessionStatusInputs): SessionStatus {
  if (!inputs.history.ok) return status("history_invalid", inputs.history.reason, inputs.history.replica);
  const hasHistory = inputs.held.some((h) => (h.profile?.frames.length ?? 0) > 0);
  const key = inputs.custody === "available" ? inputs.myKey : null;
  if (key === null) {
    // A key that exists but cannot be read is never "no key": that would route to creating a new one.
    if (inputs.custody === "unavailable") return status("identity_mismatch", "key_unavailable");
    return hasHistory ? status("identity_mismatch", "key_missing") : status("no_key");
  }
  for (const { profile } of inputs.held) {
    if (!profile) continue;
    const byId = new Map(profile.frames.map((f) => [f.id, f]));
    if (profile.outbox.some((id) => byId.has(id) && byId.get(id)!.author !== key)) return status("identity_mismatch", "outbox_other_key");
  }
  const space = inputs.space;
  if (space === null) return status("key_only");
  if (groupMemberKeys(space).includes(key)) return status("member");
  const events = Array.isArray(space.state.membership_events) ? (space.state.membership_events as { action?: unknown; recipient?: unknown }[]) : [];
  if (events.some((e) => e.action === "remove" && e.recipient === key)) return status("removed");
  const revoked = new Set(Array.isArray(space.state.revoked_invitations) ? (space.state.revoked_invitations as unknown[]) : []);
  const invited = honoredCommands(space, "issue_invitation").some((op) => op.commandArgs?.[0] === key && !revoked.has(op.id) && authorOf(op) !== key);
  return status(invited ? "joining" : "key_only");
}
