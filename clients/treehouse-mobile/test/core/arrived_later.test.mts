import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1b.4 Arrived later and unread by id (03 "Order, time and unread", 04 Thread screen). The facts come from
// the ThreadTimeline read model; the reference for order is the judge over the same frames, never the
// session itself. The screen helpers in src/ui/thread_view.ts only hold what was true when the thread
// opened (the divider) or while it was open (arrived later), so writing the read marker does not erase them.

const profileOf = (frames: CarrierOpFrame[], outbox: string[] = [], acked: string[] = []) => ({ frames, outbox, acked });

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
  unreadCount: messages.filter((m) => m.unread).length,
  unmarked: messages.filter((m) => m.unread).map((m) => m.id),
  health: { ops: messages.length, bytes: 0 },
  ...over,
});
const nameOf = (pubkey: string) => (pubkey === "me" ? "You" : `Key check ${pubkey}`);
const utcDay = (ms: number) => ({ key: new Date(ms).toISOString().slice(0, 10), label: new Date(ms).toISOString().slice(0, 10) });

test("after a partition and heal, the other member's post sorts above my later posts, is arrived later and counted", async () => {
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt } = await import("../support/authoring");
  const { judgeTreehouseFrames } = await import("../support/vectors");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");

  const group = await buildGroup({ members: 2 });
  const [me, other] = group.members as [typeof group.members[0], typeof group.members[0]];
  const thread = group.thread.replica;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  for (const [replica, product, frames] of [
    [group.space.replica, "Treehouse.Space", group.space.frames],
    [thread, "Treehouse.Thread", group.thread.frames],
  ] as const) {
    await store.adopt(replica, product);
    await store.mergeSync(replica, frames, []);
  }
  const feed = createFakeFeed();
  feed.seed(group.space.replica, group.space.frames);
  // Before the partition the other member has posted once, and this phone shows it.
  const before = await postAt(other, group.thread.frames, "before the pause", heads(group.thread.frames));
  feed.seed(thread, [...group.thread.frames, before]);
  let link!: ReturnType<typeof feed.link>;
  const session = createTreehouseSession({
    local: await (await import("../../src/local/local_store")).openMemoryLocalStore(),
    custody: MemoryKeyCustody.holding(me.signer),
    store,
    clock: new ManualClock(2_000),
    link: (host) => (link = feed.link(host)),
  });
  await session.open();
  const timeline = () => session.read().timelines[thread]!;
  /** What the thread screen does while open: mark every shown id the timeline lists as unmarked. */
  const show = async () => {
    const ids = timeline().unmarked;
    if (ids.length > 0) assert.ok((await session.markRead(thread, ids)).ok);
  };
  try {
    await link.configure(loopbackRoutes([group.space.replica, thread], me.realm));
    await link.start();
    await link.syncNow();
    await show();
    assert.equal(timeline().unreadCount, 0);

    // Partition: this phone pauses and posts a chain of three while the other member posts at the old heads.
    await link.stop();
    const relayHeads = heads([...group.thread.frames, before]);
    const mine: string[] = [];
    for (const text of ["one", "two", "three"]) {
      const posted = await session.postMessage(thread, text);
      assert.ok(posted.ok);
      mine.push(posted.value.id);
      await show();
    }
    const late = await postAt(other, [...group.thread.frames, before], "while you were paused", relayHeads);
    feed.seed(thread, [late]);

    // Heal.
    await link.start();
    await link.syncNow();

    // Reference: the judge's order over the frames this phone now holds.
    const held = store.profile(thread)!.frames;
    const order = judgeTreehouseFrames(thread, held).order;
    const lateAt = order.indexOf(late.id);
    assert.ok(lateAt >= 0, "the late post is counted by the judge");
    assert.ok(order.indexOf(mine[2]!) > lateAt && order.indexOf(mine[1]!) > lateAt, "the judge sorts it above my later posts");
    assert.deepEqual(timeline().messages.filter((m) => m.removed === null).map((m) => m.id), order, "the timeline is the judge's order");

    const view = timeline().messages.find((m) => m.id === late.id)!;
    assert.equal(view.unread, true);
    assert.equal(view.arrivedLate, true, "it sorts above messages this phone has shown");
    assert.equal(timeline().unreadCount, 1);
    const row = session.read().threads.threads.find((t) => t.replica === thread)!;
    assert.equal(row.unreadCount, 1, "the Threads tab counts it");
    for (const id of mine) assert.equal(timeline().messages.find((m) => m.id === id)!.arrivedLate, false);
  } finally {
    await session.close();
  }
});

test("my own posts held with an empty read marker mark nothing arrived later", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt } = await import("../support/authoring");

  // A reinstall, a re-sync into a fresh store or a demo role switch: history is held, nothing is marked.
  const group = await buildGroup({ members: 2 });
  const [me, other] = group.members as [typeof group.members[0], typeof group.members[0]];
  let frames = [...group.thread.frames];
  for (const [who, text] of [[other, "a"], [me, "b"], [other, "c"], [me, "d"]] as const) {
    frames = [...frames, await postAt(who, frames, text, heads(frames))];
  }
  const timeline = projectThreadTimeline({ replica: group.thread.replica, profile: profileOf(frames), myKey: me.pubkey, route: null });
  assert.equal(timeline.messages.filter((m) => m.arrivedLate).length, 0);
  assert.equal(timeline.unreadCount, 2);
});

test("the timeline lists the shown ids not yet in the read marker, my own included", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt } = await import("../support/authoring");

  const group = await buildGroup({ members: 2 });
  const [me, other] = group.members as [typeof group.members[0], typeof group.members[0]];
  let frames = [...group.thread.frames];
  const ids: string[] = [];
  for (const [who, text] of [[other, "a"], [me, "b"], [other, "c"]] as const) {
    const frame = await postAt(who, frames, text, heads(frames));
    frames = [...frames, frame];
    ids.push(frame.id);
  }
  const project = (read: string[]) =>
    projectThreadTimeline({ replica: group.thread.replica, profile: profileOf(frames), myKey: me.pubkey, route: null, readIds: new Set(read) });
  assert.deepEqual(project([]).unmarked, ids, "unread ones and mine, in timeline order");
  assert.deepEqual(project([ids[0]!]).unmarked, [ids[1]!, ids[2]!]);
  assert.deepEqual(project(ids).unmarked, []);
});

test("the unread divider and arrived-later marks are held from open, after the read marker clears them", async () => {
  const { createOpenMarks } = await import("../../src/ui/thread_view");
  const marks = createOpenMarks();
  assert.equal(marks.take(null).divider, null, "nothing is taken before the timeline exists");

  const opened = timelineOf([
    msg({ id: "a" }),
    msg({ id: "b", unread: true, arrivedLate: true }),
    msg({ id: "c", author: "me", mine: true }),
    msg({ id: "d", unread: true }),
  ]);
  const first = marks.take(opened);
  assert.deepEqual(first.divider, { before: "b", count: 2 }, "above the first unread id, with the count on open");
  assert.deepEqual([...first.arrivedLate], ["b"]);

  // The screen writes the read marker: the next timeline has nothing unread and nothing arrived later.
  const marked = timelineOf(opened.messages.map((m) => ({ ...m, unread: false, arrivedLate: false })));
  const after = marks.take(marked);
  assert.deepEqual(after.divider, { before: "b", count: 2 }, "the divider stays where it was on open");
  assert.deepEqual([...after.arrivedLate], ["b"], "the caption stays while the screen is open");
  assert.equal(marks.take(marked), after, "unchanged marks keep their identity, so the list is not rebuilt");

  // A post that arrives late while the screen is open is captioned too; the divider does not move.
  const grown = timelineOf([...marked.messages.slice(0, 1), msg({ id: "e", unread: true, arrivedLate: true }), ...marked.messages.slice(1)]);
  const later = marks.take(grown);
  assert.deepEqual(later.divider, { before: "b", count: 2 });
  assert.deepEqual([...later.arrivedLate].sort(), ["b", "e"]);

  // Another thread starts over.
  const elsewhere = marks.take(timelineOf([msg({ id: "x" })], { replica: "replica:treehouse:thread:b" }));
  assert.equal(elsewhere.divider, null);
  assert.equal(elsewhere.arrivedLate.size, 0);

  // Opening with nothing unread shows no divider, even when posts arrive afterwards.
  const quiet = createOpenMarks();
  quiet.take(timelineOf([msg({ id: "a" })]));
  assert.equal(quiet.take(timelineOf([msg({ id: "a" }), msg({ id: "b", unread: true })])).divider, null);
});

test("the timeline puts the unread divider above the first unread id and the held caption on the bubble", async () => {
  const { timelineItems } = await import("../../src/ui/thread_view");
  const { message, thread } = await import("../../src/ui/strings");
  const timeline = timelineOf([
    msg({ id: "a", author: "k1" }),
    msg({ id: "b", author: "k1", firstSeenMs: Date.UTC(2026, 10, 25) }),
    msg({ id: "c", author: "me", mine: true, delivery: "on_relay" }),
  ]);
  const items = timelineItems(timeline, nameOf, utcDay, { divider: { before: "b", count: 1 }, arrivedLate: new Set(["b"]) });
  assert.deepEqual(
    items.map((i) => i.kind),
    ["message", "day", "unread", "message", "message"],
    "the divider sits after the day separator, right above the message",
  );
  const divider = items[2] as Extract<(typeof items)[number], { kind: "unread" }>;
  assert.equal(divider.label, thread.unreadDivider(1));
  assert.ok(divider.accessibilityLabel.length > 0);
  const b = items[3] as Extract<(typeof items)[number], { kind: "message" }>;
  assert.equal(b.showAuthor, true, "the divider ends an author run");
  assert.equal(b.arrivedLate, true, "the held mark, though the timeline no longer says so");
  assert.ok(b.accessibilityLabel.includes(message.arrivedLate), "the screen reader hears it");
  const c = items[4] as Extract<(typeof items)[number], { kind: "message" }>;
  assert.equal(c.arrivedLate, false);

  // A divider whose message is gone (removed while open) is simply not drawn.
  const gone = timelineItems(timeline, nameOf, utcDay, { divider: { before: "zz", count: 1 }, arrivedLate: new Set() });
  assert.ok(!gone.some((i) => i.kind === "unread"));
});

test("the divider and caption copy pass the word scan and say their state in words", async () => {
  const { message, thread } = await import("../../src/ui/strings");
  assert.equal(thread.unreadDivider(3), "3 unread");
  assert.match(thread.unreadDividerLabel(3), /3 unread/);
  assert.equal(message.arrivedLate, "Arrived later");
});
