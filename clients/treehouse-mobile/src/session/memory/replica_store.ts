import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { Clock, HeldProfile, HeldReplica, ReplicaStore, TreehouseProduct } from "../ports";

// In-memory ReplicaStore for Core tests. The "disk" outlives a store object, so a test can restart a
// session over the same durable state. Writes are copy-on-write and only ever add: frames and outbox ids
// are appended, acked ids grow, nothing is deleted or rewritten (the rules M1a.2's SQLite store keeps).

interface DiskReplica {
  product: TreehouseProduct;
  frames: CarrierOpFrame[];
  outbox: string[];
  acked: string[];
  firstSeen: Record<string, number>;
}

/** Durable state shared by every MemoryReplicaStore opened on it. */
export class MemoryReplicaDisk {
  replicas = new Map<string, DiskReplica>();
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryReplicaStore implements ReplicaStore {
  private held = new Map<string, DiskReplica>();
  private readonly listeners = new Set<(replica: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly disk: MemoryReplicaDisk = new MemoryReplicaDisk(),
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  async open(): Promise<void> {
    this.held = new Map([...this.disk.replicas].map(([replica, entry]) => [replica, copy(entry)]));
  }

  replicas(): HeldReplica[] {
    return [...this.held].map(([replica, entry]) => ({ replica, product: entry.product }));
  }

  profile(replica: string): HeldProfile | undefined {
    const entry = this.held.get(replica);
    return entry && { frames: entry.frames, outbox: entry.outbox, acked: entry.acked };
  }

  firstSeenMs(replica: string, id: string): number | undefined {
    return this.held.get(replica)?.firstSeen[id];
  }

  adopt(replica: string, product: TreehouseProduct): Promise<void> {
    return this.write(replica, (current) => {
      if (current) {
        if (current.product !== product) throw new Error("replica_product_mismatch");
        return null;
      }
      return { product, frames: [], outbox: [], acked: [], firstSeen: {} };
    }).then(() => undefined);
  }

  appendAuthored(replica: string, frame: CarrierOpFrame): Promise<void> {
    return this.write(replica, (current) => {
      if (!current) throw new Error("unknown_replica");
      if (frame.replica !== replica) throw new Error("wrong_replica");
      const held = current.frames.some((f) => f.id === frame.id);
      const queued = current.outbox.includes(frame.id);
      if (held && queued) return null;
      return {
        ...current,
        frames: held ? current.frames : [...current.frames, frame],
        outbox: queued ? current.outbox : [...current.outbox, frame.id],
        firstSeen: held ? current.firstSeen : { ...current.firstSeen, [frame.id]: this.clock.now() },
      };
    }).then(() => undefined);
  }

  async mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]): Promise<boolean> {
    return this.write(replica, (current) => {
      if (!current) throw new Error("unknown_replica");
      const ids = new Set(current.frames.map((f) => f.id));
      const added: CarrierOpFrame[] = [];
      const now = this.clock.now();
      const firstSeen = { ...current.firstSeen };
      for (const frame of pulled) {
        if (frame.replica !== replica) throw new Error("wrong_replica");
        if (ids.has(frame.id)) continue;
        ids.add(frame.id);
        added.push(frame);
        firstSeen[frame.id] = now;
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
      return { ...current, frames: [...current.frames, ...added], acked: [...current.acked, ...newAcks], firstSeen };
    });
  }

  onChange(listener: (replica: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One serialized write: `next` returns the new entry, or null for no change. Returns whether it changed. */
  private write(replica: string, next: (current: DiskReplica | undefined) => DiskReplica | null): Promise<boolean> {
    const run = async () => {
      const updated = next(this.held.get(replica));
      if (updated === null) return false;
      this.disk.replicas.set(replica, copy(updated));
      this.held.set(replica, updated);
      for (const listener of [...this.listeners]) listener(replica);
      return true;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
