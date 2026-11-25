import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CarrierRoute } from "@treetopdevs/lattice-shell-kit";
import { SPACE_EXPORT_FORMAT } from "@treetopdevs/lattice-client";
import { buildGroup, heads } from "../support/group_fixture";
import type { Group, TestIdentity } from "../support/group_fixture";
import { connectAs, startLocalRelay } from "../support/local_relay";
import type { LocalRelay } from "../support/local_relay";
import { nodeSqliteDb } from "../support/node_sqlite";
import type { NodeSqliteDb } from "../support/node_sqlite";

// M1a.7 stage 1: the app's composition root over the real adapters. The app session opens a SqliteReplicaStore
// (node:sqlite here, expo-sqlite on the phone), carries the M0 snapshot over before the session opens, and
// syncs only through the session's gated mergeSync. References: the local BEAM relay's own advertised ids
// (a separate client, not the app), the fixture's Space frame ids, and the bytes of the database file.

type AppModule = typeof import("../../src/native/app_session");

async function load(): Promise<AppModule> {
  return import("../../src/native/app_session");
}

function mobile(identity: TestIdentity) {
  return {
    realm: identity.realm,
    publicKey: identity.signer.publicKey,
    publicKeyBase64: identity.pubkey,
    fingerprint: identity.pubkey.replace(/[^A-Za-z0-9]/g, "").slice(0, 10),
    color: "#000000",
    source: "demo-seed" as const,
    signer: identity.signer as never,
  };
}

function routesOf(group: Group, relay: LocalRelay) {
  return relay.routes.map((r: CarrierRoute) => ({
    ...r,
    product: r.replica === group.space.replica ? ("Treehouse.Space" as const) : ("Treehouse.Thread" as const),
  }));
}

async function relayIds(identity: TestIdentity, route: CarrierRoute): Promise<string[]> {
  const client = await connectAs(identity, route);
  try {
    return [...(await client.advertise())].sort();
  } finally {
    client.close();
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function dir(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "treehouse-app-session-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function deps(root: string, legacy: NodeSqliteDb | null, localDisk?: unknown) {
  const { openMemoryLocalStore, MemoryLocalDisk } = await import("../../src/local/local_store");
  const { readLegacyProfiles } = await import("../../src/native/legacy_snapshot");
  const opened: NodeSqliteDb[] = [];
  return {
    opened,
    deps: {
      local: await openMemoryLocalStore((localDisk as InstanceType<typeof MemoryLocalDisk>) ?? new MemoryLocalDisk()),
      clock: { now: () => Date.now() },
      openReplicaDb: async (name: string) => {
        const db = nodeSqliteDb(join(root, name));
        opened.push(db);
        return db;
      },
      readLegacyProfiles: async (namespace: string) => (legacy ? readLegacyProfiles(legacy, namespace) : null),
      link: { pollMs: 0 },
    },
  };
}

/** The M0 host's snapshot table, as src/native/storage.ts wrote it (namespace, payload, updated_at). */
function writeLegacy(path: string, namespace: string, profiles: Record<string, unknown>): NodeSqliteDb {
  const db = nodeSqliteDb(path);
  void db.execAsync(
    "CREATE TABLE IF NOT EXISTS snapshots (namespace TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  void db.runAsync(
    "INSERT INTO snapshots (namespace, payload, updated_at) VALUES (?, ?, ?)",
    namespace,
    JSON.stringify({ version: 1, namespace, profiles }),
    1,
  );
  return db;
}

async function dumpReplicaFile(path: string): Promise<string> {
  const db = nodeSqliteDb(path);
  try {
    const replicas = await db.getAllAsync("SELECT replica, product FROM replica ORDER BY rowid");
    const frames = await db.getAllAsync("SELECT replica, id, seq, json, authored, acked, first_seen_ms FROM frame ORDER BY replica, seq");
    const meta = await db.getAllAsync("SELECT key, value FROM meta ORDER BY key");
    return JSON.stringify({ replicas, frames, meta });
  } finally {
    db.close();
  }
}

test("the app session carries an unsynced M0 post over before open, and it reaches the relay", async (t) => {
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());
  const root = dir(t);

  // The M0 host saved a post offline: in the thread profile and its outbox, never sent.
  const post = await member.post(group.thread.frames, "written before the store switch");
  const identity = mobile(member);
  const legacy = writeLegacy(join(root, "treehouse_mobile_v1.db"), app.legacyNamespace(identity), {
    [group.space.replica]: { frames: group.space.frames, outbox: [], acked: [] },
    [group.thread.replica]: { frames: [...group.thread.frames, post], outbox: [post.id], acked: [] },
  });
  const legacyBefore = JSON.stringify(await legacy.getAllAsync("SELECT namespace, payload, updated_at FROM snapshots"));
  const threadRoute = relay.routes.find((r) => r.replica === group.thread.replica)!;
  assert.ok(!(await relayIds(group.admin, threadRoute)).includes(post.id), "the relay does not hold the M0 post yet");

  const { deps: d } = await deps(root, legacy);
  const opened = await app.openAppSession(d, { identity, routes: routesOf(group, relay) });
  t.after(() => opened.close());
  assert.deepEqual(opened.carryOver && opened.carryOver.ok, true);
  assert.equal(opened.session.read().status.phase, "member");

  await until(async () => (await relayIds(group.admin, threadRoute)).includes(post.id), "the carried post on the relay");
  await until(() => opened.session.read().linkStatus.waiting === 0, "the outbox to be acknowledged");
  const mine = opened.session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === post.id);
  assert.equal(mine?.delivery, "on_relay");
  // The M0 snapshot is read, never written.
  assert.equal(JSON.stringify(await legacy.getAllAsync("SELECT namespace, payload, updated_at FROM snapshots")), legacyBefore);
});

test("a post survives a relaunch over the same replica file and then reaches the relay", async (t) => {
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());
  const root = dir(t);
  const identity = mobile(member);
  const threadRoute = relay.routes.find((r) => r.replica === group.thread.replica)!;
  const fixtureThreadIds = group.thread.frames.map((f) => f.id).sort();
  const { MemoryLocalDisk } = await import("../../src/local/local_store");
  const localDisk = new MemoryLocalDisk();

  const { deps: first } = await deps(root, null, localDisk);
  const a = await app.openAppSession(first, { identity, routes: routesOf(group, relay) });
  await until(() => a.session.read().timelines[group.thread.replica]?.canPost === true, "the thread pulled and postable");
  const off = await a.session.goOffline();
  assert.equal(off.ok, true);
  const posted = await a.session.postMessage(group.thread.replica, "saved while offline, then relaunched");
  assert.ok(posted.ok);
  const id = posted.value.id;
  assert.equal(a.session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)?.delivery, "saved");
  await a.close();
  assert.deepEqual(await relayIds(group.admin, threadRoute), fixtureThreadIds, "nothing was sent while offline");

  // Relaunch: a new process opens the same file. The person turned sync back on.
  const { deps: second } = await deps(root, null, localDisk);
  const b = await app.openAppSession(second, { identity, routes: routesOf(group, relay) });
  t.after(() => b.close());
  assert.equal(b.session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)?.delivery, "saved");
  assert.equal(b.session.read().linkStatus.pill, "offline", "sync stays off across the relaunch, as the person left it");
  assert.equal((await b.session.goOnline()).ok, true);
  await until(async () => (await relayIds(group.admin, threadRoute)).includes(id), "the post on the relay");
  await until(() => b.session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === id)?.delivery === "on_relay", "on_relay");
  assert.deepEqual(await relayIds(group.admin, threadRoute), [...fixtureThreadIds, id].sort());
});

test("history_invalid offers the held Space frames as a D-31 export, and re-sync fills a fresh store from the relay", async (t) => {
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());
  const root = dir(t);
  const identity = mobile(member);
  const { MemoryLocalDisk } = await import("../../src/local/local_store");
  const localDisk = new MemoryLocalDisk();

  const { deps: first } = await deps(root, null, localDisk);
  const a = await app.openAppSession(first, { identity, routes: routesOf(group, relay) });
  await until(
    () => (a.session.read().timelines[group.thread.replica]?.health.ops ?? 0) === group.thread.frames.length,
    "the thread pulled",
  );
  await a.close();

  // Tamper one held Thread frame's signature on disk (a damaged file, not an app path).
  const file = join(root, app.replicaStoreName(identity.publicKeyBase64, 0));
  const raw = nodeSqliteDb(file);
  const victim = group.thread.frames[1]!;
  const sig = victim.sig.startsWith("A") ? `B${victim.sig.slice(1)}` : `A${victim.sig.slice(1)}`;
  await raw.runAsync("UPDATE frame SET json = ? WHERE id = ?", JSON.stringify({ ...victim, sig }), victim.id);
  raw.close();
  const damaged = await dumpReplicaFile(file);

  const { deps: second } = await deps(root, null, localDisk);
  const b = await app.openAppSession(second, { identity, routes: routesOf(group, relay) });
  const status = b.session.read().status;
  assert.equal(status.phase, "history_invalid");
  assert.equal(status.replica, group.thread.replica);
  assert.ok(b.session.read().link.routes.every((r) => r.connection === "idle"), "history_invalid never goes online");

  // Export: the D-31 shape, the fixture's Space ids, rooted at the admin who created the Space.
  const exported = await b.session.exportSpaceFrames();
  assert.ok(exported.ok, JSON.stringify(exported));
  const doc = JSON.parse(exported.value.text) as { format: string; space: string; root: string; frames: { id: string }[] };
  assert.equal(doc.format, SPACE_EXPORT_FORMAT);
  assert.equal(doc.space, group.space.replica);
  assert.equal(doc.root, group.admin.pubkey);
  assert.deepEqual(doc.frames.map((f) => f.id), group.space.frames.map((f) => f.id).sort());
  assert.match(exported.value.fileName, /^treehouse-space-[A-Za-z0-9]+\.frames\.json$/);

  // Re-sync after confirmation: a fresh store, filled from the relay; the failed store is untouched.
  const c = await b.resync();
  t.after(() => c.close());
  assert.equal(c.epoch, 1);
  await until(() => c.session.read().status.phase === "member", "the fresh store verified");
  const threadRoute = relay.routes.find((r) => r.replica === group.thread.replica)!;
  await until(
    () => (c.session.read().timelines[group.thread.replica]?.health.ops ?? 0) === group.thread.frames.length,
    "the fresh thread pulled",
  );
  const held = c.session.read().timelines[group.thread.replica]!;
  assert.equal(held.health.ops, (await relayIds(group.admin, threadRoute)).length);
  assert.equal(await dumpReplicaFile(file), damaged, "the failed store is not deleted or rewritten");

  // The pointer is per identity: a relaunch opens the fresh store again.
  await c.close();
  const { deps: third } = await deps(root, null, localDisk);
  const d = await app.openAppSession(third, { identity, routes: routesOf(group, relay) });
  t.after(() => d.close());
  assert.equal(d.epoch, 1);
  assert.equal(d.session.read().status.phase, "member");
  assert.equal(app.epochFor(third.local, group.admin.pubkey), 0, "another identity keeps its own store");
});

test("re-sync is refused while the held history is fine", async (t) => {
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const relay = await startLocalRelay(group, [group.admin]);
  t.after(() => relay.kill());
  const { deps: d } = await deps(dir(t), null);
  const a = await app.openAppSession(d, { identity: mobile(group.admin), routes: routesOf(group, relay) });
  t.after(() => a.close());
  await assert.rejects(a.resync(), /history_ok/);
  assert.equal(a.epoch, 0);
});

test("an M0 snapshot that fails verification is history_invalid, never online; a confirmed re-sync skips it", async (t) => {
  // Review (M1a.7 close): a failed carry-over was only a notice, so the app looked healthy and went online
  // while the unsent M0 posts it could not carry stayed behind. 03: a verify failure on launch is history_invalid.
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());
  const root = dir(t);
  const post = await member.post(group.thread.frames, "written before the store switch");
  const identity = mobile(member);
  const victim = group.thread.frames[1]!;
  const sig = victim.sig.startsWith("A") ? `B${victim.sig.slice(1)}` : `A${victim.sig.slice(1)}`;
  const tampered = group.thread.frames.map((f) => (f.id === victim.id ? { ...f, sig } : f));
  const legacy = writeLegacy(join(root, "treehouse_mobile_v1.db"), app.legacyNamespace(identity), {
    [group.space.replica]: { frames: group.space.frames, outbox: [], acked: [] },
    [group.thread.replica]: { frames: [...tampered, post], outbox: [post.id], acked: [] },
  });
  const { MemoryLocalDisk } = await import("../../src/local/local_store");
  const localDisk = new MemoryLocalDisk();
  const { deps: first } = await deps(root, legacy, localDisk);
  const a = await app.openAppSession(first, { identity, routes: routesOf(group, relay) });
  t.after(() => a.close());
  assert.equal(a.carryOver?.ok, false);
  assert.equal(a.session.read().status.phase, "history_invalid");
  assert.ok(a.session.read().link.routes.every((r) => r.connection === "idle"), "a failed carry-over never goes online");
  assert.deepEqual((await a.session.postMessage(group.thread.replica, "x")).ok, false);

  // The person confirms re-sync: the fresh store does not re-import the M0 snapshot, so it can be left.
  const b = await a.resync();
  t.after(() => b.close());
  assert.equal(b.epoch, 1);
  assert.equal(b.carryOver, null);
  await until(() => b.session.read().status.phase === "member", "the fresh store verified");
});

test("a re-sync that cannot persist its pointer leaves the failed session open and usable", async (t) => {
  // Review (M1a.7 close): resync closed the session before persisting the epoch, so a storage failure left
  // the UI bound to a closed session (export refused not_open).
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const relay = await startLocalRelay(group, [group.admin, member]);
  t.after(() => relay.kill());
  const root = dir(t);
  const identity = mobile(member);
  const { MemoryLocalDisk } = await import("../../src/local/local_store");
  const localDisk = new MemoryLocalDisk();
  const { deps: first } = await deps(root, null, localDisk);
  const a = await app.openAppSession(first, { identity, routes: routesOf(group, relay) });
  await until(() => (a.session.read().timelines[group.thread.replica]?.health.ops ?? 0) === group.thread.frames.length, "pulled");
  await a.close();
  const file = join(root, app.replicaStoreName(identity.publicKeyBase64, 0));
  const raw = nodeSqliteDb(file);
  const victim = group.thread.frames[1]!;
  const sig = victim.sig.startsWith("A") ? `B${victim.sig.slice(1)}` : `A${victim.sig.slice(1)}`;
  await raw.runAsync("UPDATE frame SET json = ? WHERE id = ?", JSON.stringify({ ...victim, sig }), victim.id);
  raw.close();

  const { deps: second } = await deps(root, null, localDisk);
  const b = await app.openAppSession(second, { identity, routes: routesOf(group, relay) });
  t.after(() => b.close());
  assert.equal(b.session.read().status.phase, "history_invalid");
  second.local.setSetting = async () => {
    throw new Error("storage_failed");
  };
  await assert.rejects(b.resync(), /storage_failed/);
  const exported = await b.session.exportSpaceFrames();
  assert.ok(exported.ok, `the failed session stays open: ${JSON.stringify(exported)}`);
  assert.equal(app.epochFor(second.local, identity.publicKeyBase64), 0);
});

test("a route whose product conflicts with the held replica is reported, not swallowed", async (t) => {
  const app = await load();
  const group = await buildGroup({ members: 1 });
  const relay = await startLocalRelay(group, [group.admin]);
  t.after(() => relay.kill());
  const root = dir(t);
  const identity = mobile(group.admin);
  const { MemoryLocalDisk } = await import("../../src/local/local_store");
  const localDisk = new MemoryLocalDisk();
  const { deps: first } = await deps(root, null, localDisk);
  const a = await app.openAppSession(first, { identity, routes: routesOf(group, relay) });
  assert.deepEqual(a.adoptFailed, []);
  await a.close();
  const swapped = routesOf(group, relay).map((r) =>
    r.replica === group.thread.replica ? { ...r, product: "Treehouse.Space" as const } : r,
  );
  const { deps: second } = await deps(root, null, localDisk);
  const b = await app.openAppSession(second, { identity, routes: swapped });
  t.after(() => b.close());
  assert.deepEqual(b.adoptFailed, [{ replica: group.thread.replica, reason: "replica_product_mismatch" }]);
});

test("export of a Space genesis frame without deps is a typed export_failed, not a throw", async () => {
  const { exportSpaceFrames } = await import("../../src/session/commands/export_space");
  const group = await buildGroup({ members: 1 });
  const frames = group.space.frames.map((f) => (f.deps.length === 0 ? ({ ...f, deps: undefined } as unknown as typeof f) : f));
  const store = {
    replicas: () => [{ replica: group.space.replica, product: "Treehouse.Space" as const }],
    profile: () => ({ frames, outbox: [], acked: [] }),
  } as unknown as Parameters<typeof exportSpaceFrames>[0];
  assert.deepEqual(await exportSpaceFrames(store), { ok: false, reason: "export_failed" });
});

test("the app source has no merge path around the session and no M0 host or snapshot storage", async () => {
  const { existsSync, readFileSync, readdirSync, statSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  assert.equal(existsSync(join(src, "lib", "treehouse_mobile_host.ts")), false);
  assert.equal(existsSync(join(src, "lib", "host_session_ports.ts")), false);
  assert.equal(existsSync(join(src, "native", "storage.ts")), false);
  const files = (function walk(d: string): string[] {
    return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
  })(src);
  // Pulled frames reach a store only through the session host's gated mergeSync, or the verified carry-over.
  const allowed = new Set(["session/session.ts", "session/carry_over.ts", "session/ports.ts", "session/memory/replica_store.ts", "native/sqlite_replica_store.ts", "native/replica_store_device_check.ts"]);
  const callers = files
    .filter((f) => /\.mergeSync\(/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(src.length + 1))
    .filter((f) => !allowed.has(f));
  assert.deepEqual(callers, []);
});

void heads;
