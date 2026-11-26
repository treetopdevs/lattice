import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteConnection, RouteFeedState } from "@treetopdevs/lattice-shell-kit/sync";

// M1a.4 LinkStatus: one Group pill from per-route states (03, "Connection state"), Space as the anchor.
// Overlaps in 03's table are resolved by a fixed precedence: offline, relay refused, reconnecting,
// live, partly connected, connecting.

const SPACE = "replica:treehouse:space:s";
const T1 = "replica:treehouse:thread:a";
const T2 = "replica:treehouse:thread:b";

const route = (replica: string, connection: RouteConnection, pending = 0): RouteFeedState => ({
  replica,
  connection,
  pending,
  acked: 0,
  generation: null,
  matchesRelay: null,
  refused: [],
  submitStopped: null,
  message: "",
});

test("link status reduces route states to one pill per the table in 03", async () => {
  const { projectLinkStatus } = await import("../../src/session/projections/link_status");
  const pill = (routes: RouteFeedState[], syncEnabled = true) =>
    projectLinkStatus({ feed: { configured: true, routes }, space: SPACE, syncEnabled, waiting: 0, lastSyncMs: null }).pill;

  assert.equal(pill([route(SPACE, "live"), route(T1, "live"), route(T2, "live")]), "live");
  assert.equal(pill([route(SPACE, "connecting"), route(T1, "live")]), "connecting");
  assert.equal(pill([route(SPACE, "live"), route(T1, "reconnecting")]), "reconnecting", "reconnecting outranks partly connected");
  assert.equal(pill([route(SPACE, "reconnecting"), route(T1, "connecting")]), "reconnecting");
  assert.equal(pill([route(SPACE, "live"), route(T1, "connecting")]), "partly_connected");
  assert.equal(pill([route(SPACE, "live"), route(T1, "refused")]), "partly_connected", "a refused Thread route only partly connects");
  assert.equal(pill([route(SPACE, "refused"), route(T1, "live")]), "relay_refused", "the Space route is the anchor");
  assert.equal(pill([route(SPACE, "refused"), route(T1, "reconnecting")]), "relay_refused", "relay refused dominates");
  assert.equal(pill([route(SPACE, "idle"), route(T1, "idle")]), "offline");
  assert.equal(pill([route(SPACE, "live"), route(T1, "live")], false), "offline", "sync turned off");
  assert.equal(projectLinkStatus({ feed: { configured: false, routes: [] }, space: null, syncEnabled: true, waiting: 0, lastSyncMs: null }).pill, "offline");

  const status = projectLinkStatus({
    feed: { configured: true, routes: [route(SPACE, "live"), route(T1, "live", 2)] },
    space: SPACE,
    syncEnabled: true,
    waiting: 2,
    lastSyncMs: 5_000,
  });
  assert.equal(status.waiting, 2, "the waiting count is appended to the pill");
  assert.equal(status.lastSyncMs, 5_000);
  assert.deepEqual(status.routes.map((r) => [r.replica, r.connection, r.waiting]), [
    [SPACE, "live", 0],
    [T1, "live", 2],
  ]);
});

test("relay access follows the Space route", async () => {
  const { relayAccess } = await import("../../src/session/projections/link_status");
  assert.equal(relayAccess({ configured: false, routes: [] }, SPACE), "no_group");
  assert.equal(relayAccess({ configured: true, routes: [route(SPACE, "refused")] }, SPACE), "no_relay_access");
  assert.equal(relayAccess({ configured: true, routes: [route(SPACE, "live")] }, SPACE), "admitted");
  assert.equal(relayAccess({ configured: true, routes: [route(SPACE, "connecting")] }, SPACE), "checking");
});
