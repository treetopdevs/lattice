import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { Clock, HeldProfile, HeldReplica, ReplicaStore, TreehouseProduct } from "../session/ports";

// M1a.2: the ReplicaStore over SQLite. One database per device identity. The schema is the one in 07:
// inserts only, `authored` and `acked` move 0 to 1 and never back, no DELETE on frame, and each write is
// one transaction. There is no fallback: if the database cannot open, open() rejects and the session
// reports history_invalid. first_seen_ms is written in the transaction that first retains the frame,
// so this store is the sole owner of first-seen times (03).
//
// The database handle is injected. In the app it is expo-sqlite (openExpoReplicaDb); Core tests pass a
// node:sqlite shim with the same async surface. Every SQL statement is one plain string literal in this
// file, so the static scan in test/core/replica_store.test.mts sees all of them.

type SqlParam = string | number | null;

/** The part of expo-sqlite's SQLiteDatabase this store uses. */
export interface ReplicaDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: SqlParam[]): Promise<unknown>;
  getAllAsync<T>(source: string, ...params: SqlParam[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const SCHEMA_VERSION = "1";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS replica (replica TEXT PRIMARY KEY, product TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS frame (replica TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
  json TEXT NOT NULL, authored INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0,
  first_seen_ms INTEGER NOT NULL, PRIMARY KEY (replica, id));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface Held {
  product: TreehouseProduct;
  frames: CarrierOpFrame[];
  outbox: string[];
  acked: string[];
  firstSeen: Map<string, number>;
  nextSeq: number;
}

/** The database file for one identity: never the M0 snapshot file, never shared between identities. */
export function replicaDbName(publicKeyBase64: string): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(publicKeyBase64))).slice(0, 32);
  return `treehouse_replicas_v1_${digest}.db`;
}

/** Opens the expo-sqlite database. Loaded lazily so Node can import this module without expo-sqlite. */
export async function openExpoReplicaDb(name: string): Promise<ReplicaDb> {
  const { openDatabaseAsync } = await import("expo-sqlite");
  const db = await openDatabaseAsync(name);
  await db.execAsync("PRAGMA journal_mode = WAL;");
  // Assigned, not cast, so tsc checks expo-sqlite's surface against the one this store uses.
  const handle: ReplicaDb = db;
  return handle;
}

export class SqliteReplicaStore implements ReplicaStore {
  private db: ReplicaDb | null = null;
  private held = new Map<string, Held>();
  private readonly listeners = new Set<(replica: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly openDb: () => Promise<ReplicaDb>,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  async open(): Promise<void> {
    const db = await this.openDb();
    await db.execAsync(SCHEMA);
    const version = await db.getAllAsync<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    if (version.length === 0) {
      await db.runAsync("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
    } else if (version[0]!.value !== SCHEMA_VERSION) {
      throw new Error(`unsupported_schema_version ${version[0]!.value}`);
    }
    const replicas = await db.getAllAsync<{ replica: string; product: string }>("SELECT replica, product FROM replica ORDER BY rowid");
    const rows = await db.getAllAsync<{ replica: string; id: string; seq: number; json: string; authored: number; acked: number; first_seen_ms: number }>(
      "SELECT replica, id, seq, json, authored, acked, first_seen_ms FROM frame ORDER BY replica, seq",
    );
    const held = new Map<string, Held>();
    for (const r of replicas) {
      if (r.product !== "Treehouse.Space" && r.product !== "Treehouse.Thread") throw new Error(`unknown_product ${r.product}`);
      held.set(r.replica, { product: r.product, frames: [], outbox: [], acked: [], firstSeen: new Map(), nextSeq: 0 });
    }
    for (const row of rows) {
      const entry = held.get(row.replica);
      if (!entry) throw new Error("frame_without_replica");
      entry.frames.push(JSON.parse(row.json) as CarrierOpFrame);
      if (row.authored === 1) entry.outbox.push(row.id);
      if (row.acked === 1) entry.acked.push(row.id);
      entry.firstSeen.set(row.id, Number(row.first_seen_ms));
      entry.nextSeq = Math.max(entry.nextSeq, Number(row.seq) + 1);
    }
    this.db = db;
    this.held = held;
  }

  replicas(): HeldReplica[] {
    return [...this.held].map(([replica, entry]) => ({ replica, product: entry.product }));
  }

  profile(replica: string): HeldProfile | undefined {
    const entry = this.held.get(replica);
    return entry && { frames: entry.frames, outbox: entry.outbox, acked: entry.acked };
  }

  firstSeenMs(replica: string, id: string): number | undefined {
    return this.held.get(replica)?.firstSeen.get(id);
  }

  adopt(replica: string, product: TreehouseProduct): Promise<void> {
    return this.write(replica, async (db, current) => {
      if (current) {
        if (current.product !== product) throw new Error("replica_product_mismatch");
        return null;
      }
      await db.runAsync("INSERT INTO replica (replica, product) VALUES (?, ?)", replica, product);
      return { product, frames: [], outbox: [], acked: [], firstSeen: new Map(), nextSeq: 0 };
    }).then(() => undefined);
  }

  appendAuthored(replica: string, frame: CarrierOpFrame): Promise<void> {
    return this.write(replica, async (db, current) => {
      if (!current) throw new Error("unknown_replica");
      if (frame.replica !== replica) throw new Error("wrong_replica");
      const held = current.frames.some((f) => f.id === frame.id);
      const queued = current.outbox.includes(frame.id);
      if (held && queued) return null;
      const now = this.clock.now();
      if (!held) {
        await db.runAsync(
          "INSERT INTO frame (replica, id, seq, json, authored, acked, first_seen_ms) VALUES (?, ?, ?, ?, 0, 0, ?)",
          replica,
          frame.id,
          current.nextSeq,
          JSON.stringify(frame),
          now,
        );
      }
      await db.runAsync("UPDATE frame SET authored = 1 WHERE replica = ? AND id = ? AND authored = 0", replica, frame.id);
      const firstSeen = new Map(current.firstSeen);
      if (!held) firstSeen.set(frame.id, now);
      return {
        ...current,
        frames: held ? current.frames : [...current.frames, frame],
        outbox: [...current.outbox, frame.id],
        firstSeen,
        nextSeq: held ? current.nextSeq : current.nextSeq + 1,
      };
    }).then(() => undefined);
  }

  mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]): Promise<boolean> {
    return this.write(replica, async (db, current) => {
      if (!current) throw new Error("unknown_replica");
      // Decide everything before the first statement, so a refusal writes nothing.
      const ids = new Set(current.frames.map((f) => f.id));
      const added: CarrierOpFrame[] = [];
      for (const frame of pulled) {
        if (frame.replica !== replica) throw new Error("wrong_replica");
        if (ids.has(frame.id)) continue;
        ids.add(frame.id);
        added.push(frame);
      }
      const acked = new Set(current.acked);
      const newAcks: string[] = [];
      for (const id of ackedIds) {
        if (!ids.has(id)) throw new Error("acked_not_held");
        if (!acked.has(id)) {
          acked.add(id);
          newAcks.push(id);
        }
      }
      if (added.length === 0 && newAcks.length === 0) return null;
      const now = this.clock.now();
      let seq = current.nextSeq;
      const firstSeen = new Map(current.firstSeen);
      for (const frame of added) {
        await db.runAsync(
          "INSERT INTO frame (replica, id, seq, json, authored, acked, first_seen_ms) VALUES (?, ?, ?, ?, 0, 0, ?)",
          replica,
          frame.id,
          seq++,
          JSON.stringify(frame),
          now,
        );
        firstSeen.set(frame.id, now);
      }
      for (const id of newAcks) {
        await db.runAsync("UPDATE frame SET acked = 1 WHERE replica = ? AND id = ? AND acked = 0", replica, id);
      }
      return { ...current, frames: [...current.frames, ...added], acked: [...current.acked, ...newAcks], firstSeen, nextSeq: seq };
    });
  }

  onChange(listener: (replica: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One serialized write in one transaction. `next` runs its statements and returns the new held entry,
   * or null for no change. The held copy and the change event follow only a committed transaction.
   */
  private write(replica: string, next: (db: ReplicaDb, current: Held | undefined) => Promise<Held | null>): Promise<boolean> {
    const run = async () => {
      const db = this.db;
      if (!db) throw new Error("store_not_open");
      let updated: Held | null = null;
      await db.withTransactionAsync(async () => {
        updated = await next(db, this.held.get(replica));
      });
      if (updated === null) return false;
      this.held.set(replica, updated);
      for (const listener of [...this.listeners]) listener(replica);
      return true;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
