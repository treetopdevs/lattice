import { base64ToBytes, treehouseCommandDecoders, verifyEd25519 } from "@treetopdevs/lattice-client";
import type { CarrierSigner, CarrierVerifier, ConnectCarrierWebSocketOptions, Verifier } from "@treetopdevs/lattice-client";
import { createRouteValidators } from "@treetopdevs/lattice-shell-kit";
import type { RouteAlphabet, RouteValidators } from "@treetopdevs/lattice-shell-kit";
import { createFeedController, createRelayConnector } from "@treetopdevs/lattice-shell-kit/sync";
import type { FeedController, ShellHost } from "@treetopdevs/lattice-shell-kit/sync";
import alphabet from "../../route_alphabet.json";
import { postMessage as postMessageCommand } from "./commands/post_message";
import type { CommandContext } from "./commands/pipeline";
import type { Outcome, PostRefusal } from "./outcomes";
import type { Clock, FeedState, KeyCustody, RelayLink, ReplicaStore, RouteConfig } from "./ports";
import { projectThreadTimeline } from "./projections/thread_timeline";
import type { ThreadTimeline } from "./projections/thread_timeline";

// TreehouseSession: one device identity in one Group (03). The UI subscribes to read models and calls
// commands; everything else is reached through the ports. Internally the session is shell-kit's
// ShellHost (profile and mergeSync from the ReplicaStore, signer from KeyCustody, the route book from
// the RelayLink's config), so createFeedController and syncRoutes run unchanged.

export interface ReadModels {
  /** One timeline per held Thread replica. An unchanged thread keeps the identical object. */
  timelines: Readonly<Record<string, ThreadTimeline>>;
  link: FeedState;
}

export interface TreehouseSession {
  open(): Promise<void>;
  close(): Promise<void>;
  subscribe<T>(select: (m: ReadModels) => T, listener: (value: T) => void): () => void;
  read(): ReadModels;
  postMessage(thread: string, text: string): Promise<Outcome<{ id: string }, PostRefusal>>;
}

/**
 * Everything of ShellHost except the route book's saved routes, which the RelayLink owns. Its validators
 * are the full set, so the link can check a route set as a set (validateRoutes).
 */
export type SessionHost = Omit<ShellHost, "relay" | "validators"> & { validators: RouteValidators };

export interface SessionPorts {
  custody: KeyCustody;
  store: ReplicaStore;
  clock: Clock;
  /** Builds the session's RelayLink over its host. Called once, at construction. */
  link(host: SessionHost): RelayLink;
}

const MAX_ROUTES = 16;

export const strictOpVerifier: Verifier = {
  async verify(author, bytes, sig) {
    try {
      return verifyEd25519(sig, bytes, base64ToBytes(author));
    } catch {
      return false;
    }
  },
};

export const strictCarrierVerifier: CarrierVerifier = {
  verify: (pubkey, bytes, signature) => verifyEd25519(signature, bytes, pubkey),
};

export function createTreehouseSession(ports: SessionPorts): TreehouseSession {
  const { custody, store } = ports;
  let myKey: string | null = null;
  let opened = false;
  let unsubscribe: (() => void)[] = [];
  const subscribers = new Set<{ select: (m: ReadModels) => unknown; listener: (v: unknown) => void; last: unknown }>();

  const productOf = (replica: string) => store.replicas().find((r) => r.replica === replica)?.product;

  const host: SessionHost = {
    maxRoutes: MAX_ROUTES,
    validators: createRouteValidators(alphabet as RouteAlphabet, {
      maxRoutes: MAX_ROUTES,
      isReplica: (replica) => replica.startsWith("replica:"),
      isSpace: (replica) => replica.startsWith("replica:treehouse:space:"),
    }),
    verifier: strictOpVerifier,
    isAnchor: (replica) => productOf(replica) === "Treehouse.Space",
    holdsAnchorProfile: () =>
      store.replicas().some((r) => r.product === "Treehouse.Space" && (store.profile(r.replica)?.frames.length ?? 0) > 0),
    profile: (replica) => store.profile(replica),
    decoders(replica) {
      const product = productOf(replica);
      if (!product) throw new Error("unknown_replica");
      return treehouseCommandDecoders(product);
    },
    mergeSync: (replica, pulled, acked) => store.mergeSync(replica, pulled, acked),
    signer(): CarrierSigner {
      if (myKey === null) throw new Error("identity_unavailable");
      return { publicKey: base64ToBytes(myKey), sign: (bytes) => custody.sign(bytes) };
    },
  };
  const link = ports.link(host);

  let models: ReadModels = { timelines: {}, link: link.state() };

  const connectionOf = (replica: string, state: FeedState) =>
    state.routes.find((r) => r.replica === replica)?.connection ?? null;

  /** Recompute the timelines of `replicas` (all when omitted), keeping equal results identical. */
  const recompute = (replicas?: readonly string[], linkState?: FeedState): void => {
    const state = linkState ?? models.link;
    const threads = store.replicas().filter((r) => r.product === "Treehouse.Thread").map((r) => r.replica);
    const targets = new Set(replicas ?? threads);
    const timelines: Record<string, ThreadTimeline> = {};
    let timelinesChanged = false;
    for (const replica of threads) {
      const previous = models.timelines[replica];
      if (previous && !targets.has(replica)) {
        timelines[replica] = previous;
        continue;
      }
      const next = projectThreadTimeline({ replica, profile: store.profile(replica), myKey, connection: connectionOf(replica, state) });
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) timelines[replica] = previous;
      else {
        timelines[replica] = next;
        timelinesChanged = true;
      }
    }
    if (Object.keys(models.timelines).length !== threads.length) timelinesChanged = true;
    if (!timelinesChanged && linkState === undefined) return;
    // An unchanged set of timelines keeps the identical record, so a whole-record selector stays quiet.
    models = { timelines: timelinesChanged ? timelines : models.timelines, link: state };
    for (const sub of [...subscribers]) {
      const value = sub.select(models);
      if (Object.is(value, sub.last)) continue;
      sub.last = value;
      sub.listener(value);
    }
  };

  const linkActive = () =>
    link.state().routes.some((r) => r.connection === "live" || r.connection === "connecting" || r.connection === "reconnecting");

  const ctx: CommandContext = {
    custody,
    store,
    myKey: () => myKey,
    nudge() {
      if (linkActive()) link.syncNow().catch(() => undefined);
    },
  };

  return {
    async open() {
      if (opened) return;
      myKey = (await custody.status()) === "available" ? await custody.publicKey() : null;
      await store.open();
      unsubscribe = [store.onChange((replica) => recompute([replica])), link.onState((state) => recompute(undefined, state))];
      opened = true;
      recompute(undefined, link.state());
    },
    async close() {
      if (!opened) return;
      opened = false;
      for (const off of unsubscribe) off();
      unsubscribe = [];
      await link.stop();
    },
    subscribe<T>(select: (m: ReadModels) => T, listener: (value: T) => void) {
      const sub = { select, listener: listener as (v: unknown) => void, last: select(models) as unknown };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },
    read: () => models,
    postMessage(thread, text) {
      if (!opened) return Promise.resolve({ ok: false, reason: "identity_unavailable" } as const);
      return postMessageCommand(ctx, thread, text);
    },
  };
}

export interface FeedRelayLinkOptions {
  /** Poll fallback in milliseconds; 0 disables it. Defaults to shell-kit's. */
  pollMs?: number;
  webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
}

/**
 * The RelayLink over shell-kit: one availability feed per route while started; nothing dials while
 * stopped. A stopped feed controller cannot restart, so each start builds a fresh one.
 */
export function createFeedRelayLink(host: SessionHost, options: FeedRelayLinkOptions = {}): RelayLink {
  let config: RouteConfig | null = null;
  let feed: FeedController | null = null;
  const listeners = new Set<(state: FeedState) => void>();
  // The session host's members are closures over live state, so a shallow copy reads it each call.
  const shellHost: ShellHost = { ...host, relay: () => config };
  const connector = createRelayConnector({
    host: shellHost,
    verifier: strictCarrierVerifier,
    ...(options.webSocket ? { webSocket: options.webSocket } : {}),
  });
  const sync = {
    connect: connector.connect,
    verifier: host.verifier,
  };
  const emit = (state: FeedState) => {
    for (const listener of [...listeners]) listener(state);
  };
  const build = (onState: (state: FeedState) => void) =>
    createFeedController({
      host: shellHost,
      sync,
      connect: connector.connectFeed,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      autosyncOnMount: true,
      onState,
    });
  // Never started: it only answers state() with idle routes and the held counts.
  const idle = build(() => undefined);
  const state = (): FeedState => (feed ?? idle).state();

  return {
    async configure(next) {
      config =
        next === null
          ? null
          : {
              localRealm: host.validators.validateLocalRealm(next.localRealm),
              // The set-level check: non-empty, no duplicate replica, exactly one Space, within maxRoutes.
              routes: host.validators.validateRoutes([...next.routes]),
            };
      if (feed) await feed.reconfigure();
      emit(state());
    },
    async start() {
      if (feed) return;
      feed = build((s) => emit(s));
      await feed.start();
    },
    async stop() {
      const running = feed;
      feed = null;
      if (running) await running.stop();
      emit(state());
    },
    // Stopped means the person turned sync off: syncNow then dials nothing and reports the idle state.
    async syncNow() {
      return feed ? feed.syncNow() : state();
    },
    state,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
