import type { FeedState, HeldProfile, RouteConnection } from "@treetopdevs/lattice-shell-kit/sync";
import type { ReplicaView } from "./replica_view";
import type { ThreadTimeline } from "./thread_timeline";

// ThreadList (03): one row per thread the Space lists, in the judge's Space order, from the timelines
// (title, archived, last message, unread), the held profiles (waiting) and the feed (link state). A listed
// thread this phone does not hold yet still has a row, with `held: false`.

export interface ThreadListItem {
  replica: string;
  title: string;
  held: boolean;
  archived: boolean;
  /** The last counted message, or a removed placeholder; null when there is none. */
  last: { text: string; author: string; removed: boolean } | null;
  unreadCount: number;
  /** Authored ids not yet acknowledged by the relay. */
  waitingCount: number;
  connection: RouteConnection | null;
}

export interface ThreadList {
  threads: ThreadListItem[];
}

export interface ThreadListInputs {
  space: ReplicaView | null;
  timelines: Readonly<Record<string, ThreadTimeline>>;
  profiles: Readonly<Record<string, HeldProfile | undefined>>;
  feed: FeedState;
}

export function projectThreadList(inputs: ThreadListInputs): ThreadList {
  const listed = Array.isArray(inputs.space?.state.threads)
    ? (inputs.space!.state.threads as { replica?: unknown; title?: unknown }[]).map((t) => ({ replica: String(t.replica ?? ""), title: String(t.title ?? "") }))
    : [];
  const replicas = [...listed];
  for (const replica of Object.keys(inputs.timelines))
    if (!replicas.some((t) => t.replica === replica)) replicas.push({ replica, title: inputs.timelines[replica]!.title });

  const threads = replicas.map(({ replica, title }): ThreadListItem => {
    const timeline = inputs.timelines[replica];
    const profile = inputs.profiles[replica];
    const acked = new Set(profile?.acked ?? []);
    const counted = timeline?.messages.filter((m) => m.standing === "honored") ?? [];
    const last = counted[counted.length - 1];
    return {
      replica,
      title: timeline?.title || title,
      held: timeline !== undefined,
      archived: timeline?.archived ?? false,
      last: last ? { text: last.text, author: last.author, removed: last.removed !== null } : null,
      unreadCount: timeline?.unreadCount ?? 0,
      waitingCount: (profile?.outbox ?? []).filter((id) => !acked.has(id)).length,
      connection: inputs.feed.routes.find((r) => r.replica === replica)?.connection ?? null,
    };
  });
  return { threads };
}
