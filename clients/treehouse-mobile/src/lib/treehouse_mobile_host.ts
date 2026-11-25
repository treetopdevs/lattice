import {
  analyzeAuthority,
  authorTreehouseCommand,
  canonicalOrder,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  frontier,
  index,
  observeTreehouse,
  treehouseCommandDecoders,
  treehouseSpaceSchema,
  treehouseThreadSchema,
  type CarrierDelegation,
  type CarrierOpFrame,
  type CarrierSigner,
  type CommandDecoderMap,
  type ConnectCarrierWebSocketOptions,
  type Op,
  type TreehouseProduct,
  type Verifier,
} from "@treetopdevs/lattice-client";
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
import alphabet from "../../route_alphabet.json";
import {
  pubkeyColor,
  pubkeyFingerprint,
  strictCarrierVerifier,
  strictOpVerifier,
  type MobileIdentity,
} from "../native/custody";
import {
  ExpoSqliteStorage,
  type MobileStorage,
  type PersistedMobileSnapshot,
} from "../native/storage";

export const DEFAULT_DEMO_WSS_ORIGIN = "https://lattice-demo-wss.fly.dev";

export interface DemoEndpoint {
  name: string;
  product: string;
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

export interface TreehouseSpaceView {
  replica: string;
  name: string;
  members: { pubkey: string; label: string; fingerprint: string; color: string }[];
  threads: string[];
  adminHolder: string | null;
  moderatorHolder: string | null;
  opCount: number;
  quarantinedCount: number;
}

export interface TreehousePostView {
  id: string;
  authorPubkey: string;
  authorLabel: string;
  authorColor: string;
  text: string;
  pending: boolean;
}

export interface TreehouseThreadView {
  replica: string;
  title: string;
  archived: boolean;
  posts: TreehousePostView[];
  opCount: number;
  quarantinedCount: number;
  pendingCount: number;
  canPost: boolean;
}

export interface TreehouseMobileHostOptions {
  storage?: MobileStorage;
  webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
  pollMs?: number;
  onStateChange?: () => void;
  onFeedState?: (state: FeedState) => void;
}

export async function fetchDemoEndpoints(
  origin = DEFAULT_DEMO_WSS_ORIGIN,
): Promise<DemoEndpointsManifest> {
  const base = origin.replace(/\/$/, "");
  const res = await fetch(`${base}/demo-endpoints.json`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`demo_endpoints_fetch_failed:${res.status}`);
  }
  return (await res.json()) as DemoEndpointsManifest;
}

export async function fetchDemoSeed(
  origin: string,
  role: "founder" | "neighbor" | "observer",
): Promise<{ realm: string; seedHex: string }> {
  const base = origin.replace(/\/$/, "");
  const res = await fetch(`${base}/demo-seed/${role}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`demo_seed_fetch_failed:${role}:${res.status}`);
  }
  return (await res.json()) as { realm: string; seedHex: string };
}

function productForReplica(endpoints: DemoEndpoint[], replica: string): TreehouseProduct {
  const ep = endpoints.find((item) => item.replica === replica);
  if (ep?.product === "Treehouse.Space" || ep?.product === "Treehouse.Thread") {
    return ep.product;
  }
  if (replica.startsWith("replica:treehouse:space:")) return "Treehouse.Space";
  return "Treehouse.Thread";
}

function frontierIds(frames: CarrierOpFrame[]): string[] {
  const ops = frames.map((frame) => ({
    id: frame.id,
    deps: frame.deps,
  })) as unknown as Op[];
  return frontier(ops);
}

function pickTreehouseCapability(
  product: TreehouseProduct,
  frames: CarrierOpFrame[],
  pubkeyBase64: string,
  commandName: string,
  realmByPubkey: Record<string, string>,
): string | null {
  const ops = carrierOpsToSemanticOps(frames, realmByPubkey, treehouseCommandDecoders(product));
  const schema = product === "Treehouse.Space" ? treehouseSpaceSchema : treehouseThreadSchema;
  const byId = index(ops);
  const order = canonicalOrder(ops, byId);
  const included = new Set(order);
  const analysis = analyzeAuthority(schema, ops, included, order, byId);
  const delegations = carrierDelegationsFromFrames(frames);
  const revoked = new Set(analysis.security.effectiveRevokes.map((r) => r.delegationId));

  let epoch: number | null = null;
  for (const b of analysis.security.validBeacons) {
    const n = typeof b.epoch === "number" ? b.epoch : Number(b.epoch);
    if (Number.isSafeInteger(n) && (epoch === null || n > epoch)) epoch = n;
  }

  let chosen: CarrierDelegation | null = null;
  for (const d of delegations) {
    if (d.audience !== pubkeyBase64) continue;
    if (!d.ops.includes(commandName)) continue;
    if (revoked.has(d.id)) continue;
    const record = analysis.security.delegations.get(d.id);
    if (record && !record.validation.valid) continue;
    if (d.expires_epoch !== undefined && epoch !== null && epoch > d.expires_epoch) continue;
    chosen = d;
  }
  return chosen?.id ?? null;
}

/**
 * Native mobile `ShellHost` for Treehouse (iOS-first, Android-next).
 * Consumes `@treetopdevs/lattice-client` and `@treetopdevs/lattice-shell-kit` directly.
 */
export class TreehouseMobileHost implements ShellHost {
  readonly maxRoutes = 16;
  readonly verifier: Verifier = strictOpVerifier;
  readonly validators: RouteValidators;

  private readonly storage: MobileStorage;
  private readonly webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
  private readonly pollMs: number;
  private readonly onStateChange?: () => void;
  private readonly onFeedState?: (state: FeedState) => void;

  private namespace = "default";
  private identity: MobileIdentity | null = null;
  private endpoints: DemoEndpoint[] = [];
  private realmByPubkey: Record<string, string> = {};
  private routeConfig: RouteConfig | null = null;
  private snapshot: PersistedMobileSnapshot = { version: 1, namespace: "default", profiles: {} };
  private feed: FeedController | null = null;
  private feedState: FeedState = { configured: false, routes: [] };
  private online = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: TreehouseMobileHostOptions = {}) {
    this.storage = options.storage ?? new ExpoSqliteStorage();
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
    identity: MobileIdentity,
    realmByPubkey: Record<string, string> = {},
    namespace?: string,
  ): Promise<void> {
    await this.stopFeed();
    const treehouseOnly = endpoints.filter(
      (ep) => ep.product === "Treehouse.Space" || ep.product === "Treehouse.Thread",
    );
    this.endpoints = [...treehouseOnly];
    this.identity = identity;
    this.realmByPubkey = {
      ...realmByPubkey,
      [identity.publicKeyBase64]: identity.realm,
    };
    this.namespace = namespace ?? `treehouse:${identity.realm}:${identity.fingerprint}`;
    this.snapshot = await this.storage.load(this.namespace);

    const routes: CarrierRoute[] = this.endpoints.map((ep) =>
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

    for (const ep of this.endpoints) {
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

  async postMessage(threadReplica: string, rawText: string): Promise<CarrierOpFrame> {
    if (!this.identity) throw new Error("identity_unavailable");
    const text = rawText.trim();
    if (!text) throw new Error("empty_post_text");

    const frames = this.getFrames(threadReplica);
    const capId = pickTreehouseCapability(
      "Treehouse.Thread",
      frames,
      this.identity.publicKeyBase64,
      "post",
      this.realmByPubkey,
    );
    if (!capId) {
      throw new Error("no_post_capability");
    }

    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: threadReplica,
      deps: frontierIds(frames),
      signer: this.identity.signer,
      capId,
      command: { command: "post", text },
    });
    await this.appendLocalFrame(threadReplica, frame);
    return frame;
  }

  observeSpace(spaceReplica: string): TreehouseSpaceView {
    const frames = this.getFrames(spaceReplica);
    const ops = carrierOpsToSemanticOps(
      frames,
      this.realmByPubkey,
      treehouseCommandDecoders("Treehouse.Space"),
    );
    const observed = observeTreehouse("Treehouse.Space", ops);
    const byId = index(ops);
    const order = canonicalOrder(ops, byId);
    const analysis = analyzeAuthority(treehouseSpaceSchema, ops, new Set(order), order, byId);

    const adminAcquires = analysis.acquiresByRole.get("admin");
    const modAcquires = analysis.acquiresByRole.get("moderator");
    const adminHolder =
      adminAcquires && adminAcquires.length > 0
        ? adminAcquires[adminAcquires.length - 1]!.holder
        : null;
    const moderatorHolder =
      modAcquires && modAcquires.length > 0
        ? modAcquires[modAcquires.length - 1]!.holder
        : null;

    const rawMembers = Array.isArray(observed.state.members)
      ? (observed.state.members as string[])
      : [];
    const members = rawMembers.map((pubkey) => ({
      pubkey,
      label: this.realmByPubkey[pubkey] ?? pubkeyFingerprint(pubkey),
      fingerprint: pubkeyFingerprint(pubkey),
      color: pubkeyColor(pubkey),
    }));

    return {
      replica: spaceReplica,
      name: String(observed.state.name ?? ""),
      members,
      threads: Array.isArray(observed.state.threads) ? (observed.state.threads as string[]) : [],
      adminHolder,
      moderatorHolder,
      opCount: observed.operationCount,
      quarantinedCount: observed.quarantineReasons.size,
    };
  }

  observeThread(threadReplica: string): TreehouseThreadView {
    const frames = this.getFrames(threadReplica);
    const ops = carrierOpsToSemanticOps(
      frames,
      this.realmByPubkey,
      treehouseCommandDecoders("Treehouse.Thread"),
    );
    const observed = observeTreehouse("Treehouse.Thread", ops);
    const profile = this.snapshot.profiles[threadReplica];
    const acked = new Set(profile?.acked ?? []);
    const outbox = new Set(profile?.outbox ?? []);

    const posts: TreehousePostView[] = observed.posts.map((post) => ({
      id: post.id,
      authorPubkey: post.author,
      authorLabel: this.realmByPubkey[post.author] ?? pubkeyFingerprint(post.author),
      authorColor: pubkeyColor(post.author),
      text: String(post.text ?? ""),
      pending: outbox.has(post.id) && !acked.has(post.id),
    }));

    const canPost =
      this.identity !== null &&
      pickTreehouseCapability(
        "Treehouse.Thread",
        frames,
        this.identity.publicKeyBase64,
        "post",
        this.realmByPubkey,
      ) !== null;

    return {
      replica: threadReplica,
      title: String(observed.state.title ?? "Thread"),
      archived: Boolean(observed.state.archived),
      posts,
      opCount: observed.operationCount,
      quarantinedCount: observed.quarantineReasons.size,
      pendingCount: this.getPendingCount(threadReplica),
      canPost,
    };
  }

  isOnline(): boolean {
    return this.online;
  }

  getIdentity(): MobileIdentity | null {
    return this.identity;
  }

  getEndpoints(): DemoEndpoint[] {
    return this.endpoints;
  }

  getSpaceEndpoint(): DemoEndpoint | undefined {
    return this.endpoints.find((ep) => ep.product === "Treehouse.Space");
  }

  getThreadEndpoint(): DemoEndpoint | undefined {
    return this.endpoints.find((ep) => ep.product === "Treehouse.Thread");
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

  getTotalPendingCount(): number {
    return this.endpoints.reduce((sum, ep) => sum + this.getPendingCount(ep.replica), 0);
  }

  async dispose(): Promise<void> {
    await this.stopFeed();
    this.feed = null;
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
    return treehouseCommandDecoders(productForReplica(this.endpoints, replica));
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
