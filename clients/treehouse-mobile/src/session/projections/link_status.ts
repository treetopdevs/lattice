import type { FeedState, RouteConnection } from "@treetopdevs/lattice-shell-kit/sync";

// LinkStatus (03, "Connection state"): one Group pill from shell-kit's per-route states, with the Space
// route as the anchor. 03's table overlaps, so the pill takes the first rule that matches, in this order:
//   offline           sync turned off, nothing configured, or no route is trying (all idle)
//   relay_refused     the Space route is refused (wrong relay key or no relay access)
//   reconnecting      any route is reconnecting
//   live              every route is live
//   partly_connected  the Space route is live and some Thread route is not
//   connecting        otherwise (some route still connecting)

export type LinkPill = "live" | "connecting" | "reconnecting" | "partly_connected" | "relay_refused" | "offline";

export interface LinkRouteStatus {
  replica: string;
  connection: RouteConnection;
  /** Authored ids not yet durable on the relay (shell-kit's count). */
  waiting: number;
}

export interface LinkStatus {
  pill: LinkPill;
  routes: LinkRouteStatus[];
  /** Total waiting to send: held outbox ids not yet acknowledged, across every replica. */
  waiting: number;
  /** Local time of the last successful sync, stamped by the session; null before one. */
  lastSyncMs: number | null;
  /**
   * The person's sync setting (M1b.7): false after Pause sync. The Offline pill also covers an idle or
   * unconfigured link, so the Group tab's switch reads this, not the pill.
   */
  syncEnabled: boolean;
}

export interface LinkStatusInputs {
  feed: FeedState;
  space: string | null;
  syncEnabled: boolean;
  waiting: number;
  lastSyncMs: number | null;
}

export function projectLinkStatus(inputs: LinkStatusInputs): LinkStatus {
  const routes = inputs.feed.routes.map((r) => ({ replica: r.replica, connection: r.connection, waiting: r.pending }));
  return { pill: pill(inputs), routes, waiting: inputs.waiting, lastSyncMs: inputs.lastSyncMs, syncEnabled: inputs.syncEnabled };
}

function pill(inputs: LinkStatusInputs): LinkPill {
  const routes = inputs.feed.routes;
  if (!inputs.syncEnabled || !inputs.feed.configured || routes.length === 0) return "offline";
  if (routes.every((r) => r.connection === "idle")) return "offline";
  const space = routes.find((r) => r.replica === inputs.space);
  if (space?.connection === "refused") return "relay_refused";
  if (routes.some((r) => r.connection === "reconnecting")) return "reconnecting";
  if (routes.every((r) => r.connection === "live")) return "live";
  if (space?.connection === "live") return "partly_connected";
  return "connecting";
}

export type RelayAccess = "no_group" | "checking" | "admitted" | "no_relay_access";

/** Relay access, with the Space route as the anchor (03): refused there means this phone has no relay access. */
export function relayAccess(state: FeedState, spaceReplica: string | null): RelayAccess {
  const space = spaceReplica === null ? undefined : state.routes.find((r) => r.replica === spaceReplica);
  if (!state.configured || !space) return "no_group";
  if (space.connection === "refused") return "no_relay_access";
  if (space.connection === "live") return "admitted";
  return "checking";
}
