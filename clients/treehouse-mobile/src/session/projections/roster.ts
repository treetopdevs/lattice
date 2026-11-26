import type { RouteFeedState } from "@treetopdevs/lattice-shell-kit/sync";
import { groupMemberKeys, spaceRoot } from "./group_summary";
import { relayAccess } from "./link_status";
import type { RelayAccess } from "./link_status";
import { authorOf, honoredCommands } from "./replica_view";
import type { ReplicaView } from "./replica_view";

// Roster (03): per member, contact, Space roles, is-root, relay access if known, removal pending. Relay
// access is known only for this phone's own key (from the Space route); nothing reports it for other keys.
// A member whose removal this phone authored but has not yet had acknowledged stays listed as pending.

export type RosterRole = "admin" | "moderator";

export interface RosterEntry {
  pubkey: string;
  /** Device-local name (LocalStore), or null. */
  petname: string | null;
  roles: RosterRole[];
  isRoot: boolean;
  isMe: boolean;
  /** Only for this phone's own key; null when unknown. */
  relayAccess: RelayAccess | null;
  removalPending: boolean;
}

export interface Roster {
  members: RosterEntry[];
  /** True when the Space's moderator holder differs from some held Thread's (03: one Group moderator). */
  moderatorMismatch: boolean;
}

export interface RosterInputs {
  space: ReplicaView | null;
  threads: readonly ReplicaView[];
  myKey: string | null;
  petname(pubkey: string): string | null;
  spaceRoute: RouteFeedState | null;
  /** Space ids this phone authored that are not yet acknowledged (outbox minus acked). */
  waitingIds: ReadonlySet<string>;
}

export function projectRoster(inputs: RosterInputs): Roster {
  const { space } = inputs;
  if (space === null) return { members: [], moderatorMismatch: false };
  const root = spaceRoot(space);
  const admin = space.state.admin;
  const moderator = space.state.moderator;
  const keys = groupMemberKeys(space);
  const pending = honoredCommands(space, "remove_member")
    .filter((op) => inputs.waitingIds.has(op.id) && authorOf(op) === inputs.myKey)
    .map((op) => String(op.commandArgs?.[0]));
  const pendingSet = new Set(pending);
  for (const key of pending) if (!keys.includes(key)) keys.push(key);

  const access =
    inputs.spaceRoute === null ? null : relayAccess({ configured: true, routes: [inputs.spaceRoute] }, space.replica);
  const members = keys.map((pubkey): RosterEntry => {
    const roles: RosterRole[] = [];
    if (admin === pubkey) roles.push("admin");
    if (moderator === pubkey) roles.push("moderator");
    const isMe = pubkey === inputs.myKey;
    return {
      pubkey,
      petname: inputs.petname(pubkey),
      roles,
      isRoot: pubkey === root,
      isMe,
      relayAccess: isMe ? access : null,
      removalPending: pendingSet.has(pubkey),
    };
  });
  // An adopted Thread holding no frames yet (before its first pull, which verify_held permits) has no
  // moderator to compare; only Threads with history count.
  const moderatorMismatch = inputs.threads.some((thread) => thread.frames.length > 0 && thread.state.moderator !== moderator);
  return { members, moderatorMismatch };
}
