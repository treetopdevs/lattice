import type { SQLiteDatabase } from "expo-sqlite";
import {
  createCachedLocalStore,
  DEFAULT_SETTINGS,
  type Draft,
  type LocalSnapshot,
  type LocalStore,
  type Settings,
} from "./local_store";

// The SQLite LocalStore adapter (07 M1a.3). A database file of its own, separate from the replica store, so
// device-local facts can never be mistaken for group facts. Written against the narrow LocalSqliteDb shape:
// expo-sqlite's SQLiteDatabase satisfies it on the device (checked below by the type system), and node:sqlite
// satisfies it in Core tests. No silent fallback: if the file cannot open or a row cannot be read, open
// rejects with the reason.

export const LOCAL_DB_NAME = "treehouse_local_v1.db";
const SCHEMA_VERSION = "1";

type Bind = string | number | null;

export interface LocalSqliteConn {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: Bind[]): Promise<unknown>;
  getAllAsync<T>(source: string, ...params: Bind[]): Promise<T[]>;
}

export interface LocalSqliteDb extends LocalSqliteConn {
  withExclusiveTransactionAsync(task: (txn: LocalSqliteConn) => Promise<void>): Promise<void>;
}

// expo-sqlite 58's SQLiteDatabase must fit this shape without a cast.
const fitsExpo: (db: SQLiteDatabase) => LocalSqliteDb = (db) => db;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS petname     (pubkey TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS draft       (thread TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS read_marker (thread TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (thread, id));
  CREATE TABLE IF NOT EXISTS setting     (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
`;

function parseDraft(thread: string, json: string): Draft {
  const value = JSON.parse(json) as Draft;
  if (!value || typeof value.text !== "string") throw new Error(`local_store: unreadable draft for ${thread}`);
  if (value.editOf && (typeof value.editOf.root !== "string" || typeof value.editOf.latest !== "string"))
    throw new Error(`local_store: unreadable draft target for ${thread}`);
  return value;
}

/** Opens the LocalStore over an already-open database: creates the schema, then loads every row. */
export async function openSqliteLocalStore(db: LocalSqliteDb): Promise<LocalStore> {
  await db.execAsync(SCHEMA);
  const version = await db.getAllAsync<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (version.length === 0) await db.runAsync("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
  else if (version[0]!.value !== SCHEMA_VERSION)
    throw new Error(`local_store: unsupported schema_version ${version[0]!.value}`);

  const snapshot: LocalSnapshot = { petnames: {}, drafts: {}, read: {}, settings: {} };
  for (const row of await db.getAllAsync<{ pubkey: string; name: string }>("SELECT pubkey, name FROM petname"))
    snapshot.petnames[row.pubkey] = row.name;
  for (const row of await db.getAllAsync<{ thread: string; json: string }>("SELECT thread, json FROM draft"))
    snapshot.drafts[row.thread] = parseDraft(row.thread, row.json);
  for (const row of await db.getAllAsync<{ thread: string; id: string }>("SELECT thread, id FROM read_marker"))
    (snapshot.read[row.thread] ??= []).push(row.id);
  for (const row of await db.getAllAsync<{ key: string; json: string }>("SELECT key, json FROM setting")) {
    if (!(row.key in DEFAULT_SETTINGS)) continue; // a setting a newer build wrote; keep it, ignore it
    const value = JSON.parse(row.json) as unknown;
    const key = row.key as keyof Settings;
    if (typeof value !== typeof DEFAULT_SETTINGS[key] || value === null || Array.isArray(value))
      throw new Error(`local_store: unreadable setting ${row.key}`);
    (snapshot.settings as Record<string, unknown>)[key] = value;
  }

  return createCachedLocalStore(snapshot, {
    async putPetname(pubkey, name) {
      if (name === null) await db.runAsync("DELETE FROM petname WHERE pubkey = ?", pubkey);
      else
        await db.runAsync(
          "INSERT INTO petname (pubkey, name) VALUES (?, ?) ON CONFLICT(pubkey) DO UPDATE SET name = excluded.name",
          pubkey,
          name,
        );
    },
    async putDraft(thread, draft) {
      if (draft === null) await db.runAsync("DELETE FROM draft WHERE thread = ?", thread);
      else
        await db.runAsync(
          "INSERT INTO draft (thread, json) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET json = excluded.json",
          thread,
          JSON.stringify(draft),
        );
    },
    async addRead(thread, ids) {
      await db.withExclusiveTransactionAsync(async (txn) => {
        for (const id of ids) await txn.runAsync("INSERT OR IGNORE INTO read_marker (thread, id) VALUES (?, ?)", thread, id);
      });
    },
    async putSetting(key, value) {
      await db.runAsync(
        "INSERT INTO setting (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
        key,
        JSON.stringify(value),
      );
    },
  });
}

/** The device adapter: opens the local database file with expo-sqlite. Rejects if it cannot open. */
export async function openExpoLocalStore(): Promise<LocalStore> {
  const { openDatabaseAsync } = await import("expo-sqlite");
  const db = await openDatabaseAsync(LOCAL_DB_NAME);
  await db.execAsync("PRAGMA journal_mode = WAL;");
  return openSqliteLocalStore(fitsExpo(db));
}
