import type {
  CarrierAvailability,
  CarrierAvailabilitySubscription,
} from "@treetopdevs/lattice-client";
import type { CarrierRoute, ShellHost } from "./host";
import { syncRoute as syncOneRoute } from "./sync";
import type { RelayConnection, RouteSyncResult, SyncOptions } from "./sync";

// Plan 181 slice 3b2. The feed controller keeps one availability subscription per configured route and
// turns each hint into one verified sync of that route. It is adapted from the earlier shell's feed controller
// (connect, subscribe, coalesced trailing refresh, reconnect backoff, epoch cancel) with two changes: the
// relay has no state reporter, so the verified pull plus the local `verifyProfile` is the check, and a sync
// also submits locally authored frames. A hint carries no operation and no authority; it only says the relay
// has something to pull. State here describes the relay link and what this device holds. It is never
// labelled peer convergence.

/** The subscription connection of one route. By type it cannot submit anything. */
export interface FeedSession {
  subscribeAvailability(): Promise<CarrierAvailabilitySubscription>;
  close(): void;
}

export type RouteConnection =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "refused"
  /** The local store could not hold the last merge (`ShellHost.capacityReason`); paused until a manual sync. */
  | "full";

export interface RouteFeedState {
  replica: string;
  connection: RouteConnection;
  /** Authored ids not yet durable on the relay: outbox minus acked. */
  pending: number;
  /** Ids known durable on the relay. */
  acked: number;
  /** Latest relay generation seen on the subscription, or null before the first hint. */
  generation: number | null;
  /** Local ids equal the advertised relay frontier after the last sync. Null before the first sync. */
  matchesRelay: boolean | null;
  /**
   * Ids the relay will not hold as of the last completed sync: its quarantined verdicts, then its rejected
   * ones, as `[id, reason]`. The last sync's verdict only, not durable history: empty after a restart and
   * cleared when a later sync fails. An id listed here counts as pending, never as acknowledged.
   */
  refused: [string, string][];
  /** The relay's error reason when the last sync stopped submitting (`unavailable`, `read_only`), else null. */
  submitStopped: string | null;
  message: string;
}

export interface FeedState {
  configured: boolean;
  routes: RouteFeedState[];
}

export interface FeedTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CreateFeedControllerOptions {
  host: ShellHost;
  /** Per-sync connection and verification options (the sync module's own seam). */
  sync: SyncOptions;
  /** One availability connection per route. The signal aborts a handshake still in progress. */
  connect(route: CarrierRoute, localRealm: string, signal?: AbortSignal): Promise<FeedSession>;
  onState(state: FeedState): void;
  sleep?(delay: number, signal: AbortSignal): Promise<void>;
  timers?: FeedTimers;
  /** Poll fallback interval in milliseconds. 0 disables it. Defaults to 60000. */
  pollMs?: number;
  /** When false nothing connects until a manual `syncNow`. Defaults to true. */
  autosyncOnMount?: boolean;
}

export interface FeedController {
  /** Start the per-route feeds, or stay idle when autosync on mount is off. Refuses above four routes. */
  start(): Promise<void>;
  /** One verified sync per route. It starts the subscriptions first when they are not running. */
  syncNow(): Promise<FeedState>;
  /** Re-read the saved routes and restart every feed under a new epoch. */
  reconfigure(): Promise<void>;
  stop(): Promise<void>;
  state(): FeedState;
}

export const DEFAULT_POLL_MS = 60_000;

/** A relay that does not hold the pinned identity is refused, not retried. */
function refusal(error: unknown): boolean {
  const text = errorMessage(error);
  return (
    text.startsWith("carrier hello ") ||
    text === "malformed carrier hello" ||
    // An endpoint that speaks another protocol version, or a broken nonce, will not change on redial.
    text === "malformed carrier nonce" ||
    text === "unsupported carrier operation wire version" ||
    text === "unsupported carrier session version" ||
    text === "carrier peer error: unauthenticated" ||
    text === "invalid_route" ||
    text === "invalid_local_realm" ||
    text === "unknown_route_replica"
  );
}

interface Worker {
  epoch: number;
  route: CarrierRoute;
  cancelled: boolean;
  session: FeedSession | null;
  abort: AbortController;
  done: Promise<void>;
  /** Settles after the first completed baseline sync or the first connect failure. */
  first: Promise<void>;
  /** Rejects when the worker is cancelled, so an awaited in-flight sync never blocks teardown. */
  cancelled$: Promise<never>;
  settleFirst(): void;
  ended: boolean;
}

export function createFeedController(
  options: CreateFeedControllerOptions,
): FeedController {
  const sleep = options.sleep ?? abortableSleep;
  const timers: FeedTimers = options.timers ?? {
    set: (fn, ms) => setInterval(fn, ms),
    clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const autosync = options.autosyncOnMount ?? true;
  const host = options.host;

  let epoch = 0;
  let stopped = false;
  let running = false;
  let pollHandle: unknown = null;
  let workers = new Map<string, Worker>();
  const link = new Map<string, RouteFeedState>();
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
  // Aborted by stop and reconfigure: it closes the sync connections of the old epoch, so a relay that
  // stops answering cannot leave the drain, and with it reconfigure, pending forever.
  let syncAbort = new AbortController();

  const syncOptions = (signal: AbortSignal): SyncOptions => ({
    ...options.sync,
    async connect(route, localRealm) {
      if (signal.aborted) throw new Error("feed_reconfigured");
      let rejectDial!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectDial = reject;
      });
      aborted.catch(() => undefined);
      const onDialAbort = (): void => rejectDial(new Error("feed_reconfigured"));
      signal.addEventListener("abort", onDialAbort, { once: true });
      const dialing = options.sync.connect(route, localRealm, signal);
      dialing.then((late) => {
        if (signal.aborted) late.close();
      }, () => undefined);
      let connection: RelayConnection;
      try {
        connection = await Promise.race([dialing, aborted]);
      } finally {
        signal.removeEventListener("abort", onDialAbort);
      }
      // Closing rejects any request still waiting on the relay. The listener goes when the sync closes.
      const close = connection.close.bind(connection);
      const onAbort = (): void => close();
      signal.addEventListener("abort", onAbort, { once: true });
      return Object.assign(connection, {
        close() {
          signal.removeEventListener("abort", onAbort);
          close();
        },
      });
    },
  });

  const routes = (): CarrierRoute[] => host.relay()?.routes ?? [];

  // A full local store only grows by an explicit user action elsewhere, never by retrying, so a capacity
  // failure pauses the route: no redial, no hint or poll sync. The refused merge writes nothing; earlier
  // committed progress survives and history remains readable.
  const capacity = (error: unknown): boolean =>
    host.capacityReason !== undefined && errorMessage(error) === host.capacityReason;
  const isFull = (replica: string): boolean => link.get(replica)?.connection === "full";
  const pauseFull = (replica: string, dependent: boolean): void => {
    setLink(replica, {
      connection: "full",
      message: dependent
        ? "Paused: this route syncs after its anchor route, which is paused because local storage is full. Sync now tries again."
        : `Paused: local storage is full (${host.capacityReason}). The refused merge writes nothing; earlier committed progress survives and history remains readable. Sync now tries again.`,
    });
    // The route's feed worker ends now, so no hint, reconnect or baseline sync pulls into the full store.
    const worker = workers.get(replica);
    if (worker) cancel(worker);
  };
  /** A failed sync's message, unless the route is paused: the pause explains the failure already. */
  const failed = (replica: string, what: string, error: unknown): void => {
    if (!isFull(replica)) setLink(replica, { message: `${what}: ${errorMessage(error)}` });
  };

  const counts = (replica: string) => {
    const profile = host.profile(replica);
    // An id the relay refused in the last sync is not acknowledged whatever the saved set says: a profile
    // written before quarantined ids stopped acking still holds them in `acked`, and `acked` never shrinks.
    const refused = new Set((link.get(replica)?.refused ?? []).map(([id]) => id));
    const acked = new Set((profile?.acked ?? []).filter((id) => !refused.has(id)));
    return {
      pending: (profile?.outbox ?? []).filter((id) => !acked.has(id)).length,
      acked: acked.size,
    };
  };

  const snapshot = (): FeedState => ({
    configured: host.relay() !== null,
    routes: routes().map((route) => {
      const own = link.get(route.replica);
      return {
        replica: route.replica,
        connection: own?.connection ?? "idle",
        generation: own?.generation ?? null,
        matchesRelay: own?.matchesRelay ?? null,
        refused: own?.refused ?? [],
        submitStopped: own?.submitStopped ?? null,
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

  const setLink = (replica: string, patch: Partial<RouteFeedState>): void => {
    const current = link.get(replica) ?? {
      replica,
      connection: "idle" as RouteConnection,
      pending: 0,
      acked: 0,
      generation: null,
      matchesRelay: null,
      refused: [],
      submitStopped: null,
      message: "Not connected.",
    };
    link.set(replica, { ...current, ...patch });
  };

  const syncRoute = async (route: CarrierRoute, at: number): Promise<RouteSyncResult> => {
    const sync = syncOptions(syncAbort.signal);
    // A sync that outlives its epoch must not write route state into the next one.
    // A failed sync leaves the previous verdict unknown, so it is cleared rather than shown stale.
    const forget = (replica: string): void => {
      if (stopped || at !== epoch) return;
      setLink(replica, { refused: [], submitStopped: null });
    };
    const record = (replica: string, result: RouteSyncResult): void => {
      if (stopped || at !== epoch) return;
      const submitStopped = result.submitStopped?.reason ?? null;
      setLink(replica, {
        matchesRelay: result.matchesRelay,
        refused: [...result.quarantined, ...result.rejected],
        submitStopped,
      });
      // The subscription message only describes a live connection; any other state keeps its own message.
      if (link.get(replica)?.connection === "live")
        setLink(replica, { message: liveMessage(submitStopped) });
    };
    // Each route's worker subscribes on its own socket, so a Thread hint can arrive before the Space has
    // synced even though the queue orders routes that wait together. A Thread merged without its Space
    // fails the profile check, so the Space syncs first here, and only while no Space profile is held.
    if (!host.isAnchor(route.replica) && !host.holdsAnchorProfile()) {
      const space = routes().find((r) => host.isAnchor(r.replica));
      if (space) {
        // A paused anchor is not retried from here; the pause belongs to the anchor, this route only waits.
        if (isFull(space.replica)) throw new AnchorPaused();
        const first = await syncOneRoute(host, space, sync).catch((error: unknown) => {
          forget(space.replica);
          if (!capacity(error)) throw error;
          if (!stopped && at === epoch) {
            pauseFull(space.replica, false);
            emit();
          }
          throw new AnchorPaused();
        });
        record(space.replica, first);
        // A reconfigure or stop during the Space pre-sync ends this sync before it dials the next route.
        if (stopped || at !== epoch) throw new Error("feed_reconfigured");
      }
    }
    const result = await syncOneRoute(host, route, sync).catch((error: unknown) => {
      forget(route.replica);
      throw error;
    });
    record(route.replica, result);
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
        [...queued.keys()].find((r) => host.isAnchor(r)) ?? [...queued.keys()][0]!;
      const waiter = queued.get(replica)!;
      queued.delete(replica);
      const route = routes().find((r) => r.replica === replica);
      try {
        if (waiter.epoch !== epoch) throw new Error("feed_reconfigured");
        if (!route) throw new Error("unknown_route_replica");
        // Queued before the route paused (a poll behind an in-flight sync): it must not run now.
        if (isFull(replica)) throw new Error(host.capacityReason);
        const result = await syncRoute(route, waiter.epoch);
        waiter.resolve(result);
        if (host.isAnchor(replica) && result.pulledFrames > 0 && waiter.epoch === epoch && !stopped)
          for (const thread of routes().filter((r) => !host.isAnchor(r.replica) && !isFull(r.replica)))
            request(thread.replica).catch((error: unknown) => {
              failed(thread.replica, "Sync failed", error);
              emit();
            });
      } catch (error) {
        const dependent = error instanceof AnchorPaused;
        if ((dependent || capacity(error)) && waiter.epoch === epoch && !stopped && !isFull(replica)) {
          pauseFull(replica, dependent);
          emit();
        }
        waiter.reject(error);
      }
    }
  };

  /** Queue one sync. A route paused at `full` syncs again only once Sync now respawns its worker. */
  const request = (replica: string): Promise<RouteSyncResult> => {
    if (stopped) return Promise.reject(new Error("feed_stopped"));
    if (isFull(replica)) return Promise.reject(new Error(host.capacityReason));
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
      for (const route of routes().filter((r) => !isFull(r.replica)))
        request(route.replica).then(
          () => emit(),
          (error: unknown) => {
            failed(route.replica, "Poll sync failed", error);
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

  const spawn = (route: CarrierRoute): Worker => {
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
      let session: FeedSession | null = null;
      try {
        // The dial is cancellable: a server that accepts the socket but never completes the handshake
        // must not hold teardown open. A session that still arrives after cancellation is closed.
        const dialing = options.connect(worker.route, host.relay()!.localRealm, worker.abort.signal);
        dialing.then((late) => {
          if (!active(worker)) late.close();
        }, () => undefined);
        session = await Promise.race([dialing, worker.cancelled$]);
        worker.session = session;
        if (!active(worker)) return;
        const subscription = await session.subscribeAvailability();
        if (!active(worker)) return;
        setLink(replica, {
          connection: "live",
          generation: subscription.baseline.generation,
          message: liveMessage(link.get(replica)?.submitStopped ?? null),
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
    session: FeedSession,
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
        setLink(replica, { message: liveMessage(link.get(replica)?.submitStopped ?? null) });
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
    if (host.relay() === null) throw new Error("routes_not_configured");
    if (routes().length > host.maxRoutes) throw new Error("too_many_routes");
  };

  const launch = (): void => {
    running = true;
    startPoll();
    const ordered = [
      ...routes().filter((r) => host.isAnchor(r.replica)),
      ...routes().filter((r) => !host.isAnchor(r.replica)),
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
      if (host.relay() === null) {
        options.onState(snapshot());
        return;
      }
      if (routes().length > host.maxRoutes) throw new Error("too_many_routes");
      options.onState(snapshot());
      if (autosync && !running) launch();
    },

    async syncNow() {
      guard();
      if (!running) launch();
      else {
        // A paused route's worker was cancelled and ends promptly; Sync now restarts it.
        // Drain first so a queued dependent pause is in the snapshot, not skipped.
        await draining;
        const paused = [...workers.values()].filter((w) => isFull(w.route.replica));
        await Promise.all(paused.map((w) => w.done));
        for (const [replica, worker] of workers)
          if (worker.ended && (!worker.cancelled || paused.includes(worker))) {
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
            failed(worker.route.replica, "Sync failed", error);
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
      // Stop the poll before waiting: a tick during a slow drain would keep refilling the queue.
      stopPoll();
      await teardown();
      // A cancelled worker stops waiting on its sync, but the sync itself runs on to its commit. Abort its
      // relay I/O, then wait for the drain, so no old-epoch commit or route state lands after the relaunch
      // and a relay that stops answering cannot hold the reconfigure open.
      syncAbort.abort();
      await draining;
      syncAbort = new AbortController();
      link.clear();
      running = false;
      if (host.relay() === null) {
        options.onState(snapshot());
        return;
      }
      if (routes().length > host.maxRoutes) throw new Error("too_many_routes");
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
      syncAbort.abort();
      await teardown();
    },
  };
}

/** A route that syncs after its anchor (Treehouse: a Thread before its Space is held) found the anchor paused. */
class AnchorPaused extends Error {
  constructor() {
    super("anchor_paused");
  }
}

function liveMessage(submitStopped: string | null): string {
  return submitStopped === null
    ? "Relay subscription is live."
    : `Relay subscription is live. Submit stopped: ${submitStopped}`;
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
      reject(new Error("feed worker stopped"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("feed worker stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
