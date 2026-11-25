import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1a.1: the post tracer through TreehouseSession. References: the Sim vectors for order, text and
// quarantine, and the local BEAM relay's own advertise for "on relay". The session is never its own
// oracle. Modules load inside each test so a missing layer fails its own named test.


async function layers() {
  const session = await import("../../src/session/session");
  const store = await import("../../src/session/memory/replica_store");
  const custody = await import("../../src/session/memory/key_custody");
  const clock = await import("../../src/session/memory/clock");
  const link = await import("../../src/session/memory/relay_link");
  return { ...session, ...store, ...custody, ...clock, ...link };
}

type Layers = Awaited<ReturnType<typeof layers>>;

/** A custody that counts signatures, so a test can prove a refusal happened before signing. */
function counting(inner: InstanceType<Layers["MemoryKeyCustody"]>) {
  const counter = { signs: 0 };
  return {
    counter,
    custody: {
      status: () => inner.status(),
      publicKey: () => inner.publicKey(),
      create: () => inner.create(),
      async sign(bytes: Uint8Array) {
        counter.signs++;
        return inner.sign(bytes);
      },
    },
  };
}

async function seededStore(
  L: Layers,
  seeds: { replica: string; product: "Treehouse.Space" | "Treehouse.Thread"; frames: CarrierOpFrame[] }[],
  disk = new L.MemoryReplicaDisk(),
) {
  const store = new L.MemoryReplicaStore(disk, new L.ManualClock(1_000));
  await store.open();
  for (const seed of seeds) {
    await store.adopt(seed.replica, seed.product);
    await store.mergeSync(seed.replica, seed.frames, []);
  }
  return { store, disk };
}

function offlineSession(L: Layers, store: InstanceType<Layers["MemoryReplicaStore"]>, custody: { status(): Promise<"none" | "available" | "unavailable">; publicKey(): Promise<string | null>; create(): Promise<string>; sign(bytes: Uint8Array): Promise<Uint8Array> }) {
  return L.createTreehouseSession({
    custody,
    store,
    clock: new L.ManualClock(2_000),
    link: () => new L.MemoryRelayLink(),
  });
}

test("timeline equals Sim order and text for treehouse_thread_conflicts", async () => {
  const L = await layers();
  const { loadTreehouseVector } = await import("../support/vectors");
  const vector = loadTreehouseVector("treehouse_thread_conflicts");
  const { store } = await seededStore(L, [{ replica: vector.replica, product: "Treehouse.Thread", frames: vector.frames }]);
  const session = offlineSession(L, store, new L.MemoryKeyCustody());
  await session.open();
  try {
    const timeline = session.read().timelines[vector.replica]!;
    assert.ok(timeline, "the held Thread has a timeline");
    const expectedState = vector.expected.state as { posts: string[]; title: string; archived: boolean };
    assert.deepEqual(timeline.messages.map((m) => m.id), vector.expected.order, "order equals Sim");
    assert.deepEqual(timeline.messages.map((m) => m.text), expectedState.posts, "text equals Sim");
    assert.equal(timeline.title, expectedState.title);
    assert.equal(timeline.archived, expectedState.archived);
    assert.ok(timeline.messages.every((m) => !m.mine && m.delivery === null), "nothing is mine without a key");
    assert.equal(timeline.canPost, false, "no key, no post");
  } finally {
    await session.close();
  }
});

test("timeline omits quarantined posts for treehouse_thread_archive", async () => {
  const L = await layers();
  const { loadTreehouseVector } = await import("../support/vectors");
  const vector = loadTreehouseVector("treehouse_thread_archive");
  assert.ok(Object.keys(vector.expected.quarantined).length > 0, "the vector quarantines something");
  const { store } = await seededStore(L, [{ replica: vector.replica, product: "Treehouse.Thread", frames: vector.frames }]);
  const session = offlineSession(L, store, new L.MemoryKeyCustody());
  await session.open();
  try {
    const timeline = session.read().timelines[vector.replica]!;
    const ids = timeline.messages.map((m) => m.id);
    assert.deepEqual(ids, vector.expected.order, "order equals Sim");
    assert.deepEqual(timeline.messages.map((m) => m.text), (vector.expected.state as { posts: string[] }).posts);
    for (const id of Object.keys(vector.expected.quarantined))
      assert.ok(!ids.includes(id), `quarantined ${id} is not in the timeline`);
    assert.equal(timeline.archived, true);
  } finally {
    await session.close();
  }
});

test("post appears as saved while the link is stopped, then on_relay after sync", async (t) => {
  const L = await layers();
  const { buildGroup } = await import("../support/group_fixture");
  const { startLocalRelay, connectAs } = await import("../support/local_relay");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());

  const { store } = await seededStore(L, [
    { replica: group.space.replica, product: "Treehouse.Space", frames: group.space.frames },
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
  ]);
  let link: ReturnType<typeof L.createFeedRelayLink> | null = null;
  const session = L.createTreehouseSession({
    custody: L.MemoryKeyCustody.holding(member.signer),
    store,
    clock: new L.ManualClock(5_000),
    link: (host) => (link = L.createFeedRelayLink(host, { pollMs: 0 })),
  });
  await session.open();
  t.after(() => session.close());
  // The route set is checked as a set: one without its Space route is refused and configures nothing.
  await assert.rejects(
    link!.configure({ localRealm: member.realm, routes: relay.routes.filter((r) => r.replica !== group.space.replica) }),
    /route_set_needs_one_space/,
  );
  assert.equal(link!.state().configured, false, "a refused route set is not saved");
  await link!.configure({ localRealm: member.realm, routes: relay.routes });

  const posted = await session.postMessage(group.thread.replica, "hello from the tracer");
  assert.ok(posted.ok, `post accepted: ${JSON.stringify(posted)}`);
  const id = posted.value.id;
  const saved = session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id);
  assert.deepEqual(
    saved && { text: saved.text, mine: saved.mine, delivery: saved.delivery, author: saved.author },
    { text: "hello from the tracer", mine: true, delivery: "saved", author: member.pubkey },
  );

  // The relay itself is the reference: it does not hold the post while the link is stopped, even when
  // a sync is asked for (stopped means sync is off, so nothing dials).
  await link!.syncNow();
  assert.equal(session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)?.delivery, "saved");
  const threadRoute = relay.routes.find((r) => r.replica === group.thread.replica)!;
  const before = await connectAs(group.admin, threadRoute);
  try {
    assert.ok(!(await before.advertise()).includes(id), "relay does not hold the post before sync");
  } finally {
    before.close();
  }

  await link!.start();
  await link!.syncNow();
  const after = await connectAs(group.admin, threadRoute);
  try {
    assert.ok((await after.advertise()).includes(id), "relay holds the post after sync");
  } finally {
    after.close();
  }
  const synced = session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id);
  assert.equal(synced?.delivery, "on_relay");
  await link!.stop();
});

test("post by a key without a grant is refused no_capability and writes nothing", async () => {
  const L = await layers();
  const { buildGroup, testIdentity } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const { store } = await seededStore(L, [
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
  ]);
  const { custody, counter } = counting(L.MemoryKeyCustody.holding(testIdentity("stranger").signer));
  const session = offlineSession(L, store, custody);
  await session.open();
  try {
    const before = structuredClone(store.profile(group.thread.replica));
    assert.equal(session.read().timelines[group.thread.replica]!.canPost, false);
    const result = await session.postMessage(group.thread.replica, "let me in");
    assert.deepEqual(result, { ok: false, reason: "no_capability" });
    assert.equal(counter.signs, 0, "nothing was signed");
    assert.deepEqual(store.profile(group.thread.replica), before, "nothing was written");
  } finally {
    await session.close();
  }
});

test("empty and over-long text are refused before signing", async () => {
  const L = await layers();
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const { store } = await seededStore(L, [
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
  ]);
  const { custody, counter } = counting(L.MemoryKeyCustody.holding(group.members[0]!.signer));
  const session = offlineSession(L, store, custody);
  await session.open();
  try {
    const before = structuredClone(store.profile(group.thread.replica));
    for (const text of ["", "   \n\t "])
      assert.deepEqual(await session.postMessage(group.thread.replica, text), { ok: false, reason: "empty_text" });
    assert.deepEqual(await session.postMessage(group.thread.replica, "x".repeat(4_001)), { ok: false, reason: "text_too_long" });
    // A lone surrogate (a truncated paste) is malformed text, not a custody failure.
    assert.deepEqual(await session.postMessage(group.thread.replica, "cut \uD83C"), { ok: false, reason: "malformed_text" });
    // Characters, not UTF-16 units: 4,000 emoji are within the limit.
    assert.equal(counter.signs, 0, "nothing was signed");
    assert.deepEqual(store.profile(group.thread.replica), before, "nothing was written");
    const limit = await session.postMessage(group.thread.replica, "\u{1F333}".repeat(4_000));
    assert.ok(limit.ok, "exactly 4,000 characters is accepted");
  } finally {
    await session.close();
  }
});

test("a second session on the same store sees the queued post after restart", async () => {
  const L = await layers();
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const seeds = [{ replica: group.thread.replica, product: "Treehouse.Thread" as const, frames: group.thread.frames }];
  const { store, disk } = await seededStore(L, seeds);
  const first = offlineSession(L, store, L.MemoryKeyCustody.holding(member.signer));
  await first.open();
  const posted = await first.postMessage(group.thread.replica, "still here after restart");
  assert.ok(posted.ok);
  await first.close();

  // Restart: a new store object over the same durable disk, a new session, the same key.
  const reopened = new L.MemoryReplicaStore(disk, new L.ManualClock(9_000));
  await reopened.open();
  const second = offlineSession(L, reopened, L.MemoryKeyCustody.holding(member.signer));
  await second.open();
  try {
    const message = second.read().timelines[group.thread.replica]!.messages.find((m) => m.id === posted.value.id);
    assert.deepEqual(
      message && { text: message.text, mine: message.mine, delivery: message.delivery },
      { text: "still here after restart", mine: true, delivery: "saved" },
    );
    assert.deepEqual(reopened.profile(group.thread.replica)!.outbox, [posted.value.id], "still waiting to send");
    assert.equal(reopened.firstSeenMs(group.thread.replica, posted.value.id), 1_000, "first-seen survives restart");
  } finally {
    await second.close();
  }
});

test("subscribe fires once per change and not when an unrelated slice changes", async () => {
  const L = await layers();
  const { buildGroup } = await import("../support/group_fixture");
  const { loadTreehouseVector } = await import("../support/vectors");
  const group = await buildGroup({ members: 1 });
  const other = loadTreehouseVector("treehouse_thread_conflicts");
  const { store } = await seededStore(L, [
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
    { replica: other.replica, product: "Treehouse.Thread", frames: other.frames },
  ]);
  const link = new L.MemoryRelayLink();
  const session = L.createTreehouseSession({
    custody: L.MemoryKeyCustody.holding(group.members[0]!.signer),
    store,
    clock: new L.ManualClock(2_000),
    link: () => link,
  });
  await session.open();
  try {
    const mine: unknown[] = [];
    const record: unknown[] = [];
    const offRecord = session.subscribe((m) => m.timelines, (v) => record.push(v));
    // A link-state change with no timeline change keeps the identical timelines record.
    await link.configure(null);
    assert.equal(record.length, 0, "a link-only change does not re-fire a timelines selector");
    offRecord();
    const unrelated: unknown[] = [];
    const offMine = session.subscribe((m) => m.timelines[group.thread.replica], (v) => mine.push(v));
    const offUnrelated = session.subscribe((m) => m.timelines[other.replica], (v) => unrelated.push(v));

    const posted = await session.postMessage(group.thread.replica, "one change");
    assert.ok(posted.ok);
    assert.equal(mine.length, 1, "the posted thread's listener fired once");
    assert.equal(unrelated.length, 0, "the unrelated thread's listener did not fire");

    // A merge that adds nothing is not a change.
    assert.equal(await store.mergeSync(group.thread.replica, group.thread.frames, []), false);
    assert.equal(mine.length, 1, "a no-op merge does not fire");

    offMine();
    offUnrelated();
    const again = await session.postMessage(group.thread.replica, "after unsubscribe");
    assert.ok(again.ok);
    assert.equal(mine.length, 1, "an unsubscribed listener does not fire");
  } finally {
    await session.close();
  }
});
