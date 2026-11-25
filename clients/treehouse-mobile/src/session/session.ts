import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64ToBytes, treehouseCommandDecoders, verifyEd25519 } from "@treetopdevs/lattice-client";
import type { CarrierSigner, CarrierVerifier, ConnectCarrierWebSocketOptions, Verifier } from "@treetopdevs/lattice-client";
import { createRouteValidators } from "@treetopdevs/lattice-shell-kit";
import type { RouteAlphabet, RouteValidators } from "@treetopdevs/lattice-shell-kit";
import { createFeedController, createRelayConnector } from "@treetopdevs/lattice-shell-kit/sync";
import type { FeedController, ShellHost } from "@treetopdevs/lattice-shell-kit/sync";
import alphabet from "../../route_alphabet.json";
import { archiveThread as archiveThreadCommand } from "./commands/archive_thread";
import { deleteMessage as deleteMessageCommand } from "./commands/delete_message";
import { editMessage as editMessageCommand } from "./commands/edit_message";
import { exportSpaceFrames as exportSpaceFramesCommand } from "./commands/export_space";
import type { SpaceExport } from "./commands/export_space";
import * as linkCommands from "./commands/link_commands";
import type { LinkContext } from "./commands/link_commands";
import * as localCommands from "./commands/local_commands";
import { postMessage as postMessageCommand } from "./commands/post_message";
import { removeMessage as removeMessageCommand } from "./commands/remove_message";
import type { CommandContext } from "./commands/pipeline";
import { refuse } from "./outcomes";
import type {
  ArchiveRefusal,
  DeleteRefusal,
  EditRefusal,
  ExportRefusal,
  LinkRefusal,
  LocalRefusal,
  Outcome,
  PostRefusal,
  RemoveRefusal,
} from "./outcomes";
import type { Clock, FeedState, KeyCustody, RelayLink, ReplicaStore, RouteConfig, TreehouseProduct } from "./ports";
import { createCachedLocalStore } from "../local/local_store";
import type { Draft, LocalStore } from "../local/local_store";
import { projectAbilities } from "./projections/abilities";
import type { Abilities } from "./projections/abilities";
import { projectAuditView } from "./projections/audit_view";
import type { AuditView } from "./projections/audit_view";
import { projectGroupSummary } from "./projections/group_summary";
import type { GroupSummary } from "./projections/group_summary";
import { projectLinkStatus } from "./projections/link_status";
import type { LinkStatus } from "./projections/link_status";
import { viewReplica } from "./projections/replica_view";
import type { ReplicaView } from "./projections/replica_view";
import { projectRoster } from "./projections/roster";
import type { Roster } from "./projections/roster";
import { projectSessionStatus } from "./projections/session_status";
import type { HistoryCheck, SessionStatus } from "./projections/session_status";
import { projectThreadList } from "./projections/thread_list";
import type { ThreadList } from "./projections/thread_list";
import { projectThreadTimeline } from "./projections/thread_timeline";
import type { MessageLineage, ThreadTimeline } from "./projections/thread_timeline";
import { strictOpVerifier, verifyHeld } from "./verify_held";
import type { HeldEntry, VerifyHeldResult } from "./verify_held";

export { strictOpVerifier };

// TreehouseSession: one device identity in one Group (03). The UI subscribes to read models and calls
// commands; everything else is reached through the ports. Internally the session is shell-kit's
// ShellHost (profile and mergeSync from the ReplicaStore, signer from KeyCustody, the route book from
// the RelayLink's config), so createFeedController and syncRoutes run unchanged.

export interface ReadModels {
  status: SessionStatus;
  /** Null until a Space is held. */
  group: GroupSummary | null;
  linkStatus: LinkStatus;
  threads: ThreadList;
  abilities: Abilities;
  roster: Roster;
  audit: AuditView;
  /** One timeline per held Thread replica. An unchanged thread keeps the identical object. */
  timelines: Readonly<Record<string, ThreadTimeline>>;
  /** shell-kit's raw feed state, for the adapters that still read it directly. */
  link: FeedState;
  /**
   * Verify-on-open result (M1a.2). Not ok means `history_invalid` (03): nothing is posted, nothing is
   * deleted. `replica` is null when the store itself could not open. `status` carries the same result as
   * its phase; this field stays for the M0 screen until M1a.7 reads `status`.
   */
  history: HistoryCheck;
}

export type { HistoryCheck };

export interface TreehouseSession {
  open(): Promise<void>;
  close(): Promise<void>;
  subscribe<T>(select: (m: ReadModels) => T, listener: (value: T) => void): () => void;
  read(): ReadModels;
  postMessage(thread: string, text: string): Promise<Outcome<{ id: string }, PostRefusal>>;
  /** Edit my message. Only `ref.root` is trusted; the target is the held lineage's latest edit. */
  editMessage(thread: string, ref: MessageLineage, text: string): Promise<Outcome<{ id: string }, EditRefusal>>;
  /** Delete my message for the group (author_tombstone). Irreversible. */
  deleteMessage(thread: string, ref: MessageLineage): Promise<Outcome<{ id: string }, DeleteRefusal>>;
  /** Remove anyone's message as the moderator holder (moderator_tombstone). */
  removeMessage(thread: string, ref: MessageLineage): Promise<Outcome<{ id: string }, RemoveRefusal>>;
  archiveThread(thread: string): Promise<Outcome<{ id: string }, ArchiveRefusal>>;
  setPetname(pubkey: string, name: string | null): Promise<Outcome<null, LocalRefusal>>;
  saveDraft(thread: string, draft: Draft | null): Promise<Outcome<null, LocalRefusal>>;
  markRead(thread: string, ids: readonly string[]): Promise<Outcome<null, LocalRefusal>>;
  goOnline(): Promise<Outcome<FeedState, LinkRefusal>>;
  goOffline(): Promise<Outcome<FeedState, LinkRefusal>>;
  syncNow(): Promise<Outcome<FeedState, LinkRefusal>>;
  /**
   * Lifecycle (03): the app is in the foreground. Starts the feed and syncs once when sync is on and the
   * history and key allow it; otherwise reports the idle state. Never changes the person's sync setting.
   */
  foreground(): Promise<Outcome<FeedState, LinkRefusal>>;
  /** Lifecycle (03): the app is in the background. Stops the feed and closes sockets. No background work. */
  background(): Promise<Outcome<FeedState, LinkRefusal>>;
  /**
   * The held Space frames in the D-31 export shape (04). Offered in every phase, including history_invalid
   * and identity_mismatch; nothing is signed or written.
   */
  exportSpaceFrames(): Promise<Outcome<SpaceExport, ExportRefusal>>;
}

export type { SpaceExport };

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
  /**
   * Device-local facts (read markers, petnames, settings). Required: a caller that has no persistent store
   * passes an explicitly in-memory one, so no command reports success over persistence that is not there.
   */
  local: LocalStore;
  /**
   * A check the caller already failed before open (the M0 carry-over): open reports it as history_invalid
   * even when the store itself verifies, so the session never goes online or signs over it.
   */
  blockedHistory?: HistoryCheck & { ok: false };
  /** Verify on open and before each merge. Defaults to verifyHeld (lattice-client's checks). */
  verify?: (held: readonly HeldEntry[], verifier: Verifier) => Promise<VerifyHeldResult>;
}

const MAX_ROUTES = 16;

/**
 * The strict op verifier, remembering passes. The key binds author, signature and the digest of the signed
 * bytes, so a remembered pass can only ever answer the identical check again.
 */
function rememberingVerifier(inner: Verifier): Verifier {
  const passed = new Set<string>();
  return {
    async verify(author, bytes, sig) {
      const key = `${author}|${bytesToHex(sig)}|${bytesToHex(sha256(bytes))}`;
      if (passed.has(key)) return true;
      const ok = await inner.verify(author, bytes, sig);
      if (ok) passed.add(key);
      return ok;
    },
  };
}

export const strictCarrierVerifier: CarrierVerifier = {
  verify: (pubkey, bytes, signature) => verifyEd25519(signature, bytes, pubkey),
};

/** Keep `previous` when `next` is structurally equal, so a selector sees the identical object. */
function keep<T>(previous: T | undefined, next: T): T {
  if (previous === next) return next;
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function createTreehouseSession(ports: SessionPorts): TreehouseSession {
  const { custody, store } = ports;
  const { local } = ports;
  const verify = ports.verify ?? ((held, verifier) => verifyHeld(held, { verifier }));
  const verifier = rememberingVerifier(strictOpVerifier);
  let history: HistoryCheck = { ok: true };
  let custodyStatus: "none" | "available" | "unavailable" = "none";
  let myKey: string | null = null;
  let lastSyncMs: number | null = null;
  let lastSyncMark = "";
  const views = new Map<string, { count: number; view: ReplicaView }>();
  /** Per Thread: the inputs its timeline was last projected from, so an untouched thread is not re-projected. */
  const timelineInputs = new Map<string, { view: ReplicaView; outbox: number; acked: number; route: string; read: ReadonlySet<string>; key: string | null; timeline: ThreadTimeline }>();
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
    // A pull is retained only if the held set would still verify with it (as the Tauri shell's mergeSync
    // runs verifyProfile first): held frames are never deleted, so a bad pull must not reach the store.
    async mergeSync(replica, pulled, acked) {
      if (!history.ok) throw new Error("history_invalid");
      const current = store.profile(replica);
      const product = productOf(replica);
      if (!current || !product) throw new Error("unknown_replica");
      const ids = new Set(current.frames.map((f) => f.id));
      const candidate = {
        frames: [...current.frames, ...pulled.filter((f) => !ids.has(f.id))],
        outbox: current.outbox,
        acked: [...new Set([...current.acked, ...acked])],
      };
      const verdict = await verify(
        store.replicas().map((r) => ({ ...r, profile: r.replica === replica ? candidate : store.profile(r.replica) })),
        verifier,
      );
      if (!verdict.ok) throw new Error(verdict.reason);
      return store.mergeSync(replica, pulled, acked);
    },
    signer(): CarrierSigner {
      if (myKey === null) throw new Error("identity_unavailable");
      return { publicKey: base64ToBytes(myKey), sign: (bytes) => custody.sign(bytes) };
    },
  };
  const link = ports.link(host);

  /** The judged view of one held replica, rebuilt only when its frames grew (frames are append-only). */
  const viewOf = (replica: string, product: TreehouseProduct): ReplicaView => {
    const frames = store.profile(replica)?.frames ?? [];
    const cached = views.get(replica);
    if (cached && cached.count === frames.length && cached.view.product === product) return cached.view;
    const view = viewReplica(replica, product, frames);
    views.set(replica, { count: frames.length, view });
    return view;
  };

  /**
   * Stamp a completed sync: every route is live and has compared with the relay (matchesRelay is a result,
   * true or false), and either some route's relay result (match, acknowledged count, generation) moved, or
   * `completed` says a syncNow just finished. An offline post changes only the pending count, so it never
   * stamps; a route that is reconnecting keeps its last result but is not a completed sync.
   */
  const stampSync = (state: FeedState, completed = false): void => {
    if (!state.configured || state.routes.length === 0) return;
    if (state.routes.some((r) => r.matchesRelay === null || r.connection !== "live")) return;
    const mark = JSON.stringify(state.routes.map((r) => [r.replica, r.matchesRelay, r.acked, r.generation]));
    if (mark === lastSyncMark && !completed) return;
    lastSyncMark = mark;
    lastSyncMs = ports.clock.now();
  };

  const build = (state: FeedState, previous: ReadModels | null): ReadModels => {
    // Unverified history is never shown: with history_invalid (or before open) every replica-derived model
    // is empty.
    const held = history.ok && opened ? store.replicas() : [];
    const heldViews = held.map((r) => viewOf(r.replica, r.product));
    const space = heldViews.find((v) => v.product === "Treehouse.Space") ?? null;
    const threadViews = heldViews.filter((v) => v.product === "Treehouse.Thread");
    const profiles = Object.fromEntries(held.map((r) => [r.replica, store.profile(r.replica)]));
    const routeOf = (replica: string) => state.routes.find((r) => r.replica === replica) ?? null;

    const timelines: Record<string, ThreadTimeline> = {};
    for (const view of threadViews) {
      const profile = profiles[view.replica];
      const route = routeOf(view.replica);
      const read = local.readIds(view.replica);
      // First-seen times are written with the frame, so a grown view covers them.
      const inputs = { view, outbox: profile?.outbox.length ?? 0, acked: profile?.acked.length ?? 0, route: JSON.stringify(route), read, key: myKey };
      const cached = timelineInputs.get(view.replica);
      if (
        cached &&
        cached.view === inputs.view &&
        cached.outbox === inputs.outbox &&
        cached.acked === inputs.acked &&
        cached.route === inputs.route &&
        cached.read === inputs.read &&
        cached.key === inputs.key
      ) {
        timelines[view.replica] = cached.timeline;
        continue;
      }
      const next = projectThreadTimeline({
        replica: view.replica,
        profile,
        myKey,
        route,
        readIds: read,
        firstSeen: (id) => store.firstSeenMs(view.replica, id),
        view,
      });
      const timeline = keep(previous?.timelines[view.replica], next);
      timelineInputs.set(view.replica, { ...inputs, timeline });
      timelines[view.replica] = timeline;
    }
    const sameTimelines =
      previous !== null &&
      Object.keys(previous.timelines).length === threadViews.length &&
      threadViews.every((v) => previous.timelines[v.replica] === timelines[v.replica]);

    let waiting = 0;
    const spaceWaiting = new Set<string>();
    for (const r of held) {
      const profile = profiles[r.replica];
      const acked = new Set(profile?.acked ?? []);
      for (const id of profile?.outbox ?? [])
        if (!acked.has(id)) {
          waiting++;
          if (r.product === "Treehouse.Space") spaceWaiting.add(id);
        }
    }

    const next: ReadModels = {
      status: projectSessionStatus({
        custody: custodyStatus,
        myKey,
        history,
        space,
        held: held.map((r) => ({ replica: r.replica, profile: profiles[r.replica] })),
      }),
      group: projectGroupSummary({ space, myKey }),
      linkStatus: projectLinkStatus({
        feed: state,
        space: space?.replica ?? null,
        syncEnabled: local.setting("syncEnabled"),
        waiting,
        lastSyncMs,
      }),
      threads: projectThreadList({ space, timelines, profiles, feed: state }),
      abilities: projectAbilities({ views: heldViews, myKey }),
      roster: projectRoster({
        space,
        threads: threadViews,
        myKey,
        petname: (key) => local.petname(key),
        spaceRoute: space ? routeOf(space.replica) : null,
        waitingIds: spaceWaiting,
      }),
      audit: projectAuditView({ views: heldViews, feed: state }),
      timelines: sameTimelines ? previous!.timelines : timelines,
      link: state,
      history,
    };
    if (previous === null) return next;
    const merged = { ...next } as Record<keyof ReadModels, unknown>;
    for (const key of Object.keys(next) as (keyof ReadModels)[])
      if (key !== "timelines") merged[key] = keep(previous[key], next[key]);
    const result = merged as unknown as ReadModels;
    return (Object.keys(result) as (keyof ReadModels)[]).every((key) => result[key] === previous[key]) ? previous : result;
  };

  let models: ReadModels = build(link.state(), null);

  /** Recompute every read model from its inputs, keeping each unchanged one identical, then publish. */
  const recompute = (linkState?: FeedState): void => {
    if (linkState) stampSync(linkState);
    const next = build(linkState ?? models.link, models);
    if (next === models) return;
    models = next;
    publish();
  };

  function publish(): void {
    for (const sub of [...subscribers]) {
      const value = sub.select(models);
      if (Object.is(value, sub.last)) continue;
      sub.last = value;
      sub.listener(value);
    }
  }

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

  /**
   * 02 Invariant 8: when the key and the held history disagree (this phone's outbox holds another key's
   * ops), nothing is signed and nothing goes online. A key that is missing or locked is the custody's own
   * refusal (identity_unavailable) for signing; transport stops for every identity_mismatch reason.
   */
  const mismatched = () => models.status.phase === "identity_mismatch";
  const linkCtx: LinkContext = { link, local, historyOk: () => history.ok, identityOk: () => !mismatched() };

  /** Every signed command: refused before open, with history_invalid, and with identity_mismatch. */
  const signed = <R extends string>(run: () => Promise<Outcome<{ id: string }, R>>) => {
    if (!opened) return Promise.resolve(refuse("identity_unavailable" as const));
    if (!history.ok) return Promise.resolve(refuse("history_invalid" as const));
    if (mismatched())
      return Promise.resolve(refuse(models.status.reason === "outbox_other_key" ? ("identity_mismatch" as const) : ("identity_unavailable" as const)));
    return run();
  };
  const whenOpen = <T, R extends string>(run: () => Promise<Outcome<T, R>>) =>
    opened ? run() : Promise.resolve(refuse("not_open" as const));

  return {
    async open() {
      if (opened) return;
      custodyStatus = await custody.status();
      myKey = custodyStatus === "available" ? await custody.publicKey() : null;
      // No silent fallback (M1a.2): a store that cannot open, or held history that fails verification, is
      // history_invalid with its reason. Nothing is deleted or rewritten to recover.
      try {
        await store.open();
        const verdict = await verify(
          store.replicas().map((r) => ({ ...r, profile: store.profile(r.replica) })),
          verifier,
        );
        history = !verdict.ok ? verdict : ports.blockedHistory ?? { ok: true };
      } catch (error) {
        history = { ok: false, replica: null, reason: error instanceof Error ? error.message : String(error) };
      }
      opened = true;
      if (!history.ok) {
        recompute();
        return;
      }
      unsubscribe = [
        store.onChange(() => recompute()),
        link.onState((state) => recompute(state)),
        local.onChange(() => recompute()),
      ];
      recompute(link.state());
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
    postMessage: (thread, text) => signed(() => postMessageCommand(ctx, thread, text)),
    editMessage: (thread, ref, text) => signed(() => editMessageCommand(ctx, thread, ref, text)),
    deleteMessage: (thread, ref) => signed(() => deleteMessageCommand(ctx, thread, ref)),
    removeMessage: (thread, ref) => signed(() => removeMessageCommand(ctx, thread, ref)),
    archiveThread: (thread) => signed(() => archiveThreadCommand(ctx, thread)),
    setPetname: (pubkey, name) => whenOpen(() => localCommands.setPetname(local, pubkey, name)),
    saveDraft: (thread, draft) => whenOpen(() => localCommands.saveDraft(local, thread, draft)),
    markRead: (thread, ids) => whenOpen(() => localCommands.markRead(local, thread, ids)),
    goOnline: () => whenOpen(() => linkCommands.goOnline(linkCtx)),
    goOffline: () => whenOpen(() => linkCommands.goOffline(linkCtx)),
    syncNow: () =>
      whenOpen(async () => {
        const outcome = await linkCommands.syncNow(linkCtx);
        if (outcome.ok) {
          stampSync(outcome.value, true);
          recompute(outcome.value);
        }
        return outcome;
      }),
    foreground: () =>
      whenOpen(async () => {
        const outcome = await linkCommands.foreground(linkCtx);
        if (outcome.ok) {
          stampSync(outcome.value, true);
          recompute(outcome.value);
        }
        return outcome;
      }),
    background: () =>
      whenOpen(async () => {
        const outcome = await linkCommands.background(linkCtx);
        if (outcome.ok) recompute(outcome.value);
        return outcome;
      }),
    exportSpaceFrames: () => whenOpen(() => exportSpaceFramesCommand(store)),
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
