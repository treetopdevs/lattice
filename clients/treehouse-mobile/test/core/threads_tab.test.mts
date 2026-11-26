import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1b.1 Threads tab (04 "Threads tab"). The facts come from the ThreadList and LinkStatus read models; the
// row and pill helpers in src/ui only turn them into words, so every state mark has a text label.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Item = import("../../src/session/projections/thread_list").ThreadListItem;
const item = (over: Partial<Item>): Item => ({
  replica: "replica:treehouse:thread:a",
  title: "General",
  held: true,
  archived: false,
  last: null,
  unreadCount: 0,
  waitingCount: 0,
  connection: "live",
  routeNotConnected: false,
  ...over,
});

const nameOf = (pubkey: string, petname?: string | null) => petname || (pubkey === "me" ? "You" : `Key check ${pubkey}`);

test("archived threads sit in their own section after the active ones, in list order", async () => {
  const { threadSections } = await import("../../src/ui/thread_rows");
  const list = {
    threads: [
      item({ replica: "a", archived: true }),
      item({ replica: "b" }),
      item({ replica: "c", archived: true }),
      item({ replica: "d" }),
    ],
  };
  const sections = threadSections(list);
  assert.deepEqual(sections.active.map((t) => t.replica), ["b", "d"]);
  assert.deepEqual(sections.archived.map((t) => t.replica), ["a", "c"]);
  assert.deepEqual(threadSections(null), { active: [], archived: [] });
});

test("a row names the last author and says unread, waiting and not connected in words", async () => {
  const { threadRowView } = await import("../../src/ui/thread_rows");
  const { threadsTab, removedPlaceholder, thread } = await import("../../src/ui/strings");

  const plain = threadRowView(item({}), nameOf);
  assert.equal(plain.preview, thread.empty);
  assert.equal(plain.unreadLabel, null);
  assert.equal(plain.waitingLabel, null);
  assert.equal(plain.routeMark, null);

  const busy = threadRowView(
    item({ last: { text: "hello", author: "k1", authorPetname: "Ada", removed: null }, unreadCount: 2, waitingCount: 1, routeNotConnected: true }),
    nameOf,
  );
  assert.equal(busy.preview, threadsTab.preview("Ada", "hello"));
  assert.equal(busy.unreadLabel, threadsTab.unread(2));
  assert.equal(busy.waitingLabel, threadsTab.waiting(1));
  assert.equal(busy.routeMark, threadsTab.routeNotConnected);
  for (const part of [thread.empty === busy.preview ? "" : busy.preview, threadsTab.unread(2), threadsTab.waiting(1), threadsTab.routeNotConnected])
    assert.ok(busy.accessibilityLabel.includes(part), `the screen reader hears "${part}"`);
  assert.ok(busy.accessibilityLabel.startsWith("General"));

  const mine = threadRowView(item({ last: { text: "hi", author: "me", authorPetname: null, removed: null } }), nameOf);
  assert.equal(mine.preview, threadsTab.preview("You", "hi"));

  const unnamed = threadRowView(item({ last: { text: "hi", author: "k2", authorPetname: null, removed: null } }), nameOf);
  assert.equal(unnamed.preview, threadsTab.preview("Key check k2", "hi"));

  const removed = threadRowView(item({ last: { text: "", author: "k1", authorPetname: null, removed: "by_moderator" } }), nameOf);
  assert.equal(removed.preview, removedPlaceholder.by_moderator);

  const unheld = threadRowView(item({ held: false, connection: null }), nameOf);
  assert.equal(unheld.preview, thread.notHeld);

  const archived = threadRowView(item({ archived: true }), nameOf);
  assert.ok(archived.accessibilityLabel.includes(threadsTab.archivedMark));
});

test("the link pill has a text label, a tone and a hint for every state", async () => {
  const { linkPillView } = await import("../../src/ui/thread_rows");
  const { linkPillLabel, threadsTab, waitingSuffix } = await import("../../src/ui/strings");
  const status = (pill: import("../../src/session/projections/link_status").LinkPill, waiting = 0) => ({ pill, routes: [], waiting, lastSyncMs: null, syncEnabled: pill !== "offline" });

  assert.deepEqual(linkPillView(null), { label: linkPillLabel.connecting, tone: "muted", accessibilityLabel: threadsTab.pillLabel(linkPillLabel.connecting) });
  const live = linkPillView(status("live"));
  assert.equal(live.tone, "live");
  assert.equal(live.label, linkPillLabel.live);
  const waiting = linkPillView(status("offline", 2));
  assert.equal(waiting.tone, "muted");
  assert.equal(waiting.label, `${linkPillLabel.offline} ${waitingSuffix(2)}`);
  assert.equal(waiting.accessibilityLabel, threadsTab.pillLabel(waiting.label));
  assert.equal(linkPillView(status("relay_refused")).tone, "error");
  assert.equal(linkPillView(status("reconnecting")).tone, "warn");
  assert.equal(linkPillView(status("partly_connected")).tone, "warn");
});

test("a thread route that is down while the link is up gets a quiet mark", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { projectThreadList } = await import("../../src/session/projections/thread_list");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const profile = { frames: group.thread.frames, outbox: [], acked: [] };
  const timeline = projectThreadTimeline({ replica: group.thread.replica, profile, myKey: group.admin.pubkey, route: null });
  const base = { replica: "", connection: "live" as "live" | "reconnecting" | "idle", pending: 0, acked: 0, generation: null, matchesRelay: null, refused: [], submitStopped: null, message: "" };
  const space = viewReplica(group.space.replica, "Treehouse.Space", group.space.frames);
  const listWith = (routes: (typeof base)[]) =>
    projectThreadList({ space, timelines: { [group.thread.replica]: timeline }, profiles: { [group.thread.replica]: profile }, feed: { configured: true, routes } }).threads[0]!;

  const spaceLive = { ...base, replica: group.space.replica };
  assert.equal(listWith([spaceLive, { ...base, replica: group.thread.replica }]).routeNotConnected, false, "both live");
  assert.equal(listWith([spaceLive, { ...base, replica: group.thread.replica, connection: "reconnecting" }]).routeNotConnected, true, "space live, thread down");
  assert.equal(listWith([spaceLive]).routeNotConnected, true, "no route for the thread while the link is up");
  assert.equal(
    listWith([{ ...spaceLive, connection: "idle" }, { ...base, replica: group.thread.replica, connection: "idle" }]).routeNotConnected,
    false,
    "everything idle: the pill says offline, no row is singled out",
  );
});

test("the last message carries the author's petname from this phone", async () => {
  const { openMemoryLocalStore, MemoryLocalDisk } = await import("../../src/local/local_store");
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const theirs = await group.admin.post(group.thread.frames, "welcome");
  const phone = await openPhone({ group, as: (g) => g.members[0]!, local: await openMemoryLocalStore(new MemoryLocalDisk()) });
  try {
    await phone.deliver(group.thread.replica, [theirs]);
    const row = () => phone.session.read().threads.threads.find((t) => t.replica === group.thread.replica)!;
    assert.equal(row().last?.authorPetname, null);
    await phone.session.setPetname(group.admin.pubkey, "Ada");
    assert.equal(row().last?.authorPetname, "Ada");
    assert.equal(row().last?.author, group.admin.pubkey);
  } finally {
    await phone.close();
  }
});

test("opening a thread marks what it shows, so the row's unread count clears", async () => {
  const { openMemoryLocalStore, MemoryLocalDisk } = await import("../../src/local/local_store");
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const phone = await openPhone({ group, as: (g) => g.members[0]!, local: await openMemoryLocalStore(new MemoryLocalDisk()) });
  try {
    const thread = group.thread.replica;
    const row = () => phone.session.read().threads.threads.find((t) => t.replica === thread)!;
    assert.equal(row().unreadCount, 0);
    const one = await group.admin.post(group.thread.frames, "one");
    const two = await group.admin.post([...group.thread.frames, one], "two");
    await phone.deliver(thread, [one, two]);
    assert.equal(row().unreadCount, 2, "a post from the other participant raises the count");

    // M1b.4: the screen marks the timeline's `unmarked` ids (the unread ones plus my own).
    const timeline = phone.session.read().timelines[thread]!;
    assert.deepEqual([...timeline.unmarked].sort(), [one.id, two.id].sort());
    assert.deepEqual(await phone.session.markRead(thread, timeline.unmarked), { ok: true, value: null });
    assert.equal(row().unreadCount, 0, "opening clears it");
    assert.deepEqual(phone.session.read().timelines[thread]!.unmarked, []);
  } finally {
    await phone.close();
  }
});

test("the thread screen marks the ids it shows", () => {
  const screen = readFileSync(join(ROOT, "src/app/thread/[replica].tsx"), "utf8");
  // M1b.4: the timeline's `unmarked` (the unread ids plus my own) replaced unreadIdsOf here.
  assert.match(screen, /timeline\?\.unmarked/);
  assert.match(screen, /session\.markRead\(/);
});

test("the archived toggle heads the archived section and the archived rows follow it only while open", async () => {
  const { threadsTabRows } = await import("../../src/ui/thread_rows");
  const list = { threads: [item({ replica: "a", archived: true }), item({ replica: "b" }), item({ replica: "c", archived: true })] };
  const keys = (open: boolean) => threadsTabRows(list, open).map((r) => (r.kind === "thread" ? r.item.replica : `toggle:${r.count}:${r.open}`));
  assert.deepEqual(keys(false), ["b", "toggle:2:false"]);
  assert.deepEqual(keys(true), ["b", "toggle:2:true", "a", "c"], "the toggle sits between the active and the archived rows");
  assert.deepEqual(threadsTabRows({ threads: [item({ replica: "b" })] }, true).map((r) => r.kind), ["thread"], "no archived, no toggle");
  assert.deepEqual(threadsTabRows(null, false), []);
  const screen = readFileSync(join(ROOT, "src/app/(tabs)/threads.tsx"), "utf8");
  assert.match(screen, /threadsTabRows\(/);
  assert.doesNotMatch(screen, /ListFooterComponent/, "the toggle is a list row, not a footer below the archived rows");
  assert.doesNotMatch(screen, /group \? <LinkPill/, "the pill shows before a Space is pulled too");
});

test("no screen shows the transport realm (01: realm is not shown)", () => {
  const files = [
    ...readdirSync(join(ROOT, "src/app"), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name)),
    ...readdirSync(join(ROOT, "src/ui"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => join(ROOT, "src/ui", f)),
  ];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /\.realm\b/, `${file} renders a realm`);
});

test("the Threads tab is one virtualized list built from ThreadRow and LinkPill", () => {
  const screen = readFileSync(join(ROOT, "src/app/(tabs)/threads.tsx"), "utf8");
  assert.match(screen, /<FlatList/);
  assert.match(screen, /<ThreadRow/);
  assert.match(screen, /<LinkPill/);
  assert.doesNotMatch(screen, /\.map\(\s*\(?\w*\)?\s*=>\s*<ThreadRow/, "rows are rendered by the list, not mapped");
});
