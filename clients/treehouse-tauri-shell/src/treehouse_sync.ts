import { ed25519 } from "@noble/curves/ed25519.js";
import {
  carrierOpsToSemanticOps,
  syncCarrierOnce,
  treehouseCommandDecoders,
} from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  CarrierRelayClient,
  CarrierSyncClient,
  TreehouseProduct,
  Verifier,
} from "@treetopdevs/lattice-client";
import { MAX_ROUTES } from "./treehouse_state";
import type { LocalProfile, RelayRoute } from "./treehouse_state";
import { fromBase64 } from "./treehouse_workflow";
import type { TreehouseWorkflow } from "./treehouse_workflow";

// Plan 181 slice 3b1. Sync is the only network action of the Treehouse shell and the only caller of the
// relay. It pulls and verifies, merges only dependency-closed sets, and submits locally authored frames
// one signed op at a time. The relay stays a plaintext-readable, availability-withholding transport: its
// reply decides durability of what this device sent, never semantic authority.

export type TreehouseRelayConnection = CarrierSyncClient &
  CarrierRelayClient & { close(): void };

export interface SyncTreehouseOptions {
  /** One authenticated connection per replica route (the hello challenge binds a replica). */
  connect(route: RelayRoute, localRealm: string): Promise<TreehouseRelayConnection>;
  /** Operation signature check. Defaults to strict Ed25519, as `verifyProfile` uses. */
  verifier?: Verifier;
  /** Backoff between rate-limited rounds. Defaults to a real timer; tests inject a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Pull rounds allowed while a merged set still has open dependencies. */
  maxPullRounds?: number;
}

export interface RouteSyncResult {
  replica: string;
  /** Frames newly retained from the relay by this sync. */
  pulledFrames: number;
  /** Locally authored frames the relay persisted (accepted or structurally quarantined). */
  ackedSubmissions: number;
  accepted: string[];
  quarantined: [string, string][];
  rejected: [string, string][];
  /** Relay `pending` bucket: it lacks a dependency and did not persist the op. */
  relayPending: string[];
  /** Authored ids not yet durable on the relay: outbox minus acked, after this sync. */
  pendingIds: string[];
  /** The relay kept rate-limiting and the retry bound ran out; pending is left for the next sync. */
  rateLimited: boolean;
  /** Local ids equal the relay's advertised ids after the sync. Never labelled peer convergence. */
  matchesRelay: boolean;
  relayIdCount: number;
}

export type RouteOutcome =
  | ({ ok: true } & RouteSyncResult)
  | { ok: false; replica: string; error: string };

export interface TreehouseSyncResult {
  routes: RouteOutcome[];
}

const DEFAULT_PULL_ROUNDS = 16;
/** One relay token refills in about 83 ms, so a sleeping retry always earns progress when the relay is healthy. */
const STALL_SLEEP_MS = 250;
const MAX_STALLS = 40;

const defaultVerifier: Verifier = {
  verify: async (pub, bytes, sig) =>
    ed25519.verify(sig, bytes, fromBase64(pub), { zip215: false }),
};
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const frameId = (frame: unknown) => (frame as { id: string }).id;
const productOf = (replica: string): TreehouseProduct =>
  replica.startsWith("replica:treehouse:space:")
    ? "Treehouse.Space"
    : "Treehouse.Thread";
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** Remembers the latest advertise so the final fresh frontier can decide the matches-relay flag. */
class Observed implements CarrierSyncClient, CarrierRelayClient {
  advertised: string[] = [];
  constructor(private readonly inner: TreehouseRelayConnection) {}
  async advertise() {
    this.advertised = await this.inner.advertise();
    return this.advertised;
  }
  pull(have: string[]) {
    return this.inner.pull(have);
  }
  push(ops: unknown[]) {
    return this.inner.push(ops);
  }
  relay(op: CarrierOpFrame) {
    return this.inner.relay(op);
  }
}

/**
 * Sync every configured route, the Space first so a joiner holds the Space before the Threads it
 * references. A failing route is reported and does not stop the others. More than four routes, or no
 * routes, refuses before any connection is made.
 */
export async function syncTreehouse(
  workflow: TreehouseWorkflow,
  options: SyncTreehouseOptions,
): Promise<TreehouseSyncResult> {
  const relay = workflow.state.relay;
  if (relay === null) throw new Error("routes_not_configured");
  if (relay.routes.length > MAX_ROUTES) throw new Error("too_many_routes");
  const ordered = [
    ...relay.routes.filter((r) => productOf(r.replica) === "Treehouse.Space"),
    ...relay.routes.filter((r) => productOf(r.replica) === "Treehouse.Thread"),
  ];
  const routes: RouteOutcome[] = [];
  for (const route of ordered) {
    try {
      routes.push({ ok: true, ...(await syncTreehouseRoute(workflow, route, options)) });
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
 * time; an id enters `acked` only after the relay's persisted report (accepted or quarantined) or a fresh
 * advertise that lists it. The rejected and pending buckets never ack.
 */
export async function syncTreehouseRoute(
  workflow: TreehouseWorkflow,
  route: RelayRoute,
  options: SyncTreehouseOptions,
): Promise<RouteSyncResult> {
  const relay = workflow.state.relay;
  if (relay === null) throw new Error("routes_not_configured");
  if (relay.routes.length > MAX_ROUTES) throw new Error("too_many_routes");
  // Only a configured route may be dialled; the caller's copy is never trusted over the saved one.
  const configured = relay.routes.find((r) => r.replica === route.replica);
  if (!configured) throw new Error("unknown_route_replica");
  const replica = configured.replica;
  const decoders = treehouseCommandDecoders(productOf(replica));
  const verifier = options.verifier ?? defaultVerifier;
  const sleep = options.sleep ?? defaultSleep;
  const maxPullRounds = options.maxPullRounds ?? DEFAULT_PULL_ROUNDS;
  const profileNow = (): LocalProfile | undefined =>
    workflow.state.profiles.find((p) => p.replica === replica);

  const connection = await options.connect(configured, relay.localRealm);
  const client = new Observed(connection);
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
    matchesRelay: false,
    relayIdCount: 0,
  };
  try {
    // Verified pulled frames not yet committed, in the relay's causal order.
    const accumulated = new Map<string, CarrierOpFrame>();
    let pullRounds = 0;
    let stalls = 0;
    for (;;) {
      const profile = profileNow();
      const held = profile?.frames ?? [];
      const heldIds = new Set(held.map(frameId));
      const acked = new Set(profile?.acked ?? []);
      const outbox = new Set(profile?.outbox ?? []);
      // pending = outbox minus acked. Foreign frames are never in the outbox, so never pending.
      const candidates = held.filter((f) => outbox.has(f.id) && !acked.has(f.id));
      const localOps = carrierOpsToSemanticOps(
        [...held, ...accumulated.values()],
        {},
        decoders,
      );
      const synced = await syncCarrierOnce(client, localOps, candidates, {}, {
        verifier,
        submission: "relay",
        expectedReplica: replica,
        commandDecoders: decoders,
      });
      const report = synced.pushReport;
      result.accepted.push(...report.accepted);
      result.quarantined.push(...report.quarantined);
      result.rejected.push(...report.rejected);
      result.relayPending.push(...report.pending);

      // Acknowledgements: only frames this call submitted can ack through the report, only authored
      // frames are ever acked here, and the relay's own persist-before-reply is what makes them durable.
      const candidateIds = new Set(candidates.map(frameId));
      const submitted = new Set(synced.pushedFrames.map(frameId));
      const ackNow = new Set<string>();
      for (const id of [
        ...report.accepted,
        ...report.quarantined.map(([quarantinedId]) => quarantinedId),
      ])
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
      if (frames.length > 0 || ackNow.size > 0) {
        await workflow.mergeSync(replica, frames, [...ackNow]);
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
      const remaining = candidates.filter((f) => !ackNow.has(f.id));
      if (remaining.length === 0) break;
      // pushedFrames is shorter than the candidates only when the relay rate-limited the burst.
      if (submitted.size < candidates.length) {
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
      // Everything was submitted and the rest is rejected or pending: nothing more to do this sync.
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
      await workflow.mergeSync(replica, [], late);
      result.ackedSubmissions += late.length;
    }
    const final = profileNow();
    result.pendingIds = (final?.outbox ?? []).filter((id) => !final!.acked.includes(id));
    result.relayIdCount = frontier.size;
    result.matchesRelay = sameSet(new Set((final?.frames ?? []).map(frameId)), frontier);
    return result;
  } finally {
    connection.close();
  }
}
