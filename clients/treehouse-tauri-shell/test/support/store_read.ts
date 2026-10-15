import { execFileSync } from "node:child_process";

// Read-only evidence from a packaged Treehouse store, possibly while the app is running. The app opens the store
// in rollback-journal mode with a 5 s busy timeout (lattice-mobile-core storage.rs), so a reader that arrives
// during a write meets SQLITE_BUSY. A bare sqlite3 read fails at once with "database is locked (5)"; ".timeout"
// installs SQLite's busy handler, so the read waits for the writer instead of failing or spinning. The reader's
// budget is longer than the writer's. Every read is -readonly: this never writes, clears or migrates app data.

export const STORE_READ_BUSY_TIMEOUT_MS = 10_000;
export const STORE_READ_OPTIONS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 } as const;

export function storeReadArgs(database: string, sql: string): string[] {
  return ["-readonly", "-json", "-cmd", `.timeout ${STORE_READ_BUSY_TIMEOUT_MS}`, database, sql];
}

/** sqlite3 -json prints nothing for an empty result, so that reads as no rows. */
export const parseStoreRows = <Row>(output: string): Row[] => JSON.parse(output || "[]");

export function readStore<Row>(database: string, sql: string): Row[] {
  return parseStoreRows<Row>(execFileSync("sqlite3", storeReadArgs(database, sql), STORE_READ_OPTIONS));
}

export const readKv = (database: string) =>
  readStore<{ key: string; value: string }>(database, "SELECT key,value FROM kv ORDER BY key;");
