import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1a.4 ThreadTimeline. References: the Sim vectors (order, winning text, quarantine reasons) and
// shell-kit's real feed state over FakeRelay forced outcomes (delivery). Modules load inside each test so
// a missing projection fails its own named test.

const profileOf = (frames: CarrierOpFrame[], outbox: string[] = [], acked: string[] = []) => ({ frames, outbox, acked });

test("message delivery: saved, sending, on_relay, relay_refused, stopped", async () => {
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");

  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  for (const [replica, product, frames] of [
    [group.space.replica, "Treehouse.Space", group.space.frames],
    [group.thread.replica, "Treehouse.Thread", group.thread.frames],
  ] as const) {
    await store.adopt(replica, product);
    await store.mergeSync(replica, frames, []);
  }
  const feed = createFakeFeed();
  feed.seed(group.space.replica, group.space.frames);
  feed.seed(group.thread.replica, group.thread.frames);
  let link!: ReturnType<typeof feed.link>;
  const session = createTreehouseSession({
    local: await (await import("../../src/local/local_store")).openMemoryLocalStore(),
    custody: MemoryKeyCustody.holding(member.signer),
    store,
    clock: new ManualClock(2_000),
    link: (host) => (link = feed.link(host)),
  });
  await session.open();
  const delivery = (id: string) => session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)?.delivery;
  try {
    await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], member.realm));
    const relay = feed.relay(group.thread.replica);

    // Not started: saved on this phone.
    const first = await session.postMessage(group.thread.replica, "first");
    assert.ok(first.ok);
    assert.equal(delivery(first.value.id), "saved");
    assert.equal(session.read().linkStatus.lastSyncMs, null, "no sync has run yet");

    // Live, but the relay holds it back (pending): sending.
    relay.forced.set(first.value.id, "pending");
    await link.start();
    await link.syncNow();
    assert.equal(link.state().routes.find((r) => r.replica === group.thread.replica)?.connection, "live");
    assert.equal(delivery(first.value.id), "sending");
    assert.equal(session.read().linkStatus.lastSyncMs, 2_000, "the first completed sync is stamped with the session clock");
    assert.equal(session.read().linkStatus.waiting, 1);

    // Accepted on the next sync: on relay.
    relay.forced.delete(first.value.id);
    await link.syncNow();
    assert.equal(delivery(first.value.id), "on_relay");

    // A forced quarantine: the relay did not accept it.
    const second = await session.postMessage(group.thread.replica, "second");
    assert.ok(second.ok);
    relay.forced.set(second.value.id, "quarantined");
    await link.syncNow();
    assert.equal(delivery(second.value.id), "relay_refused");

    // The relay stops taking submissions (read_only): not accepting messages.
    relay.forced.delete(second.value.id);
    relay.quarantine.delete(second.value.id);
    relay.errors.set("*", "read_only");
    const third = await session.postMessage(group.thread.replica, "third");
    assert.ok(third.ok);
    await link.syncNow();
    const route = link.state().routes.find((r) => r.replica === group.thread.replica)!;
    assert.equal(route.submitStopped, "read_only", "shell-kit reports the stop");
    assert.equal(delivery(third.value.id), "stopped");
    assert.equal(delivery(first.value.id), "on_relay", "an acked message stays on relay");
  } finally {
    await session.close();
  }
});

test("message delivery follows the lineage: an unsent or refused edit or delete of an acked post is not on relay", async () => {
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");

  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  for (const [replica, product, frames] of [
    [group.space.replica, "Treehouse.Space", group.space.frames],
    [group.thread.replica, "Treehouse.Thread", group.thread.frames],
  ] as const) {
    await store.adopt(replica, product);
    await store.mergeSync(replica, frames, []);
  }
  const feed = createFakeFeed();
  feed.seed(group.space.replica, group.space.frames);
  feed.seed(group.thread.replica, group.thread.frames);
  let link!: ReturnType<typeof feed.link>;
  const session = createTreehouseSession({
    local: await (await import("../../src/local/local_store")).openMemoryLocalStore(),
    custody: MemoryKeyCustody.holding(member.signer),
    store,
    clock: new ManualClock(2_000),
    link: (host) => (link = feed.link(host)),
  });
  await session.open();
  const message = (id: string) => session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)!;
  try {
    await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], member.realm));
    const relay = feed.relay(group.thread.replica);
    const posted = await session.postMessage(group.thread.replica, "first");
    assert.ok(posted.ok);
    await link.start();
    await link.syncNow();
    assert.equal(message(posted.value.id).delivery, "on_relay");

    // Offline edit of an acknowledged post: the new text is only on this phone.
    await link.stop();
    const edit = await session.editMessage(group.thread.replica, message(posted.value.id).ref, "first, edited");
    assert.ok(edit.ok);
    assert.equal(message(posted.value.id).text, "first, edited");
    assert.equal(message(posted.value.id).delivery, "saved", "the unsent edit is saved on this phone, not on relay");

    // The relay refuses the edit: the message says so.
    relay.forced.set(edit.value.id, "quarantined");
    await link.start();
    await link.syncNow();
    assert.equal(message(posted.value.id).delivery, "relay_refused", "a refused edit is visible on its message");

    // A second post, acked, then deleted offline: the placeholder is not on relay either.
    relay.forced.delete(edit.value.id);
    relay.quarantine.delete(edit.value.id);
    const other = await session.postMessage(group.thread.replica, "second");
    assert.ok(other.ok);
    await link.syncNow();
    assert.equal(message(other.value.id).delivery, "on_relay");
    await link.stop();
    const removed = await session.deleteMessage(group.thread.replica, message(other.value.id).ref);
    assert.ok(removed.ok);
    assert.equal(message(other.value.id).removed, "by_author");
    assert.equal(message(other.value.id).delivery, "saved", "the unsent delete is saved on this phone");
    assert.equal(message(other.value.id).edited, false);
  } finally {
    await session.close();
  }
});

test("message standing: a post quarantined after a concurrent revoke shows not_counted with its reason", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt, revokeThreadGrant } = await import("../support/authoring");
  const { judgeTreehouseFrames } = await import("../support/vectors");

  const group = await buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const base = group.thread.frames;
  const at = heads(base);
  const honored = await postAt(bob, base, "still counts", at);
  const revoke = await revokeThreadGrant(group, alice, base, at);
  const late = await postAt(alice, base, "after the revoke", [...heads([...base, revoke])]);
  const concurrent = await postAt(alice, base, "concurrent with the revoke", at);
  const frames = [...base, honored, revoke, concurrent, late];
  const judged = judgeTreehouseFrames(group.thread.replica, frames);
  // The reference: the judge's own verdicts, which the Sim vectors pin for this reducer.

  const timeline = projectThreadTimeline({
    replica: group.thread.replica,
    profile: profileOf(frames, [concurrent.id, late.id]),
    myKey: alice.pubkey,
    route: null,
  });
  // The judge quarantines both the concurrent post and the later one as revoked_capability.
  assert.equal(judged.quarantined[concurrent.id], "revoked_capability", "the judge refuses the post concurrent with the revoke");
  assert.equal(judged.quarantined[late.id], "revoked_capability");
  const byId = new Map(timeline.messages.map((m) => [m.id, m]));
  for (const id of [concurrent.id, late.id]) {
    const view = byId.get(id);
    assert.ok(view, "my own not-counted post is shown");
    assert.equal(view.standing, "not_counted");
    assert.equal(view.notCountedReason, "revoked_capability", "with the judge's reason");
    assert.equal(view.unread, false);
  }
  assert.equal(byId.get(honored.id)?.standing, "honored");

  // Another member's quarantined post is not in the timeline (it belongs in Verify).
  const asBob = projectThreadTimeline({ replica: group.thread.replica, profile: profileOf(frames), myKey: bob.pubkey, route: null });
  assert.ok(!asBob.messages.some((m) => m.id === late.id), "other people's not-counted posts are not shown");
  // The counted subsequence equals the judge's order.
  assert.deepEqual(asBob.messages.filter((m) => m.standing === "honored" && m.removed === null).map((m) => m.id), judged.order);
});

test("edited and removed messages render the winning text or placeholder per Sim", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { loadTreehouseVector } = await import("../support/vectors");
  for (const name of ["treehouse_thread_archive", "treehouse_thread_conflicts"]) {
    const vector = loadTreehouseVector(name);
    const state = vector.expected.state as { posts: string[] };
    const timeline = projectThreadTimeline({ replica: vector.replica, profile: profileOf(vector.frames), myKey: null, route: null });
    const shown = timeline.messages.filter((m) => m.removed === null);
    assert.deepEqual(shown.map((m) => m.id), vector.expected.order, `${name}: order equals Sim`);
    assert.deepEqual(shown.map((m) => m.text), state.posts, `${name}: winning text equals Sim`);
    for (const m of timeline.messages) assert.equal(m.ref.root, m.id);
    if (name === "treehouse_thread_archive") {
      const edited = timeline.messages.find((m) => m.text === "edited")!;
      assert.equal(edited.edited, true);
      assert.notEqual(edited.ref.latest, edited.ref.root, "the lineage names the winning edit");
      const editFrame = vector.frames.find((f) => f.id === edited.ref.latest);
      assert.ok(editFrame, "the latest edit is a held frame");
      const removed = timeline.messages.filter((m) => m.removed !== null);
      assert.equal(removed.length, 1, "the moderator-removed post leaves one placeholder");
      assert.equal(removed[0]!.removed, "by_moderator");
      assert.equal(removed[0]!.text, "", "a placeholder carries no text");
    } else {
      // Two concurrent edits: Sim's winner ("left") is shown, and the lineage names that edit's frame.
      assert.equal(timeline.messages[0]!.edited, true);
      const { carrierOpsToSemanticOps, treehouseCommandDecoders } = await import("@treetopdevs/lattice-client");
      const leftEdit = carrierOpsToSemanticOps([...vector.frames], {}, treehouseCommandDecoders("Treehouse.Thread")).find(
        (op) => op.command === "author_edit" && op.commandArgs?.[2] === state.posts[0],
      )!;
      assert.equal(timeline.messages[0]!.ref.latest, leftEdit.id, "ref.latest is the winning edit");
      assert.equal(timeline.messages[1]!.edited, false);
    }
  }
});

test("a post that sorts above read messages is marked arrivedLate and counts as unread", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt } = await import("../support/authoring");
  const { judgeTreehouseFrames } = await import("../support/vectors");

  const group = await buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const at = heads(group.thread.frames);
  const a = await postAt(alice, group.thread.frames, "from alice", at);
  const b = await postAt(bob, group.thread.frames, "from bob", at);
  const frames = [...group.thread.frames, a, b];
  const order = judgeTreehouseFrames(group.thread.replica, frames).order;
  const [above, below] = order as [string, string];
  // The reader holds and has read only the lower message; the upper one arrived later.
  const reader = group.admin.pubkey;
  const timeline = projectThreadTimeline({
    replica: group.thread.replica,
    profile: profileOf(frames),
    myKey: reader,
    route: null,
    readIds: new Set([below]),
  });
  const view = (id: string) => timeline.messages.find((m) => m.id === id)!;
  assert.equal(view(above).arrivedLate, true);
  assert.equal(view(above).unread, true);
  assert.equal(view(below).arrivedLate, false);
  assert.equal(view(below).unread, false);
  assert.equal(timeline.unreadCount, 1);
});

test("timeline of 4,000 ops: the projection is under 150 ms; a whole replica change stays under its measured ceiling", async () => {
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const { buildGroup } = await import("../support/group_fixture");
  const { memberCapability, authorTreehouseCommand } = await import("@treetopdevs/lattice-client");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const cap = memberCapability(group.thread.frames, member.pubkey, group.thread.replica, { product: "Treehouse.Thread", command: "post" })!;
  const frames = [...group.thread.frames];
  let tip = frames[frames.length - 1]!.id;
  while (frames.length < 4_000) {
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: group.thread.replica,
      deps: [tip],
      signer: member.signer,
      capId: cap.id,
      command: { command: "post", text: `message ${frames.length}` },
    });
    frames.push(frame);
    tip = frame.id;
  }
  // Two timers, both asserted. The plan's 150 ms budget is met only by the app's projection over the shared
  // judged view. A whole replica change, which is what the session runs synchronously when a frame arrives
  // (lattice-client's decode and materialize, the live-delegation materialize, then the projection), was
  // measured at about 5 s here and is NOT within 150 ms: that is a recorded Known gap (incremental judged
  // view in lattice-client). The ceiling below (the plan's "adjust once measured") catches it growing worse.
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const profile = profileOf(frames);
  const WHOLE_CHANGE_CEILING_MS = 15_000;
  const wholeStarted = performance.now();
  const fresh = viewReplica(group.thread.replica, "Treehouse.Thread", frames);
  const whole = projectThreadTimeline({ replica: group.thread.replica, profile, myKey: member.pubkey, route: null, readIds: new Set<string>(), view: fresh });
  const wholeMs = performance.now() - wholeStarted;
  assert.equal(whole.messages.length, 4_000 - group.thread.frames.length);

  const inputs = { replica: group.thread.replica, profile, myKey: member.pubkey, route: null, readIds: new Set<string>(), view: fresh };
  const started = performance.now();
  const timeline = projectThreadTimeline(inputs);
  const elapsed = performance.now() - started;
  console.log(`# 4,000-op timeline: projection ${elapsed.toFixed(1)} ms; whole replica change ${wholeMs.toFixed(0)} ms (ceiling ${WHOLE_CHANGE_CEILING_MS} ms; 150 ms budget unmet)`);
  assert.equal(timeline.messages.length, 4_000 - group.thread.frames.length);
  assert.ok(elapsed < 150, `projected in ${elapsed.toFixed(1)} ms`);
  assert.ok(wholeMs < WHOLE_CHANGE_CEILING_MS, `a whole replica change took ${wholeMs.toFixed(0)} ms`);
});
