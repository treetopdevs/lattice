import type { Delivery, MessageView, ThreadTimeline } from "../session/projections/thread_timeline";
import { deliveryLabel, message as messageCopy, removedPlaceholder, thread as threadCopy } from "./strings";

// Presentation helpers for the Thread screen (M1b.2). Pure: no react, react-native or expo, so Core tests run
// them. Order, standing, delivery and first-seen time come from the ThreadTimeline read model; these helpers
// only group, separate and put those facts into words.

export type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string; label: string; accessibilityLabel: string }
  | {
      kind: "message";
      key: string;
      message: MessageView;
      /** Arrived later, as the timeline says now or as it said while the screen was open (M1b.4). */
      arrivedLate: boolean;
      /** First of a run of consecutive messages by one author (a day separator ends a run). */
      showAuthor: boolean;
      authorName: string;
      /** Everything the bubble shows, in words, for the screen reader. */
      accessibilityLabel: string;
    };

/** A day bucket for a first-seen time: a stable key and the separator's words. */
export type DayOf = (ms: number) => { key: string; label: string };

/**
 * The timeline in canonical order with day separators and author runs. Day rule (04 "Day separators use
 * first-seen time where it exists"): walking canonical order, a separator goes before a message whose
 * first-seen day differs from the current one; a message with no first-seen time stays in the current day.
 * First-seen time is device-local and not monotonic in canonical order, so a day can appear twice.
 */
export function timelineItems(
  timeline: ThreadTimeline | null,
  nameOf: (pubkey: string) => string,
  dayOf: DayOf,
  marks: OpenMarks = NO_MARKS,
): TimelineItem[] {
  if (!timeline) return [];
  const divider = marks.divider;
  const items: TimelineItem[] = [];
  let day: string | null = null;
  let previousAuthor: string | null = null;
  for (const m of timeline.messages) {
    if (m.firstSeenMs !== null) {
      const bucket = dayOf(m.firstSeenMs);
      if (bucket.key !== day) {
        day = bucket.key;
        items.push({ kind: "day", key: `day:${bucket.key}:${m.id}`, label: bucket.label });
        previousAuthor = null;
      }
    }
    // M1b.4: the unread divider goes right above the first unread id on open (after its day separator), and
    // ends an author run. If that message is gone (removed while open), no divider is drawn.
    if (divider && m.id === divider.before) {
      items.push({
        kind: "unread",
        key: `unread:${m.id}`,
        label: threadCopy.unreadDivider(divider.count),
        accessibilityLabel: threadCopy.unreadDividerLabel(divider.count),
      });
      previousAuthor = null;
    }
    const authorName = nameOf(m.author);
    const arrivedLate = m.arrivedLate || marks.arrivedLate.has(m.id);
    items.push({
      kind: "message",
      key: m.id,
      message: m,
      arrivedLate,
      showAuthor: m.author !== previousAuthor,
      authorName,
      accessibilityLabel: bubbleLabel(m, authorName, arrivedLate),
    });
    previousAuthor = m.author;
  }
  return items;
}

/** The words a bubble shows: its text or placeholder, then each state. */
export function bubbleLabel(m: MessageView, authorName: string, arrivedLate: boolean = m.arrivedLate): string {
  return [
    authorName,
    m.removed ? removedPlaceholder[m.removed] : m.text,
    m.edited ? messageCopy.edited : null,
    arrivedLate ? messageCopy.arrivedLate : null,
    m.standing === "not_counted" ? messageCopy.notCounted : null,
    m.delivery ? deliveryLabel[m.delivery] : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(". ");
}

/** Where the unread divider sits: above `before`, the first unread id when the thread opened. */
export interface UnreadDivider {
  before: string;
  /** The unread count when the thread opened. */
  count: number;
}

/** What the thread screen holds while it is open (M1b.4). */
export interface OpenMarks {
  divider: UnreadDivider | null;
  /** Every id the timeline called arrived later while the screen was open. */
  arrivedLate: ReadonlySet<string>;
}

const NO_MARKS: OpenMarks = { divider: null, arrivedLate: new Set() };

/**
 * Holds the unread divider and the arrived-later ids for one open thread screen. The screen writes the read
 * marker as soon as it shows a timeline, and the next timeline then has nothing unread and nothing arrived
 * later (03: arrived later is "unread and sorted above a shown message"). So the divider is taken from the
 * first timeline seen, before that write, and stays put; the arrived-later ids only grow while the screen is
 * open, so a post that arrives late while it is open is captioned too. A different replica starts over.
 * `take` returns the same object while nothing changed, so a memoized list is not rebuilt.
 */
export function createOpenMarks(): { take(timeline: ThreadTimeline | null): OpenMarks } {
  let replica: string | null = null;
  let current: OpenMarks = NO_MARKS;
  return {
    take(timeline) {
      if (!timeline) return current;
      if (timeline.replica !== replica) {
        replica = timeline.replica;
        const first = timeline.messages.find((m) => m.unread);
        current = {
          divider: first ? { before: first.id, count: timeline.unreadCount } : null,
          arrivedLate: new Set(timeline.messages.filter((m) => m.arrivedLate).map((m) => m.id)),
        };
        return current;
      }
      const added = timeline.messages.filter((m) => m.arrivedLate && !current.arrivedLate.has(m.id));
      if (added.length > 0) current = { divider: current.divider, arrivedLate: new Set([...current.arrivedLate, ...added.map((m) => m.id)]) };
      return current;
    },
  };
}

export type MarkTone = "muted" | "warn" | "error";

/**
 * My message's delivery mark (04): clock for saved or sending, one check for on relay, warning for relay did
 * not accept. `stopped` (the relay takes no messages now) is a warning too, in the warn tone. There is no
 * second check: nothing says another person has a message.
 */
export const deliveryMark: Record<Delivery, { glyph: string; label: string; tone: MarkTone }> = {
  saved: { glyph: "◷", label: deliveryLabel.saved, tone: "muted" },
  sending: { glyph: "◷", label: deliveryLabel.sending, tone: "muted" },
  on_relay: { glyph: "✓", label: deliveryLabel.on_relay, tone: "muted" },
  relay_refused: { glyph: "⚠", label: deliveryLabel.relay_refused, tone: "error" },
  stopped: { glyph: "⚠", label: deliveryLabel.stopped, tone: "warn" },
};

/** 04: Send is enabled when the text is non-empty and `post` is allowed (and no post is running). */
export function canSend(text: string, canPost: boolean, busy: boolean): boolean {
  return canPost && !busy && text.trim() !== "";
}

/** Local days: "Today", "Yesterday", else a short date in the phone's locale. */
export function localDay(nowMs: number): DayOf {
  const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const now = new Date(nowMs);
  const today = keyOf(now);
  const yesterday = keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return (ms) => {
    const d = new Date(ms);
    const key = keyOf(d);
    const label =
      key === today
        ? threadCopy.today
        : key === yesterday
          ? threadCopy.yesterday
          : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return { key, label };
  };
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DraftSaver {
  /** The stored draft to show, once: null when already seeded, when text was typed first, or nothing is stored. */
  seed(stored: string | null): string | null;
  /** The composer text changed; saves after a pause. */
  change(text: string): void;
  /** Save a pending change now (leaving the screen or the app). */
  flush(): Promise<void>;
  /** A post went out: drop any pending save and clear the stored draft. */
  clear(): Promise<void>;
  /** Drop a pending save without writing. */
  cancel(): void;
}

/**
 * Saves the composer's draft on every pause (04). Keystrokes stay in the component; only the text after a
 * pause of `delayMs` is written, and an unchanged text is not written twice. Empty text clears the draft.
 */
/** `save` resolves false (or throws) when the write did not happen. */
export function createDraftSaver(opts: { save(text: string | null): Promise<unknown>; delayMs: number; timers: Timers }): DraftSaver {
  let seeded = false;
  let lastSaved: string | null | undefined;
  let pending: { handle: unknown; text: string | null } | null = null;
  // The latest text not yet confirmed saved, kept until a write of it resolves ok, so a save that fails after
  // its pause (storage_failed, not_open) is retried by the next flush even with no further keystroke.
  let unconfirmed: { text: string | null } | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const write = (text: string | null): Promise<void> => {
    if (text === lastSaved) return inflight;
    lastSaved = text;
    // A save that reports `false` or throws is forgotten, so the next change or flush writes it again.
    const forget = () => {
      if (lastSaved === text) lastSaved = undefined;
    };
    const done = opts.save(text).then(
      (ok) => {
        if (ok === false) forget();
        else if (unconfirmed && unconfirmed.text === text) unconfirmed = null;
      },
      forget,
    );
    inflight = done;
    return done;
  };
  const drop = () => {
    if (pending) opts.timers.clear(pending.handle);
    pending = null;
  };

  return {
    seed(stored) {
      if (seeded || stored === null) return null;
      seeded = true;
      lastSaved = stored;
      return stored;
    },
    change(text) {
      seeded = true;
      drop();
      const value = text === "" ? null : text;
      unconfirmed = { text: value };
      const handle = opts.timers.set(() => {
        pending = null;
        void write(value);
      }, opts.delayMs);
      pending = { handle, text: value };
    },
    async flush() {
      if (pending) {
        const { text } = pending;
        drop();
        await write(text);
        return;
      }
      // A pause-save may still be running or may have failed: wait for it, then retry what is unconfirmed.
      await inflight;
      if (unconfirmed) await write(unconfirmed.text);
    },
    clear() {
      drop();
      unconfirmed = { text: null };
      return write(null);
    },
    cancel: drop,
  };
}
