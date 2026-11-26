import type { Ability } from "../session/projections/abilities";
import type { ThreadTimeline } from "../session/projections/thread_timeline";
import { threadInfo } from "./strings";

// Thread info (04, M1b.6). Pure: no react, react-native or expo, so Core tests run it. The counts, size and
// limits are the timeline's `health`; whether this key may archive is the Abilities answer for
// `archive_thread` (delegation, moderator holder, judge policy); whether the thread is archived is the judge's
// materialized flag. This helper only puts those facts into words and hides Archive once archived (01: no
// unarchive), whatever the judge would say about a second archive.

export interface ThreadInfoRow {
  key: "messages" | "ops" | "size";
  label: string;
  value: string;
  accessibilityLabel: string;
}

export interface ThreadInfoView {
  title: string;
  archived: boolean;
  rows: ThreadInfoRow[];
  canArchive: boolean;
}

/** 4000 -> "4,000", without Intl (Hermes builds may ship without full Intl data). */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A byte count in the units 04 uses for the limit (8 MiB shown as "8 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${groupDigits(Math.max(1, Math.round(bytes / 1024)))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

const row = (key: ThreadInfoRow["key"], label: string, value: string): ThreadInfoRow => ({
  key,
  label,
  value,
  accessibilityLabel: threadInfo.row(label, value),
});

export function threadInfoView(timeline: ThreadTimeline, abilities: Readonly<Record<string, Ability>> | undefined): ThreadInfoView {
  const h = timeline.health;
  return {
    title: timeline.title,
    archived: timeline.archived,
    rows: [
      row("messages", threadInfo.messages, groupDigits(h.messages)),
      row("ops", threadInfo.ops, threadInfo.ofLimit(groupDigits(h.ops), groupDigits(h.opsLimit))),
      row("size", threadInfo.size, threadInfo.ofLimit(formatBytes(h.bytes), formatBytes(h.bytesLimit))),
    ],
    canArchive: !timeline.archived && abilities?.archive_thread?.allowed === true,
  };
}
