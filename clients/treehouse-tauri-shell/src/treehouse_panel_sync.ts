import { createTreehouseFeedController, treehouseFeedEnv } from "./treehouse_feed";
import type {
  FeedTimers,
  TreehouseFeedController,
  TreehouseFeedState,
  TreehouseRouteConnection,
} from "./treehouse_feed";
import { productOf } from "./treehouse_routes";
import { createTreehouseRelayConnector } from "./treehouse_relay_client";
import type { TreehouseRelayConnector } from "./treehouse_relay_client";
import type { SyncTreehouseOptions } from "./treehouse_sync";
import type { TreehouseWorkflow } from "./treehouse_workflow";

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
          : "The relay lists operations this device does not hold yet.",
    message: route.message,
  }));
  const pending = routes.reduce((n, r) => n + r.pending, 0);
  const acked = routes.reduce((n, r) => n + r.acked, 0);
  const summary = !feed.configured
    ? "No relay routes are saved yet."
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

export interface PanelSync {
  /** Report status, and connect only when autosync is on and a route is already saved. */
  start(): Promise<void>;
  /** One explicit verified sync per route, starting the session's subscriptions. */
  sync(): Promise<PanelSyncStatus>;
  /** Routes were saved or extended. Restarts feeds that are running; never starts one. */
  routesChanged(): Promise<void>;
  status(): PanelSyncStatus;
  stop(): Promise<void>;
}

export function createPanelSync(options: PanelSyncOptions): PanelSync {
  const connector =
    options.connector ?? createTreehouseRelayConnector({ workflow: options.workflow });
  const flags = treehouseFeedEnv(options.env ?? {});
  const controller: TreehouseFeedController = createTreehouseFeedController({
    workflow: options.workflow,
    sync: { ...options.sync, connect: (route, realm) => connector.connect(route, realm) },
    connect: (route, realm) => connector.connectFeed(route, realm),
    onState: (state) => options.onStatus(describeSyncStatus(state)),
    pollMs: flags.pollMs,
    autosyncOnMount: flags.autosyncOnMount,
    ...(options.feedSleep ? { sleep: options.feedSleep } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  const status = () => describeSyncStatus(controller.state());
  return {
    start: () => controller.start(),
    async sync() {
      return describeSyncStatus(await controller.syncNow());
    },
    async routesChanged() {
      const running = controller.state().routes.some((r) => r.connection !== "idle");
      if (running) await controller.reconfigure();
      else options.onStatus(status());
    },
    status,
    stop: () => controller.stop(),
  };
}
