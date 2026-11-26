import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 link commands: goOnline, goOffline, syncNow. The route states are shell-kit's own, over its real
// feed controller and in-process FakeRelays (test/support/fake_feed_link.ts).

test("goOnline starts the link and syncs, goOffline stops it and turns sync off", async () => {
  const { openMemoryLocalStore } = await import("../../src/local/local_store");
  const { buildGroup } = await import("../support/group_fixture");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");
  const group = await buildGroup({ members: 1 });
  const feed = createFakeFeed();
  feed.seed(group.space.replica, group.space.frames);
  feed.seed(group.thread.replica, group.thread.frames);
  let link!: ReturnType<typeof feed.link>;
  const local = await openMemoryLocalStore();
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  await store.adopt(group.space.replica, "Treehouse.Space");
  await store.mergeSync(group.space.replica, group.space.frames, []);
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  await store.mergeSync(group.thread.replica, group.thread.frames, []);
  const member = group.members[0]!;
  const session = createTreehouseSession({
    custody: MemoryKeyCustody.holding(member.signer),
    store,
    clock: new ManualClock(2_000),
    local,
    link: (host) => (link = feed.link(host)),
  });
  await session.open();
  try {
    await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], member.realm));
    assert.equal(session.read().linkStatus.pill, "offline", "configured but not started");

    const online = await session.goOnline();
    assert.ok(online.ok, `goOnline refused: ${JSON.stringify(online)}`);
    assert.equal(local.setting("syncEnabled"), true);
    assert.equal(session.read().linkStatus.pill, "live");

    const posted = await session.postMessage(group.thread.replica, "hello");
    assert.ok(posted.ok);
    const synced = await session.syncNow();
    assert.ok(synced.ok);
    assert.ok(feed.relay(group.thread.replica).log.has(posted.value.id), "syncNow submitted the post");

    const offline = await session.goOffline();
    assert.ok(offline.ok);
    assert.equal(local.setting("syncEnabled"), false);
    assert.equal(session.read().linkStatus.pill, "offline");
    assert.ok(link.state().routes.every((r) => r.connection === "idle"), "nothing dials while offline");

    // While sync is off, syncNow dials nothing: a new post stays on this phone.
    const later = await session.postMessage(group.thread.replica, "later");
    assert.ok(later.ok);
    assert.ok((await session.syncNow()).ok);
    assert.equal(feed.relay(group.thread.replica).log.has(later.value.id), false, "offline syncNow submits nothing");
    assert.equal(session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === later.value.id)!.delivery, "saved");
  } finally {
    await session.close();
  }
});

test("goOnline is refused with history_invalid and dials nothing", async () => {
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");
  const group = await buildGroup({ members: 1 });
  const feed = createFakeFeed();
  let link!: ReturnType<typeof feed.link>;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  const session = createTreehouseSession({
    local: await (await import("../../src/local/local_store")).openMemoryLocalStore(),
    custody: MemoryKeyCustody.holding(group.members[0]!.signer),
    store,
    clock: new ManualClock(2_000),
    link: (host) => (link = feed.link(host)),
    verify: async () => ({ ok: false, replica: group.thread.replica, reason: "invalid_retained_history" as const }),
  });
  await session.open();
  try {
    await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], group.members[0]!.realm));
    assert.deepEqual(await session.goOnline(), { ok: false, reason: "history_invalid" });
    assert.deepEqual(await session.syncNow(), { ok: false, reason: "history_invalid" });
    assert.ok(link.state().routes.every((r) => r.connection === "idle"));
  } finally {
    await session.close();
  }
});

test("lastSyncMs moves on every completed syncNow, even when nothing changed", async () => {
  const { openMemoryLocalStore } = await import("../../src/local/local_store");
  const { buildGroup } = await import("../support/group_fixture");
  const { createFakeFeed, loopbackRoutes } = await import("../support/fake_feed_link");
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const group = await buildGroup({ members: 1 });
  const feed = createFakeFeed();
  feed.seed(group.space.replica, group.space.frames);
  feed.seed(group.thread.replica, group.thread.frames);
  let link!: ReturnType<typeof feed.link>;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  for (const [replica, product, frames] of [
    [group.space.replica, "Treehouse.Space", group.space.frames],
    [group.thread.replica, "Treehouse.Thread", group.thread.frames],
  ] as const) {
    await store.adopt(replica, product);
    await store.mergeSync(replica, frames, []);
  }
  const clock = new ManualClock(2_000);
  const session = createTreehouseSession({
    custody: MemoryKeyCustody.holding(group.members[0]!.signer),
    store,
    clock,
    link: (host) => (link = feed.link(host)),
    local: await openMemoryLocalStore(),
  });
  await session.open();
  try {
    await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], group.members[0]!.realm));
    assert.ok((await session.goOnline()).ok);
    assert.ok((await session.syncNow()).ok);
    assert.equal(session.read().linkStatus.lastSyncMs, 2_000);
    clock.advance(60_000);
    assert.ok((await session.syncNow()).ok);
    assert.equal(session.read().linkStatus.lastSyncMs, 62_000, "a later completed sync with nothing new still stamps");
  } finally {
    await session.close();
  }
});
