import type { FeedState } from "../session/ports";

// M1a.6: the trust card copy and the relay access state. Pure: no react, react-native or expo, so Node
// tests read the same constants the screen renders. M1a.5 folds the copy into strings.ts and M1a.4's
// link_status projection takes over relayAccess.

/** The one approved hosting sentence, short form for cards (01, "Hosting sentence"). */
export const HOSTING_SENTENCE =
  "The relay keeps a readable copy of this group. Its operator can read it and can take the relay offline. " +
  "The relay cannot write messages in your name or change who is a member, and it cannot erase what is already on your phone.";

/** Shown when the relay refuses this phone's key at the hello (04, join step 4; 03 pill "Relay refused this phone"). */
export const NO_RELAY_ACCESS = "The relay does not know this phone yet. Ask the admin to check relay access.";

/** 04 error table: a held-history verify failure, shown with its reason code. Nothing syncs. */
export const HISTORY_INVALID = "Saved group data failed its check.";

export const RELAY_REFUSED_PILL = "Relay refused this phone";

/** Shown in a build without demo identities, where this phone holds only its own key and no group yet. */
export const NO_GROUP_YET = "This phone is not in a group yet. Joining by invitation comes in a later version.";

export type RelayAccess = "no_group" | "checking" | "admitted" | "no_relay_access";

/** Relay access, with the Space route as the anchor (03): refused there means this phone has no relay access. */
export function relayAccess(state: FeedState, spaceReplica: string | null): RelayAccess {
  const space = spaceReplica === null ? undefined : state.routes.find((r) => r.replica === spaceReplica);
  if (!state.configured || !space) return "no_group";
  if (space.connection === "refused") return "no_relay_access";
  if (space.connection === "live") return "admitted";
  return "checking";
}
