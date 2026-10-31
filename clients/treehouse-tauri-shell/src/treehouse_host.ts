import { treehouseCommandDecoders } from "@treetopdevs/lattice-client";
import type { CarrierSigner, CarrierVerifier } from "@treetopdevs/lattice-client";
import {
  DEFAULT_POLL_MS,
  createFeedController,
  createPanelSync as createKitPanelSync,
  createRelayConnector,
  syncRoute,
  syncRoutes,
} from "@treetopdevs/lattice-shell-kit/sync";
import type {
  CreateFeedControllerOptions,
  FeedController,
  FeedSession,
  FeedState,
  FeedTimers,
  PanelSync as KitPanelSync,
  RelayConnection,
  RelayConnector,
  RelayConnectorOptions,
  RouteConnection,
  RouteFeedState,
  RouteOutcome,
  RouteSyncResult,
  ShellHost,
  SyncOptions,
  SyncResult,
} from "@treetopdevs/lattice-shell-kit/sync";
import { productOf, validateLocalRealm, validateRoute } from "./treehouse_routes";
import { MAX_ROUTES } from "./treehouse_state";
import type { RelayRoute } from "./treehouse_state";
import { fromBase64, strictEd25519, strictVerifier } from "./treehouse_workflow";
import type { TreehouseWorkflow } from "./treehouse_workflow";

// Plan 186 decision 6. The shell side of the kit's host port: the relay client, sync, feed and panel sync
// now live in @treetopdevs/lattice-shell-kit and reach the Treehouse workflow only through
// `treehouseHost`. Every member reads `workflow.state` live, so a route set or profile saved after
// construction is seen. The adapters below keep the signatures the old shell modules exported.

export type TreehouseRelayConnection = RelayConnection;
export type SyncTreehouseOptions = SyncOptions;
export type { FeedTimers, RouteOutcome, RouteSyncResult };
export type TreehouseSyncResult = SyncResult;
export type TreehouseFeedSession = FeedSession;
export type TreehouseRouteConnection = RouteConnection;
export type TreehouseRouteFeedState = RouteFeedState;
export type TreehouseFeedState = FeedState;
export type CreateTreehouseFeedControllerOptions = Omit<CreateFeedControllerOptions, "host"> & {
  workflow: TreehouseWorkflow;
};
export type TreehouseFeedController = FeedController;
export type TreehouseRelayConnectorOptions = Omit<RelayConnectorOptions, "host" | "verifier"> & {
  workflow: TreehouseWorkflow;
  /** Server hello check. Defaults to strict Ed25519 (no ZIP-215 leniency), as operation checks use. */
  verifier?: CarrierVerifier;
};
export type TreehouseRelayConnector = RelayConnector;

/** The kit host port over one workflow. */
export function treehouseHost(workflow: TreehouseWorkflow): ShellHost {
  return hostOver(() => workflow);
}

/** The host port over whichever workflow `current` returns at each call. */
function hostOver(current: () => TreehouseWorkflow): ShellHost {
  const host: ShellHost = {
    relay: () => current().state.relay,
    // A getter, as in treehouse_routes: MAX_ROUTES is read at use, never captured at construction.
    get maxRoutes() {
      return MAX_ROUTES;
    },
    isAnchor: (replica) => productOf(replica) === "Treehouse.Space",
    holdsAnchorProfile: () => current().state.profiles.some((p) => p.product === "Treehouse.Space"),
    profile: (replica) => current().state.profiles.find((p) => p.replica === replica),
    validators: { validateRoute, validateLocalRealm },
    decoders: (replica) => treehouseCommandDecoders(productOf(replica)),
    verifier: strictVerifier,
    mergeSync: (replica, pulled, ackedIds) => current().mergeSync(replica, pulled, ackedIds),
    capacityReason: "preview_storage_limit",
    signer: () => treehouseCarrierSigner(current()),
  };
  return host;
}

/**
 * The caller's options object, read live as the old shell modules read it: a member reassigned after
 * construction is seen, and getters and method callbacks run with the caller's object as `this`. The kit's
 * extra members are read from `extra` (a getter there runs when the kit reads it). The proxy wraps a fresh
 * object, so a frozen caller object cannot trip a proxy invariant.
 */
function liveOptions<T extends object, E extends object>(options: T, extra: E): T & E {
  return new Proxy({} as T & E, {
    get: (_target, property) => {
      if (property in extra) return Reflect.get(extra, property);
      const value: unknown = Reflect.get(options, property, options);
      // A call keeps the caller's object as `this`; `new` (the socket seam is a constructor) passes through.
      return typeof value === "function"
        ? new Proxy(value, { apply: (fn, _this, args) => Reflect.apply(fn, options, args) })
        : value;
    },
    has: (_target, property) => property in extra || property in options,
  });
}

const defaultVerifier: CarrierVerifier = {
  verify: (pubkey, bytes, signature) => strictEd25519(signature, bytes, pubkey),
};

/**
 * The carrier session signer for the local key. The public key comes from the saved record and every
 * signature goes through native signing, so no seed or private key is ever held in TypeScript.
 */
export function treehouseCarrierSigner(workflow: TreehouseWorkflow): CarrierSigner {
  const publicKey = workflow.state.publicKey;
  if (publicKey === null || !workflow.keyAvailable) throw new Error("identity_unavailable");
  return {
    publicKey: fromBase64(publicKey),
    sign: (bytes) => workflow.native.sign(bytes),
  };
}

export function createTreehouseRelayConnector(
  options: TreehouseRelayConnectorOptions,
): TreehouseRelayConnector {
  // The old connector read the workflow and the socket seam at each dial, and the verifier once.
  return createRelayConnector(
    liveOptions(options, {
      host: hostOver(() => options.workflow),
      verifier: options.verifier ?? defaultVerifier,
    }),
  );
}

/** Sync every configured route, the Space first. See the kit's `syncRoutes`. */
export function syncTreehouse(
  workflow: TreehouseWorkflow,
  options: SyncTreehouseOptions,
): Promise<TreehouseSyncResult> {
  return syncRoutes(treehouseHost(workflow), options);
}

/** One verified sync of one replica route. See the kit's `syncRoute`. */
export function syncTreehouseRoute(
  workflow: TreehouseWorkflow,
  route: RelayRoute,
  options: SyncTreehouseOptions,
): Promise<RouteSyncResult> {
  return syncRoute(treehouseHost(workflow), route, options);
}

export function createTreehouseFeedController(
  options: CreateTreehouseFeedControllerOptions,
): TreehouseFeedController {
  // The old controller captured the workflow once, after its timing options, and read every other option
  // live. The kit reads `host` once at that same point, so the getter reads the workflow then.
  return createFeedController(
    liveOptions(options, {
      get host() {
        return treehouseHost(options.workflow);
      },
    }),
  );
}

/** Build-time feed flags: `VITE_TREEHOUSE_POLL_MS` (0 disables) and `VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT`. */
export function treehouseFeedEnv(env: Record<string, string | undefined>): {
  pollMs: number;
  autosyncOnMount: boolean;
} {
  const raw = env.VITE_TREEHOUSE_POLL_MS;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const pollMs = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_POLL_MS;
  return { pollMs, autosyncOnMount: env.VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT !== "0" };
}

// Plan 181 slice 3c. The enrollment panel's Sync control and status, kept out of the Vue file so the wiring
// is testable without a DOM. Sync is the only action here that touches the network, it is always an
// explicit press (or the build-time autosync flag for a route that is already saved), and saving routes is
// never a network action. The status states relay facts only: what the relay acknowledged and what this
// device still holds back. It never claims that other members hold the same history.

export interface PanelSyncRouteStatus {
  replica: string;
  kind: "Group" | "Thread";
  connection: TreehouseRouteConnection;
  connectionLabel: string;
  pending: number;
  acked: number;
  generation: number | null;
  holdsRelayLabel: string;
  /** The relay's quarantined and rejected verdicts from the last sync, as `[id, reason]`. */
  refused: [string, string][];
  /** The relay's error reason when the last sync stopped submitting, else null. */
  submitStopped: string | null;
  message: string;
}

export interface PanelSyncStatus {
  configured: boolean;
  routes: PanelSyncRouteStatus[];
  summary: string;
}

const CONNECTION_LABELS: Record<TreehouseRouteConnection, string> = {
  idle: "Not connected",
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  refused: "Refused: this server is not the one saved for the route",
  full: "Paused: this device's local storage is full",
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Turn the feed controller's state into the text the status panel shows. */
export function describeSyncStatus(feed: TreehouseFeedState): PanelSyncStatus {
  const routes = feed.routes.map((route): PanelSyncRouteStatus => ({
    replica: route.replica,
    kind: productOf(route.replica) === "Treehouse.Space" ? "Group" : "Thread",
    connection: route.connection,
    connectionLabel: CONNECTION_LABELS[route.connection],
    pending: route.pending,
    acked: route.acked,
    generation: route.generation,
    holdsRelayLabel:
      route.matchesRelay === null
        ? "Not synced yet."
        : route.matchesRelay
          ? "This device holds every operation the relay lists."
          // Neutral on purpose: a local post still waiting for the relay differs the same way as a relay
          // operation not pulled yet, and the pending count already reports the first.
          : "This device and the relay do not list the same operations yet.",
    refused: route.refused,
    submitStopped: route.submitStopped,
    message: route.message,
  }));
  const pending = routes.reduce((n, r) => n + r.pending, 0);
  const acked = routes.reduce((n, r) => n + r.acked, 0);
  const summary = !feed.configured
    ? "No relay routes are saved yet."
    : routes.some((r) => r.connection === "full")
      ? "Local storage could not hold the latest relay operations. The refused merge writes nothing; earlier committed progress survives and history remains readable."
      : pending > 0
        ? `${plural(pending, "operation")} waiting to be acknowledged by the relay.`
        : `${plural(acked, "operation")} on this device ${acked === 1 ? "is" : "are"} acknowledged by the relay.`;
  return { configured: feed.configured, routes, summary };
}

export interface PanelSyncOptions {
  workflow: TreehouseWorkflow;
  /** Build-time flags (`import.meta.env` in the shell). */
  env?: Record<string, string | undefined>;
  /** The relay client. Defaults to the real authenticated carrier connector. */
  connector?: TreehouseRelayConnector;
  /** Sync seam overrides for tests: backoff sleep, verifier, pull round bound. */
  sync?: Partial<Omit<SyncTreehouseOptions, "connect">>;
  feedSleep?: (delay: number, signal: AbortSignal) => Promise<void>;
  timers?: FeedTimers;
  onStatus(status: PanelSyncStatus): void;
}

export type PanelSync = KitPanelSync<PanelSyncStatus>;

export function createPanelSync(options: PanelSyncOptions): PanelSync {
  const connector =
    options.connector ?? createTreehouseRelayConnector({ workflow: options.workflow });
  const flags = treehouseFeedEnv(options.env ?? {});
  // As before, `onStatus` is read at each emission; the other options are read once, here.
  return createKitPanelSync(
    liveOptions(options, {
      // Read when the kit builds the feed controller, where the old module passed `options.workflow`.
      get host() {
        return treehouseHost(options.workflow);
      },
      connector,
      describe: describeSyncStatus,
      pollMs: flags.pollMs,
      autosyncOnMount: flags.autosyncOnMount,
    }),
  );
}
