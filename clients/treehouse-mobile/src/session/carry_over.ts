import type { TreehouseProduct } from "@treetopdevs/lattice-client";
import type { HeldProfile, ReplicaStore } from "./ports";
import { verifyHeld } from "./verify_held";
import type { HeldHistoryReason } from "./verify_held";

// Carry-over from the M0 identity-scoped snapshot (src/native/storage.ts, one namespace per identity)
// into the ReplicaStore, so an unsynced post saved before the switch is not stranded (07, defect a).
// The legacy profiles are verified first and nothing is written if they fail. Carrying only adds through
// the store's own write paths, so a second run adds nothing; the legacy snapshot is never modified or
// cleared here. The caller passes one identity's namespace into that identity's replica store.

export type CarryOverResult =
  | { ok: true; carried: number; skipped: string[] }
  | { ok: false; replica: string; reason: HeldHistoryReason };

const productOf = (replica: string): TreehouseProduct | null =>
  replica.startsWith("replica:treehouse:space:")
    ? "Treehouse.Space"
    : replica.startsWith("replica:treehouse:thread:")
      ? "Treehouse.Thread"
      : null;

export async function carryOverLegacyProfiles(
  store: ReplicaStore,
  profiles: Readonly<Record<string, HeldProfile>>,
): Promise<CarryOverResult> {
  const entries: { replica: string; product: TreehouseProduct; profile: HeldProfile }[] = [];
  // A replica that is neither a Space nor a Thread is not Treehouse history (the M0 host could hold
  // other demo endpoints); it is reported, left in the legacy snapshot, and does not block the rest.
  const skipped: string[] = [];
  for (const [replica, profile] of Object.entries(profiles)) {
    const product = productOf(replica);
    if (!product) skipped.push(replica);
    else entries.push({ replica, product, profile });
  }
  // Each legacy profile must stand on its own before it is merged: every frame filed under its replica and
  // every outbox and acked id held in that same snapshot. A frame or id the store already holds must not
  // mask a bad legacy entry, since the merged check below skips frames by id (a held id is not re-carried).
  for (const { replica, profile } of entries) {
    if (profile.frames.some((f) => f.replica !== replica))
      return { ok: false, replica, reason: "invalid_retained_history" };
    const legacyIds = new Set(profile.frames.map((f) => f.id));
    if ([...profile.outbox, ...profile.acked].some((id) => !legacyIds.has(id)))
      return { ok: false, replica, reason: "incomplete_retained_history" };
  }
  // Verify what the store would hold afterwards: the store's current profiles with the legacy frames added.
  const merged = new Map<string, { replica: string; product: TreehouseProduct; profile: HeldProfile }>();
  for (const held of store.replicas())
    merged.set(held.replica, { ...held, profile: store.profile(held.replica) ?? { frames: [], outbox: [], acked: [] } });
  for (const entry of entries) {
    const current = merged.get(entry.replica)?.profile ?? { frames: [], outbox: [], acked: [] };
    const ids = new Set(current.frames.map((f) => f.id));
    merged.set(entry.replica, {
      ...entry,
      profile: {
        frames: [...current.frames, ...entry.profile.frames.filter((f) => !ids.has(f.id))],
        outbox: [...new Set([...current.outbox, ...entry.profile.outbox])],
        acked: [...new Set([...current.acked, ...entry.profile.acked])],
      },
    });
  }
  const verdict = await verifyHeld([...merged.values()]);
  if (!verdict.ok) return verdict;

  let carried = 0;
  // Space first, so a Thread is never held without the Space that references it.
  entries.sort((a, b) => (a.product === b.product ? 0 : a.product === "Treehouse.Space" ? -1 : 1));
  for (const { replica, product, profile } of entries) {
    await store.adopt(replica, product);
    const before = JSON.stringify(store.profile(replica));
    // Frames first, as pulled; then the outbox through appendAuthored (it keeps the held row); then acks.
    await store.mergeSync(replica, profile.frames, []);
    const byId = new Map(profile.frames.map((f) => [f.id, f]));
    for (const id of profile.outbox) {
      if (!store.profile(replica)?.outbox.includes(id)) await store.appendAuthored(replica, byId.get(id)!);
    }
    await store.mergeSync(replica, [], [...profile.acked]);
    if (JSON.stringify(store.profile(replica)) !== before) carried++;
  }
  return { ok: true, carried, skipped };
}
