import {
  createRouteValidators,
  type CarrierRoute,
  type RouteAlphabet,
  type RouteConfig,
  type RouteValidators,
} from "@treetopdevs/lattice-shell-kit";
import {
  createFeedController,
  createRelayConnector,
  syncRoutes,
  type FeedController,
  type FeedState,
  type HeldProfile,
  type ShellHost,
} from "@treetopdevs/lattice-shell-kit/sync";
import {
  verifyCarrierOp,
  type CarrierOpFrame,
  type CarrierSigner,
  type CommandDecoderMap,
  type ConnectCarrierWebSocketOptions,
  type Verifier,
} from "@treetopdevs/lattice-client";
import alphabet from "../../route_alphabet.json";
import {
  emptySnapshot,
  IndexedDbDemoStorage,
  strictCarrierVerifier,
  strictOpVerifier,
  type DemoIdentity,
  type DemoStorage,
  type PersistedDemoSnapshot,
} from "./custody";
import { decodersForProduct, type DemoProduct } from "./products";

export interface DemoEndpoint {
  name: string;
  product: DemoProduct;
  replica: string;
  ws_url: string;
  peer_realm: string;
  peer_pubkey: string;
  relay_realms: string[];
  initial_ops: number;
}

export interface DemoParticipantInfo {
  realm: string;
  pubkey: string;
  seed_file: string;
}

export interface DemoEndpointsManifest {
  mode: string;
  notice: string;
  manifest_path: string;
  health: {
    livez: string;
    readyz: string;
  };
  participants: Record<string, DemoParticipantInfo>;
  endpoints: DemoEndpoint[];
  treehouse_routes: CarrierRoute[];
}

export interface BrowserEcosystemHostOptions {
  storage?: DemoStorage;
  webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
  pollMs?: number;
  onStateChange?: () => void;
  onFeedState?: (state: FeedState) => void;
}

/**
 * Multi-product `ShellHost` implementation for browser demo apps.
 * Consumes `@treetopdevs/lattice-shell-kit` directly for route validation,
 * authenticated WebSocket carrier dialing, dependency-closed pull/relay sync,
 * and `ops_available`-driven reactive feeds.
 */
export class BrowserEcosystemHost implements ShellHost {
  readonly maxRoutes = 16;
  readonly verifier: Verifier = strictOpVerifier;
  readonly validators: RouteValidators;

  private readonly storage: DemoStorage;
  private readonly webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
  private readonly pollMs: number;
  private readonly onStateChange?: () => void;
  private readonly onFeedState?: (state: FeedState) => void;

  private namespace = "default";
  private identity: DemoIdentity | null = null;
  private endpoints: DemoEndpoint[] = [];
  private routeConfig: RouteConfig | null = null;
  private snapshot: PersistedDemoSnapshot = { version: 1, namespace: "default", profiles: {} };
  private feed: FeedController | null = null;
  private feedState: FeedState = { configured: false, routes: [] };
  private online = false;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Bumped by every profile switch; a write that was asked for under an older one is refused. */
  private generation = 0;
  private releaseNamespace: () => void = () => {};

  constructor(options: BrowserEcosystemHostOptions = {}) {
    this.storage = options.storage ?? new IndexedDbDemoStorage();
    this.webSocket = options.webSocket;
    this.pollMs = options.pollMs ?? 30_000;
    this.onStateChange = options.onStateChange;
    this.onFeedState = options.onFeedState;

    this.validators = createRouteValidators(alphabet as RouteAlphabet, {
      maxRoutes: this.maxRoutes,
      isReplica: (replica) => replica.startsWith("replica:"),
      isSpace: (replica) => replica.startsWith("replica:treehouse:space:"),
    });
  }

  /**
   * Switch to `identity` and its stored profile. Everything that can fail is staged first and the
   * host state is replaced in one step, so a failed switch keeps the previous identity, namespace,
   * routes and snapshot together. It leaves the host offline either way: the old feed is stopped
   * before the switch and the caller brings the new one online.
   */
  async configure(
    endpoints: DemoEndpoint[],
    identity: DemoIdentity,
    namespace?: string,
  ): Promise<void> {
    const nextNamespace = namespace ?? `${identity.realm}:${identity.fingerprint}`;
    const routes: CarrierRoute[] = endpoints.map((ep) =>
      this.validators.validateRoute({
        replica: ep.replica,
        url: ep.ws_url,
        expectedPeerRealm: ep.peer_realm,
        expectedPeerPubkey: ep.peer_pubkey,
      }),
    );
    const routeConfig: RouteConfig = {
      localRealm: this.validators.validateLocalRealm(identity.realm),
      routes,
    };

    // The feed is stopped outside the write queue: a sync it has in flight commits through
    // `mergeSync`, which waits on that queue, so stopping from inside it would never finish.
    this.online = false;
    await this.stopFeed();
    this.feed = null;

    const sameNamespace = this.identity !== null && nextNamespace === this.namespace;
    let release = this.releaseNamespace;

    try {
      if (!sameNamespace) {
        release = () => {};
        release = (await this.storage.claim?.(nextNamespace)) ?? release;
      }
      // Behind the queued writes, so an append still waiting on a save lands in the profile it was
      // made for, and the stored record is read only after the last write to it.
      await this.serializeWrite(async () => {
        const snapshot = await this.loadVerified(nextNamespace, endpoints);
        if (!sameNamespace) this.releaseNamespace();
        this.releaseNamespace = release;
        this.generation++;
        this.endpoints = [...endpoints];
        this.identity = identity;
        this.namespace = nextNamespace;
        this.routeConfig = routeConfig;
        this.snapshot = snapshot;
        this.feedState = { configured: false, routes: [] };
      });
    } catch (error) {
      if (!sameNamespace) release();
      this.onStateChange?.();
      throw error;
    }

    this.feed = this.buildFeedController();
    this.onStateChange?.();
  }

  /**
   * Load the stored snapshot and keep only profiles whose every frame passes the strict verifier
   * (id is the hash of the signed bytes, signature by the author), names its own replica and has
   * its dependencies held. A cached frame is otherwise trusted by every projection, and the relay
   * never re-sends an id the client already advertises, so one altered record would stay on screen
   * and still report `matchesRelay`. A profile that fails is dropped and pulled again.
   */
  private async loadVerified(
    namespace: string,
    endpoints: DemoEndpoint[],
  ): Promise<PersistedDemoSnapshot> {
    const stored = await this.storage.load(namespace);
    const snapshot = emptySnapshot(namespace);
    let rejected = false;
    for (const ep of endpoints) {
      const profile = await this.verifiedProfile(ep.replica, stored.profiles?.[ep.replica]);
      if (profile === null) {
        rejected = true;
        console.warn(`Dropped stored profile for ${ep.replica}: it failed verification.`);
      }
      snapshot.profiles[ep.replica] = profile ?? { frames: [], outbox: [], acked: [] };
    }
    // Overwrite the record now, so the rejected frames cannot be read back by a later load.
    if (rejected) await this.storage.save(snapshot);
    return snapshot;
  }

  /** The profile when it verifies, an empty one when nothing is stored, null when it must be dropped. */
  private async verifiedProfile(replica: string, stored: unknown): Promise<HeldProfile | null> {
    if (stored === undefined) return { frames: [], outbox: [], acked: [] };
    try {
      const { frames, outbox, acked } = stored as HeldProfile;
      const strings = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === "string");
      if (!Array.isArray(frames) || !strings(outbox) || !strings(acked)) return null;
      const held = new Set(frames.map((frame) => frame.id));
      if (held.size !== frames.length) return null;
      for (const frame of frames) {
        if (frame.replica !== replica) return null;
        if (!frame.deps.every((dep) => held.has(dep))) return null;
        if (!(await verifyCarrierOp(frame, this.verifier)).valid) return null;
      }
      if (!outbox.every((id) => held.has(id))) return null;
      return { frames: [...frames], outbox: [...outbox], acked: [...acked] };
    } catch {
      return null;
    }
  }

  private buildFeedController(): FeedController {
    const connector = createRelayConnector({
      host: this,
      verifier: strictCarrierVerifier,
      ...(this.webSocket ? { webSocket: this.webSocket } : {}),
    });

    return createFeedController({
      host: this,
      sync: {
        connect: (route, localRealm, signal) => connector.connect(route, localRealm, signal),
        verifier: this.verifier,
      },
      connect: (route, localRealm, signal) => connector.connectFeed(route, localRealm, signal),
      pollMs: this.pollMs,
      autosyncOnMount: true,
      onState: (state) => {
        this.feedState = state;
        this.onFeedState?.(state);
        this.onStateChange?.();
      },
    });
  }

  async goOnline(): Promise<FeedState> {
    if (!this.routeConfig) throw new Error("host_not_configured");
    if (!this.feed) {
      this.feed = this.buildFeedController();
    }
    this.online = true;
    await this.feed.start();
    const state = await this.feed.syncNow();
    this.feedState = state;
    this.onFeedState?.(state);
    this.onStateChange?.();
    return state;
  }

  async goOffline(): Promise<void> {
    this.online = false;
    await this.stopFeed();
    this.feed = null;
    this.onStateChange?.();
  }

  async syncNow(): Promise<void> {
    if (!this.routeConfig) throw new Error("host_not_configured");
    // Online, the feed already holds a connection per route: one round through it, not a second one
    // over fresh sockets whose result would replace the first.
    if (this.online && this.feed) {
      await this.feed.syncNow();
      this.onStateChange?.();
      return;
    }
    const connector = createRelayConnector({
      host: this,
      verifier: strictCarrierVerifier,
      ...(this.webSocket ? { webSocket: this.webSocket } : {}),
    });
    await syncRoutes(this, {
      connect: (route, localRealm, signal) => connector.connect(route, localRealm, signal),
      verifier: this.verifier,
    });
    this.onStateChange?.();
  }

  async appendLocalFrame(replica: string, frame: CarrierOpFrame): Promise<void> {
    await this.appendLocalFrames(replica, [frame]);
  }

  /**
   * Hold and queue `frames` for `replica` in one stored write: either all of them are durable or
   * none is, so frames that only make sense together (a custody transfer and its lease) cannot be
   * split by a failed save.
   */
  async appendLocalFrames(replica: string, frames: CarrierOpFrame[]): Promise<void> {
    const asked = this.generation;
    await this.serializeWrite(async () => {
      // The frames were signed for the profile that was active when they were authored.
      if (asked !== this.generation) throw new Error("host_reconfigured");
      const current = this.snapshot.profiles[replica] ?? { frames: [], outbox: [], acked: [] };
      const held = new Set(current.frames.map((existing) => existing.id));
      const queued = new Set(current.outbox);
      const nextFrames = [...current.frames];
      const nextOutbox = [...current.outbox];
      for (const frame of frames) {
        if (!held.has(frame.id)) {
          held.add(frame.id);
          nextFrames.push(frame);
        }
        if (!queued.has(frame.id)) {
          queued.add(frame.id);
          nextOutbox.push(frame.id);
        }
      }
      await this.commit(replica, { frames: nextFrames, outbox: nextOutbox, acked: current.acked });
    });

    if (this.online && this.feed) {
      await this.feed.syncNow();
    }
  }

  async clearLocalStorage(): Promise<void> {
    await this.serializeWrite(async () => {
      await this.storage.clear(this.namespace);
      this.snapshot = { version: 1, namespace: this.namespace, profiles: {} };
      for (const ep of this.endpoints) {
        this.snapshot.profiles[ep.replica] = { frames: [], outbox: [], acked: [] };
      }
      this.onStateChange?.();
    });
  }

  isOnline(): boolean {
    return this.online;
  }

  getIdentity(): DemoIdentity | null {
    return this.identity;
  }

  getEndpoints(): DemoEndpoint[] {
    return this.endpoints;
  }

  getFeedState(): FeedState {
    return this.feedState;
  }

  getFrames(replica: string): CarrierOpFrame[] {
    return this.snapshot.profiles[replica]?.frames ?? [];
  }

  getPendingCount(replica: string): number {
    const p = this.snapshot.profiles[replica];
    if (!p) return 0;
    const acked = new Set(p.acked);
    return p.outbox.filter((id) => !acked.has(id)).length;
  }

  async dispose(): Promise<void> {
    await this.stopFeed();
    this.releaseNamespace();
    this.releaseNamespace = () => {};
  }

  // ── ShellHost implementation ───────────────────────────────────────────────

  relay(): RouteConfig | null {
    return this.routeConfig;
  }

  isAnchor(replica: string): boolean {
    return replica.startsWith("replica:treehouse:space:");
  }

  holdsAnchorProfile(): boolean {
    return Object.entries(this.snapshot.profiles).some(
      ([replica, profile]) => this.isAnchor(replica) && profile.frames.length > 0,
    );
  }

  profile(replica: string): HeldProfile | undefined {
    return this.snapshot.profiles[replica];
  }

  decoders(replica: string): CommandDecoderMap {
    const ep = this.endpoints.find((item) => item.replica === replica);
    if (!ep) throw new Error(`unknown_replica_product:${replica}`);
    return decodersForProduct(ep.product);
  }

  signer(): CarrierSigner {
    if (!this.identity) throw new Error("identity_unavailable");
    return this.identity.signer;
  }

  async mergeSync(
    replica: string,
    pulled: CarrierOpFrame[],
    ackedIds: string[],
  ): Promise<void> {
    const asked = this.generation;
    await this.serializeWrite(async () => {
      // A sync the previous profile started can still commit after its feed stopped.
      if (asked !== this.generation) return;
      const current = this.snapshot.profiles[replica] ?? { frames: [], outbox: [], acked: [] };
      const existingIds = new Set(current.frames.map((f) => f.id));
      let changed = false;

      const nextFrames = [...current.frames];
      for (const frame of pulled) {
        if (!existingIds.has(frame.id)) {
          existingIds.add(frame.id);
          nextFrames.push(frame);
          changed = true;
        }
      }

      const nextAcked = new Set(current.acked);
      for (const id of ackedIds) {
        if (!nextAcked.has(id)) {
          nextAcked.add(id);
          changed = true;
        }
      }

      if (!changed) return;
      await this.commit(replica, {
        frames: nextFrames,
        outbox: current.outbox,
        acked: [...nextAcked],
      });
    });
  }

  /**
   * Store the snapshot with `profile` in place, then adopt it. Memory changes only after the save
   * resolves, so a failed save leaves the write undone and a retry runs it again in full.
   */
  private async commit(replica: string, profile: HeldProfile): Promise<void> {
    const next: PersistedDemoSnapshot = {
      ...this.snapshot,
      profiles: { ...this.snapshot.profiles, [replica]: profile },
    };
    await this.storage.save(next);
    this.snapshot = next;
    this.onStateChange?.();
  }

  private async stopFeed(): Promise<void> {
    if (this.feed) {
      await this.feed.stop();
    }
  }

  private serializeWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
