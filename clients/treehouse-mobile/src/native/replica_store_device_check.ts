import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTownshipGenesis,
  authorTreehouseCommand,
  carrierDelegationsFromFrames,
  treehouseCommandDecoders,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, CarrierOpSigner } from "@treetopdevs/lattice-client";
import { REPLICA_STORE_CONTRACT } from "../../test/core/replica_store_contract_cases";
import type { ContractAssert, ContractHarness, ContractLocation } from "../../test/core/replica_store_contract_cases";
import { bytesToHex } from "./custody";
import { openExpoReplicaDb, SqliteReplicaStore, type ReplicaDb } from "./sqlite_replica_store";

// M1a.2 simulator gate, dev builds only (App.tsx requires this module under __DEV__). Runs the same
// ReplicaStore contract cases as test/core/replica_store.test.mts, against SqliteReplicaStore over the real
// expo-sqlite, opened through the production openDatabaseAsync path. Each location is its own database
// file, closed and deleted afterwards. The signing key is a throwaway made in memory for this run and is
// never stored, shown or logged; only case names, pass/fail and a truncated failure message are reported.

export interface DeviceCheckCase {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DeviceCheckResult {
  adapter: string;
  cases: DeviceCheckCase[];
  passed: number;
  total: number;
}

class CheckFailure extends Error {}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 60)}...` : s;
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as never)[k], (b as never)[k]));
}

const contractAssert: ContractAssert = {
  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) throw new CheckFailure(`${message ?? "equal"}: got ${show(actual)}, want ${show(expected)}`);
  },
  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) throw new CheckFailure(`${message ?? "deepEqual"}: got ${show(actual)}, want ${show(expected)}`);
  },
  ok(value, message) {
    if (!value) throw new CheckFailure(message ?? "expected a truthy value");
  },
  async rejects(promise, pattern, message) {
    try {
      await promise;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!pattern.test(text)) throw new CheckFailure(`${message ?? "rejects"}: rejected with ${show(text)}, want ${pattern}`);
      return;
    }
    throw new CheckFailure(`${message ?? "rejects"}: resolved, want a rejection matching ${pattern}`);
  },
};

/** Three signed frames of one legacy-rooted Thread: genesis, title, one post, by a throwaway key. */
async function throwawayThread(): Promise<{ replica: string; frames: CarrierOpFrame[] }> {
  const secret = ed25519.utils.randomSecretKey();
  const signer: CarrierOpSigner = { publicKey: ed25519.getPublicKey(secret), sign: (bytes) => ed25519.sign(bytes, secret) };
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const genesis = await authorTownshipGenesis({
    replica: `replica:treehouse:thread:devcheck-${bytesToHex(nonce)}`,
    signer,
    ops: [...treehouseCommandDecoders("Treehouse.Thread").keys()],
    roles: ["moderator"],
    policies: {},
  });
  const capId = carrierDelegationsFromFrames([genesis])[0]!.id;
  const title = await authorTreehouseCommand({
    product: "Treehouse.Thread",
    replica: genesis.replica,
    deps: [genesis.id],
    signer,
    capId,
    command: { command: "create_thread", title: "Device check" },
  });
  const post = await authorTreehouseCommand({
    product: "Treehouse.Thread",
    replica: genesis.replica,
    deps: [title.id],
    signer,
    capId,
    command: { command: "post", text: "device check" },
  });
  return { replica: genesis.replica, frames: [genesis, title, post] };
}

interface OpenHandle {
  closeAsync(): Promise<void>;
}

export async function runReplicaStoreDeviceCheck(): Promise<DeviceCheckResult> {
  const sqlite = await import("expo-sqlite");
  const runId = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(6)));
  const names: string[] = [];
  const handles: OpenHandle[] = [];
  let n = 0;
  const thread = await throwawayThread();

  const harness: ContractHarness = {
    thread,
    async fresh(startMs): Promise<ContractLocation> {
      const name = `treehouse_devcheck_${runId}_${n++}.db`;
      names.push(name);
      let now = startMs;
      const clock = { now: () => now };
      let current: OpenHandle | null = null;
      return {
        advance: (ms) => {
          now += ms;
        },
        async openStore() {
          // A reopen closes the previous connection first, so the new store reads what reached disk.
          if (current) await current.closeAsync();
          const store = new SqliteReplicaStore(async () => {
            // The production open path. openExpoReplicaDb returns the expo-sqlite database itself, so the
            // harness can close it before the next reopen and before deleting the file.
            const db = await openExpoReplicaDb(name);
            const handle = db as ReplicaDb & OpenHandle;
            current = handle;
            handles.push(handle);
            return db;
          }, clock);
          await store.open();
          return store;
        },
      };
    },
  };

  const cases: DeviceCheckCase[] = [];
  for (const c of REPLICA_STORE_CONTRACT) {
    try {
      await c.run(harness, contractAssert);
      cases.push({ name: c.name, ok: true });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      cases.push({ name: c.name, ok: false, detail: text.length > 160 ? `${text.slice(0, 160)}...` : text });
    }
  }
  // Device-only case: a statement failing inside mergeSync rolls the whole transaction back on the real
  // expo-sqlite (Core's rollback is the node:sqlite shim's own), with a real Date.now() first-seen time.
  const rollback = "a failed statement inside mergeSync rolls back on expo-sqlite";
  try {
    const name = `treehouse_devcheck_${runId}_${n++}.db`;
    names.push(name);
    let failInserts = false;
    let inserts = 0;
    const open = (inject: boolean) =>
      new SqliteReplicaStore(async () => {
        const db = (await openExpoReplicaDb(name)) as ReplicaDb & OpenHandle;
        handles.push(db);
        if (!inject) return db;
        return {
          execAsync: (sql: string) => db.execAsync(sql),
          getAllAsync: <T,>(sql: string, ...p: (string | number | null)[]) => db.getAllAsync<T>(sql, ...p),
          withTransactionAsync: (task: () => Promise<void>) => db.withTransactionAsync(task),
          runAsync: (sql: string, ...p: (string | number | null)[]) => {
            if (failInserts && /^INSERT INTO frame/.test(sql) && ++inserts === 2) return Promise.reject(new Error("injected"));
            return db.runAsync(sql, ...p);
          },
        };
      });
    const { replica, frames } = thread;
    const store = open(true);
    await store.open();
    await store.adopt(replica, "Treehouse.Thread");
    const before = Date.now();
    await store.mergeSync(replica, [frames[0]!], []);
    const seen = store.firstSeenMs(replica, frames[0]!.id) ?? 0;
    contractAssert.ok(seen >= before && seen <= Date.now(), "first seen is the wall clock");
    failInserts = true;
    await contractAssert.rejects(store.mergeSync(replica, [frames[1]!, frames[2]!], []), /injected/);
    for (const h of handles.splice(0)) await h.closeAsync().catch(() => undefined);
    const reopened = open(false);
    await reopened.open();
    contractAssert.deepEqual(reopened.profile(replica)?.frames.map((f) => f.id), [frames[0]!.id], "the first insert was rolled back");
    contractAssert.equal(reopened.firstSeenMs(replica, frames[0]!.id), seen, "first seen survives reopen");
    cases.push({ name: rollback, ok: true });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    cases.push({ name: rollback, ok: false, detail: text.length > 160 ? `${text.slice(0, 160)}...` : text });
  }
  for (const h of handles) await h.closeAsync().catch(() => undefined);
  for (const name of names) await sqlite.deleteDatabaseAsync(name).catch(() => undefined);
  const passed = cases.filter((c) => c.ok).length;
  return { adapter: "SqliteReplicaStore on expo-sqlite", cases, passed, total: cases.length };
}
