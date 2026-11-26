import { carrierOpsToSemanticOps, treehouseCommandDecoders } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, CarrierOpSigner } from "@treetopdevs/lattice-client";
import { createTreehouseSession } from "../../src/session/session";
import type { TreehouseSession } from "../../src/session/session";
import { MemoryReplicaDisk, MemoryReplicaStore } from "../../src/session/memory/replica_store";
import { MemoryKeyCustody } from "../../src/session/memory/key_custody";
import { ManualClock } from "../../src/session/memory/clock";
import { MemoryRelayLink } from "../../src/session/memory/relay_link";
import type { KeyCustody, RelayLink } from "../../src/session/ports";
import { openMemoryLocalStore } from "../../src/local/local_store";
import type { LocalStore } from "../../src/local/local_store";
import { buildGroup } from "./group_fixture";
import type { Group, TestIdentity } from "./group_fixture";

// M1a.5 command tests: one phone's session over a memory replica store seeded with a Group built by
// lattice-client's own helpers. Frames other phones author arrive through `deliver`, the same mergeSync
// path a pull uses (verified first by the session host). Nothing here reduces or judges.

export interface CommandPhone {
  group: Group;
  who: TestIdentity;
  session: TreehouseSession;
  store: MemoryReplicaStore;
  link: RelayLink;
  /** Signatures custody made: proves a refusal happened before or after signing. */
  signs: { count: number };
  /** The Thread profile as held now (frames, outbox, acked), deep-copied. */
  threadProfile(): { frames: CarrierOpFrame[]; outbox: string[]; acked: string[] };
  /** Merge frames another phone authored into this phone's store, as a pull would. */
  deliver(replica: string, frames: readonly CarrierOpFrame[]): Promise<void>;
  close(): Promise<void>;
}

function counting(signer: CarrierOpSigner): { custody: KeyCustody; signs: { count: number } } {
  const inner = MemoryKeyCustody.holding(signer);
  const signs = { count: 0 };
  return {
    signs,
    custody: {
      status: () => inner.status(),
      publicKey: () => inner.publicKey(),
      create: () => inner.create(),
      async sign(bytes) {
        signs.count++;
        return inner.sign(bytes);
      },
    },
  };
}

export async function openPhone(
  opts: { group?: Group; as?: (group: Group) => TestIdentity; members?: number; local?: LocalStore; link?: () => RelayLink } = {},
): Promise<CommandPhone> {
  const group = opts.group ?? (await buildGroup({ members: opts.members ?? 2 }));
  const who = opts.as ? opts.as(group) : group.admin;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  await store.adopt(group.space.replica, "Treehouse.Space");
  await store.mergeSync(group.space.replica, group.space.frames, []);
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  await store.mergeSync(group.thread.replica, group.thread.frames, []);
  const { custody, signs } = counting(who.signer);
  let link!: RelayLink;
  const session = createTreehouseSession({
    custody,
    store,
    clock: new ManualClock(2_000),
    link: () => (link = opts.link ? opts.link() : new MemoryRelayLink()),
    local: opts.local ?? (await openMemoryLocalStore()),
  });
  await session.open();
  const threadProfile = () => structuredClone(store.profile(group.thread.replica)!) as { frames: CarrierOpFrame[]; outbox: string[]; acked: string[] };
  return {
    group,
    who,
    session,
    store,
    link,
    signs,
    threadProfile,
    async deliver(replica, frames) {
      await store.mergeSync(replica, [...frames], []);
    },
    close: () => session.close(),
  };
}

/** The frame with `id` in this phone's Thread profile. */
export function heldFrame(phone: CommandPhone, id: string): CarrierOpFrame {
  const frame = phone.threadProfile().frames.find((f) => f.id === id);
  if (!frame) throw new Error(`frame ${id} not held`);
  return frame;
}

/** The command name and args of a held Thread frame, decoded by lattice-client. */
export function decoded(frame: CarrierOpFrame): { command: string | undefined; args: unknown[] } {
  const [op] = carrierOpsToSemanticOps([frame], {}, treehouseCommandDecoders("Treehouse.Thread"));
  return { command: op?.command, args: [...(op?.commandArgs ?? [])] };
}
