import type { AnyCommandRefusal } from "../session/outcomes";
import type { AbilityRefusal } from "../session/projections/abilities";
import type { LinkPill } from "../session/projections/link_status";
import type { IdentityMismatchReason, SessionPhase } from "../session/projections/session_status";
import type { Delivery, Removed } from "../session/projections/thread_timeline";

// All user-facing text (07 M1a.5), as typed constants. Pure: no react, react-native or expo, so Node tests
// scan the same values the screens render. Every Record below is keyed by a closed union from the session,
// so a new reason, delivery state, pill or phase without copy fails `tsc`. The words follow 01: never
// "delivered", "read" or "seen by", "online" for a person, "encrypted" or "private", "account" or
// "password", or a send time; and none of Plan 178's prohibited phrases. strings.test.mts enforces both.

/** The one approved hosting sentence, short form for cards (01, "Hosting sentence"). */
export const HOSTING_SENTENCE =
  "The relay keeps a readable copy of this group. Its operator can read it and can take the relay offline. " +
  "The relay cannot write messages in your name or change who is a member, and it cannot erase what is already on your phone.";

/** Shown when the relay refuses this phone's key at the hello (04, join step 4; 03 pill "Relay refused this phone"). */
export const NO_RELAY_ACCESS = "The relay does not know this phone yet. Ask the admin to check relay access.";

/** 04 problem screen: a held-history verify failure, shown with its reason code. Nothing syncs. */
export const HISTORY_INVALID = "Saved group data failed its check.";

/** Shown in a build without demo identities, where this phone holds only its own key and no group yet. */
export const NO_GROUP_YET = "This phone is not in a group yet. Joining by invitation comes in a later version.";

/** The Group pill (03, "Connection state"). */
export const linkPillLabel: Record<LinkPill, string> = {
  live: "Live",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  partly_connected: "Partly connected",
  relay_refused: "Relay refused this phone",
  offline: "Offline",
};

export const RELAY_REFUSED_PILL = linkPillLabel.relay_refused;

/** Appended to the pill whenever the outbox has unacknowledged ids (03). */
export const waitingSuffix = (count: number): string => `· ${count} waiting`;

/** My message's delivery mark (03, "Message state: two axes"). There is no state for a person having it. */
export const deliveryLabel: Record<Delivery, string> = {
  saved: "Saved on this phone",
  sending: "Sending",
  on_relay: "On relay",
  relay_refused: "Relay did not accept",
  stopped: "Relay is not accepting messages",
};

/** Placeholder text for a removed message (04, Thread screen). */
export const removedPlaceholder: Record<Removed, string> = {
  by_author: "Message deleted",
  by_moderator: "Removed by moderator",
};

export const message = {
  edited: "edited",
  arrivedLate: "Arrived later",
  notCounted: "Not counted",
  firstSeen: "First on this phone",
  copyText: "Copy text",
  tryAgain: "Try again",
} as const;

/** Tab titles (04: three tabs). */
export const tabs = {
  threads: "Threads",
  people: "People",
  group: "Group",
} as const;

export const thread = {
  screenTitle: "Thread",
  empty: "No messages yet.",
  post: "Post",
  write: "Write a message",
  cannotPost: "This phone can't post in this thread.",
  notHeld: "Not on this phone yet.",
  noThreads: "No threads yet.",
  // 04 says "Archived. Read only."; 01 never uses "read", so the banner says what it means instead.
  archived: "Archived. No new messages.",
  slotsFull: "This group has used all 12 threads.",
  /** Day separators (M1b.2), from first-seen time on this phone. */
  today: "Today",
  yesterday: "Yesterday",
  /** The composer while a post is being signed and saved. */
  posting: "Posting",
  /** Screen-reader name for the message list. */
  messages: (title: string | number) => `Messages in ${title}`,
  composerLabel: "Message text",
  /** The unread divider (M1b.4): above the first unread id when the thread opened, with the count then. */
  unreadDivider: (count: number) => `${count} unread`,
  unreadDividerLabel: (count: number) => `${count} unread from here`,
} as const;

/** The Threads tab (04, M1b.1). Every row and pill state has words, so colour is never the only signal. */
export const threadsTab = {
  /** This phone's own key, wherever a name is shown. */
  you: "You",
  /** A key with no name on this phone (01: "Key check" is the fingerprint). */
  keyCheck: (fingerprint: string | number) => `Key check ${fingerprint}`,
  preview: (name: string | number, text: string | number) => `${name}: ${text}`,
  unread: (count: number) => `${count} unread`,
  waiting: (count: number) => `${count} waiting to send`,
  routeNotConnected: "Not connected",
  archivedMark: "Archived",
  archivedSection: (count: number) => `Archived threads (${count})`,
  showArchived: "Show archived threads",
  hideArchived: "Hide archived threads",
  openThread: (title: string | number) => `Open ${title}`,
  pillLabel: (label: string | number) => `Connection: ${label}`,
  pillHint: "Shows the relay details on the Group tab",
  /** The Group name row when no Space is held yet. */
  noGroupName: "Group",
} as const;

/** Long-press sheet items and their confirmations (04). */
export const actions = {
  copy: "Copy",
  edit: "Edit",
  delete: "Delete",
  remove: "Remove as moderator",
  details: "Details",
  archive: "Archive",
  confirmDelete:
    "Delete this message for the group? This can't be undone. Copies already synced stay in the group's signed history.",
  confirmRemove:
    "Remove this message for the group? This can't be undone. Copies already synced stay in the group's signed history.",
  /** The confirmation's button for a moderator remove (04: same sentence, "Remove"). */
  removeConfirm: "Remove",
  cancel: "Cancel",
  /** M1b.3: the sheet's title and the bubble's screen-reader action that opens it. */
  sheetTitle: "Message",
  openSheet: "Message actions",
  openSheetHint: "Opens what you can do with this message",
  /** The composer while it edits one of my messages. */
  editing: "Editing message",
  saveEdit: "Save",
  savingEdit: "Saving",
  editLabel: "Edited message text",
} as const;

/** Relay section of the Group tab (04). */
export const relay = {
  syncNow: "Sync now",
  pauseSync: "Pause sync",
  resumeSync: "Turn sync on",
} as const;

/** People tab (04). */
export const people = {
  onlyMe: "Just you so far.",
  you: "you",
  startedGroup: "Started this group",
  confirmRemoveMember: (name: string | number) =>
    `Remove ${name}? They can't post or receive new messages once this reaches the relay. They keep everything already on their phone.`,
  confirmMakeModerator: (name: string | number) => `Make ${name} the moderator? The current moderator loses that role.`,
  confirmTransferAdmin: (name: string | number) =>
    `Make ${name} the admin? You stop being admin. This can only be reversed by ${name}.`,
} as const;

/** Recovery offers on the problem screens (04): export, and re-sync from the relay into a fresh store. */
export const recovery = {
  export: "Save group data to a file",
  exportTitle: "Treehouse group data",
  resync: "Re-sync from relay",
  resyncTitle: "Re-sync from relay?",
  confirmResync:
    "This phone starts a fresh copy of the group from the relay. The saved data that failed its check stays on this phone and is not used. Messages in it that never reached the relay are not sent, and the saved file does not hold them.",
  confirm: "Re-sync",
  cancel: "Cancel",
  carryOverFailed: "Group data from the earlier version of this app failed its check and was not moved. It stays on this phone.",
} as const;

/** One line per SessionStatus phase (04, Problem screens); empty for the ordinary member phase. */
export const phaseCopy: Record<SessionPhase, string> = {
  no_key: "This phone has no key yet.",
  key_only: NO_GROUP_YET,
  joining: "You are invited. Joining finishes when the admin admits this phone.",
  member: "",
  removed: "You've been removed from this group. What's on this phone stays readable.",
  identity_mismatch: "The key on this phone doesn't match the saved group.",
  history_invalid: HISTORY_INVALID,
};

/**
 * The identity_mismatch problem line by reason (04 Problem screens, M1b.2). Each says what is true on this
 * phone; none offers a reset, since the app never replaces a key or deletes held history on its own.
 */
export const identityMismatchCopy: Record<IdentityMismatchReason, string> = {
  key_unavailable: "This phone's key can't be opened right now. Unlock the phone and open Treehouse again.",
  key_missing: "This phone holds a saved group but not the key that goes with it.",
  outbox_other_key: phaseCopy.identity_mismatch,
};

/** Every refusal any command or ability can give. */
export type AllRefusalReasons = AnyCommandRefusal | AbilityRefusal;

/** Exactly one line of copy per refusal reason (03, Commands). A reason without copy fails `tsc`. */
export const refusalCopy: Record<AllRefusalReasons, string> = {
  // App-level reasons.
  identity_unavailable: "This phone's key is not available right now.",
  no_capability: "This phone can't do this in this group. Ask the admin.",
  empty_text: "Write something first.",
  text_too_long: "Messages can be up to 4,000 characters.",
  malformed_text: "This text has a character that can't be signed. Remove it and try again.",
  storage_failed: "This phone couldn't save that. Nothing was sent.",
  history_invalid: HISTORY_INVALID,
  not_open: "Treehouse is still opening.",
  link_failed: "The relay connection hit an error. Try again.",
  identity_mismatch: "The key on this phone doesn't match the saved group. Nothing was signed or sent.",
  no_space: "There is no group data on this phone to save.",
  export_failed: "The group data on this phone failed its check, so no file was made.",
  // The six pinned application denials, in 03's wording.
  "missing or not-causal target": "That message isn't on this phone yet.",
  "quarantined target": "That message doesn't count in the group, so it can't be changed.",
  "wrong target kind or thread": "That can't be changed this way.",
  "wrong author": "Only the person who wrote a message can change it.",
  "already tombstoned": "That message was already removed.",
  "archived thread": "This thread is archived. It takes no new messages or changes.",
  // The judge's capability and authority reasons.
  capability_not_visible: "What lets you do this hasn't reached this phone yet. Sync and try again.",
  capability_wrong_audience: "That was given to a different key.",
  invalid_capability: "What lets you do this is not valid.",
  lease_expired: "Your access didn't renew in time. Ask the admin.",
  malformed_command: "This action is not well formed.",
  not_holder: "Only the current holder of that role can do this.",
  operation_not_granted: "You were not given this action in this group.",
  revoked_capability: "The admin took this away from you.",
  role_not_granted: "This needs a role you don't have.",
  stale_holder: "That role has moved to someone else.",
  wrong_replica: "That belongs to another thread or group.",
  quarantined: "The group's rules would not count this.",
};
