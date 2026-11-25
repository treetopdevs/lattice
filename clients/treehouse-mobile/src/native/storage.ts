import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { HeldProfile } from "@treetopdevs/lattice-shell-kit/sync";

export interface PersistedMobileSnapshot {
  version: 1;
  namespace: string;
  profiles: Record<string, HeldProfile>;
}

export interface MobileStorage {
  load(namespace: string): Promise<PersistedMobileSnapshot>;
  save(snapshot: PersistedMobileSnapshot): Promise<void>;
  clear(namespace: string): Promise<void>;
}

export function emptySnapshot(namespace: string): PersistedMobileSnapshot {
  return { version: 1, namespace, profiles: {} };
}

export function cloneProfile(profile: HeldProfile): HeldProfile {
  return {
    frames: profile.frames.map((frame) => structuredClone(frame) as CarrierOpFrame),
    outbox: [...profile.outbox],
    acked: [...profile.acked],
  };
}

export class MemoryMobileStorage implements MobileStorage {
  private readonly store = new Map<string, PersistedMobileSnapshot>();

  async load(namespace: string): Promise<PersistedMobileSnapshot> {
    const existing = this.store.get(namespace);
    if (!existing) return emptySnapshot(namespace);
    const profiles: Record<string, HeldProfile> = {};
    for (const [replica, profile] of Object.entries(existing.profiles)) {
      profiles[replica] = cloneProfile(profile);
    }
    return { version: 1, namespace, profiles };
  }

  async save(snapshot: PersistedMobileSnapshot): Promise<void> {
    const profiles: Record<string, HeldProfile> = {};
    for (const [replica, profile] of Object.entries(snapshot.profiles)) {
      profiles[replica] = cloneProfile(profile);
    }
    this.store.set(snapshot.namespace, {
      version: 1,
      namespace: snapshot.namespace,
      profiles,
    });
  }

  async clear(namespace: string): Promise<void> {
    this.store.delete(namespace);
  }
}

const SQLITE_DB_NAME = "treehouse_mobile_v1.db";

type SqliteDb = {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null>;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
};

/**
 * Durable SQLite-backed storage via `expo-sqlite` (WAL mode).
 * Falls back cleanly to `MemoryMobileStorage` when running in Node tests.
 */
export class ExpoSqliteStorage implements MobileStorage {
  private readonly fallback = new MemoryMobileStorage();
  private dbPromise: Promise<SqliteDb | null> | null = null;
  private opened: SqliteDb | null = null;
  private openError: string | undefined;

  /** Why the last open attempt fell back to memory, if it did. */
  lastError(): string | undefined {
    return this.openError;
  }

  /** Which backend answered: "sqlite" only once the database actually opened. */
  backend(): "sqlite" | "memory" {
    return this.opened ? "sqlite" : "memory";
  }

  /** Forces the lazy open so backend() is meaningful before the first load/save. */
  async ready(): Promise<"sqlite" | "memory"> {
    await this.open();
    return this.backend();
  }

  private async open(): Promise<SqliteDb | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = (async () => {
      try {
        const mod = await import("expo-sqlite");
        if (typeof mod.openDatabaseAsync !== "function") {
          this.openError = "expo-sqlite has no openDatabaseAsync";
          return null;
        }
        const db = (await mod.openDatabaseAsync(SQLITE_DB_NAME)) as unknown as SqliteDb;
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS snapshots (
            namespace TEXT PRIMARY KEY NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
        this.opened = db;
        return db;
      } catch (e) {
        this.openError = e instanceof Error ? e.message : String(e);
        return null;
      }
    })();
    return this.dbPromise;
  }

  async load(namespace: string): Promise<PersistedMobileSnapshot> {
    const db = await this.open();
    if (!db) return this.fallback.load(namespace);
    const row = await db.getFirstAsync<{ payload: string }>(
      "SELECT payload FROM snapshots WHERE namespace = ?",
      namespace,
    );
    if (!row) return emptySnapshot(namespace);
    try {
      const parsed = JSON.parse(row.payload) as PersistedMobileSnapshot;
      if (parsed && parsed.version === 1 && typeof parsed.profiles === "object") {
        return parsed;
      }
    } catch {
      // Corrupt row: start fresh rather than crashing startup.
    }
    return emptySnapshot(namespace);
  }

  async save(snapshot: PersistedMobileSnapshot): Promise<void> {
    const db = await this.open();
    if (!db) {
      await this.fallback.save(snapshot);
      return;
    }
    const payload = JSON.stringify(snapshot);
    await db.runAsync(
      "INSERT INTO snapshots (namespace, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
      snapshot.namespace,
      payload,
      Date.now(),
    );
  }

  async clear(namespace: string): Promise<void> {
    const db = await this.open();
    if (!db) {
      await this.fallback.clear(namespace);
      return;
    }
    await db.runAsync("DELETE FROM snapshots WHERE namespace = ?", namespace);
  }
}
