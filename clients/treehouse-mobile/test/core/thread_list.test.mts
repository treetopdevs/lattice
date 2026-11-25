import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1a.4 ThreadList: one row per thread the Space lists, from the timelines, read markers and feed state.

const profileOf = (frames: CarrierOpFrame[], outbox: string[] = [], acked: string[] = []) => ({ frames, outbox, acked });

test("unread count is ids not in the read set, not a position", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { projectThreadList } = await import("../../src/session/projections/thread_list");
  const { buildGroup } = await import("../support/group_fixture");

  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const frames = [...group.thread.frames];
  for (const text of ["one", "two", "three"]) frames.push(await member.post(frames, text));
  const [one, two, three] = frames.slice(-3).map((f) => f.id) as [string, string, string];
  // The newest and the oldest are read, the middle one is not: a position marker would say 0 unread.
  const readIds = new Set([one, three]);
  const profile = profileOf(frames);
  const timeline = projectThreadTimeline({ replica: group.thread.replica, profile, myKey: group.admin.pubkey, route: null, readIds });
  assert.deepEqual(timeline.messages.filter((m) => m.unread).map((m) => m.id), [two]);

  const list = projectThreadList({
    space: viewReplica(group.space.replica, "Treehouse.Space", group.space.frames),
    timelines: { [group.thread.replica]: timeline },
    profiles: { [group.thread.replica]: profile },
    feed: { configured: false, routes: [] },
  });
  assert.equal(list.threads.length, 1);
  const row = list.threads[0]!;
  assert.equal(row.replica, group.thread.replica);
  assert.equal(row.title, "General");
  assert.equal(row.held, true);
  assert.equal(row.unreadCount, 1);
  assert.equal(row.last?.text, "three");
  assert.equal(row.last?.author, member.pubkey);
  assert.equal(row.connection, null);
});

test("thread list shows waiting counts and listed threads this phone does not hold", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { projectThreadList } = await import("../../src/session/projections/thread_list");
  const { loadTreehouseVector } = await import("../support/vectors");
  const { buildGroup } = await import("../support/group_fixture");

  // The membership vector's Space lists three threads, none of which is held here.
  const vector = loadTreehouseVector("treehouse_space_membership");
  const unheld = projectThreadList({ space: viewReplica(vector.replica, "Treehouse.Space", vector.frames), timelines: {}, profiles: {}, feed: { configured: false, routes: [] } });
  assert.deepEqual(unheld.threads.map((t) => [t.title, t.held]), [["One", false], ["BMP", false], ["Supplementary", false]]);

  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const post = await member.post(group.thread.frames, "waiting");
  const profile = profileOf([...group.thread.frames, post], [post.id]);
  const timeline = projectThreadTimeline({ replica: group.thread.replica, profile, myKey: member.pubkey, route: null });
  const route = { replica: group.thread.replica, connection: "reconnecting" as const, pending: 1, acked: 0, generation: null, matchesRelay: null, refused: [], submitStopped: null, message: "" };
  const list = projectThreadList({
    space: viewReplica(group.space.replica, "Treehouse.Space", group.space.frames),
    timelines: { [group.thread.replica]: timeline },
    profiles: { [group.thread.replica]: profile },
    feed: { configured: true, routes: [route] },
  });
  assert.equal(list.threads[0]!.waitingCount, 1);
  assert.equal(list.threads[0]!.unreadCount, 0, "my own message is never unread");
  assert.equal(list.threads[0]!.connection, "reconnecting");
});
