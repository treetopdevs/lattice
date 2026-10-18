import { createFeedController } from "./feed";
import type { FeedController, FeedState, FeedTimers } from "./feed";
import type { ShellHost } from "./host";
import type { RelayConnector } from "./relay_client";
import type { SyncOptions } from "./sync";

// Plan 181 slice 3c. The enrollment panel's Sync control and status, kept out of the Vue file so the wiring
// is testable without a DOM. Sync is the only action here that touches the network, it is always an
// explicit press (or the build-time autosync flag for a route that is already saved), and saving routes is
// never a network action. The status states relay facts only: what the relay acknowledged and what this
// device still holds back. It never claims that other members hold the same history. The status text is
// product copy and stays in the shell, which passes it in as `describe`.

export interface PanelSyncOptions<S> {
  host: ShellHost;
  /** The relay client. The shell passes the real authenticated carrier connector by default. */
  connector: RelayConnector;
  /** Turn the feed controller's state into the text the status panel shows. */
  describe(feed: FeedState): S;
  /** Poll fallback interval in milliseconds, from the shell's build-time flags. 0 disables it. */
  pollMs: number;
  /** When false nothing connects until a manual `sync`, from the shell's build-time flags. */
  autosyncOnMount: boolean;
  /** Sync seam overrides for tests: backoff sleep, verifier, pull round bound. */
  sync?: Partial<Omit<SyncOptions, "connect">>;
  feedSleep?: (delay: number, signal: AbortSignal) => Promise<void>;
  timers?: FeedTimers;
  onStatus(status: S): void;
}

export interface PanelSync<S> {
  /** Report status, and connect only when autosync is on and a route is already saved. */
  start(): Promise<void>;
  /** One explicit verified sync per route, starting the session's subscriptions. */
  sync(): Promise<S>;
  /** Routes were saved or extended. Restarts feeds that are running; never starts one. */
  routesChanged(): Promise<void>;
  status(): S;
  stop(): Promise<void>;
}

export function createPanelSync<S>(options: PanelSyncOptions<S>): PanelSync<S> {
  const connector = options.connector;
  const controller: FeedController = createFeedController({
    host: options.host,
    sync: { ...options.sync, connect: (route, realm, signal) => connector.connect(route, realm, signal) },
    connect: (route, realm, signal) => connector.connectFeed(route, realm, signal),
    onState: (state) => options.onStatus(options.describe(state)),
    pollMs: options.pollMs,
    autosyncOnMount: options.autosyncOnMount,
    ...(options.feedSleep ? { sleep: options.feedSleep } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  const status = () => options.describe(controller.state());
  return {
    start: () => controller.start(),
    async sync() {
      return options.describe(await controller.syncNow());
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
