import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.7 lifecycle (03, Lifecycle): foreground starts the feed and syncs, background stops it and closes the
// sockets, and neither touches the person's sync setting. The route states are shell-kit's own, over its
// real feed controller and in-process FakeRelays; the relay's log is the reference for what was sent.

async function memberSession() {
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
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  await store.adopt(group.space.replica, "Treehouse.Space");
  await store.mergeSync(group.space.replica, group.space.frames, []);
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  await store.mergeSync(group.thread.replica, group.thread.frames, []);
  const member = group.members[0]!;
  const local = await openMemoryLocalStore();
  let link!: ReturnType<typeof feed.link>;
  const session = createTreehouseSession({
    custody: MemoryKeyCustody.holding(member.signer),
    store,
    clock: new ManualClock(2_000),
    local,
    link: (host) => (link = feed.link(host)),
  });
  await session.open();
  await link.configure(loopbackRoutes([group.space.replica, group.thread.replica], member.realm));
  return { group, feed, local, session, link: () => link };
}

test("background stops the link and keeps sync on; foreground starts it and sends what was saved", async () => {
  const { group, feed, local, session, link } = await memberSession();
  try {
    assert.ok((await session.goOnline()).ok);
    assert.equal(session.read().linkStatus.pill, "live");

    const away = await session.background();
    assert.ok(away.ok, JSON.stringify(away));
    assert.ok(link().state().routes.every((r) => r.connection === "idle"), "every socket closed in the background");
    assert.equal(local.setting("syncEnabled"), true, "background is not the person turning sync off");

    // A post made while backgrounded (e.g. from a share sheet) stays on this phone until foreground.
    const posted = await session.postMessage(group.thread.replica, "written in the background");
    assert.ok(posted.ok);
    assert.equal(feed.relay(group.thread.replica).log.has(posted.value.id), false, "nothing dials in the background");

    const back = await session.foreground();
    assert.ok(back.ok, JSON.stringify(back));
    assert.equal(session.read().linkStatus.pill, "live");
    assert.ok(feed.relay(group.thread.replica).log.has(posted.value.id), "foreground synced the saved post");
    assert.equal(
      session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === posted.value.id)?.delivery,
      "on_relay",
    );
  } finally {
    await session.close();
  }
});

test("foreground dials nothing while the person has sync off", async () => {
  const { group, feed, session, link } = await memberSession();
  try {
    assert.ok((await session.goOffline()).ok);
    const posted = await session.postMessage(group.thread.replica, "kept on this phone");
    assert.ok(posted.ok);
    const back = await session.foreground();
    assert.ok(back.ok);
    assert.ok(link().state().routes.every((r) => r.connection === "idle"));
    assert.equal(feed.relay(group.thread.replica).log.has(posted.value.id), false);
    assert.equal(session.read().linkStatus.pill, "offline");
  } finally {
    await session.close();
  }
});

test("foreground and background are refused before open", async () => {
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { openMemoryLocalStore } = await import("../../src/local/local_store");
  const { createFakeFeed } = await import("../support/fake_feed_link");
  const feed = createFakeFeed();
  const session = createTreehouseSession({
    custody: new MemoryKeyCustody(),
    store: new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1)),
    clock: new ManualClock(1),
    local: await openMemoryLocalStore(),
    link: (host) => feed.link(host),
  });
  assert.deepEqual(await session.foreground(), { ok: false, reason: "not_open" });
  assert.deepEqual(await session.background(), { ok: false, reason: "not_open" });
});

/** An AppState stand-in: the binder only needs addEventListener("change") and currentState. */
function fakeAppState(initial: string) {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: initial,
    addEventListener(_type: "change", listener: (s: string) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(state: string) {
      this.currentState = state;
      for (const l of [...listeners]) l(state);
    },
    get count() {
      return listeners.size;
    },
  };
}

test("app state active foregrounds, background backgrounds, inactive does nothing, and transitions run in order", async () => {
  const { bindLifecycle } = await import("../../src/native/lifecycle");
  const appState = fakeAppState("active");
  const calls: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const unbind = bindLifecycle(appState, {
    async foreground() {
      calls.push("foreground:start");
      await Promise.resolve();
      calls.push("foreground:end");
    },
    async background() {
      calls.push("background:start");
      await slow;
      calls.push("background:end");
    },
  });
  appState.emit("inactive");
  appState.emit("background");
  appState.emit("active");
  // The foreground waits for the slower background to finish: the link never starts while it is stopping.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["background:start"]);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["background:start", "background:end", "foreground:start", "foreground:end"]);
  // Repeated states collapse: a second active without a background in between does nothing.
  appState.emit("active");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 4);
  unbind();
  assert.equal(appState.count, 0, "unbinding removes the listener");
});

test("a failing transition does not stop the next one", async () => {
  const { bindLifecycle } = await import("../../src/native/lifecycle");
  const appState = fakeAppState("active");
  const calls: string[] = [];
  const unbind = bindLifecycle(appState, {
    async foreground() {
      calls.push("foreground");
    },
    async background() {
      calls.push("background");
      throw new Error("link_failed");
    },
  });
  appState.emit("background");
  appState.emit("active");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["background", "foreground"]);
  unbind();
});

test("a session installed while the app is in the background is backgrounded, in order with transitions", async () => {
  // Review (M1a.7 close): backgrounding while connect() is pending reached no session, and the session that
  // open() then put online kept its sockets in the background. reconcile() re-applies the current state.
  const { bindLifecycle } = await import("../../src/native/lifecycle");
  const appState = fakeAppState("active");
  const calls: string[] = [];
  let installed = false;
  const binding = bindLifecycle(appState, {
    async foreground() {
      if (installed) calls.push("foreground");
    },
    async background() {
      if (installed) calls.push("background");
    },
  });
  appState.emit("background"); // no session yet: a no-op for the target
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, []);
  installed = true;
  binding.reconcile();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["background"], "the new session is stopped because the app is in the background");
  // Active installs do nothing extra: open already went online.
  appState.emit("active");
  binding.reconcile();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["background", "foreground"]);
  binding();
  assert.equal(appState.count, 0);
});

test("a read model source keeps the identical snapshot until the selected model changes", async () => {
  const { readModelSource } = await import("../../src/ui/read_model_source");
  const { group, session } = await memberSession();
  try {
    const source = readModelSource(session, (m) => m.timelines[group.thread.replica] ?? null);
    const first = source.getSnapshot();
    assert.ok(first, "the thread timeline is projected");
    assert.equal(source.getSnapshot(), first, "no change, identical snapshot (useSyncExternalStore must not loop)");
    let notified = 0;
    const off = source.subscribe(() => notified++);
    // A change elsewhere (the Space's route state) does not notify a thread selector whose value is unchanged.
    await session.setPetname(group.admin.pubkey, "Ada");
    assert.equal(notified, 0);
    assert.equal(source.getSnapshot(), first);
    const posted = await session.postMessage(group.thread.replica, "new");
    assert.ok(posted.ok);
    assert.ok(notified > 0, "a post notifies");
    assert.notEqual(source.getSnapshot(), first);
    off();

    // No session yet: a stable null snapshot and a no-op subscription.
    const none = readModelSource(null, (m) => m.threads);
    assert.equal(none.getSnapshot(), null);
    assert.equal(none.getSnapshot(), none.getSnapshot());
    none.subscribe(() => undefined)();
  } finally {
    await session.close();
  }
});
