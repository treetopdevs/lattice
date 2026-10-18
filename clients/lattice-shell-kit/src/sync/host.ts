import type {
  CarrierOpFrame,
  CarrierSigner,
  CommandDecoderMap,
  Verifier,
} from "@treetopdevs/lattice-client";
import type { CarrierRoute, RouteConfig, RouteValidators } from "../routes";

// Plan 186 decision 6: the two-interface host port. The shell implements both over its own workflow and
// state (Treehouse: src/treehouse_host.ts), and the relay client, sync and feed reach the product only
// through them. Every member reads live state: a route set or profile saved after construction is seen.

/** The retained frames of one replica and the authored ids among them, as the host has them saved. */
export interface HeldProfile {
  frames: CarrierOpFrame[];
  /** Ids this device authored. Never shrinks. */
  outbox: string[];
  /** Ids known durable on the relay. Grows only; a subset of the retained frame ids. */
  acked: string[];
}

/** What the shell has configured: routes, local realm, pinned profiles, the route limit. */
export interface RouteBook {
  /** The saved route set and local realm, or null before any route is saved. */
  relay(): RouteConfig | null;
  /** At most this many routes may be configured. */
  readonly maxRoutes: number;
  /** The anchor replica (Treehouse: the Space). Anchors sync before every other route. */
  isAnchor(replica: string): boolean;
  /** True once a profile of the anchor kind is held, whichever replica it is. */
  holdsAnchorProfile(): boolean;
  /** The held profile of one replica, or undefined. */
  profile(replica: string): HeldProfile | undefined;
  /** The route and realm checks, run before any socket exists. */
  readonly validators: Pick<RouteValidators, "validateRoute" | "validateLocalRealm">;
}

/** What one sync needs from the shell: decoders, verifier, the frame store and the session identity. */
export interface SyncHost {
  /** The command decoders for a replica's product. */
  decoders(replica: string): CommandDecoderMap;
  /** The default operation signature check. */
  readonly verifier: Verifier;
  /**
   * Merge a verified, dependency-closed pull and relay acknowledgements in one commit. Writes nothing when
   * the merge adds nothing.
   */
  mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]): Promise<unknown>;
  /** The carrier session signer, read at each dial. Throws when the identity is unavailable. */
  signer(): CarrierSigner;
}

export type ShellHost = RouteBook & SyncHost;

export type { CarrierRoute };
