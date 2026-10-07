import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTreehouseCommand,
  carrierDelegationsFromFrames,
  decodeTreehouseJoinRequest,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { syncTreehouse, syncTreehouseRoute } from "../src/treehouse_sync";
import type { SyncTreehouseOptions } from "../src/treehouse_sync";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { LocalProfile } from "../src/treehouse_state";
import { FakeClock, FakeRelay } from "./support/fake_relay";
import { FaultNative } from "./support/fault_native";

console.log("\n▸ Treehouse relay sync: acknowledgement rules, dependency-closed merge, restart");

const SERVER_KEY = Buffer.alloc(32, 7).toString("base64");
const fresh = async (n: FaultNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};
const record = (n: FaultNative) => parseState(n.record);
const profileOf = (n: FaultNative, replica: string): LocalProfile =>
  record(n).profiles.find((p) => p.replica === replica)!;
const spaceOf = (a: TreehouseWorkflow) => a.state.profiles.find((p) => p.product === "Treehouse.Space")!;
const threadOf = (a: TreehouseWorkflow) => a.state.profiles.find((p) => p.product === "Treehouse.Thread")!;
const ids = (frames: CarrierOpFrame[]) => frames.map((f) => f.id).sort();
const routeJson = (a: TreehouseWorkflow, realm: string) =>
  JSON.stringify({
    localRealm: realm,
    routes: a.state.profiles.map((p, i) => ({
      replica: p.replica,
      url: `ws://127.0.0.1:${48000 + i}`,
      expectedPeerRealm: "relay",
      expectedPeerPubkey: SERVER_KEY,
    })),
  });

/** One FakeRelay per replica, the way a hand-written manifest has one route per replica. */
class Relays {
  readonly clock = new FakeClock();
  readonly byReplica = new Map<string, FakeRelay>();
  connectError: Error | null = null;
  for(replica: string): FakeRelay {
    if (!this.byReplica.has(replica)) this.byReplica.set(replica, new FakeRelay(this.clock, replica));
    return this.byReplica.get(replica)!;
  }
  options(extra: Partial<SyncTreehouseOptions> = {}): SyncTreehouseOptions {
    return {
      connect: async (route) => {
        if (this.connectError) throw this.connectError;
        return this.for(route.replica).connect();
      },
      sleep: this.clock.sleep,
      ...extra,
    };
  }
}

async function founder(trace: string[] = []) {
  const native = new FaultNative(trace);
  const app = await fresh(native);
  await app.createSpace("Canopy");
  await app.createThread("Field notes");
  await app.configureRoutes(routeJson(app, "founder"));
  return { native, app, space: spaceOf(app).replica, thread: threadOf(app).replica };
}

// ---- 1. report buckets: accepted and quarantined ack; rejected and pending never ack -----------------
{
  const f = await founder();
  const relays = new Relays();
  const posts: string[] = [];
  for (const text of ["one", "two", "three", "four"]) posts.push(await f.app.command(f.thread, { command: "post", text }));
  const relay = relays.for(f.thread);
  relay.forced.set(posts[1]!, "quarantined");
  relay.forced.set(posts[2]!, "rejected");
  const route = f.app.state.relay!.routes.find((r) => r.replica === f.thread)!;
  const result = await syncTreehouseRoute(f.app, route, relays.options());
  const profile = profileOf(f.native, f.thread);
  const acked = new Set(profile.acked);
  for (const id of [...profile.outbox.slice(0, 2), posts[0]!, posts[1]!]) assert(acked.has(id), `acked ${id}`);
  assert(!acked.has(posts[2]!), "a rejected id never acks");
  assert(!acked.has(posts[3]!), "a pending id never acks");
  assert.deepEqual(result.rejected.map(([id]) => id), [posts[2]]);
  assert.deepEqual(result.relayPending, [posts[3]]);
  assert.deepEqual(result.quarantined.map(([id]) => id), [posts[1]]);
  assert.deepEqual(result.pendingIds.sort(), [posts[2]!, posts[3]!].sort());
  assert.equal(result.matchesRelay, false);
  assert(profile.acked.every((id) => profile.outbox.includes(id)), "every ack is a locally authored id here");
  assert.equal(new Set(profile.acked).size, profile.acked.length);
  // The stuck tail is not retried forever and a repeat sync writes nothing.
  const before = f.native.record;
  const writes = f.native.writes;
  await syncTreehouseRoute(f.app, route, relays.options());
  assert.equal(f.native.record, before, "a no-progress sync leaves the record byte-identical");
  assert.equal(f.native.writes, writes);
  console.log("PASS accepted and quarantined ack; rejected and pending never ack; no-progress sync writes nothing");
}

// ---- 2. persist-after-ack ordering and the restart pending set -------------------------------------
{
  const trace: string[] = [];
  const f = await founder(trace);
  const relays = new Relays();
  const relay = relays.for(f.thread);
  relay.events = trace;
  await f.app.command(f.thread, { command: "post", text: "ordered" });
  trace.length = 0;
  const route = f.app.state.relay!.routes.find((r) => r.replica === f.thread)!;
  await syncTreehouseRoute(f.app, route, relays.options());
  const firstCommit = trace.indexOf("commit");
  const lastRelay = trace.map((e, i) => (e.startsWith("relay:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert(lastRelay >= 0 && firstCommit > lastRelay, "no acknowledgement is persisted before the relay replied");
  // Restart: a fresh workflow over the same record sees pending = outbox minus acked and resubmits.
  const g = await founder();
  const post = await g.app.command(g.thread, { command: "post", text: "survives restart" });
  const gRelays = new Relays();
  gRelays.connectError = new Error("relay_unreachable");
  const gRoute = g.app.state.relay!.routes.find((r) => r.replica === g.thread)!;
  await assert.rejects(syncTreehouseRoute(g.app, gRoute, gRelays.options()), /relay_unreachable/);
  const rebooted = await fresh(g.native);
  const prof = rebooted.state.profiles.find((p) => p.replica === g.thread)!;
  assert.deepEqual(prof.outbox.filter((id) => !prof.acked.includes(id)), prof.outbox, "all authored ids are pending");
  gRelays.connectError = null;
  await syncTreehouseRoute(rebooted, gRoute, gRelays.options());
  const after = profileOf(g.native, g.thread);
  assert.deepEqual([...after.acked].sort(), [...after.outbox].sort());
  assert(gRelays.for(g.thread).log.has(post), "the pending frame was resubmitted after restart");
  console.log("PASS ack is persisted only after the relay reply; pending survives restart and resubmits");
}

// ---- 3. failing commit after a successful submit ----------------------------------------------------
{
  const f = await founder();
  const relays = new Relays();
  const relay = relays.for(f.thread);
  const post = await f.app.command(f.thread, { command: "post", text: "fault" });
  const route = f.app.state.relay!.routes.find((r) => r.replica === f.thread)!;
  const before = f.native.record;
  f.native.failCommit = true;
  await assert.rejects(syncTreehouseRoute(f.app, route, relays.options()), /disk_write_refused/);
  assert.equal(f.native.record, before, "the failed commit changed nothing");
  assert(relay.log.has(post), "the relay did persist the frame");
  const stranded = profileOf(f.native, f.thread);
  assert.equal(stranded.acked.length, 0, "pending survives");
  f.native.failCommit = false;
  const rebooted = await fresh(f.native);
  // The relay advertises stale first (hides the frame), so the frame is resubmitted and the relay
  // answers with an empty report (it already holds the op). The id is acked only through the advertise path.
  relay.hideOnce = new Set(stranded.outbox);
  const eventsBefore = relay.events.length;
  await syncTreehouseRoute(rebooted, route, relays.options());
  assert(relay.events.slice(eventsBefore).some((e) => e === `relay:${post}`), "the resubmission happened");
  const healed = profileOf(f.native, f.thread);
  assert.deepEqual([...healed.acked].sort(), [...healed.outbox].sort());
  assert.equal(new Set(healed.acked).size, healed.acked.length, "no duplicate ack entries");
  assert.equal(new Set(healed.frames.map((x) => x.id)).size, healed.frames.length, "no duplicate frames");
  assert.equal(relay.log.size, healed.frames.length, "the relay gained no duplicate");
  // A relay that answers empty and never lists the id does not earn an ack.
  const g = await founder();
  const gRelays = new Relays();
  const lost = await g.app.command(g.thread, { command: "post", text: "silently dropped" });
  gRelays.for(g.thread).forced.set(lost, "empty");
  const gRoute = g.app.state.relay!.routes.find((r) => r.replica === g.thread)!;
  const gResult = await syncTreehouseRoute(g.app, gRoute, gRelays.options());
  assert(!profileOf(g.native, g.thread).acked.includes(lost), "an empty report alone is not a receipt");
  assert.deepEqual(gResult.pendingIds, [lost]);
  console.log("PASS failing commit after submit: pending survives, advertise-path ack, no duplicates, empty report is no receipt");
}

// ---- 4. an outbox larger than the relay burst drains to completion -----------------------------------
{
  const f = await founder();
  const relays = new Relays();
  const profile = threadOf(f.app);
  const cap = carrierDelegationsFromFrames(profile.frames).find(
    (d) => d.issuer === f.app.state.publicKey && d.parent_id === null,
  )!;
  const seed = f.native.seed!;
  const signer = { publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed) };
  const state = parseState(f.native.record);
  const target = state.profiles.find((p) => p.replica === f.thread)!;
  for (let i = 0; i < 150; i++) {
    const referenced = new Set(target.frames.flatMap((x) => x.deps));
    const deps = target.frames.filter((x) => !referenced.has(x.id)).map((x) => x.id).sort();
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: f.thread,
      deps,
      signer,
      capId: cap.id,
      command: { command: "post", text: `bulk ${i}` },
    });
    target.frames.push(frame);
    target.outbox.push(frame.id);
  }
  state.revision += 1;
  f.native.record = JSON.stringify(state);
  const big = await fresh(f.native);
  const route = big.state.relay!.routes.find((r) => r.replica === f.thread)!;
  const result = await syncTreehouseRoute(big, route, relays.options());
  const done = profileOf(f.native, f.thread);
  assert(done.outbox.length > 150);
  assert.equal(relays.for(f.thread).log.size, done.outbox.length);
  assert.deepEqual([...done.acked].sort(), [...done.outbox].sort());
  assert.deepEqual(result.pendingIds, []);
  assert.equal(result.rateLimited, false);
  assert(relays.clock.ms > 0, "the drain waited for the relay's refill");
  console.log("PASS an outbox larger than the relay burst drains to completion");
}

// ---- 5. enrollment over fake relays: join, pull, accept, grant, post, converge -----------------------
const f = await founder();
const relays = new Relays();
const first = await syncTreehouse(f.app, relays.options());
assert.equal(first.routes.every((r) => r.ok), true);
assert.equal(relays.for(f.space).log.size, spaceOf(f.app).frames.length);
assert.equal(relays.for(f.thread).log.size, threadOf(f.app).frames.length);

const jNative = new FaultNative();
const joiner = await fresh(jNative);
const request = await joiner.beginJoin();
assert.equal(decodeTreehouseJoinRequest(request).publicKey, joiner.state.publicKey);
const offer = await f.app.issueInvitation(request, "joiner");
await syncTreehouse(f.app, relays.options());
await joiner.useOffer(offer);
await joiner.confirmOffer();

// Paginated partial pull whose first page has open dependencies: no durable change.
{
  const sRelay = relays.for(f.space);
  const j2 = new FaultNative();
  j2.seed = jNative.seed;
  j2.record = jNative.record;
  const probe = await fresh(j2);
  const spaceRoute = probe.state.relay!.routes.find((r) => r.replica === f.space)!;
  sRelay.pullPage = 2;
  const before = j2.record;
  await assert.rejects(
    syncTreehouseRoute(probe, spaceRoute, relays.options({ maxPullRounds: 1 })),
    /pull_incomplete/,
  );
  assert.equal(j2.record, before, "open dependencies after the page cap leave no durable change");
  assert.equal(probe.state.profiles.length, 0);
  const done = await syncTreehouseRoute(probe, spaceRoute, relays.options());
  assert.equal(done.pulledFrames, sRelay.log.size);
  assert.deepEqual(ids(profileOf(j2, f.space).frames), [...sRelay.log.keys()].sort());
  sRelay.pullPage = null;
  console.log("PASS a partial pull with open dependencies changes nothing; further pages converge");
}

// Corrupt and duplicate pulled frames.
{
  const sRelay = relays.for(f.space);
  const j3 = new FaultNative();
  j3.seed = jNative.seed;
  j3.record = jNative.record;
  const probe = await fresh(j3);
  const route = probe.state.relay!.routes.find((r) => r.replica === f.space)!;
  const real = [...sRelay.log.values()][0]!;
  const forged = structuredClone(real);
  const sig = Buffer.from(forged.sig, "base64");
  sig[0]! ^= 1;
  forged.sig = sig.toString("base64");
  sRelay.servePull = [forged];
  const before = j3.record;
  await assert.rejects(syncTreehouseRoute(probe, route, relays.options()), /verification failed/);
  assert.equal(j3.record, before, "a corrupt pulled frame changes nothing");
  sRelay.servePull = null;
  // Same id with different bytes is refused by the merge itself.
  await syncTreehouseRoute(probe, route, relays.options());
  const held = probe.state.profiles.find((p) => p.replica === f.space)!.frames[0]!;
  const twisted = structuredClone(held);
  twisted.deps = ["x"];
  const mark = j3.record;
  await assert.rejects(probe.mergeSync(f.space, [twisted], []), /frame_conflict/);
  assert.equal(j3.record, mark);
  // Merging a byte-equal retained frame again is a no-op: no revision bump, no write.
  const writes = j3.writes;
  assert.deepEqual(await probe.mergeSync(f.space, [structuredClone(held)], []), { added: 0, acked: 0 });
  assert.equal(j3.record, mark);
  assert.equal(j3.writes, writes);
  // A relay that re-serves every known frame changes nothing (duplicates are byte-equal).
  sRelay.ignoreHave = true;
  await syncTreehouseRoute(probe, route, relays.options());
  assert.equal(j3.record, mark, "byte-equal duplicates are ignored without a write");
  sRelay.ignoreHave = false;
  console.log("PASS corrupt pulled frames change nothing; duplicates must be byte-equal and write nothing");
}

// More than four routes refuses to start.
{
  const f2 = await founder();
  const live = new Relays();
  const real = f2.app.state.relay!;
  f2.app.state.relay = {
    ...real,
    routes: [...real.routes, ...[2, 3, 4].map((n) => ({ ...real.routes[0]!, url: `ws://127.0.0.1:${48100 + n}` }))],
  };
  await assert.rejects(syncTreehouse(f2.app, live.options()), /too_many_routes/);
  assert.equal(live.byReplica.size, 0, "nothing connected");
  const bare = await fresh(new FaultNative());
  await assert.rejects(syncTreehouse(bare, live.options()), /routes_not_configured/);
  console.log("PASS more than four routes, or none, refuses to start before any connection");
}

// Joiner pulls the Space and Thread; foreign frames are never pending.
const pulled = await syncTreehouse(joiner, relays.options());
assert.equal(pulled.routes.every((r) => r.ok), true, JSON.stringify(pulled));
assert.equal(joiner.state.profiles.length, 2);
for (const p of joiner.state.profiles) {
  assert.deepEqual([...p.acked].sort(), ids(p.frames), "every pulled frame is acked in the same commit");
  assert.deepEqual(p.outbox, [], "foreign frames are never in the outbox");
}
assert.equal(joiner.state.active, joiner.state.profiles[1]!.replica);
// The member cannot post yet: no grant.
assert.equal(joiner.canAuthor(f.thread, "post"), false);
const acceptance = await joiner.acceptInvitation(offer);
await f.app.admitAndGrant(acceptance);
await syncTreehouse(f.app, relays.options());
await syncTreehouse(joiner, relays.options());
assert.equal(joiner.canAuthor(f.thread, "post"), true);
const memberPost = await joiner.command(f.thread, { command: "post", text: "hello over the relay" });
const sent = await syncTreehouse(joiner, relays.options());
assert.equal(sent.routes.every((r) => r.ok), true);
await syncTreehouse(f.app, relays.options());
for (const app of [f.app, joiner]) {
  const view = app.views.get(f.thread)!;
  assert.equal(view.posts.at(-1)!.id, memberPost);
  assert.equal(view.quarantineReasons.size, 0);
  for (const p of app.state.profiles) {
    assert.deepEqual([...p.acked].sort(), ids(p.frames), "acked equals the retained id set");
    assert.deepEqual(p.outbox.filter((id) => !p.acked.includes(id)), [], "pending is empty");
  }
}
for (const replica of [f.space, f.thread]) {
  const relayIds = [...relays.for(replica).log.keys()].sort();
  assert.deepEqual(ids(profileOf(f.native, replica).frames), relayIds);
  assert.deepEqual(ids(profileOf(jNative, replica).frames), relayIds);
}
const final = await syncTreehouse(f.app, relays.options());
assert.equal(final.routes.every((r) => r.ok && r.matchesRelay), true, "matches relay after a settled sync");
console.log("PASS fake-relay enrollment: pull, accept, grant, member post and convergence with acked equal retained");
