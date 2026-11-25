import { causalListEntries, depth, effectViews, lww } from "@treetopdevs/lattice-client";
import type { Op } from "@treetopdevs/lattice-client";
import type { HeldProfile, RouteFeedState } from "@treetopdevs/lattice-shell-kit/sync";
import { quarantineReason } from "../outcomes";
import type { QuarantineReason } from "../outcomes";
import { abilityOf } from "./abilities";
import { authorOf, honoredCommands, viewReplica } from "./replica_view";
import type { ReplicaView } from "./replica_view";

// The ThreadTimeline read model (03). Order, winning text and quarantine come from lattice-client: the
// visible posts are observeTreehouse's, the placeholder positions come from the same causal-list reducer
// over the same honored effects with only the delete effects left out, and standing is the judge's
// verdict. The app never re-sorts, re-judges or picks an edit winner itself.
//
// Decisions recorded for M1a.4 (03 "Order, time and unread"):
// - Removed messages keep their place as a placeholder with no text.
// - My own posts the judge does not count follow the counted timeline, in the judge's canonical order;
//   other people's appear only in the audit view.
// - Unread is "not mine, counted, not removed, id not in the read set". arrivedLate is positional: unread
//   and sorted above a message that is in the read set. LocalStore holds read ids only, not a viewed time.

/** Applies only to my own messages (03, "Message state: two axes"). */
export type Delivery = "saved" | "sending" | "on_relay" | "relay_refused" | "stopped";

export type Standing = "honored" | "not_counted";

export type Removed = "by_author" | "by_moderator";

/** A message by lineage: the root post id and the winning edit's id (the root when never edited). */
export interface MessageLineage {
  root: string;
  latest: string;
}

export interface MessageView {
  id: string;
  ref: MessageLineage;
  /** The author's public key (base64). */
  author: string;
  /** The winning text; empty for a removed message. */
  text: string;
  edited: boolean;
  removed: Removed | null;
  mine: boolean;
  /** Null for other people's messages. */
  delivery: Delivery | null;
  standing: Standing;
  /** The judge's reason when not counted, else null. */
  notCountedReason: QuarantineReason | null;
  /** Device-local first-seen time (ReplicaStore), or null when unknown (e.g. after a reinstall). */
  firstSeenMs: number | null;
  unread: boolean;
  arrivedLate: boolean;
}

export interface ThreadHealth {
  ops: number;
  /** Serialized size of the held frames, for the rollover thresholds that arrive with M2. */
  bytes: number;
}

export interface ThreadTimeline {
  replica: string;
  title: string;
  archived: boolean;
  messages: MessageView[];
  canPost: boolean;
  unreadCount: number;
  health: ThreadHealth;
}

export interface ThreadTimelineInputs {
  replica: string;
  profile: HeldProfile | undefined;
  /** This device's public key, or null when custody holds none or is unavailable. */
  myKey: string | null;
  /** The thread route's feed state, or null when no route is configured for it. */
  route: RouteFeedState | null;
  readIds?: ReadonlySet<string>;
  firstSeen?: (id: string) => number | undefined;
  /** The shared judged view of this replica; built from `profile` when omitted. */
  view?: ReplicaView;
}

const EMPTY: ReadonlySet<string> = new Set();

export function projectThreadTimeline(inputs: ThreadTimelineInputs): ThreadTimeline {
  const frames = inputs.profile?.frames ?? [];
  const view = inputs.view ?? viewReplica(inputs.replica, "Treehouse.Thread", frames);
  const readIds = inputs.readIds ?? EMPTY;
  const outbox = new Set(inputs.profile?.outbox ?? []);
  const acked = new Set(inputs.profile?.acked ?? []);
  const refused = new Set((inputs.route?.refused ?? []).map(([id]) => id));
  const archived = view.state.archived === true;

  const depthCache = new Map<string, number>();
  const byId = view.byId as Map<string, Op>;
  const depthOf = (id: string) => depth(id, byId, depthCache);

  // Placeholder positions: the same reducer over the honored "posts" effects, without the deletes.
  const postEffects = view.ops
    .filter((op) => !view.quarantine.has(op.id))
    .flatMap(effectViews)
    .filter((op) => op.field === "posts");
  const withRemoved = causalListEntries(postEffects.filter((op) => op.mutation !== "delete"), depthOf);
  const visible = new Map(view.posts.map((post) => [post.id, post]));

  const removedBy = new Map<string, Removed>();
  /** My honored author deletes per root post, so their delivery shows on the placeholder. */
  const myDeletes = new Map<string, string[]>();
  for (const op of honoredCommands(view, "author_tombstone")) {
    const root = String(op.commandArgs?.[0]);
    removedBy.set(root, "by_author");
    if (inputs.myKey !== null && authorOf(op) === inputs.myKey) myDeletes.set(root, [...(myDeletes.get(root) ?? []), op.id]);
  }
  for (const op of honoredCommands(view, "moderator_tombstone")) removedBy.set(String(op.commandArgs?.[0]), "by_moderator");

  // Winning edit per root post, chosen by the same LWW reducer the list uses for the text.
  const editsByRoot = new Map<string, Op[]>();
  for (const op of postEffects) {
    if (op.mutation !== "edit") continue;
    const target = (op.value as { target: string }).target;
    const edits = editsByRoot.get(target);
    const write = { ...op, mutation: "write" as const, value: (op.value as { value: unknown }).value };
    if (edits) edits.push(write);
    else editsByRoot.set(target, [write]);
  }

  const delivery = (id: string, mine: boolean): Delivery | null => {
    if (!mine) return null;
    if (outbox.has(id) && refused.has(id) && !acked.has(id)) return "relay_refused";
    // A post of mine not in this phone's outbox was pulled, so the relay held it.
    if (acked.has(id) || !outbox.has(id)) return "on_relay";
    if (inputs.route?.submitStopped === "unavailable" || inputs.route?.submitStopped === "read_only") return "stopped";
    return inputs.route?.connection === "live" ? "sending" : "saved";
  };
  // A message's delivery is the least delivered of my ops in its lineage (the root post, the winning edit,
  // my deletes): an edit or delete still on this phone, or refused, is not "on relay" because its post was.
  const RANK: Record<Delivery, number> = { on_relay: 0, sending: 1, saved: 2, stopped: 3, relay_refused: 4 };
  const lineageDelivery = (root: string, latest: string, mine: boolean): Delivery | null => {
    if (!mine) return null;
    let worst = delivery(root, true)!;
    for (const id of [latest, ...(myDeletes.get(root) ?? [])]) {
      if (id === root) continue;
      const next = delivery(id, true)!;
      if (RANK[next] > RANK[worst]) worst = next;
    }
    return worst;
  };
  const firstSeen = (id: string) => inputs.firstSeen?.(id) ?? null;

  const messages: MessageView[] = withRemoved.map((entry) => {
    const original = view.byId.get(entry.opId)!;
    const author = authorOf(original);
    const mine = inputs.myKey !== null && author === inputs.myKey;
    const shown = visible.get(entry.id);
    const removed = shown ? null : (removedBy.get(entry.id) ?? "by_author");
    const edits = editsByRoot.get(entry.id);
    const latest = (edits ? lww(edits, depthOf).winner : null) ?? entry.id;
    return {
      id: entry.id,
      ref: { root: entry.id, latest },
      author,
      text: removed ? "" : String(shown?.text ?? ""),
      edited: removed === null && latest !== entry.id,
      removed,
      mine,
      delivery: lineageDelivery(entry.id, latest, mine),
      standing: "honored",
      notCountedReason: null,
      firstSeenMs: firstSeen(entry.id),
      unread: !mine && removed === null && !readIds.has(entry.id),
      arrivedLate: false,
    };
  });

  // Late arrivals: unread and positioned above some message that has been read.
  let readBelow = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.unread && readBelow) message.arrivedLate = true;
    if (readIds.has(message.id)) readBelow = true;
  }

  // My own posts the judge does not count, in canonical order, after the counted timeline.
  if (inputs.myKey !== null) {
    for (const id of view.order) {
      const op = view.byId.get(id);
      const reason = view.quarantine.get(id);
      if (!op || reason === undefined || op.kind !== "command" || op.command !== "post" || authorOf(op) !== inputs.myKey) continue;
      messages.push({
        id,
        ref: { root: id, latest: id },
        author: inputs.myKey,
        text: String(op.commandArgs?.[0] ?? ""),
        edited: false,
        removed: null,
        mine: true,
        delivery: delivery(id, true),
        standing: "not_counted",
        notCountedReason: quarantineReason(reason),
        firstSeenMs: firstSeen(id),
        unread: false,
        arrivedLate: false,
      });
    }
  }

  let bytes = 0;
  for (const frame of frames) bytes += JSON.stringify(frame).length;

  return {
    replica: inputs.replica,
    title: String(view.state.title ?? ""),
    archived,
    messages,
    canPost: abilityOf(view, inputs.myKey, "post").allowed,
    unreadCount: messages.filter((m) => m.unread).length,
    health: { ops: frames.length, bytes },
  };
}
