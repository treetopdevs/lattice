import type {
  CarrierAvailability,
  CarrierAvailabilitySubscription,
} from "@treetopdevs/lattice-client";
import { MAX_ROUTES } from "./treehouse_state";
import type { RelayRoute } from "./treehouse_state";
import { productOf } from "./treehouse_routes";
import { syncTreehouseRoute } from "./treehouse_sync";
import type { RouteSyncResult, SyncTreehouseOptions } from "./treehouse_sync";
import type { TreehouseWorkflow } from "./treehouse_workflow";

// Plan 181 slice 3b2. The feed controller keeps one availability subscription per configured route and
// turns each hint into one verified sync of that route. It is adapted from the Township feed controller
// (connect, subscribe, coalesced trailing refresh, reconnect backoff, epoch cancel) with two changes: the
// relay has no state reporter, so the verified pull plus the local `verifyProfile` is the check, and a sync
// also submits locally authored frames. A hint carries no operation and no authority; it only says the relay
// has something to pull. State here describes the relay link and what this device holds. It is never
// labelled peer convergence.

/** The subscription connection of one route. By type it cannot submit anything. */
export interface TreehouseFeedSession {
  subscribeAvailability(): Promise<CarrierAvailabilitySubscription>;
  close(): void;
}

export type TreehouseRouteConnection =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "refused";

export interface TreehouseRouteFeedState {
  replica: string;
  connection: TreehouseRouteConnection;
  /** Authored ids not yet durable on the relay: outbox minus acked. */
  pending: number;
  /** Ids known durable on the relay. */
  acked: number;
  /** Latest relay generation seen on the subscription, or null before the first hint. */
  generation: number | null;
  /** Local ids equal the advertised relay frontier after the last sync. Null before the first sync. */
  matchesRelay: boolean | null;
  message: string;
}

export interface TreehouseFeedState {
  configured: boolean;
  routes: TreehouseRouteFeedState[];
}

export interface FeedTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CreateTreehouseFeedControllerOptions {
  workflow: TreehouseWorkflow;
  /** Per-sync connection and verification options (the sync module's own seam). */
  sync: SyncTreehouseOptions;
  /** One availability connection per route. */
  connect(route: RelayRoute, localRealm: string): Promise<TreehouseFeedSession>;
  onState(state: TreehouseFeedState): void;
  sleep?(delay: number, signal: AbortSignal): Promise<void>;
  timers?: FeedTimers;
  /** Poll fallback interval in milliseconds. 0 disables it. Defaults to 60000. */
  pollMs?: number;
  /** When false nothing connects until a manual `syncNow`. Defaults to true. */
  autosyncOnMount?: boolean;
}

export interface TreehouseFeedController {
  /** Start the per-route feeds, or stay idle when autosync on mount is off. Refuses above four routes. */
  start(): Promise<void>;
  /** One verified sync per route. It starts the subscriptions first when they are not running. */
  syncNow(): Promise<TreehouseFeedState>;
  /** Re-read the saved routes and restart every feed under a new epoch. */
  reconfigure(): Promise<void>;
  stop(): Promise<void>;
  state(): TreehouseFeedState;
}

const DEFAULT_POLL_MS = 60_000;
const isSpace = (replica: string) => productOf(replica) === "Treehouse.Space";

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

/** A relay that does not hold the pinned identity is refused, not retried. */
function refusal(error: unknown): boolean {
  const text = errorMessage(error);
  return (
    text.startsWith("carrier hello ") ||
    text === "malformed carrier hello" ||
    text === "carrier peer error: unauthenticated" ||
    text === "invalid_route" ||
    text === "invalid_local_realm" ||
    text === "unknown_route_replica"
  );
}

interface Worker {
  epoch: number;
  route: RelayRoute;
  cancelled: boolean;
  session: TreehouseFeedSession | null;
  abort: AbortController;
  done: Promise<void>;
  /** Settles after the first completed baseline sync or the first connect failure. */
  first: Promise<void>;
  /** Rejects when the worker is cancelled, so an awaited in-flight sync never blocks teardown. */
  cancelled$: Promise<never>;
  settleFirst(): void;
  ended: boolean;
}

export function createTreehouseFeedController(
  options: CreateTreehouseFeedControllerOptions,
): TreehouseFeedController {
  const sleep = options.sleep ?? abortableSleep;
  const timers: FeedTimers = options.timers ?? {
    set: (fn, ms) => setInterval(fn, ms),
    clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const autosync = options.autosyncOnMount ?? true;
  const workflow = options.workflow;

  let epoch = 0;
  let stopped = false;
  let running = false;
  let pollHandle: unknown = null;
  let workers = new Map<string, Worker>();
  const link = new Map<string, TreehouseRouteFeedState>();
  // Syncs are serialized across routes through one queue, the Space first, so a joiner holds the Space
  // before the Threads that reference it. A hint that arrives mid-sync waits as one trailing sync.
  const queued = new Map<
    string,
    {
      epoch: number;
      promise: Promise<RouteSyncResult>;
      resolve(r: RouteSyncResult): void;
      reject(e: unknown): void;
    }
  >();
  // The running drain, so teardown can wait for an in-flight route sync before a new epoch starts.
  let draining: Promise<void> | null = null;

  const routes = (): RelayRoute[] => workflow.state.relay?.routes ?? [];

  const counts = (replica: string) => {
    const profile = workflow.state.profiles.find((p) => p.replica === replica);
    const acked = new Set(profile?.acked ?? []);
    return {
      pending: (profile?.outbox ?? []).filter((id) => !acked.has(id)).length,
      acked: acked.size,
    };
  };

  const snapshot = (): TreehouseFeedState => ({
    configured: workflow.state.relay !== null,
    routes: routes().map((route) => {
      const own = link.get(route.replica);
      return {
        replica: route.replica,
        connection: own?.connection ?? "idle",
        generation: own?.generation ?? null,
        matchesRelay: own?.matchesRelay ?? null,
        message: own?.message ?? "Not connected.",
        ...counts(route.replica),
      };
    }),
  });

  const emit = (gate?: Worker): void => {
    if (stopped) return;
    if (gate && (gate.cancelled || gate.epoch !== epoch)) return;
    options.onState(snapshot());
  };

  const setLink = (replica: string, patch: Partial<TreehouseRouteFeedState>): void => {
    const current = link.get(replica) ?? {
      replica,
      connection: "idle" as TreehouseRouteConnection,
      pending: 0,
      acked: 0,
      generation: null,
      matchesRelay: null,
      message: "Not connected.",
    };
    link.set(replica, { ...current, ...patch });
  };

  const syncRoute = async (route: RelayRoute, at: number): Promise<RouteSyncResult> => {
    // A sync that outlives its epoch must not write route state into the next one.
    const record = (replica: string, matchesRelay: boolean): void => {
      if (!stopped && at === epoch) setLink(replica, { matchesRelay });
    };
    // Each route's worker subscribes on its own socket, so a Thread hint can arrive before the Space has
    // synced even though the queue orders routes that wait together. A Thread merged without its Space
    // fails the profile check, so the Space syncs first here, and only while no Space profile is held.
    if (!isSpace(route.replica) && !workflow.state.profiles.some((p) => p.product === "Treehouse.Space")) {
      const space = routes().find((r) => isSpace(r.replica));
      if (space) {
        const first = await syncTreehouseRoute(workflow, space, options.sync);
        record(space.replica, first.matchesRelay);
        // A reconfigure or stop during the Space pre-sync ends this sync before it dials the next route.
        if (stopped || at !== epoch) throw new Error("feed_reconfigured");
      }
    }
    const result = await syncTreehouseRoute(workflow, route, options.sync);
    record(route.replica, result.matchesRelay);
    return result;
  };

  const drain = (): Promise<void> => {
    draining ??= drainQueue().finally(() => {
      draining = null;
    });
    return draining;
  };

  const drainQueue = async (): Promise<void> => {
    while (queued.size > 0) {
      const replica =
        [...queued.keys()].find(isSpace) ?? [...queued.keys()][0]!;
      const waiter = queued.get(replica)!;
      queued.delete(replica);
      const route = routes().find((r) => r.replica === replica);
      try {
        if (waiter.epoch !== epoch) throw new Error("feed_reconfigured");
        if (!route) throw new Error("unknown_route_replica");
        const result = await syncRoute(route, waiter.epoch);
        waiter.resolve(result);
        if (isSpace(replica) && result.pulledFrames > 0 && waiter.epoch === epoch && !stopped)
          for (const thread of routes().filter((r) => !isSpace(r.replica)))
            request(thread.replica).catch((error: unknown) => {
              setLink(thread.replica, { message: `Sync failed: ${errorMessage(error)}` });
              emit();
            });
      } catch (error) {
        waiter.reject(error);
      }
    }
  };

  const request = (replica: string): Promise<RouteSyncResult> => {
    if (stopped) return Promise.reject(new Error("feed_stopped"));
    let waiter = queued.get(replica);
    if (!waiter) {
      let resolve!: (r: RouteSyncResult) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<RouteSyncResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A rejection that nobody awaits is reported through route state, never as an unhandled rejection.
      promise.catch(() => undefined);
      waiter = { epoch, promise, resolve, reject };
      queued.set(replica, waiter);
    }
    const promise = waiter.promise;
    void drain();
    return promise;
  };

  const startPoll = (): void => {
    if (pollMs <= 0 || pollHandle !== null) return;
    pollHandle = timers.set(() => {
      if (stopped) return;
      for (const route of routes())
        request(route.replica).then(
          () => emit(),
          (error: unknown) => {
            setLink(route.replica, { message: `Poll sync failed: ${errorMessage(error)}` });
            emit();
          },
        );
    }, pollMs);
  };

  const stopPoll = (): void => {
    if (pollHandle === null) return;
    timers.clear(pollHandle);
    pollHandle = null;
  };

  const spawn = (route: RelayRoute): Worker => {
    let settle!: () => void;
    const first = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const abort = new AbortController();
    const cancelled$ = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Error("feed_stopped")), { once: true });
    });
    cancelled$.catch(() => undefined);
    const worker: Worker = {
      epoch,
      route,
      cancelled: false,
      session: null,
      abort,
      done: Promise.resolve(),
      first,
      cancelled$,
      settleFirst: settle,
      ended: false,
    };
    workers.set(route.replica, worker);
    setLink(route.replica, { connection: "connecting", message: "Connecting to relay." });
    emit(worker);
    worker.done = runWorker(worker).finally(() => {
      worker.ended = true;
      worker.settleFirst();
    });
    return worker;
  };

  const cancel = (worker: Worker): void => {
    if (worker.cancelled) return;
    worker.cancelled = true;
    worker.abort.abort();
    worker.session?.close();
  };

  const active = (worker: Worker): boolean =>
    !stopped && !worker.cancelled && worker.epoch === epoch;

  const runWorker = async (worker: Worker): Promise<void> => {
    let attempt = 0;
    const replica = worker.route.replica;
    while (active(worker)) {
      let session: TreehouseFeedSession | null = null;
      try {
        session = await options.connect(worker.route, workflow.state.relay!.localRealm);
        worker.session = session;
        if (!active(worker)) return;
        const subscription = await session.subscribeAvailability();
        if (!active(worker)) return;
        setLink(replica, {
          connection: "live",
          generation: subscription.baseline.generation,
          message: "Relay subscription is live.",
        });
        emit(worker);
        // The delay resets only after a completed sync. A subscribe alone proves nothing: a relay whose pulls
        // the local check rejects would otherwise reconnect at the shortest delay forever.
        await runSession(worker, session, subscription, () => {
          attempt = 0;
        });
      } catch (error) {
        if (!active(worker)) return;
        if (refusal(error)) {
          setLink(replica, {
            connection: "refused",
            message: `Relay refused: ${errorMessage(error)}`,
          });
          emit(worker);
          worker.settleFirst();
          return;
        }
        setLink(replica, {
          connection: "reconnecting",
          message: `Relay feed reconnecting: ${errorMessage(error)}`,
        });
        emit(worker);
        worker.settleFirst();
        try {
          await sleep(reconnectDelay(attempt++), worker.abort.signal);
        } catch {
          return;
        }
      } finally {
        session?.close();
        if (worker.session === session) worker.session = null;
      }
    }
  };

  const runSession = async (
    worker: Worker,
    session: TreehouseFeedSession,
    subscription: CarrierAvailabilitySubscription,
    synced: () => void,
  ): Promise<void> => {
    const replica = worker.route.replica;
    let live = true;
    let trailing: CarrierAvailability | null = null;
    let refreshing = false;
    let rejectRefresh!: (reason: unknown) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    // Nothing awaits `failed` unless the race below is still pending; keep a rejection from escaping.
    failed.catch(() => undefined);

    const refreshAll = async (): Promise<void> => {
      while (live && active(worker) && trailing !== null) {
        const hint = trailing;
        trailing = null;
        setLink(replica, { generation: hint.generation });
        await Promise.race([request(replica), worker.cancelled$]);
        if (!active(worker)) return;
        synced();
        setLink(replica, { message: "Relay subscription is live." });
        emit(worker);
        worker.settleFirst();
      }
    };

    const offer = (hint: CarrierAvailability): void => {
      if (!live || !active(worker)) return;
      if (trailing === null || hint.generation >= trailing.generation) trailing = hint;
      if (refreshing) return;
      refreshing = true;
      refreshAll()
        .catch((error: unknown) => {
          live = false;
          trailing = null;
          rejectRefresh(error);
        })
        .finally(() => {
          refreshing = false;
          if (live && trailing !== null && active(worker)) offer(trailing);
        });
    };

    offer(subscription.baseline);
    const pump = (async (): Promise<void> => {
      while (active(worker)) offer(await subscription.next());
    })();
    // The pump can only end by throwing; a refresh failure ends the session the same way.
    pump.catch(() => undefined);
    try {
      await Promise.race([pump, failed]);
    } finally {
      live = false;
      trailing = null;
      session.close();
      await Promise.allSettled([pump]);
    }
  };

  const guard = (): void => {
    if (stopped) throw new Error("feed_stopped");
    if (workflow.state.relay === null) throw new Error("routes_not_configured");
    if (routes().length > MAX_ROUTES) throw new Error("too_many_routes");
  };

  const launch = (): void => {
    running = true;
    startPoll();
    const ordered = [
      ...routes().filter((r) => isSpace(r.replica)),
      ...routes().filter((r) => !isSpace(r.replica)),
    ];
    for (const route of ordered) spawn(route);
  };

  const teardown = async (): Promise<void> => {
    const previous = [...workers.values()];
    workers = new Map();
    for (const worker of previous) cancel(worker);
    // Requests queued for the old route set never run in the new one.
    for (const waiter of queued.values()) waiter.reject(new Error("feed_reconfigured"));
    queued.clear();
    await Promise.all(previous.map((w) => w.done));
  };

  return {
    state: snapshot,

    async start() {
      if (stopped) return;
      if (workflow.state.relay === null) {
        options.onState(snapshot());
        return;
      }
      if (routes().length > MAX_ROUTES) throw new Error("too_many_routes");
      options.onState(snapshot());
      if (autosync && !running) launch();
    },

    async syncNow() {
      guard();
      if (!running) launch();
      else {
        for (const [replica, worker] of workers)
          if (worker.ended && !worker.cancelled) {
            const route = routes().find((r) => r.replica === replica);
            if (route) spawn(route);
          }
      }
      const current = [...workers.values()];
      // Fresh workers sync on their baseline; running ones get one explicit sync per route.
      const fresh = new Set(current.filter((w) => !w.ended && link.get(w.route.replica)?.connection === "connecting"));
      await Promise.all(
        current.map(async (worker) => {
          if (fresh.has(worker)) {
            await worker.first;
            return;
          }
          try {
            await request(worker.route.replica);
          } catch (error) {
            setLink(worker.route.replica, { message: `Sync failed: ${errorMessage(error)}` });
          }
        }),
      );
      if (!stopped) options.onState(snapshot());
      return snapshot();
    },

    async reconfigure() {
      if (stopped) return;
      const wasRunning = running;
      epoch++;
      await teardown();
      // A cancelled worker stops waiting on its sync, but the sync itself runs on to its commit. The new
      // epoch starts only once it has, so no old-epoch commit or route state lands after the relaunch.
      await draining;
      stopPoll();
      link.clear();
      running = false;
      if (workflow.state.relay === null) {
        options.onState(snapshot());
        return;
      }
      if (routes().length > MAX_ROUTES) throw new Error("too_many_routes");
      options.onState(snapshot());
      if (autosync || wasRunning) launch();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      epoch++;
      stopPoll();
      for (const waiter of queued.values()) waiter.reject(new Error("feed_stopped"));
      queued.clear();
      await teardown();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reconnectDelay(attempt: number): number {
  const delays = [100, 250, 500, 1_000, 2_000, 5_000] as const;
  return delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
}

function abortableSleep(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Treehouse feed worker stopped"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Treehouse feed worker stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
