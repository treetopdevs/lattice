import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1a.4 SessionStatus through TreehouseSession, and the session's caching rule: a projection whose inputs
// did not change keeps the identical object, so subscribers do not re-render.

async function layers() {
  const session = await import("../../src/session/session");
  const store = await import("../../src/session/memory/replica_store");
  const custody = await import("../../src/session/memory/key_custody");
  const clock = await import("../../src/session/memory/clock");
  const link = await import("../../src/session/memory/relay_link");
  const local = await import("../../src/local/local_store");
  const fixture = await import("../support/group_fixture");
  const authoring = await import("../support/authoring");
  return { ...session, ...store, ...custody, ...clock, ...link, ...local, ...fixture, ...authoring };
}
type Layers = Awaited<ReturnType<typeof layers>>;

interface Seed {
  replica: string;
  product: "Treehouse.Space" | "Treehouse.Thread";
  frames: CarrierOpFrame[];
  authored?: CarrierOpFrame[];
}

async function openSession(L: Layers, custody: InstanceType<Layers["MemoryKeyCustody"]>, seeds: Seed[]) {
  const disk = new L.MemoryReplicaDisk();
  const clock = new L.ManualClock(1_000);
  const store = new L.MemoryReplicaStore(disk, clock);
  await store.open();
  for (const seed of seeds) {
    await store.adopt(seed.replica, seed.product);
    await store.mergeSync(seed.replica, seed.frames, []);
    for (const frame of seed.authored ?? []) await store.appendAuthored(seed.replica, frame);
  }
  const reopened = new L.MemoryReplicaStore(disk, clock);
  const link = new L.MemoryRelayLink();
  const local = await L.openMemoryLocalStore();
  const session = L.createTreehouseSession({ custody, store: reopened, clock, link: () => link, local });
  await session.open();
  return { session, link, local, store: reopened };
}

test("session status: no_key, key_only, member, removed, identity_mismatch, history_invalid", async () => {
  const L = await layers();
  const group = await L.buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const both: Seed[] = [
    { replica: group.space.replica, product: "Treehouse.Space", frames: group.space.frames },
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
  ];
  const phaseOf = async (custody: InstanceType<Layers["MemoryKeyCustody"]>, seeds: Seed[]) => {
    const { session } = await openSession(L, custody, seeds);
    try {
      return session.read().status;
    } finally {
      await session.close();
    }
  };

  assert.equal((await phaseOf(new L.MemoryKeyCustody(), [])).phase, "no_key");
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(L.testIdentity("newcomer").signer), [])).phase, "key_only");
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(alice.signer), both)).phase, "member");
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(group.admin.signer), both)).phase, "member", "the root is a member");

  // Holding the Space with an invitation for this key but no admission yet: joining.
  const spaceOps = await import("@treetopdevs/lattice-client").then((m) =>
    m.carrierOpsToSemanticOps([...group.space.frames], {}, m.treehouseCommandDecoders("Treehouse.Space")),
  );
  const aliceAdmit = spaceOps.findIndex((op) => op.command === "admit_member" && op.commandArgs?.[1] === alice.pubkey);
  const invitedOnly: Seed[] = [{ replica: group.space.replica, product: "Treehouse.Space", frames: group.space.frames.slice(0, aliceAdmit) }];
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(alice.signer), invitedOnly)).phase, "joining");

  // An admin removal of bob that this phone holds: removed.
  const removal = await L.authorAs(group.admin, "Treehouse.Space", group.space.frames, { command: "remove_member", recipient: bob.pubkey }, L.rootCap(group.space.frames));
  const afterRemoval: Seed[] = [{ ...both[0]!, frames: [...group.space.frames, removal] }, both[1]!];
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(bob.signer), afterRemoval)).phase, "removed");

  // History authored by a key this custody does not hold, or no key at all with history present.
  const alicePost = await alice.post(group.thread.frames, "mine");
  const authored: Seed[] = [both[0]!, { ...both[1]!, authored: [alicePost] }];
  assert.equal((await phaseOf(new L.MemoryKeyCustody(), authored)).phase, "identity_mismatch");
  assert.equal((await phaseOf(L.MemoryKeyCustody.holding(bob.signer), authored)).phase, "identity_mismatch");
  assert.equal((await phaseOf(new L.MemoryKeyCustody(), both)).phase, "identity_mismatch", "no key with history present");

  // A tampered held frame fails verify-on-open: history_invalid, with its reason.
  const tampered = structuredClone(group.thread.frames);
  const last = tampered[tampered.length - 1]!;
  last.sig = Buffer.alloc(64, 1).toString("base64");
  const invalid = await phaseOf(L.MemoryKeyCustody.holding(alice.signer), [both[0]!, { ...both[1]!, frames: tampered }]);
  assert.equal(invalid.phase, "history_invalid");
  assert.ok(invalid.reason, "the reason is reported");
});

test("projections return the identical object when inputs are unchanged", async () => {
  const L = await layers();
  const group = await L.buildGroup({ members: 1 });
  const member = group.members[0]!;
  const { session, link, local, store } = await openSession(L, L.MemoryKeyCustody.holding(member.signer), [
    { replica: group.space.replica, product: "Treehouse.Space", frames: group.space.frames },
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames },
  ]);
  try {
    const before = session.read();
    for (const key of ["status", "group", "linkStatus", "threads", "abilities", "roster", "audit", "timelines"] as const)
      assert.ok(before[key] !== undefined, `${key} is published`);
    let notified = 0;
    const off = session.subscribe((m) => m.timelines, () => notified++);

    // Unchanged inputs: a link state emission with the same state, a merge with nothing new, a local
    // change for a thread this phone does not hold.
    await link.configure(null);
    await store.mergeSync(group.thread.replica, group.thread.frames, []);
    await local.markRead("replica:treehouse:thread:elsewhere", ["x"]);
    const after = session.read();
    for (const key of ["status", "group", "linkStatus", "threads", "abilities", "roster", "audit", "timelines"] as const)
      assert.equal(after[key], before[key], `${key} keeps the identical object`);
    assert.equal(after.timelines[group.thread.replica], before.timelines[group.thread.replica]);
    assert.equal(notified, 0, "no subscriber re-render");

    // A real change replaces only what it touches.
    const posted = await session.postMessage(group.thread.replica, "hello");
    assert.ok(posted.ok);
    const changed = session.read();
    assert.notEqual(changed.timelines[group.thread.replica], before.timelines[group.thread.replica]);
    assert.equal(changed.group, before.group, "a Thread post leaves the group summary identical");
    assert.equal(notified, 1);

    // A local read marker is a local change: it never touches the group summary.
    await local.markRead(group.thread.replica, [posted.value.id]);
    assert.equal(session.read().group, before.group);
    off();
  } finally {
    await session.close();
  }
});

test("identity_mismatch stops authoring and transport; a locked key with nothing held is not no_key", async () => {
  const L = await layers();
  const group = await L.buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const alicePost = await alice.post(group.thread.frames, "mine");
  const seeds: Seed[] = [
    { replica: group.space.replica, product: "Treehouse.Space", frames: group.space.frames },
    { replica: group.thread.replica, product: "Treehouse.Thread", frames: group.thread.frames, authored: [alicePost] },
  ];
  // Bob's key over Alice's authored outbox: bob holds a post grant, so only the mismatch can stop him.
  const { session, link, store } = await openSession(L, L.MemoryKeyCustody.holding(bob.signer), seeds);
  let started = 0;
  const start = link.start.bind(link);
  link.start = async () => {
    started++;
    await start();
  };
  try {
    assert.equal(session.read().status.phase, "identity_mismatch");
    const outbox = store.profile(group.thread.replica)!.outbox.length;
    const posted = await session.postMessage(group.thread.replica, "not mine to send");
    assert.deepEqual(posted, { ok: false, reason: "identity_mismatch" });
    assert.equal(store.profile(group.thread.replica)!.outbox.length, outbox, "nothing was signed or saved");
    const online = await session.goOnline();
    assert.deepEqual(online, { ok: false, reason: "identity_mismatch" });
    const synced = await session.syncNow();
    assert.deepEqual(synced, { ok: false, reason: "identity_mismatch" });
    assert.equal(started, 0, "the link was never started");
  } finally {
    await session.close();
  }

  // A key that exists but cannot be read, with nothing held: never routed to key creation.
  const locked = L.MemoryKeyCustody.holding(L.testIdentity("locked").signer);
  locked.setUnavailable(true);
  const { session: lockedSession } = await openSession(L, locked, []);
  try {
    assert.deepEqual(lockedSession.read().status, { phase: "identity_mismatch", reason: "key_unavailable", replica: null });
  } finally {
    await lockedSession.close();
  }
});
