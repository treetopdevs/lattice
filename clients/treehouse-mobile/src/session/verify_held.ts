import {
  base64ToBytes,
  carrierOpsToSemanticOps,
  observeTreehouse,
  townshipReplicaCommitment,
  townshipReplicaRootTag,
  treehouseCommandDecoders,
  verifyCarrierOp,
  verifyEd25519,
} from "@treetopdevs/lattice-client";
import type { TreehouseProduct, Verifier } from "@treetopdevs/lattice-client";
import type { HeldProfile } from "./ports";

// Verify on open (M1a.2): the mobile form of the Tauri shell's verifyProfile and validateProfiles
// (clients/treehouse-tauri-shell/src/treehouse_workflow.ts), calling the same lattice-client functions.
// Pure: it reads the held profiles and never writes. Every frame's id and signature check, deps are
// closed, outbox and acked ids are held, the genesis matches the replica's #root: commitment, and every
// held Thread is referenced by the held Space.
//
// Two mobile differences: an adopted replica that holds nothing yet (adopt runs before the first pull)
// passes, and the replica-name grammar is not re-checked here (the session's route validators own it).

export type HeldHistoryReason =
  | "invalid_profile_replica"
  | "invalid_retained_history"
  | "incomplete_retained_history"
  | "wrong_profile_root"
  | "invalid_profile_root"
  | "incomplete_profile_initialization"
  | "invalid_space_profiles"
  | "unreferenced_local_thread";

export type VerifyHeldResult = { ok: true } | { ok: false; replica: string; reason: HeldHistoryReason };

export interface HeldEntry {
  replica: string;
  product: TreehouseProduct;
  profile: HeldProfile | undefined;
}

export const strictOpVerifier: Verifier = {
  async verify(author, bytes, sig) {
    try {
      return verifyEd25519(sig, bytes, base64ToBytes(author));
    } catch {
      return false;
    }
  },
};

class Invalid extends Error {
  constructor(readonly reason: HeldHistoryReason) {
    super(reason);
  }
}

const PREFIX: Record<TreehouseProduct, string> = {
  "Treehouse.Space": "replica:treehouse:space:",
  "Treehouse.Thread": "replica:treehouse:thread:",
};

const empty = (p: HeldProfile | undefined) =>
  !p || (p.frames.length === 0 && p.outbox.length === 0 && p.acked.length === 0);

/** One replica's checks. Returns the observation, whose Space state lists the referenced Threads. */
async function verifyOne(entry: HeldEntry, verifier: Verifier) {
  const { replica, product } = entry;
  const profile = entry.profile!;
  if (!replica.startsWith(PREFIX[product]) || townshipReplicaCommitment(replica) === null)
    throw new Invalid("invalid_profile_replica");
  const ids = new Set<string>();
  for (const frame of profile.frames) {
    if (frame.replica !== replica || ids.has(frame.id)) throw new Invalid("invalid_retained_history");
    ids.add(frame.id);
    let valid = false;
    try {
      valid = (await verifyCarrierOp(frame, verifier)).valid;
    } catch {
      valid = false;
    }
    if (!valid) throw new Invalid("invalid_retained_history");
  }
  if (
    ids.size === 0 ||
    profile.frames.some((f) => f.deps.some((id) => !ids.has(id))) ||
    new Set(profile.outbox).size !== profile.outbox.length ||
    profile.outbox.some((id) => !ids.has(id)) ||
    new Set(profile.acked).size !== profile.acked.length ||
    profile.acked.some((id) => !ids.has(id))
  )
    throw new Invalid("incomplete_retained_history");
  let ops;
  try {
    ops = carrierOpsToSemanticOps([...profile.frames], {}, treehouseCommandDecoders(product));
  } catch {
    throw new Invalid("invalid_retained_history");
  }
  // Select the root by the #root: commitment, never by position: a relay may serve a competing genesis.
  const commitment = townshipReplicaCommitment(replica);
  let rootId: string | undefined;
  for (const op of ops) {
    if (op.deps.length !== 0 || op.authority?.type !== "genesis") continue;
    const author = profile.frames.find((frame) => frame.id === op.id)?.author;
    if (author !== undefined && commitment === (await townshipReplicaRootTag(author))) {
      rootId = op.id;
      break;
    }
  }
  if (rootId === undefined) throw new Invalid("wrong_profile_root");
  const view = observeTreehouse(product, ops);
  if (view.quarantineReasons.has(rootId) || view.order.length !== ids.size) throw new Invalid("invalid_profile_root");
  const creation = product === "Treehouse.Space" ? "create_space" : "create_thread";
  if (
    !ops.some(
      (op) =>
        op.kind === "command" &&
        op.command === creation &&
        op.deps.length === 1 &&
        op.deps[0] === rootId &&
        !view.quarantineReasons.has(op.id),
    )
  )
    throw new Invalid("incomplete_profile_initialization");
  return view;
}

/** Verifies every held replica and the set as a whole. The first failure names its replica. */
export async function verifyHeld(
  held: readonly HeldEntry[],
  options: { verifier?: Verifier } = {},
): Promise<VerifyHeldResult> {
  const verifier = options.verifier ?? strictOpVerifier;
  const present = held.filter((entry) => !empty(entry.profile));
  const views = new Map<string, Awaited<ReturnType<typeof verifyOne>>>();
  for (const entry of present) {
    try {
      views.set(entry.replica, await verifyOne(entry, verifier));
    } catch (error) {
      if (error instanceof Invalid) return { ok: false, replica: entry.replica, reason: error.reason };
      throw error;
    }
  }
  const spaces = held.filter((entry) => entry.product === "Treehouse.Space");
  const threads = present.filter((entry) => entry.product === "Treehouse.Thread");
  if (spaces.length > 1) return { ok: false, replica: spaces[1]!.replica, reason: "invalid_space_profiles" };
  const space = spaces[0];
  const references = space && views.has(space.replica) ? (views.get(space.replica)!.state.threads as { replica: string }[]) : [];
  for (const thread of threads) {
    if (!references.some((r) => r.replica === thread.replica))
      return { ok: false, replica: thread.replica, reason: "unreferenced_local_thread" };
  }
  return { ok: true };
}
