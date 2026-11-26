import type { LinkStatus } from "../session/projections/link_status";
import type { ThreadList, ThreadListItem } from "../session/projections/thread_list";
import { linkPillLabel, removedPlaceholder, thread as threadCopy, threadsTab, waitingSuffix } from "./strings";

// Presentation helpers for the Threads tab (M1b.1). Pure: no react, react-native or expo, so Core tests run
// them. They only put read-model facts into words; every fact (unread, waiting, archived, route state) comes
// from the session's projections.

/** 04: archived threads sit in a collapsed section at the bottom; both keep the ThreadList's order. */
export function threadSections(list: ThreadList | null): { active: ThreadListItem[]; archived: ThreadListItem[] } {
  const threads = list?.threads ?? [];
  return { active: threads.filter((t) => !t.archived), archived: threads.filter((t) => t.archived) };
}

/** One row of the Threads tab list: a thread, or the archived section's toggle header. */
export type ThreadsTabRow = { kind: "thread"; key: string; item: ThreadListItem } | { kind: "archived"; key: string; count: number; open: boolean };

/**
 * The Threads tab's rows in one virtualized list: the active threads, then (when any are archived) the
 * archived section's toggle, then the archived threads only while it is open, so the toggle heads its section.
 */
export function threadsTabRows(list: ThreadList | null, showArchived: boolean): ThreadsTabRow[] {
  const { active, archived } = threadSections(list);
  const thread = (item: ThreadListItem): ThreadsTabRow => ({ kind: "thread", key: item.replica, item });
  const rows = active.map(thread);
  if (archived.length === 0) return rows;
  rows.push({ kind: "archived", key: "archived-toggle", count: archived.length, open: showArchived });
  if (showArchived) rows.push(...archived.map(thread));
  return rows;
}

export interface ThreadRowView {
  title: string;
  preview: string;
  unreadLabel: string | null;
  waitingLabel: string | null;
  routeMark: string | null;
  /** Everything the row shows, in words, for the screen reader. */
  accessibilityLabel: string;
}

/** `nameOf` resolves a key to "You", a petname or a key check (SessionProvider.displayName). */
export function threadRowView(item: ThreadListItem, nameOf: (pubkey: string, petname?: string | null) => string): ThreadRowView {
  const preview = !item.held
    ? threadCopy.notHeld
    : item.last
      ? item.last.removed
        ? removedPlaceholder[item.last.removed]
        : threadsTab.preview(nameOf(item.last.author, item.last.authorPetname), item.last.text)
      : threadCopy.empty;
  const unreadLabel = item.unreadCount > 0 ? threadsTab.unread(item.unreadCount) : null;
  const waitingLabel = item.waitingCount > 0 ? threadsTab.waiting(item.waitingCount) : null;
  const routeMark = item.routeNotConnected ? threadsTab.routeNotConnected : null;
  const accessibilityLabel = [item.title, preview, unreadLabel, waitingLabel, routeMark, item.archived ? threadsTab.archivedMark : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(". ");
  return { title: item.title, preview, unreadLabel, waitingLabel, routeMark, accessibilityLabel };
}

export type PillTone = "live" | "warn" | "error" | "muted";

export interface LinkPillView {
  label: string;
  tone: PillTone;
  accessibilityLabel: string;
}

const TONE: Record<LinkStatus["pill"], PillTone> = {
  live: "live",
  connecting: "muted",
  reconnecting: "warn",
  partly_connected: "warn",
  relay_refused: "error",
  offline: "muted",
};

/** The Group pill (03 "Connection state"): its label with the waiting suffix, and a tone that is never the only signal. */
export function linkPillView(status: LinkStatus | null): LinkPillView {
  if (!status) return { label: linkPillLabel.connecting, tone: "muted", accessibilityLabel: threadsTab.pillLabel(linkPillLabel.connecting) };
  const label = `${linkPillLabel[status.pill]}${status.waiting > 0 ? ` ${waitingSuffix(status.waiting)}` : ""}`;
  return { label, tone: TONE[status.pill], accessibilityLabel: threadsTab.pillLabel(label) };
}

