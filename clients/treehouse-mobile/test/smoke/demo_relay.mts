import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createIdentityFromSeedHex, loadOrCreateDeviceIdentity, MemoryKeyStore } from "../../src/native/custody";
import { openAppSession } from "../../src/native/app_session";
import type { AppRoute, AppSessionDeps } from "../../src/native/app_session";
import { MemoryLocalDisk, openMemoryLocalStore } from "../../src/local/local_store";
import { DEFAULT_DEMO_WSS_ORIGIN, fetchDemoEndpoints } from "../../src/demo/manifest";
import { fetchDemoSeed } from "../../src/demo/identities";
import { nodeSqliteDb } from "../support/node_sqlite";

// Smoke gate against the public demo relay (moved from test/m0_wss_gate.mts in M1a.0; on the app session
// since M1a.7). It reads only: the link is stopped before the post, so the post stays saved on this machine
// and is never relayed. Set DEMO_WSS_WRITE=1 to also relay that post, which adds one message to a shared demo
// thread on every run.
const WRITE = process.env.DEMO_WSS_WRITE === "1";

const origin = (process.argv[2] || process.env.DEMO_WSS_ORIGIN || DEFAULT_DEMO_WSS_ORIGIN).replace(/\/$/, "");

async function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(): Promise<void> {
  // 1. KeyStore device identity round-trip.
  const keyStore = new MemoryKeyStore();
  const loaded1 = await loadOrCreateDeviceIdentity(keyStore, "mobile-device");
  const loaded2 = await loadOrCreateDeviceIdentity(keyStore, "mobile-device");
  assert.ok(loaded1.ok && loaded2.ok, "the memory key store answers");
  const device1 = loaded1.identity;
  const device2 = loaded2.identity;
  assert.equal(device1.publicKeyBase64, device2.publicKeyBase64, "device identity must persist across loads");
  console.log(`KEYSTORE OK: device key ${device1.fingerprint} persisted`);

  // 2. Manifest and the founder's public demo seed.
  const manifest = await fetchDemoEndpoints(origin);
  const founderSeed = await fetchDemoSeed(origin, "founder");
  const founder = createIdentityFromSeedHex(founderSeed.realm, founderSeed.seedHex, "demo-seed");
  const routes: AppRoute[] = manifest.endpoints
    .filter((ep) => ep.product === "Treehouse.Space" || ep.product === "Treehouse.Thread")
    .map((ep) => ({
      replica: ep.replica,
      product: ep.product as AppRoute["product"],
      url: ep.ws_url,
      expectedPeerRealm: ep.peer_realm,
      expectedPeerPubkey: ep.peer_pubkey,
    }));
  assert.equal(routes.length, 2, "expected Space + Thread Treehouse routes");
  for (const r of routes) assert.ok(r.url.startsWith("wss://"), `expected wss://, got ${r.url}`);
  const space = routes.find((r) => r.product === "Treehouse.Space")!.replica;
  const thread = routes.find((r) => r.product === "Treehouse.Thread")!.replica;

  // 3. The app session over SQLite files (node:sqlite) and a durable-for-the-run local store.
  const root = mkdtempSync(join(tmpdir(), "treehouse-smoke-"));
  const localDisk = new MemoryLocalDisk();
  const deps = async (): Promise<AppSessionDeps> => ({
    local: await openMemoryLocalStore(localDisk),
    clock: { now: () => Date.now() },
    openReplicaDb: async (name) => nodeSqliteDb(join(root, name)),
    readLegacyProfiles: async () => null,
    link: { webSocket: WebSocket as unknown as typeof globalThis.WebSocket },
  });
  try {
    const first = await openAppSession(await deps(), { identity: founder, routes });
    // The Space and the Thread sync on separate sockets: wait for both before asserting either.
    await until(
      () => first.session.read().group?.replica === space && (first.session.read().timelines[thread]?.messages.length ?? 0) >= 1,
      "the space and the thread pulled",
    );
    const models = first.session.read();
    assert.equal(models.group?.replica, space);
    assert.equal(models.group?.name, "Canopy Demo Space", `unexpected space name: ${models.group?.name}`);
    assert.equal(models.audit.replicas.find((r) => r.replica === space)?.quarantined.length, 0, "nothing quarantined on the Space");
    assert.equal(models.timelines[thread]!.canPost, true, "founder should have post capability");
    console.log(`SPACE OK: "${models.group?.name}" (${models.group?.memberCount} members)`);
    console.log(`THREAD OK: "#${models.timelines[thread]!.title}" (${models.timelines[thread]!.messages.length} posts)`);

    // 4. Stop the link first, then author: the post is saved, never relayed in read-only mode.
    assert.equal((await first.session.goOffline()).ok, true);
    const text = `[mobile offline persistence check ${Date.now()}]`;
    const posted = await first.session.postMessage(thread, text);
    assert.ok(posted.ok, JSON.stringify(posted));
    assert.equal(first.session.read().linkStatus.waiting, 1, "expected 1 waiting post");
    await first.close();

    // 5. Relaunch over the same files: still saved, still waiting, sync still off.
    const second = await openAppSession(await deps(), { identity: founder, routes });
    const mine = second.session.read().timelines[thread]!.messages.find((m) => m.id === posted.value.id);
    assert.equal(mine?.delivery, "saved", "the post must survive the relaunch as saved");
    assert.equal(second.session.read().linkStatus.pill, "offline");
    console.log("OFFLINE OUTBOX OK: saved post persisted across a relaunch over the same SQLite file");
    if (WRITE) {
      await second.session.goOnline();
      await until(() => second.session.read().linkStatus.waiting === 0, "the post relayed");
      console.log("WRITE OK: saved post relayed to the demo thread (DEMO_WSS_WRITE=1)");
    } else {
      console.log("READ ONLY: saved post not relayed (set DEMO_WSS_WRITE=1 to relay it)");
    }
    await second.close();
    console.log(`PASS: mobile smoke against ${origin}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
