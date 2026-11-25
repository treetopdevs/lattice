import type { HeldProfile } from "../session/ports";

// M1a.7: read-only access to the M0 host's snapshot file, so carryOverLegacyProfiles can move an unsynced
// post into the replica store before anything else runs (07, defect a). The M0 writer (src/native/storage.ts)
// is gone; this reader never creates a table and never writes, updates or deletes a row, so the old file
// stays exactly as the M0 build left it.

/** The M0 host's database file: one row per identity namespace in `snapshots`. */
export const LEGACY_DB_NAME = "treehouse_mobile_v1.db";

type SqlParam = string | number | null;

export interface LegacyDb {
  getAllAsync<T>(source: string, ...params: SqlParam[]): Promise<T[]>;
}

/** The namespace the M0 host saved one identity under (`treehouse:{realm}:{fingerprint}`). */
export function legacyNamespaceOf(realm: string, fingerprint: string): string {
  return `treehouse:${realm}:${fingerprint}`;
}

/**
 * One namespace's profiles, or null when the file has no snapshot table or no row for it. An unreadable row
 * rejects (the caller reports it and leaves the file alone); the M0 build silently started fresh instead.
 */
export async function readLegacyProfiles(db: LegacyDb, namespace: string): Promise<Record<string, HeldProfile> | null> {
  const table = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'",
  );
  if (table.length === 0) return null;
  const rows = await db.getAllAsync<{ payload: string }>("SELECT payload FROM snapshots WHERE namespace = ?", namespace);
  if (rows.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rows[0]!.payload);
  } catch {
    throw new Error("legacy_snapshot_unreadable");
  }
  const snapshot = parsed as { version?: unknown; profiles?: unknown };
  if (snapshot?.version !== 1 || typeof snapshot.profiles !== "object" || snapshot.profiles === null)
    throw new Error("legacy_snapshot_unreadable");
  const profiles: Record<string, HeldProfile> = {};
  for (const [replica, value] of Object.entries(snapshot.profiles as Record<string, unknown>)) {
    const p = value as Partial<HeldProfile> | null;
    if (!p || !Array.isArray(p.frames) || !Array.isArray(p.outbox) || !Array.isArray(p.acked))
      throw new Error("legacy_snapshot_unreadable");
    profiles[replica] = { frames: p.frames, outbox: p.outbox, acked: p.acked };
  }
  return profiles;
}

/** The device adapter: the M0 file through expo-sqlite, loaded lazily so Node can import this module. */
export async function openExpoLegacyDb(): Promise<LegacyDb> {
  const { openDatabaseAsync } = await import("expo-sqlite");
  const db = await openDatabaseAsync(LEGACY_DB_NAME);
  const handle: LegacyDb = db;
  return handle;
}
