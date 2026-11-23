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
  type SyncResult,
} from "@treetopdevs/lattice-shell-kit/sync";
import type {
  CarrierOpFrame,
  CarrierSigner,
  CommandDecoderMap,
  ConnectCarrierWebSocketOptions,
  Verifier,
} from "@treetopdevs/lattice-client";
import alphabet from "../../route_alphabet.json";
import {
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

  async configure(
    endpoints: DemoEndpoint[],
    identity: DemoIdentity,
    namespace?: string,
  ): Promise<void> {
    await this.stopFeed();
    this.endpoints = [...endpoints];
    this.identity = identity;
    this.namespace = namespace ?? `${identity.realm}:${identity.fingerprint}`;
    this.snapshot = await this.storage.load(this.namespace);

    const routes: CarrierRoute[] = endpoints.map((ep) =>
      this.validators.validateRoute({
        replica: ep.replica,
        url: ep.ws_url,
        expectedPeerRealm: ep.peer_realm,
        expectedPeerPubkey: ep.peer_pubkey,
      }),
    );

    this.routeConfig = {
      localRealm: this.validators.validateLocalRealm(identity.realm),
      routes,
    };

    for (const ep of endpoints) {
      if (!this.snapshot.profiles[ep.replica]) {
        this.snapshot.profiles[ep.replica] = { frames: [], outbox: [], acked: [] };
      }
    }

    this.feed = this.buildFeedController();
    this.onStateChange?.();
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

  async syncNow(): Promise<SyncResult> {
    if (!this.routeConfig) throw new Error("host_not_configured");
    if (this.online && this.feed) {
      await this.feed.syncNow();
    }
    const connector = createRelayConnector({
      host: this,
      verifier: strictCarrierVerifier,
      ...(this.webSocket ? { webSocket: this.webSocket } : {}),
    });
    const result = await syncRoutes(this, {
      connect: (route, localRealm, signal) => connector.connect(route, localRealm, signal),
      verifier: this.verifier,
    });
    this.onStateChange?.();
    return result;
  }

  async appendLocalFrame(replica: string, frame: CarrierOpFrame): Promise<void> {
    await this.serializeWrite(async () => {
      const current = this.snapshot.profiles[replica] ?? { frames: [], outbox: [], acked: [] };
      if (!current.frames.some((existing) => existing.id === frame.id)) {
        current.frames = [...current.frames, frame];
      }
      if (!current.outbox.includes(frame.id)) {
        current.outbox = [...current.outbox, frame.id];
      }
      this.snapshot.profiles[replica] = current;
      await this.storage.save(this.snapshot);
      this.onStateChange?.();
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
  }

  // ── ShellHost implementation ───────────────────────────────────────────────

  relay(): RouteConfig | null {
    return this.routeConfig;
  }

  isAnchor(replica: string): boolean {
    return replica.startsWith("replica:treehouse:space:");
  }

  holdsAnchorProfile(): boolean {
    return true;
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
    await this.serializeWrite(async () => {
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

      this.snapshot.profiles[replica] = {
        frames: nextFrames,
        outbox: current.outbox,
        acked: [...nextAcked],
      };
      await this.storage.save(this.snapshot);
      this.onStateChange?.();
    });
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
