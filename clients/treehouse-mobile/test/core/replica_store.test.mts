import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { ContractAssert, ContractHarness } from "./replica_store_contract.mjs";

// M1a.2: the ReplicaStore contract against the memory adapter and against the SQLite adapter over
// node:sqlite (Node >= 22.13). The node:sqlite run proves the adapter's SQL and transaction use, not
// expo-sqlite itself; the same contract runs inside a dev build on the simulator for that.
// Modules load inside each test so a missing layer fails its own named test.

const contractAssert: ContractAssert = {
  equal: (a, b, m) => assert.equal(a, b, m),
  deepEqual: (a, b, m) => assert.deepEqual(a, b, m),
  ok: (v, m) => assert.ok(v, m),
  rejects: (p, re, m) => assert.rejects(p, re, m),
};

type SqlParam = string | number | null;

/** expo-sqlite's async surface, as the adapter uses it, over node:sqlite. `failOn` injects a statement failure. */
function nodeSqliteDb(path: string, opts: { failOn?: RegExp; statements?: string[] } = {}) {
  const db = new DatabaseSync(path);
  const check = (sql: string) => {
    opts.statements?.push(sql);
    if (opts.failOn?.test(sql)) throw new Error(`injected failure: ${sql.slice(0, 40)}`);
  };
  return {
    async execAsync(sql: string) {
      check(sql);
      db.exec(sql);
    },
    async runAsync(sql: string, ...params: SqlParam[]) {
      check(sql);
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, ...params: SqlParam[]) {
      check(sql);
      return db.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec("BEGIN");
      try {
        await task();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}

async function fixtureThread(): Promise<{ replica: string; frames: CarrierOpFrame[] }> {
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  assert.ok(group.thread.frames.length >= 3, "the fixture Thread has at least three frames");
  return group.thread;
}

async function memoryHarness(): Promise<ContractHarness> {
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  return {
    thread: await fixtureThread(),
    async fresh(startMs) {
      const disk = new MemoryReplicaDisk();
      const clock = new ManualClock(startMs);
      return {
        advance: (ms) => clock.advance(ms),
        async openStore() {
          const store = new MemoryReplicaStore(disk, clock);
          await store.open();
          return store;
        },
      };
    },
  };
}

const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "treehouse-replicas-"));
  tempDirs.push(dir);
  return join(dir, "replicas.db");
}

async function sqliteHarness(): Promise<ContractHarness> {
  const { SqliteReplicaStore } = await import("../../src/native/sqlite_replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  return {
    thread: await fixtureThread(),
    async fresh(startMs) {
      const path = tempDb();
      const clock = new ManualClock(startMs);
      return {
        advance: (ms) => clock.advance(ms),
        async openStore() {
          const store = new SqliteReplicaStore(async () => nodeSqliteDb(path), clock);
          await store.open();
          return store;
        },
      };
    },
  };
}

// The named contract tests, each against both adapters.
const { REPLICA_STORE_CONTRACT } = await import("./replica_store_contract.mjs");
for (const c of REPLICA_STORE_CONTRACT) {
  test(c.name, async (t) => {
    await t.test("memory adapter", async () => c.run(await memoryHarness(), contractAssert));
    await t.test("sqlite adapter (node:sqlite)", async () => c.run(await sqliteHarness(), contractAssert));
  });
}

test("no statement deletes or updates frame json", () => {
  const raw = readFileSync(new URL("../../src/native/sqlite_replica_store.ts", import.meta.url), "utf8");
  // Comments first, so an apostrophe in prose cannot open a "string" that hides a statement.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sql = [...source.matchAll(/(["'`])((?:(?!\1)[\s\S])*)\1/g)].map((m) => m[2]!).filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA|DROP|REPLACE|ALTER)\b/i.test(s));
  assert.ok(sql.length >= 5, "the scan found the adapter's statements");
  for (const statement of sql) {
    assert.doesNotMatch(statement, /\bDELETE\b/i, `no DELETE: ${statement}`);
    assert.doesNotMatch(statement, /\bDROP\b/i, `no DROP: ${statement}`);
    assert.doesNotMatch(statement, /\bREPLACE\b/i, `no REPLACE: ${statement}`);
    assert.doesNotMatch(statement, /\bALTER\b/i, `no ALTER: ${statement}`);
    assert.doesNotMatch(statement, /ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i, `no upsert: ${statement}`);
    if (/\bUPDATE\b/i.test(statement)) {
      assert.match(
        statement,
        /^\s*UPDATE frame SET (authored|acked) = 1 WHERE replica = \? AND id = \? AND \1 = 0\s*$/,
        `the only updates move authored or acked from 0 to 1: ${statement}`,
      );
    }
  }
});

test("a statement failing mid-transaction leaves disk and the held profile unchanged", async () => {
  const { SqliteReplicaStore } = await import("../../src/native/sqlite_replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { replica, frames } = await fixtureThread();
  const path = tempDb();
  const clock = new ManualClock(1_000);
  const seed = new SqliteReplicaStore(async () => nodeSqliteDb(path), clock);
  await seed.open();
  await seed.adopt(replica, "Treehouse.Thread");
  await seed.mergeSync(replica, [frames[0]!], []);

  // The frame insert succeeds and the ack update then fails: the transaction must roll both back.
  const store = new SqliteReplicaStore(async () => nodeSqliteDb(path, { failOn: /SET acked/ }), clock);
  await store.open();
  const changes: string[] = [];
  store.onChange((r) => changes.push(r));
  const before = JSON.stringify(store.profile(replica));
  await assert.rejects(store.mergeSync(replica, [frames[1]!], [frames[0]!.id]), /injected failure/);
  assert.equal(JSON.stringify(store.profile(replica)), before, "the held profile is unchanged");
  assert.equal(store.firstSeenMs(replica, frames[1]!.id), undefined);
  assert.deepEqual(changes, [], "no change event");

  const failingAuthor = new SqliteReplicaStore(async () => nodeSqliteDb(path, { failOn: /SET authored/ }), clock);
  await failingAuthor.open();
  await assert.rejects(failingAuthor.appendAuthored(replica, frames[0]!), /injected failure/);
  assert.deepEqual(failingAuthor.profile(replica)?.outbox, []);

  const reopened = new SqliteReplicaStore(async () => nodeSqliteDb(path), clock);
  await reopened.open();
  assert.deepEqual(reopened.profile(replica), { frames: [frames[0]!], outbox: [], acked: [] }, "nothing reached disk");
});

test("the sqlite store refuses to open without falling back to memory", async () => {
  const { SqliteReplicaStore } = await import("../../src/native/sqlite_replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const unopenable = new SqliteReplicaStore(async () => {
    throw new Error("disk I/O error");
  }, new ManualClock(0));
  await assert.rejects(unopenable.open(), /disk I\/O error/);
  assert.deepEqual(unopenable.replicas(), []);

  // A database written by a later schema is refused, not reinterpreted.
  const path = tempDb();
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '99');");
  raw.close();
  const later = new SqliteReplicaStore(async () => nodeSqliteDb(path), new ManualClock(0));
  await assert.rejects(later.open(), /unsupported_schema_version/);
});

test("one database per identity: the name derives from the public key and is not the M0 snapshot file", async () => {
  const { replicaDbName } = await import("../../src/native/sqlite_replica_store");
  const a = replicaDbName("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  const b = replicaDbName("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=");
  assert.notEqual(a, b);
  assert.equal(a, replicaDbName("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
  assert.match(a, /^treehouse_replicas_v1_[0-9a-f]{32}\.db$/);
  assert.notEqual(a, "treehouse_mobile_v1.db");
});

test("the legacy snapshot's unsynced outbox is carried into the replica store", async () => {
  const { carryOverLegacyProfiles } = await import("../../src/session/carry_over");
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const post = await member.post(group.thread.frames, "saved before the upgrade");
  // The M0 snapshot shape: frames, outbox and acked per replica, no product and no first-seen times.
  const legacyThread = { frames: [...group.thread.frames, post], outbox: [post.id], acked: [] as string[] };
  const legacy = {
    [group.space.replica]: { frames: group.space.frames, outbox: [] as string[], acked: [] as string[] },
    [group.thread.replica]: legacyThread,
  };
  const disk = new MemoryReplicaDisk();
  const store = new MemoryReplicaStore(disk, new ManualClock(7_000));
  await store.open();
  const first = await carryOverLegacyProfiles(store, legacy);
  assert.deepEqual(first, { ok: true, carried: 2, skipped: [] });
  assert.deepEqual(store.replicas().map((r) => r.product).sort(), ["Treehouse.Space", "Treehouse.Thread"]);
  assert.deepEqual(store.profile(group.thread.replica)?.outbox, [post.id], "the unsynced post is still queued");
  assert.deepEqual(store.profile(group.thread.replica)?.frames.map((f) => f.id), legacyThread.frames.map((f) => f.id));
  assert.equal(store.firstSeenMs(group.thread.replica, post.id), 7_000, "carried frames are first seen at carry time");

  const snapshot = JSON.stringify([...disk.replicas]);
  assert.deepEqual(await carryOverLegacyProfiles(store, legacy), { ok: true, carried: 0, skipped: [] }, "a second carry adds nothing");
  assert.equal(JSON.stringify([...disk.replicas]), snapshot);
  assert.deepEqual(legacyThread.outbox, [post.id], "the legacy snapshot is not modified");
});

test("an invalid legacy snapshot is not carried and writes nothing", async () => {
  const { carryOverLegacyProfiles } = await import("../../src/session/carry_over");
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const disk = new MemoryReplicaDisk();
  const store = new MemoryReplicaStore(disk, new ManualClock(0));
  await store.open();
  const result = await carryOverLegacyProfiles(store, {
    [group.space.replica]: { frames: group.space.frames, outbox: [], acked: [] },
    // An outbox id the snapshot does not hold.
    [group.thread.replica]: { frames: group.thread.frames, outbox: ["missing"], acked: [] },
  });
  assert.deepEqual(result, { ok: false, replica: group.thread.replica, reason: "incomplete_retained_history" });
  assert.equal(disk.replicas.size, 0, "nothing was written");
});

test("a legacy profile is checked on its own before carry, even when the store already holds its frames", async () => {
  const { carryOverLegacyProfiles } = await import("../../src/session/carry_over");
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const post = await member.post(group.thread.frames, "already held");
  const disk = new MemoryReplicaDisk();
  const store = new MemoryReplicaStore(disk, new ManualClock(0));
  await store.open();
  const seeded = await carryOverLegacyProfiles(store, {
    [group.space.replica]: { frames: group.space.frames, outbox: [], acked: [] },
    [group.thread.replica]: { frames: [...group.thread.frames, post], outbox: [], acked: [] },
  });
  assert.equal(seeded.ok, true);
  const snapshot = JSON.stringify([...disk.replicas]);

  // The legacy outbox names a frame the legacy snapshot does not hold (the store does).
  const outboxOnly = await carryOverLegacyProfiles(store, {
    [group.space.replica]: { frames: group.space.frames, outbox: [], acked: [] },
    [group.thread.replica]: { frames: group.thread.frames, outbox: [post.id], acked: [] },
  });
  assert.deepEqual(outboxOnly, { ok: false, replica: group.thread.replica, reason: "incomplete_retained_history" });
  assert.equal(JSON.stringify([...disk.replicas]), snapshot, "nothing was written");

  // A legacy frame filed under the wrong replica, with an id the store already holds elsewhere.
  const misfiled = await carryOverLegacyProfiles(store, {
    [group.space.replica]: { frames: [...group.space.frames, post], outbox: [], acked: [] },
    [group.thread.replica]: { frames: group.thread.frames, outbox: [], acked: [] },
  });
  assert.deepEqual(misfiled, { ok: false, replica: group.space.replica, reason: "invalid_retained_history" });
  assert.equal(JSON.stringify([...disk.replicas]), snapshot, "nothing was written");
});
