import {
  authorTreehouseCommand,
  authorTreehouseGrantRevocation,
  carrierDelegationsFromFrames,
  memberCapability,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, TreehouseCommand, TreehouseProduct } from "@treetopdevs/lattice-client";
import { heads } from "./group_fixture";
import type { Group, TestIdentity } from "./group_fixture";

// Authoring helpers for M1a.4 read-model tests. Every op is authored and signed with lattice-client's own
// helpers and a test identity's signer; nothing here reduces or judges.

/** The root delegation of a replica (its genesis), which the admin cites for root-only commands. */
export const rootCap = (frames: readonly CarrierOpFrame[]): string => carrierDelegationsFromFrames([frames[0]!])[0]!.id;

export async function authorAs(
  who: TestIdentity,
  product: TreehouseProduct,
  frames: readonly CarrierOpFrame[],
  command: TreehouseCommand,
  capId: string | null,
  deps: string[] = heads(frames),
): Promise<CarrierOpFrame> {
  return authorTreehouseCommand({ product, replica: frames[0]!.replica, deps, signer: who.signer, capId, command });
}

/** Revoke `member`'s honored Thread post grant, signed by the admin, on top of `deps`. */
export async function revokeThreadGrant(group: Group, member: TestIdentity, frames: readonly CarrierOpFrame[], deps: string[]) {
  const cap = memberCapability(frames, member.pubkey, group.thread.replica, { product: "Treehouse.Thread", command: "post" });
  if (!cap) throw new Error(`${member.realm} holds no Thread grant`);
  return authorTreehouseGrantRevocation({ replica: group.thread.replica, deps, signer: group.admin.signer, delegationId: cap.id });
}

/** A test identity's post on a Thread view, with explicit deps (for concurrent authoring). */
export async function postAt(who: TestIdentity, frames: readonly CarrierOpFrame[], text: string, deps: string[]) {
  const cap = memberCapability(frames, who.pubkey, frames[0]!.replica, { product: "Treehouse.Thread", command: "post" });
  return authorAs(who, "Treehouse.Thread", frames, { command: "post", text }, cap?.id ?? null, deps);
}
