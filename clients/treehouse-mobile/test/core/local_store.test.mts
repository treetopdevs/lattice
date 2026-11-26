import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.3: the LocalStore holds device-local facts only (petnames, drafts, read markers, settings). It is a
// separate database from the replica store, so a local fact can never be mistaken for a group fact.
// First-seen times are not here: ReplicaStore owns them (03). The same suite runs against the memory
// adapter and the SQLite adapter; in Node the SQLite adapter runs over node:sqlite through the same narrow
// db interface that expo-sqlite satisfies (typechecked in the adapter), so its SQL is real.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(APP, "src");

type LocalModule = typeof import("../../src/local/local_store");
type Store = Awaited<ReturnType<LocalModule["openMemoryLocalStore"]>>;

interface Adapter {
  name: string;
  /** A durable place that outlives one store object. */
  disk(): Promise<{ open(): Promise<Store>; close(): void }>;
}

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const adapters: Adapter[] = [
  {
    name: "memory",
    async disk() {
      const L = await import("../../src/local/local_store");
      const disk = new L.MemoryLocalDisk();
      return { open: () => L.openMemoryLocalStore(disk), close() {} };
    },
  },
  {
    name: "sqlite",
    async disk() {
      const S = await import("../../src/local/sqlite_local_store");
      const { DatabaseSync } = await import("node:sqlite");
      const dir = mkdtempSync(join(tmpdir(), "treehouse-local-"));
      temps.push(dir);
      const file = join(dir, S.LOCAL_DB_NAME);
      const handles: InstanceType<typeof DatabaseSync>[] = [];
      return {
        open() {
          const db = new DatabaseSync(file);
          handles.push(db);
          return S.openSqliteLocalStore(nodeSqlite(db));
        },
        close() {
          for (const db of handles.splice(0)) db.close();
        },
      };
    },
  },
];

type Bind = string | number | null;

/** node:sqlite in the shape of the adapter's db interface (the subset of expo-sqlite it uses). */
function nodeSqlite(db: import("node:sqlite").DatabaseSync) {
  const conn = {
    async execAsync(source: string) {
      db.exec(source);
    },
    async runAsync(source: string, ...params: Bind[]) {
      return db.prepare(source).run(...params);
    },
    async getAllAsync<T>(source: string, ...params: Bind[]) {
      return db.prepare(source).all(...params) as T[];
    },
  };
  return {
    ...conn,
    async withExclusiveTransactionAsync(task: (txn: typeof conn) => Promise<void>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        await task(conn);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

for (const adapter of adapters) {
  describe(`${adapter.name} adapter`, () => {
    test("petname round-trips and clears", async () => {
      const disk = await adapter.disk();
      try {
        const store = await disk.open();
        const kinds: string[] = [];
        store.onChange((kind) => kinds.push(kind));
        assert.equal(store.petname("pk-a"), null);
        await store.setPetname("pk-a", "Ana");
        assert.equal(store.petname("pk-a"), "Ana");
        assert.equal((await disk.open()).petname("pk-a"), "Ana", "durable across reopen");
        await store.setPetname("pk-a", "Ana");
        assert.deepEqual(kinds, ["petname"], "an unchanged name writes and emits nothing");
        await store.setPetname("pk-a", null);
        assert.equal(store.petname("pk-a"), null);
        assert.equal((await disk.open()).petname("pk-a"), null, "the clear is durable");
        await store.setPetname("pk-b", "   ");
        assert.equal(store.petname("pk-b"), null, "a blank name clears");
      } finally {
        disk.close();
      }
    });

    test("draft survives reopen", async () => {
      const disk = await adapter.disk();
      try {
        const store = await disk.open();
        await store.saveDraft("thread-1", { text: "half a thought" });
        await store.saveDraft("thread-2", { text: "fixed wording", editOf: { root: "op-root", latest: "op-edit" } });
        const reopened = await disk.open();
        assert.deepEqual(reopened.draft("thread-1"), { text: "half a thought" });
        assert.deepEqual(reopened.draft("thread-2"), {
          text: "fixed wording",
          editOf: { root: "op-root", latest: "op-edit" },
        });
        assert.equal(reopened.draft("thread-3"), null);
        // Saves land in call order even when not awaited one by one (the composer saves on every pause).
        const pending = [
          reopened.saveDraft("thread-1", { text: "a" }),
          reopened.saveDraft("thread-1", { text: "ab" }),
          reopened.saveDraft("thread-1", { text: "abc" }),
        ];
        await Promise.all(pending);
        assert.deepEqual((await disk.open()).draft("thread-1"), { text: "abc" });
        await reopened.saveDraft("thread-1", null);
        assert.equal((await disk.open()).draft("thread-1"), null);
      } finally {
        disk.close();
      }
    });

    test("markRead is additive and idempotent", async () => {
      const disk = await adapter.disk();
      try {
        const store = await disk.open();
        const kinds: string[] = [];
        store.onChange((kind) => kinds.push(kind));
        assert.equal(store.readIds("thread-1").size, 0);
        await store.markRead("thread-1", ["op-1", "op-2"]);
        const first = store.readIds("thread-1");
        await store.markRead("thread-1", ["op-2", "op-1"]);
        assert.equal(store.readIds("thread-1"), first, "a repeat keeps the identical set");
        assert.deepEqual(kinds, ["read"], "a repeat writes and emits nothing");
        await store.markRead("thread-1", ["op-3"]);
        assert.deepEqual([...store.readIds("thread-1")].sort(), ["op-1", "op-2", "op-3"]);
        assert.deepEqual([...first].sort(), ["op-1", "op-2"], "an earlier set is never mutated");
        assert.equal(store.readIds("thread-2").size, 0, "read markers are per thread");
        const reopened = await disk.open();
        assert.deepEqual([...reopened.readIds("thread-1")].sort(), ["op-1", "op-2", "op-3"]);
      } finally {
        disk.close();
      }
    });

    test("petnames are trimmed and capped at 40 characters", async () => {
      const disk = await adapter.disk();
      try {
        const store = await disk.open();
        await store.setPetname("pk-a", "  Ana  ");
        assert.equal(store.petname("pk-a"), "Ana");
        // 39 letters then an astral character: 40 code points (41 UTF-16 units) is kept whole.
        const forty = "x".repeat(39) + "\u{1F333}";
        await store.setPetname("pk-b", forty);
        assert.equal(store.petname("pk-b"), forty);
        // One more code point is cut without splitting the surrogate pair.
        await store.setPetname("pk-c", forty + "y");
        assert.equal(store.petname("pk-c"), forty);
        await store.setPetname("pk-d", "z".repeat(41));
        assert.equal(store.petname("pk-d"), "z".repeat(40));
        assert.equal((await disk.open()).petname("pk-c"), forty, "the stored value is the capped one");
      } finally {
        disk.close();
      }
    });
  });
}

test("settings default and persist", async () => {
  for (const adapter of adapters) {
    const disk = await adapter.disk();
    try {
      const store = await disk.open();
      assert.equal(store.setting("syncEnabled"), true, `${adapter.name}: sync is on by default`);
      await store.setSetting("syncEnabled", false);
      assert.equal((await disk.open()).setting("syncEnabled"), false, `${adapter.name}: durable`);
    } finally {
      disk.close();
    }
  }
});

test("the per-key replica store pointer survives a reopen (M1a.7 re-sync)", async () => {
  for (const adapter of adapters) {
    const disk = await adapter.disk();
    try {
      const store = await disk.open();
      assert.deepEqual(store.setting("replicaStoreEpochs"), {}, `${adapter.name}: every key starts at store 0`);
      await store.setSetting("replicaStoreEpochs", { keyA: 1 });
      await store.setSetting("replicaStoreEpochs", { ...store.setting("replicaStoreEpochs"), keyB: 2 });
      assert.deepEqual((await disk.open()).setting("replicaStoreEpochs"), { keyA: 1, keyB: 2 }, `${adapter.name}: durable`);
    } finally {
      disk.close();
    }
  }
});

// --- import scan -------------------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'";]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** Every src file reachable from `roots` through relative imports. */
function reachable(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolveLocal(file, spec);
      if (target) stack.push(target);
    }
  }
  return seen;
}

test("nothing in the local store is reachable from the replica store or a signed op", () => {
  const local = join(SRC, "local");
  const localFiles = sourceFiles(local);
  assert.ok(localFiles.length >= 2, "src/local holds the port and the SQLite adapter");

  // Roots: everything that retains frames, verifies them, authors or signs an op. Among commands, only the
  // signed ones (those reaching pipeline.ts or lattice-client) are roots; M1a.5's local_commands.ts
  // (petname, draft, markRead) legitimately holds a LocalStore and authors nothing.
  const signedCommand = (file: string) =>
    specifiers(file).some((spec) => spec.includes("lattice-client") || /(^|\/)pipeline$/.test(spec)) ||
    file.endsWith(`${join("commands", "pipeline.ts")}`);
  const roots = [
    ...sourceFiles(join(SRC, "session", "commands")).filter(signedCommand),
    ...sourceFiles(join(SRC, "session", "memory")).filter((f) => /replica_store|key_custody/.test(f)),
    ...sourceFiles(join(SRC, "native")).filter((f) => /replica_store|custody|storage/.test(f)),
    ...[join(SRC, "session", "verify_held.ts")].filter(existsSync),
  ];
  assert.ok(roots.some((f) => f.includes(join("session", "commands"))), "command roots found");
  assert.ok(roots.some((f) => /replica_store/.test(f)), "replica store roots found");
  const leaks = [...reachable(roots)].filter((f) => f.startsWith(local + "/")).map((f) => relative(APP, f));
  assert.deepEqual(leaks, [], "signed-op and replica-store code never reaches src/local");

  // Reverse: the local store imports nothing that can author, sign, verify or retain frames.
  const offenders = localFiles.flatMap((file) =>
    specifiers(file)
      .filter((spec) => {
        if (spec === "expo-sqlite") return false;
        if (!spec.startsWith(".")) return true;
        return !resolve(dirname(file), spec).startsWith(local + "/");
      })
      .map((spec) => `${relative(APP, file)} -> ${spec}`),
  );
  assert.deepEqual(offenders, [], "src/local imports only itself and expo-sqlite");

  // A separate database file: its name appears nowhere else in src.
  const sqlite = readFileSync(join(local, "sqlite_local_store.ts"), "utf8");
  const name = /LOCAL_DB_NAME\s*=\s*"([^"]+)"/.exec(sqlite)?.[1];
  assert.ok(name, "the SQLite adapter names its database file");
  const shared = sourceFiles(SRC)
    .filter((f) => !f.startsWith(local + "/"))
    .filter((f) => readFileSync(f, "utf8").includes(name))
    .map((f) => relative(APP, f));
  assert.deepEqual(shared, [], "no other store opens the local database file");
});
