import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import type {
  CarrierAvailability,
  CarrierAvailabilitySubscription,
} from "@treetopdevs/lattice-client";
import {
  createPanelSync,
  describeSyncStatus,
} from "../src/treehouse_panel_sync";
import type { PanelSyncStatus } from "../src/treehouse_panel_sync";
import type { TreehouseFeedSession, TreehouseFeedState } from "../src/treehouse_feed";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { FakeClock, FakeRelay } from "./support/fake_relay";
import { FaultNative } from "./support/fault_native";

// Plan 181 slice 3c: the logic behind the enrollment panel's Sync control and status. The panel itself
// has no DOM test (the shell has no DOM library); this covers the controller wiring and the status text.

console.log("\n▸ Treehouse panel sync: manual Sync, boot without auto-sync, status copy");

const SERVER_KEY = Buffer.from(ed25519.getPublicKey(Buffer.alloc(32, 9))).toString("base64");
const routeJson = (a: TreehouseWorkflow) =>
  JSON.stringify({
    localRealm: "founder",
    routes: a.state.profiles.map((p, i) => ({
      replica: p.replica,
      url: `ws://127.0.0.1:${48300 + i}`,
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

class Hints implements CarrierAvailabilitySubscription {
  baseline: CarrierAvailability = { generation: 1, frontier: [], frontierTruncated: false };
  private waiter: { reject(e: unknown): void } | null = null;
  next(): Promise<CarrierAvailability> {
    return new Promise((_resolve, reject) => {
      this.waiter = { reject };
    });
  }
  fail() {
    this.waiter?.reject(new Error("carrier websocket closed"));
  }
  async unsubscribe() {}
}
class Session implements TreehouseFeedSession {
  closed = false;
  constructor(private readonly hints: Hints) {}
  async subscribeAvailability() {
    return this.hints;
  }
  close() {
    this.closed = true;
    this.hints.fail();
  }
}

class Net {
  readonly clock = new FakeClock();
  readonly relays = new Map<string, FakeRelay>();
  dials: string[] = [];
  feedDials: string[] = [];
  sessions: Session[] = [];
  relay(replica: string) {
    if (!this.relays.has(replica)) this.relays.set(replica, new FakeRelay(this.clock, replica));
    return this.relays.get(replica)!;
  }
  connector() {
    return {
      connect: async (route: { replica: string }) => {
        this.dials.push(route.replica);
        return this.relay(route.replica).connect();
      },
      connectFeed: async (route: { replica: string }) => {
        this.feedDials.push(route.replica);
        const session = new Session(new Hints());
        this.sessions.push(session);
        return session;
      },
    };
  }
}

async function founder() {
  const native = new FaultNative();
  const app = new TreehouseWorkflow(native);
  await app.open();
  await app.createSpace("Canopy");
  await app.createThread("Field notes");
  await app.configureRoutes(routeJson(app));
  return app;
}
const make = (
  app: TreehouseWorkflow,
  net: Net,
  extra: { autosyncOnMount?: boolean; env?: Record<string, string | undefined> } = {},
) => {
  const states: PanelSyncStatus[] = [];
  const sync = createPanelSync({
    workflow: app,
    connector: net.connector(),
    env: extra.env ?? { VITE_TREEHOUSE_POLL_MS: "0", VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT: extra.autosyncOnMount === false ? "0" : undefined },
    sync: { sleep: net.clock.sleep },
    onStatus: (s) => states.push(s),
  });
  return { sync, states };
};

// ---- 1. boot with autosync off connects nothing, even with routes configured --------------------------
{
  const app = await founder();
  const net = new Net();
  const { sync, states } = make(app, net, { autosyncOnMount: false });
  await sync.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(net.dials, [], "no sync connection at boot");
  assert.deepEqual(net.feedDials, [], "no subscription at boot");
  const idle = sync.status();
  assert.equal(idle.configured, true);
  assert(idle.routes.every((r) => r.connection === "idle" && r.pending > 0), "unsent local ops are pending");
  assert(states.length > 0, "status is reported at boot without any network");

  // ---- 2. manual Sync performs one verified sync per route and starts the subscriptions ------------
  const done = await sync.sync();
  assert.equal(net.dials.length, 2, "one sync connection per route");
  assert.equal(net.feedDials.length, 2, "the session subscription starts with the first Sync");
  assert(done.routes.every((r) => r.pending === 0), "everything drained");
  assert(done.routes.every((r) => r.acked > 0));
  const retained = app.state.profiles.map((p) => p.frames.length);
  const acked = app.state.profiles.map((p) => p.acked.length);
  assert.deepEqual(acked, retained, "acked equals the retained ids after Sync");
  assert(done.routes.every((r) => r.connection === "live"));
  await sync.stop();
  assert(net.sessions.every((s) => s.closed), "stop closes every subscription");
  console.log("PASS boot with auto-sync off is silent; Sync does one verified pass per route and subscribes");
}

// ---- 3. no routes: nothing connects, Sync refuses ----------------------------------------------------
{
  const native = new FaultNative();
  const app = new TreehouseWorkflow(native);
  await app.open();
  await app.createSpace("Canopy");
  const net = new Net();
  const { sync } = make(app, net);
  await sync.start();
  assert.deepEqual(net.dials.concat(net.feedDials), [], "boot never auto-syncs without a configured route");
  assert.equal(sync.status().configured, false);
  await assert.rejects(() => sync.sync(), /routes_not_configured/);
  assert.deepEqual(net.dials.concat(net.feedDials), []);
  await sync.stop();
  console.log("PASS no configured route means no connection and a refused Sync");
}

// ---- 4. autosync on with routes connects at start -----------------------------------------------------
{
  const app = await founder();
  const net = new Net();
  const { sync } = make(app, net);
  await sync.start();
  await until(() => net.dials.length === 2, "baseline syncs");
  assert.equal(net.feedDials.length, 2);
  await sync.stop();
  console.log("PASS autosync on mount connects when routes are configured");
}

// ---- 5. saving routes later never connects by itself; a running feed is restarted ---------------------
{
  const native = new FaultNative();
  const app = new TreehouseWorkflow(native);
  await app.open();
  await app.createSpace("Canopy");
  await app.createThread("Field notes");
  const net = new Net();
  const { sync } = make(app, net);
  await sync.start();
  await app.configureRoutes(routeJson(app));
  await sync.routesChanged();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(net.dials.concat(net.feedDials), [], "a route save is not a network action");
  assert.equal(sync.status().routes.length, 2, "status reads the newly saved routes");
  await sync.sync();
  assert.equal(net.feedDials.length, 2);
  const before = net.sessions.length;
  await sync.routesChanged();
  await until(() => net.sessions.length === before + 2, "a running feed restarts on a route change");
  await sync.stop();
  console.log("PASS a route save is not a network action; a running feed restarts on change");
}

// ---- 6. status copy -----------------------------------------------------------------------------------
{
  const space = "replica:treehouse:space:abc#root:xyz";
  const thread = "replica:treehouse:thread:def#root:xyz";
  const feed = (over: Partial<TreehouseFeedState["routes"][number]>): TreehouseFeedState => ({
    configured: true,
    routes: [
      { replica: space, connection: "live", pending: 2, acked: 5, generation: 7, matchesRelay: true, message: "Relay subscription is live.", ...over },
      { replica: thread, connection: "refused", pending: 0, acked: 1, generation: null, matchesRelay: null, message: "Relay refused: carrier hello pubkey mismatch" },
    ],
  });
  const view = describeSyncStatus(feed({}));
  assert.equal(view.configured, true);
  assert.equal(view.routes[0]!.kind, "Group");
  assert.equal(view.routes[1]!.kind, "Thread");
  assert.equal(view.routes[0]!.pending, 2);
  assert.equal(view.routes[0]!.acked, 5);
  assert.match(view.routes[0]!.connectionLabel, /live/i);
  assert.match(view.routes[1]!.connectionLabel, /refused/i);
  assert.match(view.routes[0]!.holdsRelayLabel, /relay/i);
  assert.equal(view.routes[1]!.holdsRelayLabel, "Not synced yet.");
  assert.match(view.summary, /2 operations waiting/);
  const none = describeSyncStatus({ configured: false, routes: [] });
  assert.equal(none.configured, false);
  assert.match(none.summary, /no relay routes/i);
  const clean = describeSyncStatus(feed({ pending: 0 }));
  assert.match(clean.summary, /acknowledged/i);
  const text = JSON.stringify([view, none, clean]).toLowerCase();
  for (const forbidden of ["converged", "everyone has", "peers have", "guarantee", "decentralized", "provisioned"])
    assert(!text.includes(forbidden), `status copy must not say: ${forbidden}`);
  console.log("PASS status copy states relay facts only, never peer convergence");
}
console.log("\nTreehouse panel sync: all sections passed");
