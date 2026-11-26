import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1b.2 Thread screen (04 "Thread screen"). Order, standing, delivery and first-seen come from the
// ThreadTimeline read model; the draft comes from the new `drafts` read model over LocalStore. The helpers in
// src/ui/thread_view.ts only group, separate and put those facts into words, so every mark has a text label.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Message = import("../../src/session/projections/thread_timeline").MessageView;
type Timeline = import("../../src/session/projections/thread_timeline").ThreadTimeline;
const msg = (over: Partial<Message>): Message => ({
  id: "m",
  ref: { root: "m", latest: "m" },
  author: "k1",
  text: "hello",
  edited: false,
  removed: null,
  mine: false,
  delivery: null,
  standing: "honored",
  notCountedReason: null,
  firstSeenMs: null,
  unread: false,
  arrivedLate: false,
  ...over,
});
const timelineOf = (messages: Message[], over: Partial<Timeline> = {}): Timeline => ({
  replica: "replica:treehouse:thread:a",
  title: "General",
  archived: false,
  messages,
  canPost: true,
  unreadCount: 0,
  unmarked: [],
  health: { ops: messages.length, bytes: 0 },
  ...over,
});
const nameOf = (pubkey: string) => (pubkey === "me" ? "You" : `Key check ${pubkey}`);
const DAY = 86_400_000;
/** UTC days, so the test does not depend on the machine's timezone. */
const utcDay = (ms: number) => ({ key: String(Math.floor(ms / DAY)), label: `day ${Math.floor(ms / DAY)}` });

test("the drafts read model follows saveDraft, leaves the timeline identical and survives a reopen", async () => {
  const { openMemoryLocalStore, MemoryLocalDisk } = await import("../../src/local/local_store");
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const disk = new MemoryLocalDisk();
  const thread = group.thread.replica;
  const phone = await openPhone({ group, as: (g) => g.members[0]!, local: await openMemoryLocalStore(disk) });
  try {
    assert.deepEqual(phone.session.read().drafts, {});
    const before = phone.session.read().timelines[thread];
    assert.deepEqual(await phone.session.saveDraft(thread, { text: "half a thought" }), { ok: true, value: null });
    assert.deepEqual(phone.session.read().drafts[thread], { text: "half a thought" });
    assert.equal(phone.session.read().timelines[thread], before, "a draft change does not rebuild the timeline");
  } finally {
    await phone.close();
  }
  const again = await openPhone({ group, as: (g) => g.members[0]!, local: await openMemoryLocalStore(disk) });
  try {
    assert.deepEqual(again.session.read().drafts[thread], { text: "half a thought" }, "the draft survives a relaunch");
    await again.session.saveDraft(thread, null);
    assert.equal(again.session.read().drafts[thread], undefined);
  } finally {
    await again.close();
  }
});

test("timeline items keep canonical order, group one author's run and separate days by first-seen time", async () => {
  const { timelineItems } = await import("../../src/ui/thread_view");
  const items = timelineItems(
    timelineOf([
      msg({ id: "a", author: "k1", firstSeenMs: 1 * DAY + 5 }),
      msg({ id: "b", author: "k1", firstSeenMs: null }),
      msg({ id: "c", author: "me", mine: true, delivery: "on_relay", firstSeenMs: 1 * DAY + 9 }),
      msg({ id: "d", author: "me", mine: true, delivery: "saved", firstSeenMs: 2 * DAY }),
      msg({ id: "e", author: "me", mine: true, delivery: "saved", firstSeenMs: 2 * DAY + 1 }),
    ]),
    nameOf,
    utcDay,
  );
  assert.deepEqual(
    items.map((i) => (i.kind !== "message" ? `${i.kind}:${i.label}` : `${i.message.id}:${i.showAuthor ? i.authorName : "-"}`)),
    ["day:day 1", "a:Key check k1", "b:-", "c:You", "day:day 2", "d:You", "e:-"],
    "a null first-seen joins the current day; a new day restarts the author's run",
  );
  assert.deepEqual(timelineItems(null, nameOf, utcDay), []);
  const undated = timelineItems(timelineOf([msg({ id: "x" })]), nameOf, utcDay);
  assert.deepEqual(undated.map((i) => i.kind), ["message"], "no first-seen time, no separator");
});

test("every delivery mark has a glyph and words, and there is no second check", async () => {
  const { deliveryMark } = await import("../../src/ui/thread_view");
  const { deliveryLabel } = await import("../../src/ui/strings");
  for (const delivery of ["saved", "sending", "on_relay", "relay_refused", "stopped"] as const) {
    const mark = deliveryMark[delivery];
    assert.equal(mark.label, deliveryLabel[delivery]);
    assert.ok(mark.glyph.length > 0);
    assert.doesNotMatch(mark.glyph, /[✓✔].*[✓✔]/u, "no double check");
  }
  assert.equal(deliveryMark.saved.glyph, deliveryMark.sending.glyph, "clock for saved or sending");
  assert.equal(deliveryMark.on_relay.glyph, "✓");
  assert.equal(deliveryMark.relay_refused.tone, "error");
  assert.equal(deliveryMark.on_relay.tone, "muted");
});

test("a bubble's screen-reader label says author, text and every state in words", async () => {
  const { timelineItems } = await import("../../src/ui/thread_view");
  const { deliveryLabel, message, removedPlaceholder } = await import("../../src/ui/strings");
  const [mine, removed, late] = timelineItems(
    timelineOf([
      msg({ id: "a", author: "me", mine: true, delivery: "saved", edited: true, text: "hi" }),
      msg({ id: "b", author: "k1", removed: "by_moderator", text: "" }),
      msg({ id: "c", author: "k1", arrivedLate: true, unread: true, text: "later" }),
    ]),
    nameOf,
    utcDay,
  ) as Extract<import("../../src/ui/thread_view").TimelineItem, { kind: "message" }>[];
  for (const part of ["You", "hi", message.edited, deliveryLabel.saved]) assert.ok(mine!.accessibilityLabel.includes(part), part);
  assert.ok(removed!.accessibilityLabel.includes(removedPlaceholder.by_moderator));
  assert.ok(late!.accessibilityLabel.includes(message.arrivedLate));
  assert.ok(!removed!.accessibilityLabel.includes(deliveryLabel.on_relay), "other people's messages carry no delivery mark");
});

test("send is enabled only with text and only where post is allowed", async () => {
  const { canSend } = await import("../../src/ui/thread_view");
  assert.equal(canSend("hi", true, false), true);
  assert.equal(canSend("   \n", true, false), false);
  assert.equal(canSend("hi", false, false), false);
  assert.equal(canSend("hi", true, true), false, "not while a post is running");
});

test("the draft saver saves on a pause, flushes on leave, and a post clears it for good", async () => {
  const { createDraftSaver } = await import("../../src/ui/thread_view");
  const saved: (string | null)[] = [];
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers = {
    set: (fn: () => void) => {
      pending.set(++next, fn);
      return next;
    },
    clear: (handle: unknown) => void pending.delete(handle as number),
  };
  const fire = () => {
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  };
  const saver = createDraftSaver({ save: async (text) => void saved.push(text), delayMs: 400, timers });

  assert.equal(saver.seed(null), null, "nothing stored yet (session still opening)");
  assert.equal(saver.seed("from last time"), "from last time", "seeded once the stored draft arrives");
  assert.equal(saver.seed("from last time"), null, "never seeded twice");

  saver.change("a");
  saver.change("ab");
  saver.change("abc");
  assert.deepEqual(saved, [], "nothing saved while typing");
  fire();
  assert.deepEqual(saved, ["abc"], "one save on the pause");

  saver.change("abcd");
  await saver.flush();
  assert.deepEqual(saved, ["abc", "abcd"], "leaving the screen saves at once");
  fire();
  assert.deepEqual(saved, ["abc", "abcd"], "the flushed save is not repeated");

  saver.change("posted text");
  await saver.clear();
  fire();
  assert.deepEqual(saved, ["abc", "abcd", null], "a post clears the draft and the pending save never lands");

  saver.change("");
  fire();
  assert.deepEqual(saved, ["abc", "abcd", null], "an empty composer after a clear saves nothing new");

  // A failed write (storage_failed) is not remembered as saved: the same text is written again.
  const attempts: (string | null)[] = [];
  let fail = true;
  const flaky = createDraftSaver({ save: async (text) => (attempts.push(text), !fail), delayMs: 400, timers });
  flaky.change("keep me");
  await flaky.flush();
  fail = false;
  flaky.change("keep me");
  await flaky.flush();
  assert.deepEqual(attempts, ["keep me", "keep me"], "a failed save is retried");

  // A pause-save that fails is retried by the next flush (leaving the screen) with no further keystroke.
  const paused: (string | null)[] = [];
  let failPaused = true;
  const afterPause = createDraftSaver({ save: async (text) => (paused.push(text), !failPaused), delayMs: 400, timers });
  afterPause.change("left behind");
  fire();
  await afterPause.flush();
  failPaused = false;
  await afterPause.flush();
  assert.deepEqual(paused, ["left behind", "left behind", "left behind"], "each flush retries the failed pause-save");
  await afterPause.flush();
  assert.equal(paused.length, 3, "once saved, a flush writes nothing more");

  // A flush while the pause-save is still running waits for it and retries if it failed.
  let release: (ok: boolean) => void = () => undefined;
  const slow: (string | null)[] = [];
  const inFlight = createDraftSaver({
    save: (text) => (slow.push(text), slow.length === 1 ? new Promise<boolean>((r) => (release = r)) : Promise.resolve(true)),
    delayMs: 400,
    timers,
  });
  inFlight.change("slow");
  fire();
  const leaving = inFlight.flush();
  release(false);
  await leaving;
  assert.deepEqual(slow, ["slow", "slow"], "the unmount flush retried the pause-save that failed while in flight");

  const typed = createDraftSaver({ save: async () => undefined, delayMs: 400, timers });
  typed.change("typed first");
  assert.equal(typed.seed("stored"), null, "a stored draft never overwrites typed text");
});

test("identity_mismatch says why, by reason, and never offers a reset", async () => {
  const { identityMismatchCopy, phaseCopy } = await import("../../src/ui/strings");
  const { IDENTITY_MISMATCH_REASONS } = await import("../../src/session/projections/session_status");
  const { problemTitle } = await import("../../src/ui/problem_copy");
  assert.deepEqual([...IDENTITY_MISMATCH_REASONS].sort(), ["key_missing", "key_unavailable", "outbox_other_key"]);
  const lines = new Set<string>();
  for (const reason of IDENTITY_MISMATCH_REASONS) {
    const line = problemTitle({ phase: "identity_mismatch", reason, replica: null });
    assert.equal(line, identityMismatchCopy[reason]);
    assert.doesNotMatch(line, /reset/i);
    lines.add(line);
  }
  assert.equal(lines.size, 3, "each reason has its own line");
  assert.equal(problemTitle({ phase: "identity_mismatch", reason: "outbox_other_key", replica: null }), phaseCopy.identity_mismatch);
  assert.equal(problemTitle({ phase: "identity_mismatch", reason: "something_new", replica: null }), phaseCopy.identity_mismatch);
  assert.equal(problemTitle({ phase: "history_invalid", reason: "x", replica: null }), phaseCopy.history_invalid);

  const banner = readFileSync(join(ROOT, "src/ui/SessionBanner.tsx"), "utf8");
  assert.match(banner, /problemTitle\(/, "the problem card uses the reason-aware line");
});

test("the thread screen is a virtualized MessageList of Bubbles with a Composer offset by the header", () => {
  const screen = readFileSync(join(ROOT, "src/app/thread/[replica].tsx"), "utf8");
  assert.match(screen, /<MessageList/);
  assert.match(screen, /<Composer/);
  assert.doesNotMatch(screen, /keyboardVerticalOffset=\{\d+\}/, "no fixed keyboard offset");
  assert.match(screen, /useHeaderHeight\(\)/);
  // Review fix: a new replica (or a remount) gets a fresh Composer and draft saver, never the last thread's.
  assert.match(screen, /<Composer\s+key=\{replica\}/);
  const list = readFileSync(join(ROOT, "src/ui/MessageList.tsx"), "utf8");
  assert.match(list, /<FlatList/);
  assert.match(list, /<Bubble/);
  assert.match(list, /timelineItems\(/);
  const bubble = readFileSync(join(ROOT, "src/ui/Bubble.tsx"), "utf8");
  assert.match(bubble, /<DeliveryMark/);
  assert.match(bubble, /accessibilityLabel=/);
  const composer = readFileSync(join(ROOT, "src/ui/Composer.tsx"), "utf8");
  assert.match(composer, /createDraftSaver\(/);
  assert.match(composer, /canSend\(/);
});
