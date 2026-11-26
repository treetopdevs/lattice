import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1a.0: the Core harness every later slice uses. The support modules are loaded inside each test
// so a missing or broken fixture fails its own named test.

const VECTORS = [
  "treehouse_thread_conflicts",
  "treehouse_thread_archive",
  "treehouse_space_membership",
  "treehouse_space_roles",
] as const;

const sorted = (ids: Iterable<string>) => [...ids].sort();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("vector loader returns frames whose reduced state equals the vector's expected state", async () => {
  const { loadTreehouseVector, judgeTreehouseFrames } = await import("../support/vectors");
  for (const name of VECTORS) {
    const vector = loadTreehouseVector(name);
    assert.ok(vector.frames.length > 0, `${name}: frames loaded`);
    assert.ok(vector.frames.every((f) => f.replica === vector.replica), `${name}: one replica`);
    const judged = judgeTreehouseFrames(vector.replica, vector.frames, vector.realmByPubkey);
    assert.deepEqual(judged.state, vector.expected.state, `${name}: state equals Sim`);
    assert.deepEqual(judged.order, vector.expected.order, `${name}: post order equals Sim`);
    assert.deepEqual(judged.quarantined, vector.expected.quarantined, `${name}: quarantine equals Sim`);
  }
});

test("group fixture produces a Space and Thread the judge honors with zero quarantined ops", async () => {
  const { buildGroup } = await import("../support/group_fixture");
  const { judgeTreehouseFrames, verifyFrames } = await import("../support/vectors");
  const group = await buildGroup({ members: 2 });
  assert.equal(group.members.length, 2);
  assert.ok(group.space.replica.startsWith("replica:treehouse:space:"), "Space replica is product-named");
  assert.ok(group.thread.replica.startsWith("replica:treehouse:thread:"), "Thread replica is product-named");
  assert.ok(!group.thread.replica.includes("#authority:"), "the Thread is legacy-rooted");
  await verifyFrames(group.space.frames);
  await verifyFrames(group.thread.frames);

  const space = judgeTreehouseFrames(group.space.replica, group.space.frames);
  assert.deepEqual(space.quarantined, {}, "Space: nothing quarantined");
  const spaceState = space.state as { name: string; members: string[]; threads: { replica: string }[] };
  assert.equal(spaceState.name, "Canopy");
  assert.deepEqual(sorted(spaceState.members), sorted(group.members.map((m) => m.pubkey)), "every member admitted");
  assert.deepEqual(spaceState.threads.map((t) => t.replica), [group.thread.replica], "the Space references the Thread");

  const thread = judgeTreehouseFrames(group.thread.replica, group.thread.frames);
  assert.deepEqual(thread.quarantined, {}, "Thread: nothing quarantined");
  assert.equal((thread.state as { title: string }).title, "General");
  // Each member's grant is honored: a post they author on top of the fixture is not quarantined.
  for (const member of group.members) {
    const post = await member.post(group.thread.frames, `hello from ${member.realm}`);
    const withPost = judgeTreehouseFrames(group.thread.replica, [...group.thread.frames, post]);
    assert.deepEqual(withPost.quarantined, {}, `${member.realm}: granted post is honored`);
    assert.ok(withPost.order.includes(post.id), `${member.realm}: post is in the timeline`);
  }
});

test("local relay admits a listed key and refuses an unlisted one as unauthenticated", async (t) => {
  const { buildGroup, testIdentity } = await import("../support/group_fixture");
  const { startLocalRelay, connectAs } = await import("../support/local_relay");
  const group = await buildGroup({ members: 1 });
  const relay = await startLocalRelay(group, [group.admin, ...group.members]);
  t.after(() => relay.kill());

  const threadRoute = relay.routes.find((r) => r.replica === group.thread.replica)!;
  const listed = await connectAs(group.members[0]!, threadRoute);
  try {
    assert.deepEqual(sorted(await listed.advertise()), sorted(group.thread.frames.map((f) => f.id)));
  } finally {
    listed.close();
  }
  const stranger = testIdentity("stranger");
  await assert.rejects(connectAs(stranger, threadRoute), /unauthenticated/);
  // The key is what is checked: an unlisted key claiming a listed realm is refused the same way.
  await assert.rejects(connectAs({ ...stranger, realm: group.members[0]!.realm }, threadRoute), /unauthenticated/);
});

test("two test identities converge through the local relay", async (t) => {
  const { buildGroup } = await import("../support/group_fixture");
  const { startLocalRelay, connectAs } = await import("../support/local_relay");
  const { judgeTreehouseFrames, verifyFrames } = await import("../support/vectors");
  const group = await buildGroup({ members: 2 });
  const relay = await startLocalRelay(group, [group.admin, ...group.members]);
  t.after(() => relay.kill());
  const route = relay.routes.find((r) => r.replica === group.thread.replica)!;
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];

  // Both identities pull the same view, then each authors one concurrent post on it and relays it.
  const held = new Map<string, CarrierOpFrame[]>();
  const posts = new Map<string, CarrierOpFrame>();
  for (const member of [alice, bob]) {
    const client = await connectAs(member, route);
    try {
      const frames = await pullAll(client);
      held.set(member.realm, frames);
      posts.set(member.realm, await member.post(frames, `converge from ${member.realm}`));
    } finally {
      client.close();
    }
  }
  assert.deepEqual(posts.get(alice.realm)!.deps, posts.get(bob.realm)!.deps, "the two posts are concurrent");
  for (const member of [alice, bob]) {
    const client = await connectAs(member, route);
    try {
      const post = posts.get(member.realm)!;
      const report = await client.relay(post);
      assert.deepEqual(report.accepted, [post.id], `${member.realm}: relay accepted the post`);
    } finally {
      client.close();
    }
  }
  // Both pull again; the relay's advertised ids are the reference.
  let onRelay: string[] = [];
  for (const member of [alice, bob]) {
    const client = await connectAs(member, route);
    try {
      onRelay = sorted(await client.advertise());
      held.set(member.realm, await pullAll(client));
    } finally {
      client.close();
    }
    await delay(0);
  }
  assert.equal(onRelay.length, group.thread.frames.length + 2, "relay holds the fixture plus both posts");
  for (const member of [alice, bob]) {
    const frames = held.get(member.realm)!;
    await verifyFrames(frames);
    assert.deepEqual(sorted(frames.map((f) => f.id)), onRelay, `${member.realm} holds exactly the relay's ids`);
  }
  const a = judgeTreehouseFrames(route.replica, held.get(alice.realm)!);
  const b = judgeTreehouseFrames(route.replica, held.get(bob.realm)!);
  assert.deepEqual(a.quarantined, {});
  assert.deepEqual(b, a, "both views reduce to the same state, order and quarantine");
  assert.equal(a.order.length, 2, "both posts are in the timeline");
});

async function pullAll(client: { pull(have: string[]): Promise<unknown[]> }): Promise<CarrierOpFrame[]> {
  const { decodeCarrierOpFrame } = await import("@treetopdevs/lattice-client");
  return (await client.pull([])).map(decodeCarrierOpFrame);
}
