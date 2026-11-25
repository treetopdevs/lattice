import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  createIdentityFromSeedHex,
  loadOrCreateDeviceIdentity,
  MemoryKeyStore,
} from "../../src/native/custody";
import { MemoryMobileStorage } from "../../src/native/storage";
import {
  DEFAULT_DEMO_WSS_ORIGIN,
  fetchDemoEndpoints,
  fetchDemoSeed,
  TreehouseMobileHost,
} from "../../src/lib/treehouse_mobile_host";

// Smoke gate against the public demo relay (moved from test/m0_wss_gate.mts in M1a.0). It reads only:
// the offline post is queued locally and never relayed. Set DEMO_WSS_WRITE=1 to also relay that post,
// which adds one message to a shared demo thread on every run.
const WRITE = process.env.DEMO_WSS_WRITE === "1";

const origin = (process.argv[2] || process.env.DEMO_WSS_ORIGIN || DEFAULT_DEMO_WSS_ORIGIN).replace(
  /\/$/,
  "",
);

async function run(): Promise<void> {
  // 1. Verify KeyStore device identity round-trip
  const keyStore = new MemoryKeyStore();
  const device1 = await loadOrCreateDeviceIdentity(keyStore, "mobile-device");
  const device2 = await loadOrCreateDeviceIdentity(keyStore, "mobile-device");
  assert.equal(device1.publicKeyBase64, device2.publicKeyBase64, "device identity must persist across loads");
  console.log(`KEYSTORE OK: device key ${device1.fingerprint} persisted`);

  // 2. Fetch manifest & founder demo seed from live Fly.io WSS testbed
  const manifest = await fetchDemoEndpoints(origin);
  const founderSeed = await fetchDemoSeed(origin, "founder");
  const founder = createIdentityFromSeedHex(founderSeed.realm, founderSeed.seedHex, "demo-seed");

  const realmByPubkey: Record<string, string> = {};
  for (const info of Object.values(manifest.participants)) {
    realmByPubkey[info.pubkey] = info.realm;
  }

  // 3. Connect TreehouseMobileHost over authenticated wss://
  const sharedStorage = new MemoryMobileStorage();
  const host = new TreehouseMobileHost({
    storage: sharedStorage,
    webSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  await host.configure(manifest.endpoints, founder, realmByPubkey);
  const feedState = await host.goOnline();

  assert.equal(feedState.configured, true, "feed should be configured");
  assert.equal(host.getEndpoints().length, 2, "expected Space + Thread Treehouse routes");

  const spaceEp = host.getSpaceEndpoint();
  const threadEp = host.getThreadEndpoint();
  assert.ok(spaceEp, "Treehouse.Space endpoint missing");
  assert.ok(threadEp, "Treehouse.Thread endpoint missing");
  assert.ok(spaceEp.ws_url.startsWith("wss://"), `expected wss:// for Space, got ${spaceEp.ws_url}`);
  assert.ok(threadEp.ws_url.startsWith("wss://"), `expected wss:// for Thread, got ${threadEp.ws_url}`);

  // 4. Observe verified Space & Thread projections
  const spaceView = host.observeSpace(spaceEp.replica);
  assert.equal(spaceView.name, "Canopy Demo Space", `unexpected space name: ${spaceView.name}`);
  assert.ok(spaceView.members.length >= 1, `expected >= 1 admitted member, got ${spaceView.members.length}`);
  assert.equal(spaceView.quarantinedCount, 0, `expected 0 quarantined ops on Space, got ${spaceView.quarantinedCount}`);
  console.log(
    `SPACE OK: "${spaceView.name}" (${spaceView.opCount} ops, ${spaceView.members.length} admitted member(s), 0 quarantined)`,
  );

  const threadBefore = host.observeThread(threadEp.replica);
  assert.ok(threadBefore.posts.length >= 1, `expected >= 1 thread post, got ${threadBefore.posts.length}`);
  assert.equal(threadBefore.canPost, true, "founder should have post capability");
  console.log(
    `THREAD OK: "#${threadBefore.title}" (${threadBefore.posts.length} posts, ${threadBefore.opCount} ops)`,
  );

  // 5. Go offline, author a signed post locally, verify outbox queueing & restart persistence
  await host.goOffline();
  assert.equal(host.isOnline(), false, "host should be offline");

  const offlineText = `[M0 offline persistence check ${Date.now()}]`;
  const queuedFrame = await host.postMessage(threadEp.replica, offlineText);
  const threadOffline = host.observeThread(threadEp.replica);
  assert.equal(threadOffline.pendingCount, 1, "expected 1 pending offline post in outbox");
  assert.ok(
    threadOffline.posts.some((p) => p.id === queuedFrame.id && p.pending && p.text === offlineText),
    "offline post should appear immediately as pending in observed thread",
  );
  await host.dispose();

  // Simulate app relaunch with a fresh host sharing the same durable storage
  const restartedHost = new TreehouseMobileHost({
    storage: sharedStorage,
    webSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  await restartedHost.configure(manifest.endpoints, founder, realmByPubkey);
  const threadAfterRestart = restartedHost.observeThread(threadEp.replica);
  assert.equal(threadAfterRestart.pendingCount, 1, "pending offline post must survive app restart");
  assert.ok(
    threadAfterRestart.posts.some((p) => p.id === queuedFrame.id && p.pending && p.text === offlineText),
    "offline post must remain visible after app restart",
  );
  console.log("OFFLINE OUTBOX OK: queued signed op persisted across simulated app restart");
  if (WRITE) {
    await restartedHost.goOnline();
    await restartedHost.syncNow();
    assert.equal(restartedHost.getPendingCount(threadEp.replica), 0, "DEMO_WSS_WRITE: queued post relayed");
    console.log("WRITE OK: queued post relayed to the demo thread (DEMO_WSS_WRITE=1)");
  } else {
    console.log("READ ONLY: queued post not relayed (set DEMO_WSS_WRITE=1 to relay it)");
  }
  await restartedHost.dispose();
  console.log(`PASS: M0 mobile gate verified against ${origin}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
