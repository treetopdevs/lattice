import { TREEHOUSE_LITE_THREAD_CAP, treehouseSpaceInitialization } from "@treetopdevs/lattice-client";
import type { TreehouseInitialization } from "@treetopdevs/lattice-client";
import { authorOf } from "./replica_view";
import type { ReplicaView } from "./replica_view";

// GroupSummary (03): name, member count, my roles, thread slots, initialization. All values are the
// judge's materialized Space state; the roster's member set is the one counted here.

export type GroupRole = "admin" | "moderator" | "member";

/** The contract's Threads per Space (docs/treehouse_catalog_publication.md: one Space and twelve Threads). */
export const THREADS_PER_SPACE = 12;

export interface GroupSummary {
  replica: string;
  name: string;
  /** The roster size: the root, the admin and moderator holders, and every admitted member. */
  memberCount: number;
  /** Roles this key holds, in the order admin, moderator, member. Empty without a key. */
  myRoles: GroupRole[];
  admin: string | null;
  moderator: string | null;
  /** Threads against the contract's 12 per Space (03; one Space and twelve Threads per catalog). */
  threadSlots: { used: number; total: number };
  /** The invitation scope cap the shells enforce today (TREEHOUSE_LITE_THREAD_CAP); 03 records the gap. */
  inviteScopeCap: number;
  initialization: TreehouseInitialization;
}

export interface GroupSummaryInputs {
  space: ReplicaView | null;
  myKey: string | null;
}

/** Initialization materializes the Space again, so it is computed once per judged view. */
const initializations = new WeakMap<ReplicaView, TreehouseInitialization>();
function initializationOf(space: ReplicaView): TreehouseInitialization {
  let value = initializations.get(space);
  if (value === undefined) {
    value = treehouseSpaceInitialization(space.ops);
    initializations.set(space, value);
  }
  return value;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The key of the Space's honored genesis author, which its #root: commitment names. */
export function spaceRoot(space: ReplicaView): string | null {
  for (const id of space.order) {
    const op = space.byId.get(id);
    if (op && op.kind === "authority" && op.authority?.type === "genesis" && !space.quarantine.has(id)) return authorOf(op);
  }
  return null;
}

/** The roster's member keys: root, admin holder, moderator holder, then admitted members, without repeats. */
export function groupMemberKeys(space: ReplicaView): string[] {
  const members = Array.isArray(space.state.members) ? (space.state.members as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const keys = [spaceRoot(space), text(space.state.admin), text(space.state.moderator), ...members].filter((k): k is string => k !== null);
  return [...new Set(keys)];
}

export function projectGroupSummary(inputs: GroupSummaryInputs): GroupSummary | null {
  const { space, myKey } = inputs;
  if (space === null) return null;
  const admin = text(space.state.admin);
  const moderator = text(space.state.moderator);
  const members = Array.isArray(space.state.members) ? (space.state.members as unknown[]) : [];
  const threads = Array.isArray(space.state.threads) ? space.state.threads.length : 0;
  const myRoles: GroupRole[] = [];
  if (myKey !== null) {
    if (admin === myKey) myRoles.push("admin");
    if (moderator === myKey) myRoles.push("moderator");
    if (members.includes(myKey)) myRoles.push("member");
  }
  return {
    replica: space.replica,
    name: String(space.state.name ?? ""),
    memberCount: groupMemberKeys(space).length,
    myRoles,
    admin,
    moderator,
    threadSlots: { used: threads, total: THREADS_PER_SPACE },
    inviteScopeCap: TREEHOUSE_LITE_THREAD_CAP,
    initialization: initializationOf(space),
  };
}
