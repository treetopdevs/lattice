import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { ReplicaStore } from "../../src/session/ports";

// M1a.2: the ReplicaStore contract (re-exported by replica_store_contract.mts). Every adapter (memory in Core, SQLite over node:sqlite in Core and
// over expo-sqlite in a dev build) must pass the same cases. This file imports no node:* module, no
// Buffer and no test framework: the harness supplies the signed frames, a way to open a store on one
// durable location, and the assertions, so the same cases can run inside the app on the simulator.

export interface ContractAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
  rejects(promise: Promise<unknown>, pattern: RegExp, message?: string): Promise<void>;
}

export interface ContractLocation {
  /** Opens a new store object on this location (a reopen after the first call). Resolves once open() did. */
  openStore(): Promise<ReplicaStore>;
  /** Moves the location's clock forward, so first-seen times are distinguishable. */
  advance(ms: number): void;
}

export interface ContractHarness {
  /** A fresh, empty durable location with its own clock starting at `startMs`. */
  fresh(startMs: number): Promise<ContractLocation>;
  /** Signed frames of one Thread replica, at least three, in causal order. */
  thread: { replica: string; frames: CarrierOpFrame[] };
}

export interface ContractCase {
  name: string;
  run(h: ContractHarness, a: ContractAssert): Promise<void>;
}

const ids = (frames: readonly CarrierOpFrame[] | undefined) => (frames ?? []).map((f) => f.id);
const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort();

function counter(store: ReplicaStore) {
  const seen: string[] = [];
  store.onChange((replica) => seen.push(replica));
  return seen;
}

export const REPLICA_STORE_CONTRACT: ContractCase[] = [
  {
    name: "append then reopen returns the same frames in insertion order",
    async run(h, a) {
      const { replica, frames } = h.thread;
      const loc = await h.fresh(1_000);
      const store = await loc.openStore();
      await store.adopt(replica, "Treehouse.Thread");
      a.ok(await store.mergeSync(replica, frames.slice(0, 2), []), "the first merge is new");
      loc.advance(500);
      await store.appendAuthored(replica, frames[2]!);
      const before = store.profile(replica);
      a.deepEqual(ids(before?.frames), ids(frames.slice(0, 3)), "frames in insertion order");
      a.deepEqual(before?.outbox, [frames[2]!.id], "the authored frame is queued");
      a.equal(store.firstSeenMs(replica, frames[0]!.id), 1_000);
      a.equal(store.firstSeenMs(replica, frames[2]!.id), 1_500);

      const reopened = await loc.openStore();
      a.deepEqual(reopened.replicas(), [{ replica, product: "Treehouse.Thread" }]);
      const after = reopened.profile(replica);
      a.deepEqual(after?.frames, before?.frames, "the same frames, byte for byte, in order");
      a.deepEqual(sorted(after?.outbox), sorted(before?.outbox));
      a.deepEqual(sorted(after?.acked), []);
      for (const frame of frames.slice(0, 3))
        a.equal(reopened.firstSeenMs(replica, frame.id), store.firstSeenMs(replica, frame.id), `first seen of ${frame.id}`);
      a.equal(reopened.firstSeenMs(replica, "unknown"), undefined);
    },
  },
  {
    name: "appending the same id twice stores one row",
    async run(h, a) {
      const { replica, frames } = h.thread;
      const loc = await h.fresh(1_000);
      const store = await loc.openStore();
      await store.adopt(replica, "Treehouse.Thread");
      await store.appendAuthored(replica, frames[0]!);
      loc.advance(100);
      await store.appendAuthored(replica, frames[0]!);
      a.ok(!(await store.mergeSync(replica, [frames[0]!], [])), "a pull of the authored frame adds nothing");
      // Authoring a frame that was already pulled queues it but keeps one row and its first-seen time.
      await store.mergeSync(replica, [frames[1]!], []);
      loc.advance(100);
      await store.appendAuthored(replica, frames[1]!);
      for (const s of [store, await loc.openStore()]) {
        const p = s.profile(replica);
        a.deepEqual(ids(p?.frames), [frames[0]!.id, frames[1]!.id], "one row per id");
        a.deepEqual(sorted(p?.outbox), sorted([frames[0]!.id, frames[1]!.id]), "one outbox entry per id");
        a.equal(s.firstSeenMs(replica, frames[0]!.id), 1_000, "first seen never moves");
        a.equal(s.firstSeenMs(replica, frames[1]!.id), 1_100, "first seen never moves");
      }
    },
  },
  {
    name: "mergeSync reports false and writes nothing when nothing is new",
    async run(h, a) {
      const { replica, frames } = h.thread;
      const loc = await h.fresh(1_000);
      const store = await loc.openStore();
      await store.adopt(replica, "Treehouse.Thread");
      await store.appendAuthored(replica, frames[2]!);
      a.ok(await store.mergeSync(replica, frames.slice(0, 2), [frames[2]!.id]), "new frames and a new ack");
      const changes = counter(store);
      const before = JSON.stringify(store.profile(replica));
      loc.advance(100);
      a.equal(await store.mergeSync(replica, [], []), false, "an empty merge");
      a.equal(await store.mergeSync(replica, frames.slice(0, 2), []), false, "held frames again");
      a.equal(await store.mergeSync(replica, [frames[1]!], [frames[2]!.id]), false, "a held frame and an acked id again");
      a.deepEqual(changes, [], "no change event");
      a.equal(JSON.stringify(store.profile(replica)), before, "the profile is unchanged");
      const reopened = await loc.openStore();
      a.equal(JSON.stringify(reopened.profile(replica)?.frames), JSON.stringify(store.profile(replica)?.frames));
      a.deepEqual(reopened.profile(replica)?.acked, [frames[2]!.id]);
      a.equal(reopened.firstSeenMs(replica, frames[0]!.id), 1_000, "a re-merge does not move first seen");
    },
  },
  {
    name: "acked ids must name held frames",
    async run(h, a) {
      const { replica, frames } = h.thread;
      const loc = await h.fresh(1_000);
      const store = await loc.openStore();
      await store.adopt(replica, "Treehouse.Thread");
      await store.mergeSync(replica, [frames[0]!], []);
      const changes = counter(store);
      await a.rejects(store.mergeSync(replica, [], ["not-held"]), /acked_not_held/);
      // The whole merge is refused: the new frame in the same call is not retained either.
      await a.rejects(store.mergeSync(replica, [frames[1]!], ["not-held"]), /acked_not_held/);
      a.deepEqual(ids(store.profile(replica)?.frames), [frames[0]!.id]);
      a.deepEqual(changes, [], "a refused merge fires no change event");
      const reopened = await loc.openStore();
      a.deepEqual(ids(reopened.profile(replica)?.frames), [frames[0]!.id], "nothing reached disk");
      a.deepEqual(reopened.profile(replica)?.acked, []);
      a.equal(reopened.firstSeenMs(replica, frames[1]!.id), undefined);
      // An id pulled in the same merge may be acked by it.
      a.ok(await reopened.mergeSync(replica, [frames[1]!], [frames[1]!.id]));
      a.deepEqual(reopened.profile(replica)?.acked, [frames[1]!.id]);
    },
  },
  {
    name: "a frame for another replica, or an unknown replica, is refused and writes nothing",
    async run(h, a) {
      const { replica, frames } = h.thread;
      const loc = await h.fresh(1_000);
      const store = await loc.openStore();
      await a.rejects(store.appendAuthored(replica, frames[0]!), /unknown_replica/);
      await a.rejects(store.mergeSync(replica, [frames[0]!], []), /unknown_replica/);
      await store.adopt(replica, "Treehouse.Thread");
      await a.rejects(store.adopt(replica, "Treehouse.Space"), /replica_product_mismatch/);
      const other = "replica:treehouse:thread:other";
      await store.adopt(other, "Treehouse.Thread");
      await a.rejects(store.appendAuthored(other, frames[0]!), /wrong_replica/);
      await a.rejects(store.mergeSync(other, [frames[0]!], []), /wrong_replica/);
      const reopened = await loc.openStore();
      a.deepEqual(reopened.profile(other), { frames: [], outbox: [], acked: [] });
      a.deepEqual(reopened.profile(replica), { frames: [], outbox: [], acked: [] });
    },
  },
];
