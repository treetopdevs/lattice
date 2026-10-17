import {
  CarrierPeerError,
  carrierOpsToSemanticOps,
  syncCarrierOnce,
} from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  CarrierRelayClient,
  CarrierSyncClient,
  Verifier,
} from "@treetopdevs/lattice-client";
import type { CarrierRoute, HeldProfile, ShellHost } from "./host";

// Plan 181 slice 3b1. Sync is the only network action of the shell and the only caller of the
// relay. It pulls and verifies, merges only dependency-closed sets, and submits locally authored frames
// one signed op at a time. The relay stays a plaintext-readable, availability-withholding transport: its
// reply decides durability of what this device sent, never semantic authority.

export type RelayConnection = CarrierSyncClient &
  CarrierRelayClient & { close(): void };

export interface SyncOptions {
  /** One authenticated connection per replica route (the hello challenge binds a replica). */
  connect(route: CarrierRoute, localRealm: string, signal?: AbortSignal): Promise<RelayConnection>;
  /** Operation signature check. Defaults to the host's verifier (the shell's strict Ed25519, as `verifyProfile` uses). */
  verifier?: Verifier;
  /** Backoff between rate-limited rounds. Defaults to a real timer; tests inject a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Pull rounds allowed while a merged set still has open dependencies. */
  maxPullRounds?: number;
  /**
   * Outer deadline for the dial and for each relay method call. The carrier client applies its own
   * 10 s dial and 30 s per-request bounds underneath (row 196), so this can shorten but not lengthen
   * them; a silent relay fails the route with whichever bound expires first.
   */
  requestTimeoutMs?: number;
}

export interface RouteSyncResult {
  replica: string;
  /** Frames newly retained from the relay by this sync. */
  pulledFrames: number;
  /** Locally authored frames the relay made durable (accepted, or listed by a fresh advertise). */
  ackedSubmissions: number;
  accepted: string[];
  /**
   * Frames this sync submitted that the relay quarantined, minus any the closing advertise lists. Like
   * `rejected`, an entry naming an id the round did not submit is ignored.
   */
  quarantined: [string, string][];
  /**
   * Ids the relay will not hold. The reasons are a superset of the wire's `WIRE_REPORT_REASONS`: they also
   * include `malformed`, which is a relay error reply for that one frame, not a report reason.
   */
  rejected: [string, string][];
  /** Relay `pending` bucket: it lacks a dependency and did not persist the op. */
  relayPending: string[];
  /**
   * Authored ids not yet durable on the relay: outbox minus acked, after this sync, plus any id the relay
   * refused in this sync and does not list (a legacy ack of a quarantined frame is not trusted).
   */
  pendingIds: string[];
  /** The relay kept rate-limiting and the retry bound ran out; pending is left for the next sync. */
  rateLimited: boolean;
  /**
   * The relay answered a submit with `unavailable` or `read_only`: submission stopped at that frame for this
   * sync (the pull half and every earlier ack are kept), and the next sync offers it again.
   */
  submitStopped: { id: string; reason: string } | null;
  /** Local ids equal the relay's advertised ids after the sync. Never labelled peer convergence. */
  matchesRelay: boolean;
  relayIdCount: number;
}

export type RouteOutcome =
  | ({ ok: true } & RouteSyncResult)
  | { ok: false; replica: string; error: string };

export interface SyncResult {
  routes: RouteOutcome[];
}

const DEFAULT_PULL_ROUNDS = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Race `work` against a deadline; on expiry run `expire` (which closes the connection) and reject. */
function deadline<T>(work: Promise<T>, ms: number, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expire();
      reject(new Error("relay_request_timeout"));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** The connection with every request bounded by the deadline; `close` passes straight through. */
function bounded(connection: RelayConnection, ms: number): RelayConnection {
  return new Proxy(connection, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "close") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        return out instanceof Promise ? deadline(out, ms, () => target.close()) : out;
      };
    },
  });
}
/** One relay token refills in about 83 ms, so a sleeping retry always earns progress when the relay is healthy. */
const STALL_SLEEP_MS = 250;
const MAX_STALLS = 40;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const frameId = (frame: unknown) => (frame as { id: string }).id;
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Sync every configured route, the Space first so a joiner holds the Space before the Threads it
 * references. A failing route is reported and does not stop the others. More than four routes, or no
 * routes, refuses before any connection is made.
 */
export async function syncRoutes(
  host: ShellHost,
  options: SyncOptions,
): Promise<SyncResult> {
  const relay = host.relay();
  if (relay === null) throw new Error("routes_not_configured");
  if (relay.routes.length > host.maxRoutes) throw new Error("too_many_routes");
  const ordered = [
    ...relay.routes.filter((r) => host.isAnchor(r.replica)),
    ...relay.routes.filter((r) => !host.isAnchor(r.replica)),
  ];
  const routes: RouteOutcome[] = [];
  for (const route of ordered) {
    try {
      routes.push({ ok: true, ...(await syncRoute(host, route, options)) });
    } catch (error) {
      routes.push({
        ok: false,
        replica: route.replica,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { routes };
}

/**
 * One verified sync of one replica route. Pulled frames are retained only as a dependency-closed set
 * through `mergeSync` (one CAS commit with their acks). Locally authored frames are submitted one at a
 * time; an id enters `acked` only after the relay's persisted report (accepted) or a fresh advertise that
 * lists it. The quarantined, rejected and pending buckets never ack; each id is submitted at most once per
 * sync and is offered again by the next one.
 */
export async function syncRoute(
  host: ShellHost,
  route: CarrierRoute,
  options: SyncOptions,
): Promise<RouteSyncResult> {
  const relay = host.relay();
  if (relay === null) throw new Error("routes_not_configured");
  if (relay.routes.length > host.maxRoutes) throw new Error("too_many_routes");
  // Only a configured route may be dialled; the caller's copy is never trusted over the saved one.
  const configured = relay.routes.find((r) => r.replica === route.replica);
  if (!configured) throw new Error("unknown_route_replica");
  const replica = configured.replica;
  const decoders = host.decoders(replica);
  const verifier = options.verifier ?? host.verifier;
  const sleep = options.sleep ?? defaultSleep;
  const maxPullRounds = options.maxPullRounds ?? DEFAULT_PULL_ROUNDS;
  const profileNow = (): HeldProfile | undefined => host.profile(replica);

  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const dialing = options.connect(configured, relay.localRealm);
  let timedOut = false;
  const connection = await deadline(dialing, timeout, () => {
    timedOut = true;
    dialing.then((late) => late.close(), () => undefined);
  });
  if (timedOut) connection.close();
  const client = bounded(connection, timeout);
  const result: RouteSyncResult = {
    replica,
    pulledFrames: 0,
    ackedSubmissions: 0,
    accepted: [],
    quarantined: [],
    rejected: [],
    relayPending: [],
    pendingIds: [],
    rateLimited: false,
    submitStopped: null,
    matchesRelay: false,
    relayIdCount: 0,
  };
  try {
    // What to submit comes from the relay's own ids, not from the local `acked` set: an ack that is stale
    // (a relay restored from an older backup) or was written without relay evidence never suppresses
    // delivery of a frame the relay does not hold.
    const relayHeld = new Set(await client.advertise());
    const deliveredNow = new Set<string>();
    // Every authored id the relay has replied to in this sync, acked or not.
    const attemptedNow = new Set<string>();
    // Verified pulled frames not yet committed, in the relay's causal order.
    const accumulated = new Map<string, CarrierOpFrame>();
    let pullRounds = 0;
    let stalls = 0;
    // The relay's error reply to the latest submitting round, kept across pull-only rounds so it is applied
    // once the pulled set is dependency-closed and committed. A non-rate-limited stop ends submission for
    // the rest of the pass; the pulls still run.
    let stop: { frameId: string; reason: string } | null = null;
    for (;;) {
      const profile = profileNow();
      const held = profile?.frames ?? [];
      const heldIds = new Set(held.map(frameId));
      const outbox = new Set(profile?.outbox ?? []);
      // Authored frames the relay did not list at the start of this sync and that no report of this sync
      // has acknowledged yet. Foreign frames are never in the outbox, so never submitted.
      // A frame the relay already replied to in this sync is not offered again, whatever the bucket: a
      // rejected, pending or quarantined verdict does not change by asking twice in one call.
      const candidates = held.filter(
        (f) =>
          outbox.has(f.id) &&
          !relayHeld.has(f.id) &&
          !deliveredNow.has(f.id) &&
          !attemptedNow.has(f.id),
      );
      const localOps = carrierOpsToSemanticOps(
        [...held, ...accumulated.values()],
        {},
        decoders,
      );
      const submitting = stop === null || stop.reason === "rate_limited";
      const synced = await syncCarrierOnce(client, localOps, submitting ? candidates : [], {}, {
        verifier,
        submission: "relay",
        expectedReplica: replica,
        commandDecoders: decoders,
        onRelayError: "stop",
      });
      if (submitting) stop = synced.submitStop ?? null;
      // `malformed` is a verdict on that one frame: the relay will not hold it, so it joins `rejected`, is not
      // offered again in this sync, and the rest of the outbox continues (its dependents answer `pending`).
      let malformedNow = false;
      if (stop !== null && stop.reason === "malformed") {
        result.rejected.push([stop.frameId, "malformed"]);
        attemptedNow.add(stop.frameId);
        stop = null;
        malformedNow = true;
      }
      const report = synced.pushReport;
      const candidateIds = new Set(candidates.map(frameId));
      const submitted = new Set(synced.pushedFrames.map(frameId));
      // A refusal counts only for a frame this round submitted: a report naming any other id is ignored.
      const bound = ([id]: [string, string]) => submitted.has(id) && candidateIds.has(id);
      result.accepted.push(...report.accepted);
      result.quarantined.push(...report.quarantined.filter(bound));
      result.rejected.push(...report.rejected.filter(bound));
      result.relayPending.push(...report.pending);

      // Acknowledgements: only frames this call submitted can ack through the report, only authored
      // frames are ever acked here, and the relay's own persist-before-reply is what makes them durable.
      // Only `accepted` (or relay-confirmed presence) is durable and readable back: a quarantined op is kept
      // by the relay as evidence and never advertised or served, so it never acks.
      for (const id of submitted) attemptedNow.add(id);
      const ackNow = new Set<string>();
      for (const id of report.accepted)
        if (submitted.has(id) && candidateIds.has(id)) ackNow.add(id);
      for (const id of synced.peerReportedFrameIds)
        if (candidateIds.has(id)) ackNow.add(id);

      let gotNew = 0;
      for (const frame of synced.pulledFrames as CarrierOpFrame[]) {
        if (heldIds.has(frame.id) || accumulated.has(frame.id)) continue;
        accumulated.set(frame.id, frame);
        gotNew++;
      }
      const known = new Set([...heldIds, ...accumulated.keys()]);
      const open = [...accumulated.values()].some((f) =>
        f.deps.some((dep) => !known.has(dep)),
      );
      // Frames and acks commit together once the pulled set is dependency-closed; acks alone commit
      // earlier so submitted progress is never redone after a crash.
      const frames = open ? [] : [...accumulated.values()];
      for (const id of ackNow) deliveredNow.add(id);
      if (frames.length > 0 || ackNow.size > 0) {
        await host.mergeSync(replica, frames, [...ackNow]);
        result.pulledFrames += frames.filter((f) => !heldIds.has(f.id)).length;
        result.ackedSubmissions += ackNow.size;
        if (!open) accumulated.clear();
      }
      if (open) {
        pullRounds++;
        if (gotNew === 0 || pullRounds >= maxPullRounds)
          throw new Error("pull_incomplete");
        continue;
      }
      // The relay's error reply decides what happens next, after the pass's progress is committed.
      if (stop !== null && stop.reason !== "rate_limited") {
        if (stop.reason === "unavailable" || stop.reason === "read_only") {
          result.submitStopped = { id: stop.frameId, reason: stop.reason };
          break;
        }
        // Unexpected (`unauthenticated`, `unsupported_frame`, an unknown reason): fail the route as before.
        throw new CarrierPeerError(stop.reason);
      }
      const remaining = candidates.filter((f) => !ackNow.has(f.id) && !attemptedNow.has(f.id));
      if (remaining.length === 0) break;
      if (stop !== null) {
        // `rate_limited`: nothing was judged past the stop, so wait for a refill and offer the rest.
        if (ackNow.size > 0 || gotNew > 0) {
          stalls = 0;
          continue;
        }
        if (++stalls >= MAX_STALLS) {
          result.rateLimited = true;
          break;
        }
        await sleep(STALL_SLEEP_MS);
        continue;
      }
      if (malformedNow) continue;
      // Everything offered was answered and the rest is rejected, pending or quarantined (or was dropped by
      // the client as unverifiable): nothing more to do this sync.
      break;
    }

    // A fresh advertise settles duplicates (an empty reply for an op the relay already holds) and gives
    // the matches-relay flag. Only authored, retained, unacked ids can be acked from it.
    const frontier = new Set(await client.advertise());
    const profile = profileNow();
    const late = (profile?.outbox ?? []).filter(
      (id) => !profile!.acked.includes(id) && frontier.has(id),
    );
    if (late.length > 0) {
      await host.mergeSync(replica, [], late);
      result.ackedSubmissions += late.length;
    }
    const final = profileNow();
    // A refusal the closing advertise contradicts (the relay lists the id) is dropped. An id the relay
    // refused in this sync and does not list is pending even if the saved set acks it: a profile written
    // before quarantined ids stopped acking holds them there, and `acked` never shrinks.
    const unlisted = ([id]: [string, string]) => !frontier.has(id);
    result.quarantined = result.quarantined.filter(unlisted);
    result.rejected = result.rejected.filter(unlisted);
    const refusedNow = new Set([...result.quarantined, ...result.rejected].map(([id]) => id));
    result.pendingIds = (final?.outbox ?? []).filter(
      (id) => !final!.acked.includes(id) || refusedNow.has(id),
    );
    result.relayIdCount = frontier.size;
    result.matchesRelay = sameSet(new Set((final?.frames ?? []).map(frameId)), frontier);
    return result;
  } finally {
    connection.close();
  }
}
