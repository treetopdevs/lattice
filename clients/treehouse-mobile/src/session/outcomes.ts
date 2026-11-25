// Typed command outcomes (03). Nothing throws for an expected refusal.

export type Outcome<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const refuse = <R extends string>(reason: R): { ok: false; reason: R } => ({ ok: false, reason });

/** The six pinned application denials, keyed by the judge's reason string, in the wording of 03. */
export const APPLICATION_DENIALS = {
  application_target_not_visible: "missing or not-causal target",
  application_target_quarantined: "quarantined target",
  application_wrong_target: "wrong target kind or thread",
  application_wrong_author: "wrong author",
  application_already_tombstoned: "already tombstoned",
  application_archived_thread: "archived thread",
} as const;

export type ApplicationDenial = (typeof APPLICATION_DENIALS)[keyof typeof APPLICATION_DENIALS];

/**
 * Capability and authority reasons the lattice-client judge gives a command op. Upstream exports no
 * closed type for them; this list is the app's, read from lattice-client's capability and quarantine
 * modules (2026-11-25). Any other judge reason maps to `quarantined`, so the union stays closed.
 */
export const JUDGE_REASONS = [
  "capability_not_visible",
  "capability_wrong_audience",
  "invalid_capability",
  "lease_expired",
  "malformed_command",
  "no_capability",
  "not_holder",
  "operation_not_granted",
  "revoked_capability",
  "role_not_granted",
  "stale_holder",
  "wrong_replica",
] as const;

export type JudgeReason = (typeof JUDGE_REASONS)[number];

/** Why the local judge would not count an op: a pinned denial, a judge reason, or the closed fallback. */
export type QuarantineReason = ApplicationDenial | JudgeReason | "quarantined";

export function quarantineReason(raw: string): QuarantineReason {
  if (Object.prototype.hasOwnProperty.call(APPLICATION_DENIALS, raw)) return APPLICATION_DENIALS[raw as keyof typeof APPLICATION_DENIALS];
  if ((JUDGE_REASONS as readonly string[]).includes(raw)) return raw as JudgeReason;
  return "quarantined";
}

export type PostRefusal =
  | "identity_unavailable"
  | "no_capability"
  | "empty_text"
  | "text_too_long"
  | "malformed_text"
  | "archived thread"
  | "storage_failed"
  | "history_invalid"
  | "identity_mismatch"
  | QuarantineReason;

/** Text checks shared by post and edit, made before anything is signed. */
export type TextRefusal = "empty_text" | "text_too_long" | "malformed_text";

/**
 * Every signed Thread command: the pipeline's reasons plus a session whose held history failed its check, or
 * whose key does not match the held history (02 Invariant 8: stop and say so).
 */
export type ThreadCommandRefusal =
  | "identity_unavailable"
  | "no_capability"
  | "storage_failed"
  | "history_invalid"
  | "identity_mismatch"
  | QuarantineReason;

export type EditRefusal = ThreadCommandRefusal | TextRefusal;
export type DeleteRefusal = ThreadCommandRefusal;
export type RemoveRefusal = ThreadCommandRefusal;
export type ArchiveRefusal = ThreadCommandRefusal;

/** Device-local commands (petname, draft, read marker). `not_open` before the session has opened. */
export type LocalRefusal = "storage_failed" | "not_open";

/** goOnline, goOffline, syncNow. `link_failed` when the relay link itself throws (not a route state). */
export type LinkRefusal = "history_invalid" | "identity_mismatch" | "storage_failed" | "link_failed" | "not_open";

export type AnyCommandRefusal = PostRefusal | EditRefusal | DeleteRefusal | RemoveRefusal | ArchiveRefusal | LocalRefusal | LinkRefusal;

/** App rule O-10: 4,000 characters (code points), well under the relay's 64,000-byte socket frame. */
export const MESSAGE_MAX_CHARS = 4_000;
