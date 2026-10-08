import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { carrierTranscriptBytes } from "@treetopdevs/lattice-client";
import type {
  CarrierAvailability,
  CarrierAvailabilitySubscription,
  CarrierOpFrame,
} from "@treetopdevs/lattice-client";
import {
  createTreehouseFeedController,
  treehouseFeedEnv,
} from "../src/treehouse_feed";
import type {
  TreehouseFeedController,
  TreehouseFeedSession,
  TreehouseFeedState,
} from "../src/treehouse_feed";
import {
  createTreehouseRelayConnector,
  treehouseCarrierSigner,
} from "../src/treehouse_relay_client";
import { syncTreehouseRoute } from "../src/treehouse_sync";
import type { SyncTreehouseOptions } from "../src/treehouse_sync";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { RelayRoute } from "../src/treehouse_state";
import { FakeClock, FakeRelay } from "./support/fake_relay";
import { FaultNative } from "./support/fault_native";

console.log("\n▸ Treehouse relay feed: availability hints, coalescing, reconnect, refusal, relay client");

const SERVER_SEED = Buffer.alloc(32, 9);
const SERVER_PUB = ed25519.getPublicKey(SERVER_SEED);
const SERVER_KEY = Buffer.from(SERVER_PUB).toString("base64");
const fresh = async (n: FaultNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};
const routeJson = (a: TreehouseWorkflow, realm: string) =>
  JSON.stringify({
    localRealm: realm,
    routes: a.state.profiles.map((p, i) => ({
      replica: p.replica,
      url: `ws://127.0.0.1:${48200 + i}`,
      expectedPeerRealm: "relay",
      expectedPeerPubkey: SERVER_KEY,
    })),
  });
const until = async (check: () => boolean, label: string, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};
const quiet = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function founder() {
  const native = new FaultNative();
  const app = await fresh(native);
  await app.createSpace("Canopy");
  await app.createThread("Field notes");
  await app.configureRoutes(routeJson(app, "founder"));
  const space = app.state.profiles.find((p) => p.product === "Treehouse.Space")!.replica;
  const thread = app.state.profiles.find((p) => p.product === "Treehouse.Thread")!.replica;
  return { native, app, space, thread };
}

// ---- fakes: one relay per replica, a hand-driven subscription, counted pulls and syncs ----------------
class Hints implements CarrierAvailabilitySubscription {
  baseline: CarrierAvailability;
  private queue: CarrierAvailability[] = [];
  private waiter: { resolve(a: CarrierAvailability): void; reject(e: unknown): void } | null = null;
  private failure: unknown = null;
  unsubscribed = false;
  constructor(generation: number) {
    this.baseline = { generation, frontier: [], frontierTruncated: false };
  }
  push(generation: number) {
    const hint = { generation, frontier: [], frontierTruncated: false };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(hint);
    } else this.queue.push(hint);
  }
  fail(error: unknown) {
    this.failure = error;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(error);
    }
  }
  next(): Promise<CarrierAvailability> {
    const hint = this.queue.shift();
    if (hint) return Promise.resolve(hint);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  async unsubscribe() {
    this.unsubscribed = true;
  }
}

class FeedSession implements TreehouseFeedSession {
  closed = false;
  constructor(readonly hints: Hints) {}
  async subscribeAvailability() {
    return this.hints;
  }
  close() {
    this.closed = true;
    this.hints.fail(new Error("carrier websocket closed"));
  }
}

class Harness {
  readonly clock = new FakeClock();
  readonly relays = new Map<string, FakeRelay>();
  readonly sessions = new Map<string, FeedSession[]>();
  readonly connectErrors = new Map<string, Error[]>();
  readonly delays: number[] = [];
  syncs: string[] = [];
  pulls: string[] = [];
  syncLatch: Promise<void> | null = null;
  /** Replicas whose sync fails with a non-refusal error (a relay pull the local check rejects). */
  syncFailures = new Map<string, Error>();
  /** A held feed connect per replica, so a test can choose which worker subscribes first. */
  connectLatch = new Map<string, Promise<void>>();
  states: TreehouseFeedState[] = [];
  generation = 1;
  timerFns: (() => void)[] = [];
  timersSet: number[] = [];
  timersCleared = 0;
  relay(replica: string) {
    if (!this.relays.has(replica)) this.relays.set(replica, new FakeRelay(this.clock, replica));
    return this.relays.get(replica)!;
  }
  sessionsOf(replica: string) {
    return this.sessions.get(replica) ?? [];
  }
  syncOptions(): SyncTreehouseOptions {
    return {
      connect: async (route) => {
        this.syncs.push(route.replica);
        if (this.syncLatch) await this.syncLatch;
        const failure = this.syncFailures.get(route.replica);
        if (failure) throw failure;
        const conn = this.relay(route.replica).connect();
        const pull = conn.pull.bind(conn);
        conn.pull = async (have: string[]) => {
          this.pulls.push(route.replica);
          return pull(have);
        };
        return conn;
      },
      sleep: this.clock.sleep,
    };
  }
  controller(
    app: TreehouseWorkflow,
    extra: { autosyncOnMount?: boolean; pollMs?: number } = {},
  ): TreehouseFeedController {
    return createTreehouseFeedController({
      workflow: app,
      sync: this.syncOptions(),
      connect: async (route: RelayRoute) => {
        const queued = this.connectErrors.get(route.replica);
        if (queued && queued.length > 0) throw queued.shift()!;
        const held = this.connectLatch.get(route.replica);
        if (held) await held;
        const session = new FeedSession(new Hints(this.generation));
        const list = this.sessions.get(route.replica) ?? [];
        list.push(session);
        this.sessions.set(route.replica, list);
        return session;
      },
      sleep: async (ms) => {
        this.delays.push(ms);
        await quiet(1);
      },
      timers: {
        set: (fn, ms) => {
          this.timerFns.push(fn);
          this.timersSet.push(ms);
          return this.timerFns.length;
        },
        clear: () => {
          this.timersCleared++;
        },
      },
      autosyncOnMount: extra.autosyncOnMount ?? true,
      pollMs: extra.pollMs ?? 0,
      onState: (s) => this.states.push(s),
    });
  }
  last() {
    return this.states.at(-1)!;
  }
  routeState(replica: string) {
    return this.last().routes.find((r) => r.replica === replica)!;
  }
}

const live = (h: Harness, replica: string) => h.routeState(replica)?.connection === "live";

// ---- 1. a hint triggers exactly one pull; the baseline syncs once -----------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space), "both routes live");
  await until(() => h.syncs.length === 2 && h.pulls.length >= 2, "baseline syncs");
  await quiet();
  assert.equal(h.syncs.filter((r) => r === f.thread).length, 1, "the baseline is one sync of the Thread");
  assert.equal(h.syncs.filter((r) => r === f.space).length, 1);
  // The unsynced local frames drained through the baseline sync.
  assert.equal(h.routeState(f.thread).pending, 0);
  assert.equal(h.routeState(f.thread).matchesRelay, true);
  const before = h.pulls.filter((r) => r === f.thread).length;
  h.sessions.get(f.thread)![0]!.hints.push(2);
  await until(() => h.syncs.filter((r) => r === f.thread).length === 2, "hint triggers a sync");
  await quiet();
  assert.equal(h.syncs.filter((r) => r === f.thread).length, 2, "exactly one more sync");
  assert.equal(h.pulls.filter((r) => r === f.thread).length - before, 1, "exactly one pull for the hint");
  assert.equal(h.routeState(f.thread).generation, 2);
  assert.equal(h.syncs.filter((r) => r === f.space).length, 1, "the other route is not synced");
  await feed.stop();
  console.log("PASS baseline syncs once; a hint triggers exactly one pull of its own route");
}

// ---- 2. hints coalesce into one trailing sync -------------------------------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  await quiet();
  let release!: () => void;
  h.syncLatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hints = h.sessions.get(f.thread)![0]!.hints;
  hints.push(2);
  await until(() => h.syncs.length === 3, "first hint starts a sync that is held");
  hints.push(3);
  hints.push(4);
  hints.push(5);
  await quiet();
  assert.equal(h.syncs.length, 3, "hints during an in-flight sync do not start another");
  h.syncLatch = null;
  release();
  await until(() => h.syncs.length === 4, "one trailing sync");
  await quiet();
  assert.equal(h.syncs.length, 4, "three queued hints coalesce into one trailing sync");
  assert.equal(h.routeState(f.thread).generation, 5, "the trailing sync carries the latest generation");
  await feed.stop();
  console.log("PASS hints during an in-flight sync coalesce into one trailing sync");
}

// ---- 3. hint alone converges (poll disabled), pulling a frame another device authored ---------------
{
  const f = await founder();
  const h = new Harness();
  // A second device with the same key authors a post and syncs it to the relay.
  const twin = new FaultNative();
  twin.seed = f.native.seed;
  twin.record = f.native.record;
  const other = await fresh(twin);
  const route = other.state.relay!.routes.find((r) => r.replica === f.thread)!;
  const feed = h.controller(f.app, { pollMs: 0 });
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  assert.deepEqual(h.timersSet, [], "a poll interval of 0 creates no timer");
  const post = await other.command(f.thread, { command: "post", text: "from the other device" });
  await syncTreehouseRoute(other, route, h.syncOptions());
  assert(h.relay(f.thread).log.has(post));
  assert(!f.app.state.profiles.find((p) => p.replica === f.thread)!.frames.some((x: CarrierOpFrame) => x.id === post));
  h.sessions.get(f.thread)![0]!.hints.push(2);
  await until(
    () => f.app.state.profiles.find((p) => p.replica === f.thread)!.frames.some((x: CarrierOpFrame) => x.id === post),
    "hint alone pulls the new frame",
  );
  const profile = parseState(f.native.record).profiles.find((p) => p.replica === f.thread)!;
  assert(profile.acked.includes(post), "the pulled frame is acked in the same commit");
  assert.equal(f.app.views.get(f.thread)!.posts.at(-1)!.id, post);
  assert.equal(h.routeState(f.thread).matchesRelay, true);
  await feed.stop();
  console.log("PASS with the poll disabled a hint alone converges");
}

// ---- 4. malformed or regressed hint fails the socket closed; reconnect resumes -------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  const first = h.sessions.get(f.thread)![0]!;
  first.hints.fail(new Error("carrier availability generation regressed"));
  await until(() => first.closed, "the failing session is closed");
  await until(() => h.sessions.get(f.thread)!.length === 2, "reconnect opens a new session");
  await until(() => live(h, f.thread), "live again");
  await until(() => h.syncs.length === 3, "reconnect baseline syncs");
  assert(h.delays.length >= 1 && h.delays.every((d) => d >= 100 && d <= 5000), "backoff is 100 to 5000 ms");
  assert.equal(h.sessions.get(f.space)!.length, 1, "the healthy route stays on its session");
  // A later hint on the new session still converges.
  h.sessions.get(f.thread)![1]!.hints.push(9);
  await until(() => h.syncs.length === 4, "resumed");
  await feed.stop();
  assert(h.sessions.get(f.thread)!.every((s) => s.closed), "stop closes every session");
  console.log("PASS a failed hint stream closes its socket, backs off, reconnects and resumes");
}

// ---- 4b. a sync failure after subscribe backs off; the delay resets only after a good sync ------------------
{
  const f = await founder();
  const h = new Harness();
  h.syncFailures.set(f.thread, new Error("frame_conflict"));
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => h.delays.length >= 6, "six failed sessions back off");
  assert.deepEqual(h.delays.slice(0, 6), [100, 250, 500, 1000, 2000, 5000], "a repeating sync failure walks the whole backoff table");
  assert.match(h.routeState(f.thread).message, /frame_conflict/);
  h.syncFailures.delete(f.thread);
  await until(() => live(h, f.thread) && h.routeState(f.thread).matchesRelay === true, "a good sync recovers");
  const delays = h.delays.length;
  const sessions = h.sessions.get(f.thread)!;
  sessions.at(-1)!.hints.fail(new Error("carrier websocket closed"));
  await until(() => h.delays.length > delays, "the next drop backs off");
  assert.equal(h.delays[delays], 100, "a good sync resets the backoff");
  await feed.stop();
  console.log("PASS a repeating sync failure backs off, and only a completed sync resets the delay");
}

// ---- 5. refused route does not retry; manual sync retries --------------------------------------------
{
  const f = await founder();
  const h = new Harness();
  h.connectErrors.set(f.thread, [new Error("carrier hello pubkey mismatch")]);
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => h.routeState(f.thread)?.connection === "refused", "refused");
  await until(() => live(h, f.space), "space live");
  await quiet(40);
  assert.equal(h.sessions.get(f.thread)?.length ?? 0, 0, "a refused route is not retried");
  assert.match(h.routeState(f.thread).message, /pubkey mismatch/);
  const settled = await feed.syncNow();
  assert.equal(settled.routes.find((r) => r.replica === f.thread)!.connection, "live", "manual sync retries a refused route");
  await feed.stop();
  console.log("PASS a refused route stops retrying until a manual sync");
}

// ---- 6. autosync off: nothing connects at boot; manual sync syncs and starts the subscription ----------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app, { autosyncOnMount: false, pollMs: 60000 });
  await feed.start();
  await quiet(30);
  assert.equal(h.syncs.length, 0, "nothing syncs at boot");
  assert.equal(h.sessions.size, 0, "nothing connects at boot");
  assert.deepEqual(h.timersSet, [], "no poll timer without a started feed");
  assert.equal(h.last().routes.every((r) => r.connection === "idle"), true);
  const state = await feed.syncNow();
  assert.equal(state.routes.every((r) => r.connection === "live"), true);
  assert.equal(h.syncs.length, 2, "one verified sync per route");
  assert.equal(h.sessions.get(f.thread)!.length, 1, "the subscription starts for the session");
  assert.deepEqual(h.timersSet, [60000], "the poll fallback starts with the feed");
  assert.equal(state.routes.find((r) => r.replica === f.thread)!.pending, 0);
  // A manual sync on a running feed is another single sync per route, not a reconnect.
  await feed.syncNow();
  assert.equal(h.syncs.length, 4);
  assert.equal(h.sessions.get(f.thread)!.length, 1);
  // A manually started feed keeps running across a route reconfiguration.
  await feed.reconfigure();
  await until(() => h.sessions.get(f.thread)!.length === 2 && live(h, f.thread), "manual feed relaunched");
  assert.deepEqual(h.timersSet, [60000, 60000], "the poll fallback restarts with the feed");
  await feed.stop();
  assert.equal(h.timersCleared, 2, "reconfigure and stop each clear the poll timer");
  console.log("PASS autosync off connects nothing at boot; manual sync syncs once and starts the feed");
}

// ---- 7. poll fallback ------------------------------------------------------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app, { pollMs: 60000 });
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  assert.deepEqual(h.timersSet, [60000]);
  h.timerFns[0]!();
  await until(() => h.syncs.length === 4, "the tick syncs every route");
  await feed.stop();
  const emitted = h.states.length;
  h.timerFns[0]!();
  await quiet();
  assert.equal(h.syncs.length, 4, "a tick after stop syncs nothing");
  assert.equal(h.states.length, emitted, "a tick after stop emits nothing");
  console.log("PASS the poll fallback syncs every route on its tick");
}

// ---- 8. Space first, and Threads re-sync after the Space pulls frames ----------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => h.syncs.length === 2, "baseline");
  assert.equal(h.syncs[0], f.space, "the Space syncs before the Thread");
  await until(() => live(h, f.thread) && live(h, f.space), "live");
  await quiet();
  // A Space pull that brings new frames re-syncs the Thread routes: a joiner's Thread cannot verify
  // before its Space, so a Thread that ran early must run again.
  const twin = new FaultNative();
  twin.seed = f.native.seed;
  twin.record = f.native.record;
  const other = await fresh(twin);
  await other.createThread("Second");
  const spaceRoute = other.state.relay!.routes.find((r) => r.replica === f.space)!;
  await syncTreehouseRoute(other, spaceRoute, h.syncOptions());
  const base = h.syncs.length;
  h.sessions.get(f.space)![0]!.hints.push(2);
  await until(() => h.syncs.length >= base + 2, "the Space hint and the Thread follow-up");
  assert.deepEqual(h.syncs.slice(base, base + 2), [f.space, f.thread], "the Thread is re-synced after the Space pulled frames");
  await quiet();
  assert.equal(h.syncs.length, base + 2, "no further syncs once the Space pulls nothing new");
  await feed.stop();
  console.log("PASS the Space route syncs first and Threads re-sync after the Space pulls frames");
}

// ---- 8b. a queued Space sync outranks queued Thread syncs -----------------------------------------------
{
  const native = new FaultNative();
  const app = await fresh(native);
  await app.createSpace("Canopy");
  await app.createThread("One");
  await app.createThread("Two");
  await app.configureRoutes(routeJson(app, "founder"));
  const space = app.state.profiles.find((p) => p.product === "Treehouse.Space")!.replica;
  const [one, two] = app.state.profiles.filter((p) => p.product === "Treehouse.Thread").map((p) => p.replica) as [string, string];
  const h = new Harness();
  const feed = h.controller(app);
  await feed.start();
  await until(() => [space, one, two].every((r) => live(h, r)) && h.syncs.length === 3, "settled");
  await quiet();
  let release!: () => void;
  h.syncLatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const at = h.syncs.length;
  h.sessions.get(one)![0]!.hints.push(5);
  await until(() => h.syncs.length === at + 1, "Thread One syncs and is held");
  h.sessions.get(two)![0]!.hints.push(5);
  await quiet();
  h.sessions.get(space)![0]!.hints.push(5);
  await quiet();
  h.syncLatch = null;
  release();
  await until(() => h.syncs.length === at + 3, "queued syncs run");
  assert.deepEqual(h.syncs.slice(at, at + 3), [one, space, two], "the Space jumps the queued Thread");
  await feed.stop();
  console.log("PASS a queued Space sync outranks a queued Thread sync");
}

// ---- 8c. a Thread worker that subscribes before the Space still syncs the Space first ---------------------------
{
  const f = await founder();
  const h = new Harness();
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.space)!, h.syncOptions());
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.thread)!, h.syncOptions());
  const joiner = await fresh(new FaultNative());
  const request = await joiner.beginJoin();
  const offer = await f.app.issueInvitation(request, "joiner");
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.space)!, h.syncOptions());
  await joiner.useOffer(offer);
  await joiner.confirmOffer();
  assert.equal(joiner.state.profiles.length, 0, "the joiner holds nothing before its first sync");
  let release!: () => void;
  h.connectLatch.set(f.space, new Promise<void>((resolve) => {
    release = resolve;
  }));
  h.syncs = [];
  const feed = h.controller(joiner);
  await feed.start();
  await until(() => live(h, f.thread), "the Thread subscribes while the Space is still held");
  await until(() => joiner.state.profiles.length === 2, "the Thread sync pulled the Space first, then itself");
  assert.equal(h.syncs[0], f.space, "the Space is synced before the Thread");
  await quiet();
  assert(
    h.states.every((s) => s.routes.every((r) => !r.message.includes("invalid_space_profiles"))),
    "no route ever reports invalid_space_profiles",
  );
  assert.equal(h.sessions.get(f.thread)!.length, 1, "no reconnect was needed");
  release();
  await until(() => live(h, f.space), "the Space worker connects afterwards");
  await feed.stop();
  console.log("PASS a Thread that subscribes before the Space syncs the Space first");
}

// ---- 8d. a stop during the Space pre-sync ends the old sync before it dials the Thread --------------------
{
  const f = await founder();
  const h = new Harness();
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.space)!, h.syncOptions());
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.thread)!, h.syncOptions());
  const joiner = await fresh(new FaultNative());
  const offer = await f.app.issueInvitation(await joiner.beginJoin(), "joiner");
  await syncTreehouseRoute(f.app, f.app.state.relay!.routes.find((r) => r.replica === f.space)!, h.syncOptions());
  await joiner.useOffer(offer);
  await joiner.confirmOffer();
  let releaseConnect!: () => void;
  h.connectLatch.set(f.space, new Promise<void>((resolve) => {
    releaseConnect = resolve;
  }));
  let releaseSync!: () => void;
  h.syncLatch = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  h.syncs = [];
  const feed = h.controller(joiner);
  await feed.start();
  await until(() => h.syncs.length === 1, "the Thread's Space pre-sync is in flight");
  assert.equal(h.syncs[0], f.space);
  const stopping = feed.stop();
  releaseConnect();
  await stopping;
  h.syncLatch = null;
  releaseSync();
  await quiet(50);
  assert.deepEqual(h.syncs, [f.space], "the stopped feed never dialed the Thread after its Space pre-sync");
  console.log("PASS a stop during the Space pre-sync ends the old sync before the Thread");
}

// ---- 9. stop cancels the epoch: no state after stop, no late sync ---------------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  const hints = h.sessions.get(f.thread)![0]!.hints;
  let release!: () => void;
  h.syncLatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  hints.push(2);
  await until(() => h.syncs.length === 3, "a sync is in flight");
  const emitted = h.states.length;
  await feed.stop();
  h.syncLatch = null;
  release();
  await quiet(40);
  assert.equal(h.states.length, emitted, "a stopped feed emits no further state");
  hints.push(3);
  await quiet();
  assert.equal(h.syncs.length, 3, "a stopped feed starts no further sync");
  await assert.rejects(feed.syncNow(), /feed_stopped/);
  console.log("PASS stop cancels the epoch: no late state and no late sync");
}

// ---- 10. reconfigure replaces the route set ------------------------------------------------------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  const stale = h.sessions.get(f.thread)![0]!;
  await feed.reconfigure();
  assert(stale.closed, "reconfigure closes the old sessions");
  await until(() => h.sessions.get(f.thread)!.length === 2 && live(h, f.thread), "fresh session");
  await until(() => h.syncs.length === 4, "fresh baselines");
  await quiet();
  const count = h.syncs.length;
  stale.hints.push(77);
  await quiet();
  assert.equal(h.syncs.length, count, "a hint from the old epoch does nothing");
  await feed.stop();
  console.log("PASS reconfigure cancels the old epoch and starts a fresh one");
}

// ---- 10b. teardown waits for an in-flight sync; its result never lands in the next epoch ---------------
{
  const f = await founder();
  const h = new Harness();
  const feed = h.controller(f.app);
  await feed.start();
  await until(() => live(h, f.thread) && live(h, f.space) && h.syncs.length === 2, "settled");
  let release!: () => void;
  h.syncLatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.sessions.get(f.thread)![0]!.hints.push(5);
  await until(() => h.syncs.length === 3, "a hint sync is in flight");
  let reconfigured = false;
  const done = feed.reconfigure().then(() => {
    reconfigured = true;
  });
  await quiet(30);
  assert.equal(reconfigured, false, "reconfigure waits for the in-flight sync to finish");
  h.syncLatch = null;
  release();
  await done;
  assert.equal(h.routeState(f.thread).matchesRelay, null, "the old sync wrote no state into the new epoch");
  await until(() => live(h, f.thread) && live(h, f.space), "fresh epoch live");
  await feed.stop();
  console.log("PASS teardown awaits an in-flight sync and keeps its result out of the next epoch");
}

// ---- 11. unconfigured and over-cap refuse before any connection ---------------------------------------------
{
  const bare = await fresh(new FaultNative());
  const h = new Harness();
  const feed = h.controller(bare);
  await feed.start();
  assert.equal(h.last().configured, false);
  assert.deepEqual(h.last().routes, []);
  await assert.rejects(feed.syncNow(), /routes_not_configured/);
  await feed.stop();
  const f = await founder();
  const real = f.app.state.relay!;
  f.app.state.relay = {
    ...real,
    routes: [...real.routes, ...[2, 3, 4].map((n) => ({ ...real.routes[0]!, url: `ws://127.0.0.1:${48300 + n}` }))],
  };
  const g = new Harness();
  const over = g.controller(f.app);
  await assert.rejects(over.start(), /too_many_routes/);
  assert.equal(g.sessions.size, 0);
  assert.equal(g.syncs.length, 0);
  console.log("PASS no routes or more than four routes refuses before any connection");
}

// ---- 12. build-time flags ------------------------------------------------------------------------------
{
  assert.deepEqual(treehouseFeedEnv({}), { pollMs: 60000, autosyncOnMount: true });
  assert.deepEqual(treehouseFeedEnv({ VITE_TREEHOUSE_POLL_MS: "0", VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT: "0" }), {
    pollMs: 0,
    autosyncOnMount: false,
  });
  assert.equal(treehouseFeedEnv({ VITE_TREEHOUSE_POLL_MS: "2500" }).pollMs, 2500);
  assert.equal(treehouseFeedEnv({ VITE_TREEHOUSE_POLL_MS: "nope" }).pollMs, 60000, "an unparsable value keeps the default");
  assert.equal(treehouseFeedEnv({ VITE_TREEHOUSE_POLL_MS: "-5" }).pollMs, 60000);
  assert.equal(treehouseFeedEnv({ VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT: "1" }).autosyncOnMount, true);
  console.log("PASS build-time poll and autosync flags parse, 0 disables");
}

// ---- 13. relay client: route validation, signer, scripted handshake -----------------------------------------
class ScriptedServer {
  static constructed: string[] = [];
  static serverSeed = SERVER_SEED;
  static realm = "relay";
  static answerWith: Uint8Array | null = null;
  static sockets: ScriptedServer[] = [];
  private listeners = new Map<string, ((event?: unknown) => void)[]>();
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {
    ScriptedServer.constructed.push(url);
    ScriptedServer.sockets.push(this);
    setTimeout(() => {
      this.emit("open");
      this.emit("message", {
        data: JSON.stringify({
          type: "carrier_nonce",
          nonce: Buffer.alloc(32, 5).toString("base64url"),
          wire_version: 1,
          session_version: 2,
        }),
      });
    }, 0);
  }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }
  private emit(type: string, event?: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  send(data: string) {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    setTimeout(() => {
      if (message.type === "carrier_challenge") {
        const pub = ed25519.getPublicKey(ScriptedServer.serverSeed);
        const transcript = carrierTranscriptBytes(message as never, ScriptedServer.realm, pub);
        const signature = ed25519.sign(transcript, ScriptedServer.serverSeed);
        this.emit("message", {
          data: JSON.stringify({
            type: "carrier_hello",
            realm: ScriptedServer.realm,
            pubkey: Buffer.from(pub).toString("base64"),
            signature: Buffer.from(signature).toString("base64"),
          }),
        });
      } else if (message.type === "frontier") {
        this.emit("message", { data: JSON.stringify({ type: "frontier_result", ids: ["a", "b"] }) });
      } else if (message.type === "subscribe") {
        this.emit("message", {
          data: JSON.stringify({ type: "subscribe_result", generation: 4, frontier: [], frontier_truncated: false }),
        });
      }
    }, 0);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}
{
  const f = await founder();
  const route = f.app.state.relay!.routes.find((r) => r.replica === f.thread)!;
  const connector = createTreehouseRelayConnector({
    workflow: f.app,
    webSocket: ScriptedServer as never,
  });

  // The signer is the workflow's own key through native signing; no seed is held here.
  const signer = treehouseCarrierSigner(f.app);
  assert.deepEqual(Buffer.from(signer.publicKey).toString("base64"), f.app.state.publicKey);
  const proof = new Uint8Array([1, 2, 3]);
  assert(ed25519.verify(await signer.sign(proof), proof, signer.publicKey));
  const unkeyed = await fresh(new FaultNative());
  assert.throws(() => treehouseCarrierSigner(unkeyed), /identity_unavailable/);

  // Route validation fails closed before any socket is constructed.
  for (const bad of [
    { ...route, url: "ws://example.com:9" },
    { ...route, url: "http://127.0.0.1:9" },
    { ...route, expectedPeerPubkey: "AAAA" },
    { ...route, replica: "replica:township:matter" },
  ]) {
    await assert.rejects(connector.connect(bad as RelayRoute, "founder"), /invalid_route/);
    await assert.rejects(connector.connectFeed(bad as RelayRoute, "founder"), /invalid_route/);
  }
  assert.deepEqual(ScriptedServer.constructed, [], "no socket for an invalid route");
  await assert.rejects(connector.connect(route, ""), /invalid_local_realm/);
  assert.deepEqual(ScriptedServer.constructed, []);

  // A route that is not in the saved relay is refused even when it validates.
  const stranger: RelayRoute = { ...route, replica: route.replica.replace(/.$/, route.replica.endsWith("A") ? "B" : "A") };
  await assert.rejects(connector.connect(stranger, "founder"), /unknown_route_replica/);
  assert.deepEqual(ScriptedServer.constructed, []);

  // Happy path: authenticated hello, then the sync surface answers.
  const conn = await connector.connect(route, "founder");
  assert.deepEqual(ScriptedServer.constructed, [route.url]);
  const challenge = ScriptedServer.sockets[0]!.sent[0]!;
  assert.equal(challenge.local_realm, "founder");
  assert.equal(challenge.replica, route.replica);
  assert.equal(challenge.pubkey, f.app.state.publicKey);
  assert.deepEqual(await conn.advertise(), ["a", "b"]);
  assert.equal(typeof conn.relay, "function");
  conn.close();
  assert.equal(ScriptedServer.sockets[0]!.closed, true);

  // The feed session is pull-only by type: it exposes the subscription and close, nothing that submits.
  const session = await connector.connectFeed(route, "founder");
  assert.deepEqual(Object.keys(session).sort(), ["close", "subscribeAvailability"]);
  const sub = await session.subscribeAvailability();
  assert.equal(sub.baseline.generation, 4);
  session.close();

  // A server that is not the pinned peer is refused and the socket is closed.
  ScriptedServer.serverSeed = Buffer.alloc(32, 77);
  const before = ScriptedServer.sockets.length;
  await assert.rejects(connector.connect(route, "founder"), /carrier hello pubkey mismatch/);
  assert.equal(ScriptedServer.sockets[before]!.closed, true, "a mismatched server socket is closed");
  ScriptedServer.serverSeed = SERVER_SEED;
  // A different pinned realm is refused too.
  ScriptedServer.realm = "impostor";
  await assert.rejects(connector.connect(route, "founder"), /malformed carrier hello/);
  ScriptedServer.realm = "relay";
  console.log("PASS relay client: fail-closed route validation, native signer, pinned-peer handshake, pull-only feed session");
}
