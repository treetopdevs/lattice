import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.7 stage 1: the dev-build pointer to a loopback relay. A script under test/support serves the two routes
// the demo code fetches (/demo-endpoints.json, /demo-seed/<role>) in front of the local BEAM relay fixture, so
// a simulator run can post without touching the public demo relay. References: the manifest's public keys
// (never a seed value), and the relay's own advertised ids.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(APP, "src");

test("the loopback demo server serves the manifest and seeds the demo code reads, in front of the local relay", async (t) => {
  const { startLoopbackDemo } = await import("../support/loopback_demo");
  const { fetchDemoEndpoints, demoRealmByPubkey } = await import("../../src/demo/manifest");
  const { loadDemoIdentity } = await import("../../src/demo/identities");
  const server = await startLoopbackDemo({ port: 0 });
  t.after(() => server.stop());
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const manifest = await fetchDemoEndpoints(server.origin);
  assert.equal(manifest.mode, "loopback");
  const products = manifest.endpoints.map((e) => e.product).sort();
  assert.deepEqual(products, ["Treehouse.Space", "Treehouse.Thread"]);
  for (const ep of manifest.endpoints) assert.match(ep.ws_url, /^ws:\/\/127\.0\.0\.1:\d+\/carrier$/);

  // Each served seed yields the key the manifest names (compared by public key, never by seed).
  for (const role of ["founder", "neighbor"] as const) {
    const identity = await loadDemoIdentity(server.origin, role);
    assert.equal(identity.publicKeyBase64, manifest.participants[role]!.pubkey);
    assert.equal(demoRealmByPubkey(manifest)[identity.publicKeyBase64], identity.realm);
  }
  const missing = await fetch(`${server.origin}/demo-seed/observer`);
  assert.equal(missing.status, 404);

  // The neighbor posts through the app session; the relay (through the server's own peer) holds it.
  const { openAppSession } = await import("../../src/native/app_session");
  const { openMemoryLocalStore } = await import("../../src/local/local_store");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { nodeSqliteDb } = await import("../support/node_sqlite");
  const root = mkdtempSync(join(tmpdir(), "treehouse-loopback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const neighbor = await loadDemoIdentity(server.origin, "neighbor");
  const routes = manifest.endpoints.map((ep) => ({
    replica: ep.replica,
    product: ep.product as "Treehouse.Space" | "Treehouse.Thread",
    url: ep.ws_url,
    expectedPeerRealm: ep.peer_realm,
    expectedPeerPubkey: ep.peer_pubkey,
  }));
  const opened = await openAppSession(
    {
      local: await openMemoryLocalStore(),
      clock: { now: () => Date.now() },
      openReplicaDb: async (name) => nodeSqliteDb(join(root, name)),
      readLegacyProfiles: async () => null,
      link: { pollMs: 0 },
    },
    { identity: neighbor, routes },
  );
  t.after(() => opened.close());
  const thread = routes.find((r) => r.product === "Treehouse.Thread")!.replica;
  const end = Date.now() + 15_000;
  while (opened.session.read().linkStatus.pill !== "live" || !opened.session.read().timelines[thread]?.canPost) {
    if (Date.now() > end) throw new Error(`not live: ${JSON.stringify(opened.session.read().linkStatus)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const posted = await opened.session.postMessage(thread, "loopback check");
  assert.ok(posted.ok, JSON.stringify(posted));
  const id = posted.value.id;
  while (!(await server.relayIds("thread")).includes(id)) {
    if (Date.now() > end + 15_000) throw new Error("post never reached the loopback relay");
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("the demo origin pointer is loopback only, and is read only inside src/demo", async () => {
  const { DEFAULT_DEMO_WSS_ORIGIN, demoOrigin } = await import("../../src/demo/manifest");
  assert.equal(demoOrigin(undefined), DEFAULT_DEMO_WSS_ORIGIN);
  assert.equal(demoOrigin(""), DEFAULT_DEMO_WSS_ORIGIN);
  assert.equal(demoOrigin("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  assert.equal(demoOrigin("http://localhost:4100/"), "http://localhost:4100");
  // Never a fallback to the public relay: a pointer that is not loopback is refused outright.
  assert.throws(() => demoOrigin("https://lattice-demo-wss.fly.dev"), /loopback/);
  assert.throws(() => demoOrigin("http://192.168.1.5:4100"), /loopback/);

  const files = (function walk(d: string): string[] {
    return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
  })(SRC);
  const readers = files.filter((f) => readFileSync(f, "utf8").includes("EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN")).map((f) => relative(APP, f));
  assert.deepEqual(readers, ["src/demo/manifest.ts"]);
  // The pointer is read by dot notation, so Metro inlines it (and only into a bundle that requires src/demo).
  assert.match(readFileSync(join(SRC, "demo", "manifest.ts"), "utf8"), /process\.env\.EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN\b/);
  assert.ok(existsSync(join(APP, "test", "support", "loopback_demo_server.mts")), "the runnable server script exists");
});
