import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorCarrierDelegation,
  authorCarrierOp,
  townshipGenesisBody,
  townshipReplicaRootTag,
  treehouseCommandDecoders,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, TreehouseProduct } from "@treetopdevs/lattice-client";

// M1a.2: verify on open, the mobile form of the Tauri shell's verifyProfile and validateProfiles. The
// references are lattice-client's own signature, hash, root-commitment and judge functions, and a group
// authored by lattice-client's helpers; the verifier is never checked against itself.
// Modules load inside each test so a missing layer fails its own named test.

type Held = { replica: string; product: TreehouseProduct; profile: { frames: CarrierOpFrame[]; outbox: string[]; acked: string[] } };

async function groupHeld() {
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const post = await group.members[0]!.post(group.thread.frames, "hello");
  const held: Held[] = [
    { replica: group.space.replica, product: "Treehouse.Space", profile: { frames: [...group.space.frames], outbox: [], acked: [] } },
    { replica: group.thread.replica, product: "Treehouse.Thread", profile: { frames: [...group.thread.frames, post], outbox: [post.id], acked: [post.id] } },
  ];
  return { group, post, held };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test("verify accepts a held group, and an adopted replica that holds nothing yet", async () => {
  const { verifyHeld } = await import("../../src/session/verify_held");
  const { held } = await groupHeld();
  assert.deepEqual(await verifyHeld(held), { ok: true });
  assert.deepEqual(await verifyHeld([]), { ok: true });
  const adopted: Held = { replica: "replica:treehouse:thread:pending", product: "Treehouse.Thread", profile: { frames: [], outbox: [], acked: [] } };
  assert.deepEqual(await verifyHeld([...held, adopted]), { ok: true });
});

test("verify rejects a tampered signature, a missing dependency, a wrong root and an unreferenced thread", async (t) => {
  const { verifyHeld } = await import("../../src/session/verify_held");
  const { group, held } = await groupHeld();

  await t.test("tampered signature", async () => {
    const bad = clone(held);
    const frames = bad[1]!.profile.frames;
    frames[1] = { ...frames[1]!, sig: frames[0]!.sig };
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: group.thread.replica, reason: "invalid_retained_history" });
  });

  await t.test("tampered body", async () => {
    const bad = clone(held);
    const frames = bad[0]!.profile.frames;
    frames[1] = { ...frames[1]!, deps: [] };
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: group.space.replica, reason: "invalid_retained_history" });
  });

  await t.test("missing dependency", async () => {
    const bad = clone(held);
    const frames = bad[0]!.profile.frames;
    const dropped = frames[1]!.id;
    assert.ok(frames.some((f) => f.deps.includes(dropped)), "a later Space frame depends on the dropped one");
    bad[0]!.profile.frames = frames.filter((f) => f.id !== dropped);
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: group.space.replica, reason: "incomplete_retained_history" });
  });

  await t.test("outbox or acked id not held", async () => {
    const bad = clone(held);
    bad[1]!.profile.acked = ["not-held"];
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: group.thread.replica, reason: "incomplete_retained_history" });
  });

  await t.test("wrong root", async () => {
    // A genesis signed by the member for a replica whose #root: commits to the admin.
    const { testIdentity } = await import("../support/group_fixture");
    const intruder = testIdentity("intruder");
    const replica = `replica:treehouse:thread:wrongroot#root:${await townshipReplicaRootTag(group.admin.pubkey)}`;
    const delegation = await authorCarrierDelegation({
      replica,
      audiencePubkey: intruder.signer.publicKey,
      parentId: null,
      live: true,
      signer: intruder.signer,
      ops: [...treehouseCommandDecoders("Treehouse.Thread").keys()],
      roles: ["moderator"],
    });
    const genesis = await authorCarrierOp({ replica, deps: [], kind: "authority", body: townshipGenesisBody(delegation, {}), cap: ["nil"], signer: intruder.signer });
    const bad: Held[] = [...clone(held), { replica, product: "Treehouse.Thread", profile: { frames: [genesis], outbox: [], acked: [] } }];
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica, reason: "wrong_profile_root" });
  });

  await t.test("unreferenced thread", async () => {
    const { buildGroup } = await import("../support/group_fixture");
    const other = await buildGroup({ members: 0 });
    const bad: Held[] = [...clone(held), { replica: other.thread.replica, product: "Treehouse.Thread", profile: { frames: other.thread.frames, outbox: [], acked: [] } }];
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: other.thread.replica, reason: "unreferenced_local_thread" });
  });

  await t.test("a frame filed under the wrong product or replica", async () => {
    const bad = clone(held);
    bad[1]!.profile.frames.push(bad[0]!.profile.frames[0]!);
    assert.deepEqual(await verifyHeld(bad), { ok: false, replica: group.thread.replica, reason: "invalid_retained_history" });
    const swapped = clone(held);
    swapped[1]!.product = "Treehouse.Space";
    assert.equal((await verifyHeld(swapped)).ok, false);
  });
});

async function sessionLayers() {
  const session = await import("../../src/session/session");
  const store = await import("../../src/session/memory/replica_store");
  const custody = await import("../../src/session/memory/key_custody");
  const clock = await import("../../src/session/memory/clock");
  const link = await import("../../src/session/memory/relay_link");
  return { ...session, ...store, ...custody, ...clock, ...link };
}

test("a failed verify leaves the store untouched and surfaces history_invalid", async () => {
  const L = await sessionLayers();
  const { group, held } = await groupHeld();
  const disk = new L.MemoryReplicaDisk();
  const seed = new L.MemoryReplicaStore(disk, new L.ManualClock(1_000));
  await seed.open();
  for (const h of held) {
    await seed.adopt(h.replica, h.product);
    await seed.mergeSync(h.replica, h.profile.frames, []);
  }
  // Corrupt the durable copy, as a damaged file would.
  const thread = disk.replicas.get(group.thread.replica)!;
  thread.frames[1] = { ...thread.frames[1]!, sig: thread.frames[0]!.sig };
  const before = JSON.stringify([...disk.replicas]);

  let started = 0;
  const member = group.members[0]!;
  const session = L.createTreehouseSession({
    custody: L.MemoryKeyCustody.holding(member.signer),
    store: new L.MemoryReplicaStore(disk, new L.ManualClock(2_000)),
    clock: new L.ManualClock(2_000),
    link: () => {
      const link = new L.MemoryRelayLink();
      const start = link.start.bind(link);
      link.start = async () => {
        started++;
        await start();
      };
      return link;
    },
  });
  const seen: unknown[] = [];
  session.subscribe((m) => m.history, (h) => seen.push(h));
  await session.open();
  try {
    assert.deepEqual(session.read().history, { ok: false, replica: group.thread.replica, reason: "invalid_retained_history" });
    assert.deepEqual(seen, [session.read().history], "a subscriber made before open hears history_invalid once");
    const posted = await session.postMessage(group.thread.replica, "after damage");
    assert.deepEqual(posted, { ok: false, reason: "history_invalid" });
    // open() never starts the link (the app does); this guards against a later change starting it here.
    assert.equal(started, 0, "the link is not started over invalid history");
    assert.equal(JSON.stringify([...disk.replicas]), before, "held frames are neither deleted nor rewritten");
  } finally {
    await session.close();
  }

  // A store that cannot open is also history_invalid, with its reason, and never a silent empty store.
  const broken = L.createTreehouseSession({
    custody: L.MemoryKeyCustody.holding(member.signer),
    store: Object.assign(new L.MemoryReplicaStore(), {
      open: async () => {
        throw new Error("database is locked");
      },
    }),
    clock: new L.ManualClock(0),
    link: () => new L.MemoryRelayLink(),
  });
  await broken.open();
  assert.deepEqual(broken.read().history, { ok: false, replica: null, reason: "database is locked" });
  await broken.close();
});

test("a pull that would make held history invalid is refused and writes nothing", async () => {
  const L = await sessionLayers();
  const { group, held } = await groupHeld();
  const { buildGroup } = await import("../support/group_fixture");
  const other = await buildGroup({ members: 0 });
  const disk = new L.MemoryReplicaDisk();
  const store = new L.MemoryReplicaStore(disk, new L.ManualClock(1_000));
  await store.open();
  for (const h of held) {
    await store.adopt(h.replica, h.product);
    await store.mergeSync(h.replica, h.profile.frames, []);
  }
  // Adopted but empty: valid at open. Its frames are not referenced by the held Space.
  await store.adopt(other.thread.replica, "Treehouse.Thread");
  let host: Parameters<Parameters<typeof L.createTreehouseSession>[0]["link"]>[0] | null = null;
  const session = L.createTreehouseSession({
    custody: new L.MemoryKeyCustody(),
    store,
    clock: new L.ManualClock(0),
    link: (h) => {
      host = h;
      return new L.MemoryRelayLink();
    },
  });
  await session.open();
  try {
    assert.deepEqual(session.read().history, { ok: true });
    const before = JSON.stringify([...disk.replicas]);
    await assert.rejects(host!.mergeSync(other.thread.replica, other.thread.frames, []), /unreferenced_local_thread/);
    assert.equal(JSON.stringify([...disk.replicas]), before, "nothing was retained");
    // A valid pull still merges.
    const post = await group.members[0]!.post(held[1]!.profile.frames, "a later post");
    assert.equal(await host!.mergeSync(group.thread.replica, [post], []), true);
    assert.ok(store.profile(group.thread.replica)?.frames.some((f) => f.id === post.id));
  } finally {
    await session.close();
  }
});

test("a device holding nothing yet converges through the local relay with every merge verified", async (t) => {
  const L = await sessionLayers();
  const { buildGroup } = await import("../support/group_fixture");
  const { startLocalRelay, connectAs } = await import("../support/local_relay");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());

  const store = new L.MemoryReplicaStore(new L.MemoryReplicaDisk(), new L.ManualClock(1_000));
  await store.open();
  await store.adopt(group.space.replica, "Treehouse.Space");
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  let link: ReturnType<typeof L.createFeedRelayLink> | null = null;
  const session = L.createTreehouseSession({
    custody: L.MemoryKeyCustody.holding(member.signer),
    store,
    clock: new L.ManualClock(1_000),
    link: (host) => (link = L.createFeedRelayLink(host, { pollMs: 0 })),
  });
  await session.open();
  t.after(() => session.close());
  assert.deepEqual(session.read().history, { ok: true }, "adopted empty replicas verify");
  await link!.configure({ localRealm: member.realm, routes: relay.routes });
  await link!.start();
  await link!.syncNow();
  // The relay is the reference: the device holds exactly what the relay advertises for each route.
  for (const route of relay.routes) {
    const peer = await connectAs(group.admin, route);
    try {
      const advertised = [...(await peer.advertise())].sort();
      assert.ok(advertised.length > 0, "the relay holds the route's frames");
      assert.deepEqual(store.profile(route.replica)?.frames.map((f) => f.id).sort(), advertised, `${route.replica} converged`);
    } finally {
      peer.close();
    }
  }
});
