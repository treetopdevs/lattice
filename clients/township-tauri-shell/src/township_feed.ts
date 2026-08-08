import {
  carrierOpsToSemanticOps,
  decodeCarrierOpFrame,
  integrate,
  verifyCarrierOp,
  type CarrierAvailability,
  type CarrierAvailabilitySubscription,
  type CarrierOpFrame,
  type CarrierStateReport,
  type Verifier,
} from "@treetopdevs/lattice-client";
import {
  type TownshipNativeWorkflow,
  withTownshipPersistenceWrite,
} from "./native_workflow";
import type { TownshipCarrierPeerConfig } from "./township_carrier_peer";
import {
  townshipPreviewFromOps,
  type TownshipMatterPreview,
} from "./township_preview";

export interface TownshipFeedPullClient {
  pull(have: string[]): Promise<unknown[]>;
  stateReport(): Promise<CarrierStateReport>;
}

export interface TownshipFeedClient extends TownshipFeedPullClient {
  subscribeAvailability(): Promise<CarrierAvailabilitySubscription>;
  close(): void;
}

export interface TownshipFeedSession {
  client: TownshipFeedClient;
  workflow: TownshipNativeWorkflow;
  verifier: Verifier;
}

export interface RefreshTownshipFromCarrierOptions {
  client: TownshipFeedPullClient;
  workflow: TownshipNativeWorkflow;
  verifier: Verifier;
  realmByPubkey?: Record<string, string>;
  expectedReplica: string;
  generation: number;
  signal?: AbortSignal;
}

export interface TownshipFeedProjection {
  generation: number;
  opIds: string[];
  matter: TownshipMatterPreview;
}

export type TownshipFeedState =
  | { phase: "unconfigured"; projection: null; message: string }
  | {
      phase: "connecting" | "refreshing" | "reconnecting" | "unavailable";
      projection: TownshipFeedProjection | null;
      message: string;
    }
  | { phase: "fresh"; projection: TownshipFeedProjection; message: string };

export interface CreateTownshipFeedControllerOptions {
  connect(peer: TownshipCarrierPeerConfig): Promise<TownshipFeedSession>;
  sleep?(delay: number, signal: AbortSignal): Promise<void>;
  onState(state: TownshipFeedState): void;
  realmByPubkey?: Record<string, string>;
}

export interface TownshipFeedController {
  replacePeer(peer: TownshipCarrierPeerConfig | null): Promise<void>;
  stop(): Promise<void>;
}

export async function refreshTownshipFromCarrier(
  options: RefreshTownshipFromCarrierOptions,
): Promise<TownshipFeedProjection> {
  const localOps = await options.workflow.localLog.load();
  const pulled = await options.client.pull(localOps.map((op) => op.id));
  throwIfRefreshStopped(options.signal);
  const pulledFrames = pulled.map(decodeCarrierOpFrame);

  for (const frame of pulledFrames) {
    if (frame.replica !== options.expectedReplica) {
      throw new Error(
        `carrier served foreign replica ${frame.replica}; expected ${options.expectedReplica}`,
      );
    }
    const verification = await verifyCarrierOp(frame, options.verifier);
    throwIfRefreshStopped(options.signal);
    if (!verification.valid) throw new Error(`carrier op verification failed: ${frame.id}`);
  }

  const stateReport = await options.client.stateReport();
  throwIfRefreshStopped(options.signal);

  const pulledOps = carrierOpsToSemanticOps(pulledFrames, options.realmByPubkey);
  const persisted = await withTownshipPersistenceWrite(options.workflow, async () => {
    throwIfRefreshStopped(options.signal);
    const [currentOps, currentDelegationFrames] = await Promise.all([
      options.workflow.localLog.load(),
      options.workflow.delegationFrames.load(),
    ]);
    const ops = integrate(currentOps, pulledOps);
    const delegationFrames = mergeCarrierFrames([...currentDelegationFrames, ...pulledFrames]);
    const externallyQuarantined = validateCarrierStateReport(stateReport, delegationFrames);
    const matter = townshipPreviewFromOps(
      ops,
      externallyQuarantined,
      options.expectedReplica,
    );

    throwIfRefreshStopped(options.signal);
    await Promise.all([
      options.workflow.localLog.save(ops),
      options.workflow.delegationFrames.save(delegationFrames),
    ]);
    return { ops, matter };
  });

  return {
    generation: options.generation,
    opIds: persisted.ops.map((op) => op.id).sort(),
    matter: persisted.matter,
  };
}

export function createTownshipFeedController(
  options: CreateTownshipFeedControllerOptions,
): TownshipFeedController {
  const sleep = options.sleep ?? abortableSleep;
  let epoch = 0;
  let stopped = false;
  let worker: TownshipFeedWorker | null = null;
  let lastProjection: TownshipFeedProjection | null = null;

  const active = (candidate: TownshipFeedWorker): boolean =>
    !stopped && epoch === candidate.epoch && !candidate.cancelled;

  const emit = (candidate: TownshipFeedWorker, state: TownshipFeedState): void => {
    if (active(candidate)) options.onState(state);
  };

  const replacePeer = async (peer: TownshipCarrierPeerConfig | null): Promise<void> => {
    if (stopped) return;

    const nextEpoch = ++epoch;
    const previous = worker;
    previous?.cancel();
    await previous?.done;
    if (worker === previous) worker = null;

    if (stopped || epoch !== nextEpoch) return;
    if (peer === null) {
      options.onState({
        phase: "unconfigured",
        projection: null,
        message: "No carrier pairing configured.",
      });
      return;
    }

    const nextWorker = createWorker(nextEpoch);
    worker = nextWorker;
    emit(nextWorker, {
      phase: "connecting",
      projection: lastProjection,
      message: "Connecting to carrier.",
    });
    nextWorker.done = runWorker(nextWorker, peer);
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;

    stopped = true;
    epoch++;
    const previous = worker;
    worker = null;
    previous?.cancel();
    await previous?.done;
  };

  const runWorker = async (
    candidate: TownshipFeedWorker,
    peer: TownshipCarrierPeerConfig,
  ): Promise<void> => {
    let reconnectAttempt = 0;

    while (active(candidate)) {
      let session: TownshipFeedSession | null = null;
      try {
        session = await options.connect(peer);
        candidate.client = session.client;
        if (!active(candidate)) {
          session.client.close();
          return;
        }

        const subscription = await session.client.subscribeAvailability();
        if (!active(candidate)) {
          session.client.close();
          return;
        }

        reconnectAttempt = 0;
        await runFeedSession(candidate, session, subscription, peer);
      } catch (error) {
        if (!active(candidate)) return;

        const phase = lastProjection === null ? "unavailable" : "reconnecting";
        emit(candidate, {
          phase,
          projection: lastProjection,
          message: `Carrier feed ${phase}: ${errorMessage(error)}`,
        });
        const delay = reconnectDelay(reconnectAttempt++);
        try {
          await sleep(delay, candidate.abortController.signal);
        } catch (sleepError) {
          if (!active(candidate)) return;
          emit(candidate, {
            phase: "unavailable",
            projection: lastProjection,
            message: `Carrier feed retry unavailable: ${errorMessage(sleepError)}`,
          });
          return;
        }
      } finally {
        session?.client.close();
        if (candidate.client === session?.client) candidate.client = null;
      }
    }
  };

  const runFeedSession = async (
    candidate: TownshipFeedWorker,
    session: TownshipFeedSession,
    subscription: CarrierAvailabilitySubscription,
    peer: TownshipCarrierPeerConfig,
  ): Promise<void> => {
    let sessionActive = true;
    let trailing: CarrierAvailability | null = null;
    let drain: Promise<void> | null = null;
    let rejectRefresh!: (reason: unknown) => void;
    const refreshFailed = new Promise<never>((_resolve, reject) => {
      rejectRefresh = reject;
    });

    const drainRefreshes = async (): Promise<void> => {
      while (sessionActive && active(candidate) && trailing !== null) {
        const availability = trailing;
        trailing = null;
        emit(candidate, {
          phase: "refreshing",
          projection: lastProjection,
          message: "Refreshing verified Township state.",
        });
        const projection = await refreshTownshipFromCarrier({
          client: session.client,
          workflow: session.workflow,
          verifier: session.verifier,
          ...(options.realmByPubkey ? { realmByPubkey: options.realmByPubkey } : {}),
          expectedReplica: peer.replica,
          generation: availability.generation,
          signal: candidate.abortController.signal,
        });
        if (!active(candidate)) return;
        lastProjection = projection;
        emit(candidate, {
          phase: "fresh",
          projection,
          message: "Township feed is current.",
        });
      }
    };

    const offer = (availability: CarrierAvailability): void => {
      if (!sessionActive || !active(candidate)) return;
      if (trailing === null || availability.generation >= trailing.generation) {
        trailing = availability;
      }
      if (drain !== null) return;

      drain = drainRefreshes()
        .catch((error: unknown) => {
          sessionActive = false;
          trailing = null;
          rejectRefresh(error);
        })
        .finally(() => {
          drain = null;
          if (sessionActive && trailing !== null && active(candidate)) offer(trailing);
        });
    };

    offer(subscription.baseline);
    const pump = (async (): Promise<void> => {
      while (active(candidate)) offer(await subscription.next());
    })();

    try {
      await Promise.race([pump, refreshFailed]);
    } finally {
      sessionActive = false;
      trailing = null;
      session.client.close();
      await Promise.allSettled([pump, drain ?? Promise.resolve()]);
    }
  };

  return { replacePeer, stop };
}

interface TownshipFeedWorker {
  epoch: number;
  cancelled: boolean;
  client: TownshipFeedClient | null;
  abortController: AbortController;
  done: Promise<void>;
  cancel(): void;
}

function createWorker(epoch: number): TownshipFeedWorker {
  const abortController = new AbortController();
  const worker: TownshipFeedWorker = {
    epoch,
    cancelled: false,
    client: null,
    abortController,
    done: Promise.resolve(),
    cancel(): void {
      if (worker.cancelled) return;
      worker.cancelled = true;
      abortController.abort();
      worker.client?.close();
    },
  };
  return worker;
}

function mergeCarrierFrames(frames: CarrierOpFrame[]): CarrierOpFrame[] {
  return [...new Map(frames.map((frame) => [frame.id, frame])).values()];
}

function validateCarrierStateReport(
  report: CarrierStateReport,
  frames: CarrierOpFrame[],
): ReadonlySet<string> {
  const reportIds = new Set(report.op_ids);
  const frameIds = new Set(frames.map((frame) => frame.id));
  const reportMatchesFrames =
    report.log_size === report.op_ids.length &&
    reportIds.size === report.op_ids.length &&
    reportIds.size === frameIds.size &&
    [...reportIds].every((id) => frameIds.has(id));

  if (!reportMatchesFrames) {
    throw new Error("carrier state report does not match verified frames");
  }

  const quarantined = new Set(report.authority_quarantine.map(([id]) => id));
  if ([...quarantined].some((id) => !reportIds.has(id))) {
    throw new Error("carrier state report does not match verified frames");
  }

  return quarantined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfRefreshStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Township feed refresh stopped");
}

function reconnectDelay(attempt: number): number {
  const delays = [100, 250, 500, 1_000, 2_000, 5_000] as const;
  return delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
}

function abortableSleep(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Township feed worker stopped"));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Township feed worker stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
