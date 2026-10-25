import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTownshipGenesis,
  authorTreehouseAdmitAndGrant,
  authorTreehouseCatalogBootstrap,
  authorTreehouseContinuationPin,
  authorTreehouseCommand,
  authorTreehouseIssueInvitation,
  authorTreehouseOfflineInvitation,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  decodeTreehouseAcceptance,
  decodeTreehouseJoinRequest,
  decodeTreehouseOffer,
  encodeTreehouseAcceptance,
  encodeTreehouseJoinRequest,
  encodeTreehouseOffer,
  liveTreehouseDelegations,
  memberCapability,
  observeTreehouse,
  prepareTreehouseBoundedSpaceCreation,
  prepareTreehouseBoundedThreadCreation,
  reviewTreehouseCatalogBindingPayload,
  reviewTreehouseInvitation,
  signTreehouseAcceptance,
  townshipReplicaCommitment,
  treehouseContinuationPin,
  treehouseSpaceFamily,
  continuationFamily,
  townshipReplicaRootTag,
  TREEHOUSE_LITE_THREAD_CAP,
  treehouseCommandDecoders,
  treehouseCatalogBootstrapsFromFrames,
  treehouseCommandRoles,
  verifyCarrierOp,
} from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  TreehouseCatalogBindingReview,
  TreehouseCommand,
  Verifier,
} from "@treetopdevs/lattice-client";
import { buildSpaceFramesExport, isExportFileName } from "./space_export";
import { buildOfflineInvitation, reviewOfflineInvitation as decodeOfflineInvitation } from "./offline_enrollment";
import type { OfflineInvitationReview } from "./offline_enrollment";
import {
  assertRetainedMonotonic,
  emptyState,
  parseState,
  byteLength,
  HISTORY_BYTES,
  DRAFT_BYTES,
  JOIN_INTENT_NAME,
  validThreadSetup,
  THREAD_CREATION_RESERVE_BYTES,
} from "./treehouse_state";
import type {
  PreviewNative,
  PreviewState,
  LocalProfile,
  Draft,
  RelayConfig,
  RelayRoute,
  ThreadSetup,
} from "./treehouse_state";
import {
  isProfileReplica,
  mergeRelay,
  offerRoute,
  parseRouteList,
  productOf,
  routesForOffer,
  validateLocalRealm,
} from "./treehouse_routes";

export type Observation = ReturnType<typeof observeTreehouse>;
/** What the person reviews before an offer's routes are persisted (Use, then confirm). */
export interface OfferReview {
  space: string;
  invitationId: string;
  localRealm: string;
  threads: { replica: string; archived: boolean }[];
  routes: RelayRoute[];
  /** True when retained Space frames already prove the invitation (recipient, scope, not revoked). */
  invitationVerified: boolean;
  admitted: boolean;
}
/** What the root reviews before a continuation is pinned (Review, then Pin). Memory only. */
export interface ContinuationReview {
  nominee: string;
  witnesses: string[];
  threshold: number;
  maxLeaseEpochs: number;
}
/** What the root reviews before a catalog binding is signed (Review, then Sign binding). Memory only. */
export interface BindingReview {
  record: Extract<TreehouseCatalogBindingReview, { ok: true }>["record"];
  sha256: string;
  lines: { field: string; value: string }[];
}
/**
 * Row 232: the Space's continuation facts, for the root-only Continuation and Catalog binding actions.
 * "legacy" Spaces were created before bounded continuation and can never carry a catalog binding.
 */
export interface ContinuationFacts {
  family: "none" | "legacy" | "bounded";
  /** This key is the root of a bounded Space, holds its live root capability and the Space is initialized. */
  isRoot: boolean;
  /** A continuation is pinned (an empty-delegation pin carrying the profile is honored). */
  pinned: boolean;
  /** An honored catalog binding is already in the Space; the binding is one-time. */
  bound: boolean;
  /** Admitted member keys other than the root, sorted, for prefilling the review. */
  members: string[];
}
/**
 * Row 199 (D3): every authority fact the shell UI reads, derived once per saved state and read by
 * every `:disabled` binding and by the matching workflow action, so a button and its action never
 * disagree. Recomputed only when the saved state or key availability changes.
 */
export interface WorkflowSnapshot {
  /** The author of the Space's committed genesis, or null before a Space is held. */
  readonly founderKey: string | null;
  /** This key is the founder (founderKey equals the local public key). */
  readonly isFounder: boolean;
  /** This key holds the Space's live, unrevoked root delegation. */
  readonly rootLive: boolean;
  /** `createThread` would pass its authority and route-cap checks. */
  readonly canCreateThread: boolean;
  /** `configureRoutes` would pass its authority check (live root). */
  readonly canConfigureRoutes: boolean;
  /** `issueInvitation` would pass its authority check (an honored `issue_invitation` capability). */
  readonly canIssueInvitation: boolean;
  /** `admitAndGrant` would pass its Space authority check (an honored `admit_member` capability). */
  readonly canAdmit: boolean;
  /** Per held profile replica, the command names this key holds an honored capability for. */
  readonly commands: ReadonlyMap<string, ReadonlySet<string>>;
}
/** The default confirmation threshold: a majority of the witnesses. */
export const defaultThreshold = (witnesses: number): number => Math.floor(witnesses / 2) + 1;
export const DEFAULT_MAX_LEASE_EPOCHS = 7;
const canonicalKey = (text: string): string | null => {
  try {
    const bytes = fromBase64(text);
    return bytes.length === 32 && base64(bytes) === text ? text : null;
  } catch {
    return null;
  }
};
/** Pasted base64 public keys, one per line; blank lines are ignored and any malformed key refuses the whole paste. */
export function parsePublicKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
    const key = canonicalKey(line);
    if (key === null) throw new Error("invalid_public_key");
    keys.push(key);
  }
  return keys;
}
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Strict Ed25519 (no ZIP-215 leniency) over raw bytes: the one signature policy of the shell. */
export const strictEd25519 = (
  signature: Uint8Array,
  bytes: Uint8Array,
  publicKey: Uint8Array,
): boolean => ed25519.verify(signature, bytes, publicKey, { zip215: false });

/** The operation verifier, for base64 public keys as frames carry them. */
export const strictVerifier: Verifier = {
  verify: async (pub, bytes, sig) => strictEd25519(sig, bytes, fromBase64(pub)),
};
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const nonce = () =>
  base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
/** Key-sorted JSON, so byte-equal frames compare equal whatever their property order. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
const frontier = (frames: CarrierOpFrame[]) => {
  const referenced = new Set(frames.flatMap((f) => f.deps));
  return frames
    .filter((f) => !referenced.has(f.id))
    .map((f) => f.id)
    .sort();
};

export class TreehouseWorkflow {
  state = emptyState();
  views = new Map<string, Observation>();
  /** Each verified replica's committed genesis author: the key its #root: commitment names. */
  private roots = new Map<string, string>();
  keyAvailable = false;
  private ownedThreadRoots = new Map<string, string>();
  private threadKeyProblems = new Map<string, string>();
  threadKeyIssue(replica: string) { return this.threadKeyProblems.get(replica) ?? null; }
  /** Reviewed but unconfirmed offer routes. Memory only: Use never persists. */
  private pendingOffer: { review: OfferReview; relay: RelayConfig } | null = null;
  /** Reviewed but unsigned catalog binding payload. Memory only: cancelling or reopening discards it. */
  private pendingContinuation: ContinuationReview | null = null;
  private pendingBinding: { payloadText: string; review: BindingReview } | null = null;
  private pendingRecipient: { recipient: string; state: PreviewState } | null = null;
  private pendingOffline: { review: OfflineInvitationReview; state: PreviewState } | null = null;
  private continuationCache: { state: PreviewState; facts: ContinuationFacts } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** snapshot() cache, keyed on the identity of `state` (replaced on every persist) and `keyAvailable`. */
  private cached: { state: PreviewState; keyAvailable: boolean; facts: WorkflowSnapshot } | null = null;
  constructor(readonly native: PreviewNative) {}
  async open() {
    const captured = await this.native.open();
    const next = parseState(captured.record);
    if (
      captured.keyStatus === "mismatch" ||
      (next.publicKey !== null &&
        captured.publicKey !== null &&
        next.publicKey !== captured.publicKey)
    )
      throw new Error("identity_mismatch");
    if (
      next.publicKey === null &&
      next.intent === null &&
      captured.publicKey !== null
    )
      throw new Error("missing_local_history");
    const views = new Map<string, Observation>();
    for (const profile of next.profiles)
      views.set(
        profile.replica,
        await this.verifyProfile(profile, next.publicKey!),
      );
    this.validateProfiles(next, views);
    this.ownedThreadRoots.clear();
    this.threadKeyProblems.clear();
    if (this.native.threadIdentity && captured.keyStatus === "available") {
      for (const profile of next.profiles.filter((p) => p.product === "Treehouse.Thread" && p.replica.includes("#authority:"))) {
        try {
          const nonce = profile.replica.split(":")[3]!.split("#")[0]!;
          const key = await this.native.threadIdentity(nonce);
          if (key === this.roots.get(profile.replica)) this.ownedThreadRoots.set(profile.replica, key);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!["thread_key_unbound", "thread_key_missing", "thread_key_mismatch", "thread_key_not_in_scope", "key_store_unavailable"].includes(reason)) throw error;
          if (reason !== "thread_key_unbound") this.threadKeyProblems.set(profile.replica, reason === "thread_key_not_in_scope" ? "thread_key_mismatch" : reason);
        }
      }
    }
    this.cached = null;
    this.state = next;
    this.views = views;
    this.pendingOffer = null;
    this.pendingBinding = null;
    this.pendingRecipient = null;
    this.pendingOffline = null;
    this.pendingContinuation = null;
    this.keyAvailable = captured.keyStatus === "available";
    if (
      captured.record !== null &&
      JSON.parse(captured.record).version === 0 &&
      this.keyAvailable
    ) {
      await this.persist(structuredClone(next));
    }
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  private signer() {
    if (!this.state.publicKey || !this.keyAvailable)
      throw new Error("identity_unavailable");
    return {
      publicKey: fromBase64(this.state.publicKey),
      sign: (bytes: Uint8Array) => this.native.sign(bytes),
    };
  }
  private async verifyProfile(
    profile: LocalProfile,
    publicKey: string,
  ): Promise<Observation> {
    const kind = profile.product === "Treehouse.Space" ? "space" : "thread";
    // Row 232 and plan 245 Design E: exactly the legacy grammar OR the bounded grammar of this kind (see treehouse_routes.ts).
    if (!isProfileReplica(kind, profile.replica))
      throw new Error("invalid_profile_replica");
    // Row 258: the authority judge's family must be this profile's own kind. A bounded Space keeps the
    // `treehouseSpaceFamily` check; a bounded Thread is judged by `continuationFamily` ("thread"), never as a Space.
    if (profile.replica.includes("#authority:")) {
      const sound =
        kind === "space"
          ? treehouseSpaceFamily(profile.replica) === "bounded"
          : continuationFamily(profile.replica) === "thread";
      if (!sound) throw new Error("invalid_profile_replica");
    }
    const ids = new Set<string>();
    for (const frame of profile.frames) {
      if (frame.replica !== profile.replica || ids.has(frame.id))
        throw new Error("invalid_retained_history");
      ids.add(frame.id);
      const checked = await verifyCarrierOp(frame, strictVerifier);
      if (!checked.valid) throw new Error("invalid_retained_history");
    }
    if (
      !ids.size ||
      profile.frames.some((f) => f.deps.some((id) => !ids.has(id))) ||
      new Set(profile.outbox).size !== profile.outbox.length ||
      profile.outbox.some((id) => !ids.has(id)) ||
      new Set(profile.acked).size !== profile.acked.length ||
      profile.acked.some((id) => !ids.has(id))
    )
      throw new Error("incomplete_retained_history");
    const ops = carrierOpsToSemanticOps(
      profile.frames,
      {},
      treehouseCommandDecoders(profile.product),
    );
    // The replica's #root: commitment binds it to the genesis author. A joiner holds a
    // foreign-root profile, so the author need not be the local key, but the commitment
    // must match whoever authored the genesis. A relay serves authentic quarantined
    // frames too, so a competing genesis may precede the committed one: select by the
    // commitment, never by position.
    const commitment = townshipReplicaCommitment(profile.replica);
    let root: (typeof ops)[number] | undefined;
    for (const op of ops) {
      if (op.deps.length !== 0 || op.authority?.type !== "genesis") continue;
      const author = profile.frames.find((frame) => frame.id === op.id)?.author;
      if (author !== undefined && commitment === (await townshipReplicaRootTag(author))) {
        root = op;
        break;
      }
    }
    if (!root) throw new Error("wrong_profile_root");
    // The commitment fixes the root for good, so recording it before the remaining checks is safe.
    this.roots.set(profile.replica, profile.frames.find((frame) => frame.id === root.id)!.author);
    const view = observeTreehouse(profile.product, ops);
    if (view.quarantineReasons.has(root.id) || view.order.length !== ids.size)
      throw new Error("invalid_profile_root");
    const creationCommand =
      profile.product === "Treehouse.Space" ? "create_space" : "create_thread";
    if (
      !ops.some(
        (op) =>
          op.kind === "command" &&
          op.command === creationCommand &&
          op.deps.length === 1 &&
          op.deps[0] === root.id &&
          !view.quarantineReasons.has(op.id),
      )
    )
      throw new Error("incomplete_profile_initialization");
    return view;
  }
  private validateProfiles(
    next: PreviewState,
    views: Map<string, Observation>,
  ) {
    const spaces = next.profiles.filter((p) => p.product === "Treehouse.Space");
    if (spaces.length > 1 || (next.profiles.length > 0 && spaces.length !== 1))
      throw new Error("invalid_space_profiles");
    const references = spaces[0]
      ? (views.get(spaces[0].replica)!.state.threads as { replica: string }[])
      : [];
    for (const p of next.profiles.filter(
      (p) => p.product === "Treehouse.Thread",
    )) {
      if (!references.some((r) => r.replica === p.replica))
        throw new Error("unreferenced_local_thread");
    }
  }
  private async persist(
    next: PreviewState,
    changed: LocalProfile[] = [],
    verified = new Map<string, Observation>(),
  ) {
    next.revision = this.state.revision + 1;
    const record = JSON.stringify(next);
    if (byteLength(record) > HISTORY_BYTES)
      throw new Error("preview_storage_limit");
    parseState(record);
    assertRetainedMonotonic(this.state, next);
    const views = new Map(this.views);
    for (const p of changed)
      views.set(
        p.replica,
        verified.get(p.replica) ??
          (await this.verifyProfile(p, next.publicKey!)),
      );
    this.validateProfiles(next, views);
    try {
      if (!(await this.native.commit(this.state.revision, record)))
        throw new Error("stale_saved_state");
    } catch (error) {
      const captured = await this.native.open();
      if (captured.record !== record) throw error;
    }
    this.state = next;
    this.views = views;
    // Any persisted change invalidates an unsigned continuation review.
    this.pendingContinuation = null;
    this.pendingRecipient = null;
    this.pendingOffline = null;
  }
  createSpace(name: string) {
    return this.exclusive(async () => {
      if (this.state.profiles.length) throw new Error("local_space_exists");
      // A key without a Space and without a creation intent only exists after beginJoin.
      if (
        this.state.intent?.kind === "join" ||
        (this.state.intent === null && this.state.publicKey !== null)
      )
        throw new Error("join_in_progress");
      await this.creation("space", name);
    });
  }
  createThread(name: string, setup?: ThreadSetup) {
    const capturedSetup = setup === undefined ? undefined : structuredClone(setup);
    return this.exclusive(async () => {
      if (
        this.state.profiles.filter((p) => p.product === "Treehouse.Thread")
          .length >= 12
      )
        throw new Error("thread_slots_full");
      const space = this.state.profiles.find(
        (p) => p.product === "Treehouse.Space",
      );
      if (!space) throw new Error("space_unavailable");
      // Only the Space's root holder can add a Thread. Refuse before any local Thread is authored.
      const facts = this.snapshot();
      if (!facts.rootLive) throw new Error("root_capability_unavailable");
      // Lite shell: with routes configured, the Space plus three Threads is the whole route set.
      if (!facts.canCreateThread) throw new Error("thread_cap_reached");
      if (capturedSetup !== undefined) {
        if (!validThreadSetup(capturedSetup, this.state.publicKey ?? undefined)) throw new Error("invalid_thread_setup");
        if (this.state.intent === null && byteLength(JSON.stringify(this.state)) + THREAD_CREATION_RESERVE_BYTES > HISTORY_BYTES) throw new Error("preview_storage_limit");
        if (this.state.profiles.filter((p) => p.product === "Treehouse.Thread").length >= TREEHOUSE_LITE_THREAD_CAP) throw new Error("thread_cap_reached");
        if (treehouseSpaceFamily(space.replica) !== "bounded") throw new Error("not_bounded_space");
        if (!this.native.initializeThread || !this.native.signThread) throw new Error("thread_custody_unavailable");
        if (this.state.profiles.some((p) => p.product === "Treehouse.Thread" && !p.replica.includes("#authority:"))) throw new Error("legacy_threads_require_new_space");
        if (!facts.canIssueInvitation || !facts.canAdmit) throw new Error("root_capability_unavailable");
        for (const profile of this.state.profiles.filter((p) => p.product === "Treehouse.Thread")) {
          const existing = liveTreehouseDelegations(profile.product, profile.frames, profile.replica);
          if (!existing.some((d) => d.audience === this.state.publicKey &&
              ["post", "author_edit", "author_tombstone"].every((name) => d.ops.includes(name)))) {
            throw new Error("existing_thread_grant_unavailable");
          }
        }
      }
      await this.creation("thread", name, capturedSetup);
    });
  }
  resumeCreation() {
    const intent = this.state.intent;
    if (!intent) throw new Error("no_incomplete_creation");
    if (intent.kind === "join") return this.beginJoin().then(() => undefined);
    return intent.kind === "space"
      ? this.createSpace(intent.name)
      : this.createThread(intent.name, intent.setup);
  }
  abandonThreadCreation() {
    return this.exclusive(async () => {
      if (this.state.intent?.kind !== "thread" || !this.state.intent.setup) throw new Error("no_incomplete_creation");
      const next = structuredClone(this.state);
      next.intent = null;
      // Native validates missing bound key, no child profile, and no other record changes.
      await this.persist(next);
    });
  }
  private async creation(kind: "space" | "thread", name: string, setup?: ThreadSetup) {
    if (!name.trim() || byteLength(name) > DRAFT_BYTES)
      throw new Error("invalid_name");
    if (this.state.intent === null) {
      await this.persist({
        ...structuredClone(this.state),
        intent: { kind, name, nonce: nonce(), ...(setup === undefined ? {} : { setup }) },
      });
    }
    const intent = this.state.intent!;
    if (intent.kind !== kind || intent.name !== name || canonicalJson(intent.setup ?? null) !== canonicalJson(setup ?? null))
      throw new Error("different_creation_pending");
    if (this.state.publicKey === null) {
      const publicKey = await this.native.initialize();
      await this.persist({ ...structuredClone(this.state), publicKey });
      this.keyAvailable = true;
    }
    const signer = this.signer();
    const nameReplica = `replica:treehouse:${kind}:${intent.nonce}`;
    const next = structuredClone(this.state);
    const changed: LocalProfile[] = [];
    if (kind === "space") {
      // Row 232: new Spaces are bounded-family so the root can later pin a continuation and sign the
      // catalog binding. Threads stay legacy-family.
      const prepared = await prepareTreehouseBoundedSpaceCreation({
        replica: nameReplica,
        name,
        signer,
      });
      changed.push({
        product: "Treehouse.Space",
        replica: prepared.replica,
        frames: prepared.pending,
        outbox: prepared.pending.map((f) => f.id),
        acked: [],
      });
      next.profiles.push(changed[0]!);
      next.active = prepared.replica;
    } else if (intent.setup !== undefined) {
      const publicKey = await this.native.initializeThread!(intent.nonce);
      const childSigner = { publicKey: fromBase64(publicKey), sign: (bytes: Uint8Array) => this.native.signThread!(intent.nonce, bytes) };
      const prepared = await prepareTreehouseBoundedThreadCreation({ replica: nameReplica, title: name,
        signer: childSigner, spaceRoot: this.state.publicKey!, ...intent.setup });
      const profile: LocalProfile = { product: "Treehouse.Thread", replica: prepared.replica,
        frames: prepared.pending, outbox: prepared.pending.map((f) => f.id), acked: [] };
      const space = next.profiles.find((p) => p.product === "Treehouse.Space")!;
      const reference = await this.author(space, { command: "create_thread", title: name, threadReplica: profile.replica });
      space.frames.push(reference); space.outbox.push(reference.id);
      const profiles = [...next.profiles, profile];
      const threadFrames = Object.fromEntries(profiles.filter((p) => p.product === "Treehouse.Thread").map((p) => [p.replica, p.frames]));
      const issued = await authorTreehouseIssueInvitation({ signer, replica: space.replica, frames: space.frames,
        threadFrames, routes: profiles.map((p) => ({ replica: p.replica })), recipient: this.state.publicKey! });
      space.frames.push(issued.frame); space.outbox.push(issued.frame.id);
      const acceptance = await signTreehouseAcceptance({ replica: space.replica, frames: space.frames,
        invitationId: issued.frame.id, signer });
      const authored = await authorTreehouseAdmitAndGrant({ signer, replica: space.replica, frames: space.frames,
        threadFrames, acceptance, threadSigners: { [profile.replica]: childSigner } });
      if (authored.admit) { space.frames.push(authored.admit); space.outbox.push(authored.admit.id); }
      for (const grant of authored.grants) {
        const target = profiles.find((p) => p.replica === grant.replica)!;
        target.frames.push(grant.frame); target.outbox.push(grant.frame.id);
        if (!changed.includes(target)) changed.push(target);
      }
      if (!changed.includes(profile)) changed.push(profile);
      changed.push(space);
      next.profiles.push(profile); next.active = profile.replica;
      // Only publish ownership to the workflow after the history transaction succeeds.
      await this.persistBoundedCreation(next, changed, profile.replica, publicKey);
      return;
    } else {
      const genesis = await authorTownshipGenesis({
        replica: nameReplica,
        signer,
        ops: [...treehouseCommandDecoders("Treehouse.Thread").keys()],
        roles: ["moderator"],
        policies: {},
      });
      const capId = carrierDelegationsFromFrames([genesis])[0]!.id;
      const title = await authorTreehouseCommand({
        product: "Treehouse.Thread",
        replica: genesis.replica,
        signer,
        deps: [genesis.id],
        capId,
        command: { command: "create_thread", title: name },
      });
      const profile: LocalProfile = {
        product: "Treehouse.Thread",
        replica: genesis.replica,
        frames: [genesis, title],
        outbox: [genesis.id, title.id],
        acked: [],
      };
      const space = next.profiles.find((p) => p.product === "Treehouse.Space")!;
      const reference = await this.author(space, {
        command: "create_thread",
        title: name,
        threadReplica: genesis.replica,
      });
      space.frames.push(reference);
      space.outbox.push(reference.id);
      changed.push(profile, space);
      next.profiles.push(profile);
      next.active = profile.replica;
    }
    next.intent = null;
    await this.persist(next, changed);
  }
  private async persistBoundedCreation(next: PreviewState, changed: LocalProfile[], replica: string, publicKey: string) {
    next.intent = null;
    await this.persist(next, changed);
    this.ownedThreadRoots.set(replica, publicKey);
    this.cached = null;
  }
  private rootCapability(profile: LocalProfile, command: string) {
    const key = this.ownedThreadRoots.get(profile.replica) ?? this.state.publicKey;
    if (!key) return null;
    return memberCapability(profile.frames, key, profile.replica, { command, product: profile.product });
  }
  /** Root delegation for the founder, otherwise an honored exact-audience grant that carries `command`. */
  private capabilityFor(profile: LocalProfile, command: string): string | null {
    if (this.state.publicKey === null) return null;
    const member = memberCapability(profile.frames, this.state.publicKey, profile.replica, { command, product: profile.product });
    const participantOnly = profile.product === "Treehouse.Thread" && this.roots.get(profile.replica) !== this.state.publicKey &&
      ["post", "author_edit", "author_tombstone"].includes(command);
    return member?.id ?? (participantOnly ? null : this.rootCapability(profile, command)?.id ?? null);
  }
  /**
   * The founder: the author of the Space's committed genesis, the one its #root: commitment names. A
   * competing genesis a relay serves first is never taken for it. Null before a Space is held.
   */
  founderKey(): string | null {
    return this.snapshot().founderKey;
  }
  /** The authority facts for the current saved state; the same object until the state changes. */
  snapshot(): WorkflowSnapshot {
    const { state, keyAvailable } = this;
    if (this.cached?.state === state && this.cached.keyAvailable === keyAvailable)
      return this.cached.facts;
    // A keyless select() swaps `state` without a revision bump: only a harmless recompute.
    const space = state.profiles.find((p) => p.product === "Treehouse.Space");
    const commands = new Map<string, ReadonlySet<string>>();
    let rootLive = false;
    for (const profile of state.profiles) {
      // One authority pass per profile: the root and every member grant come from the same live list,
      // the predicate `rootCapability` and `memberCapability` apply.
      const live = liveTreehouseDelegations(profile.product, profile.frames, profile.replica);
      const rootKey = this.ownedThreadRoots.get(profile.replica) ?? state.publicKey;
      if (profile === space) rootLive = this.roots.get(profile.replica) === state.publicKey &&
        live.some((d) => d.audience === state.publicKey && d.ops.includes("create_thread") && d.roles.includes("admin"));
      const names = [...treehouseCommandDecoders(profile.product).keys()];
      const mine = live.filter((d) => d.audience === state.publicKey);
      commands.set(
        profile.replica,
        new Set(
          names.filter((command) => {
            const participantOnly = profile.product === "Treehouse.Thread" && this.roots.get(profile.replica) !== state.publicKey &&
              ["post", "author_edit", "author_tombstone"].includes(command);
            const roles = treehouseCommandRoles(profile.product, command);
            const permits = (d: (typeof live)[number]) => d.ops.includes(command) && roles.every((role) => d.roles.includes(role));
            return mine.some(permits) || (!participantOnly && live.some((d) => d.audience === rootKey && permits(d)));
          }),
        ),
      );
    }
    const founderKey = space === undefined ? null : (this.roots.get(space.replica) ?? null);
    const threads =
      space === undefined
        ? []
        : ((this.views.get(space.replica)?.state.threads as unknown[] | undefined) ?? []);
    const spaceCommands = space === undefined ? undefined : commands.get(space.replica);
    const facts: WorkflowSnapshot = {
      founderKey,
      isFounder: founderKey !== null && founderKey === state.publicKey,
      rootLive,
      canCreateThread:
        rootLive && (state.relay === null || threads.length < TREEHOUSE_LITE_THREAD_CAP),
      canConfigureRoutes: rootLive,
      canIssueInvitation: spaceCommands?.has("issue_invitation") ?? false,
      canAdmit: spaceCommands?.has("admit_member") ?? false,
      commands,
    };
    this.cached = { state, keyAvailable, facts };
    return facts;
  }
  /** True when `createThread` would proceed: the Space's live root capability, and room under the route cap. */
  canCreateThread(): boolean {
    return this.snapshot().canCreateThread;
  }
  /**
   * Row 232: the Space's continuation facts, derived once per saved state. Gates the root-only
   * Continuation and Catalog binding actions; the workflow methods below re-check every fact.
   */
  continuation(): ContinuationFacts {
    const { state } = this;
    if (this.continuationCache?.state === state) return this.continuationCache.facts;
    const space = state.profiles.find((p) => p.product === "Treehouse.Space");
    let facts: ContinuationFacts = { family: "none", isRoot: false, pinned: false, bound: false, members: [] };
    if (space !== undefined) {
      const family = treehouseSpaceFamily(space.replica);
      if (family !== "bounded") facts = { ...facts, family: "legacy" };
      else {
        const view = this.views.get(space.replica);
        const bound = view
          ? carrierOpsToSemanticOps(space.frames, {}, treehouseCommandDecoders("Treehouse.Space")).some(
              (op) =>
                op.kind === "command" &&
                op.command === "catalog_bootstrap_v1" &&
                !view.quarantineReasons.has(op.id),
            )
          : false;
        const members = ((view?.state.members as unknown[] | undefined) ?? [])
          .filter((m): m is string => typeof m === "string" && m !== state.publicKey)
          .sort();
        facts = {
          family: "bounded",
          isRoot: this.snapshot().isFounder && this.snapshot().rootLive,
          pinned: treehouseContinuationPin(space.frames).configured,
          bound,
          members,
        };
      }
    }
    this.continuationCache = { state, facts };
    return facts;
  }
  private boundedRootSpace(): LocalProfile {
    const space = this.spaceProfile();
    if (treehouseSpaceFamily(space.replica) !== "bounded") throw new Error("not_bounded_space");
    if (this.state.intent) throw new Error("creation_incomplete");
    if (!this.continuation().isRoot) throw new Error("not_root");
    return space;
  }
  /** Sign one root frame for the Space, persist it into the outbox, and refuse it if the local view refuses it. */
  private async queueSpaceFrame(make: (space: LocalProfile) => Promise<CarrierOpFrame>): Promise<string> {
    const next = structuredClone(this.state);
    const profile = next.profiles.find((p) => p.product === "Treehouse.Space")!;
    const frame = await make(profile);
    profile.frames.push(frame);
    profile.outbox.push(frame.id);
    const view = await this.verifyProfile(profile, this.state.publicKey!);
    const refusal = view.quarantineReasons.get(frame.id);
    if (refusal) throw new Error(refusal);
    await this.persist(next, [profile], new Map([[profile.replica, view]]));
    return frame.id;
  }
  /**
   * Root, Review: validate the nominee, witnesses, threshold and lease bound a person typed or accepted.
   * Pure; nothing is signed or saved. Throws the named refusal.
   */
  reviewContinuation(input: {
    nominee: string;
    witnesses: string;
    threshold?: number | undefined;
    maxLeaseEpochs?: number | undefined;
  }): ContinuationReview {
    this.boundedRootSpace();
    if (this.continuation().pinned) throw new Error("continuation_already_pinned");
    const nomineeKeys = parsePublicKeys(input.nominee);
    if (nomineeKeys.length !== 1) throw new Error("invalid_public_key");
    const witnesses = [...new Set(parsePublicKeys(input.witnesses))];
    if (!witnesses.length) throw new Error("invalid_continuation_profile");
    const nominee = nomineeKeys[0]!;
    const root = this.state.publicKey!;
    if (nominee === root) throw new Error("nominee_is_root");
    if (witnesses.includes(root)) throw new Error("witness_is_root");
    if (witnesses.includes(nominee)) throw new Error("witness_is_nominee");
    const threshold = input.threshold ?? defaultThreshold(witnesses.length);
    const maxLeaseEpochs = input.maxLeaseEpochs ?? DEFAULT_MAX_LEASE_EPOCHS;
    if (
      !Number.isSafeInteger(threshold) ||
      threshold < 1 ||
      threshold > witnesses.length ||
      !Number.isSafeInteger(maxLeaseEpochs) ||
      maxLeaseEpochs < 1 ||
      maxLeaseEpochs > 65_535
    )
      throw new Error("invalid_continuation_profile");
    // Byte order, as the signed pin sorts them, so the review shows the order that is signed.
    const bytes = (key: string) => Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    const byteOrder = (a: string, b: string) => {
      const x = bytes(a), y = bytes(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
      return x.length - y.length;
    };
    const reviewed = { nominee, witnesses: [...witnesses].sort(byteOrder), threshold, maxLeaseEpochs };
    this.pendingContinuation = reviewed;
    return { ...reviewed, witnesses: [...reviewed.witnesses] };
  }
  /** Root, Pin (the explicit confirmation): author the empty-delegation pin and queue it. Never touches the network. */
  pinContinuation(review: ContinuationReview) {
    return this.exclusive(async () => {
      this.boundedRootSpace();
      if (this.continuation().pinned) throw new Error("continuation_already_pinned");
      // Only the parameters this workflow reviewed and showed can be signed.
      const pending = this.pendingContinuation;
      if (pending === null) throw new Error("no_pending_continuation");
      if (JSON.stringify(pending) !== JSON.stringify(review)) throw new Error("continuation_review_mismatch");
      // Sign the workflow's own frozen copy, never the caller's object, which it could still mutate.
      const reviewed = structuredClone(pending);
      return this.queueSpaceFrame((space) =>
        authorTreehouseContinuationPin({
          frames: space.frames,
          signer: this.signer(),
          nominee: reviewed.nominee,
          witnesses: reviewed.witnesses,
          threshold: reviewed.threshold,
          maxLeaseEpochs: reviewed.maxLeaseEpochs,
        }),
      );
    });
  }
  /**
   * Root, Review: strictly review a ceremony `binding-payload.json` against this Space and root. The reviewed
   * payload is kept in memory only until it is signed or cancelled. Throws the named refusal reason.
   */
  reviewCatalogBinding(payloadText: string): Promise<BindingReview> {
    return this.exclusive(async () => {
      const space = this.boundedRootSpace();
      this.pendingBinding = null;
      const reviewed = await reviewTreehouseCatalogBindingPayload({
        payloadText,
        replica: space.replica,
        frames: space.frames,
        rootPublicKey: this.state.publicKey!,
      });
      if (!reviewed.ok) throw new Error(reviewed.reason);
      const review: BindingReview = { record: reviewed.record, sha256: reviewed.sha256, lines: reviewed.lines };
      this.pendingBinding = { payloadText, review };
      return review;
    });
  }
  /** Cancel: discard the reviewed payload. Nothing was signed. */
  cancelCatalogBinding() {
    this.pendingBinding = null;
  }
  hasPendingBinding(): boolean {
    return this.pendingBinding !== null;
  }
  /** Root, Sign binding (the separate explicit confirmation): re-review against the current history, then sign and queue. */
  signCatalogBinding() {
    return this.exclusive(async () => {
      const pending = this.pendingBinding;
      if (!pending) throw new Error("no_pending_binding");
      const space = this.boundedRootSpace();
      const again = await reviewTreehouseCatalogBindingPayload({
        payloadText: pending.payloadText,
        replica: space.replica,
        frames: space.frames,
        rootPublicKey: this.state.publicKey!,
      });
      if (!again.ok) {
        this.pendingBinding = null;
        throw new Error(again.reason);
      }
      const id = await this.queueSpaceFrame((profile) =>
        authorTreehouseCatalogBootstrap({ frames: profile.frames, signer: this.signer(), record: again.record }),
      );
      this.pendingBinding = null;
      return id;
    });
  }
  /**
   * Root only: write the Space's public signed frames to a new file for the catalog ceremony. Sends the native
   * writer only the export text (frames, never the outbox, acknowledgements, state or keys). Resolves to the path.
   */
  exportSpaceFrames(fileName: string): Promise<string> {
    return this.exclusive(async () => {
      const space = this.boundedRootSpace();
      // Before the pin the history has no bounded profile, and `binding-payload` would refuse the file.
      if (!this.continuation().pinned) throw new Error("continuation_not_pinned");
      if (!isExportFileName(fileName)) throw new Error("invalid_export_name");
      const text = await buildSpaceFramesExport({
        space: space.replica,
        rootPublicKey: this.state.publicKey!,
        frames: space.frames,
        verify: async (frame) => (await verifyCarrierOp(frame, strictVerifier)).valid,
      });
      return this.native.exportSpaceFrames(fileName, text);
    });
  }
  /** True when this key holds a capability for `command` in the profile (the Post button's gate). */
  canAuthor(replica: string, command: string): boolean {
    return this.snapshot().commands.get(replica)?.has(command) ?? false;
  }
  private async author(profile: LocalProfile, command: TreehouseCommand) {
    const capId = this.capabilityFor(profile, command.command);
    if (!capId) throw new Error("no_capability");
    return authorTreehouseCommand({
      product: profile.product,
      replica: profile.replica,
      deps: frontier(profile.frames),
      signer: this.signerForCapability(profile, capId),
      capId,
      command,
    });
  }
  private signerForCapability(profile: LocalProfile, capId: string) {
    const cap = liveTreehouseDelegations(profile.product, profile.frames, profile.replica).find((d) => d.id === capId);
    if (cap?.audience === this.state.publicKey) return this.signer();
    const key = this.ownedThreadRoots.get(profile.replica);
    if (!key || cap?.audience !== key || !this.native.signThread) throw new Error("identity_unavailable");
    const nonce = profile.replica.split(":")[3]!.split("#")[0]!;
    return { publicKey: fromBase64(key), sign: (bytes: Uint8Array) => this.native.signThread!(nonce, bytes) };
  }
  command(
    replica: string,
    command: TreehouseCommand,
    clearDraftVersion?: number,
  ) {
    return this.exclusive(async () => {
      if (this.state.intent) throw new Error("creation_incomplete");
      const next = structuredClone(this.state);
      const profile = next.profiles.find(
        (p) => p.replica === replica && p.product === "Treehouse.Thread",
      );
      if (!profile) throw new Error("thread_unavailable");
      if (
        profile.frames.length >= 4_000 ||
        byteLength(JSON.stringify(profile.frames)) >= 8 * 1024 * 1024
      )
        throw new Error("thread_storage_limit");
      const frame = await this.author(profile, command);
      profile.frames.push(frame);
      profile.outbox.push(frame.id);
      const view = await this.verifyProfile(profile, this.state.publicKey!);
      const refusal = view.quarantineReasons.get(frame.id);
      if (refusal) throw new Error(refusal);
      if (clearDraftVersion !== undefined)
        next.clearedDrafts[replica] = clearDraftVersion;
      await this.persist(next, [profile], new Map([[profile.replica, view]]));
      return frame.id;
    });
  }
  // ---- Plan 181 enrollment: Use, Sign and Sync stay separate actions. Nothing here touches the network.
  private spaceProfile(): LocalProfile {
    const space = this.state.profiles.find((p) => p.product === "Treehouse.Space");
    if (!space) throw new Error("space_unavailable");
    return space;
  }
  private threadFrames(): Record<string, CarrierOpFrame[]> {
    return Object.fromEntries(
      this.state.profiles
        .filter((p) => p.product === "Treehouse.Thread")
        .map((p) => [p.replica, p.frames]),
    );
  }
  private archived(replica: string): boolean {
    const view = this.views.get(replica);
    if (!view) throw new Error("thread_not_available");
    return (view.state as { archived?: boolean }).archived === true;
  }
  /** Joiner: the single explicit key creation, then the public join request. Repeating it repeats the request. */
  beginJoin() {
    return this.exclusive(async () => {
      if (this.state.profiles.length) throw new Error("identity_creation_not_allowed");
      if (this.state.intent !== null && this.state.intent.kind !== "join")
        throw new Error("different_creation_pending");
      if (this.state.publicKey === null) {
        if (this.state.intent === null)
          await this.persist({
            ...structuredClone(this.state),
            intent: { kind: "join", name: JOIN_INTENT_NAME, nonce: nonce() },
          });
        const publicKey = await this.native.initialize();
        // The key commit clears the join intent: reopening never mints a second key.
        await this.persist({ ...structuredClone(this.state), publicKey, intent: null });
        this.keyAvailable = true;
      }
      if (!this.keyAvailable) throw new Error("identity_unavailable");
      return encodeTreehouseJoinRequest({ publicKey: this.state.publicKey! });
    });
  }
  /** Founder: hand-configured route list (JSON). A saved relay is extended, never replaced. */
  configureRoutes(routeList: string) {
    return this.exclusive(async () => {
      const config = parseRouteList(routeList);
      if (this.state.intent) throw new Error("creation_incomplete");
      this.spaceProfile();
      if (!this.snapshot().canConfigureRoutes) throw new Error("root_capability_unavailable");
      const known = new Set(this.state.profiles.map((p) => p.replica));
      if (config.routes.some((r) => !known.has(r.replica)))
        throw new Error("unknown_route_replica");
      const merged = mergeRelay(this.state.relay, config);
      if (merged === null) return;
      await this.persist({ ...structuredClone(this.state), relay: merged });
    });
  }
  /** Recipient key is reviewed separately from the joiner's group fingerprint. No signature or write. */
  reviewOfflineRecipient(joinRequest: string) {
    return this.exclusive(async () => {
      this.pendingRecipient = null;
      if (this.state.intent) throw new Error("creation_incomplete");
      if (!this.snapshot().canIssueInvitation) throw new Error("no_capability");
      const { publicKey: recipient } = decodeTreehouseJoinRequest(joinRequest);
      const space = this.spaceProfile();
      const bootstraps = await treehouseCatalogBootstrapsFromFrames({ replica: space.replica, frames: space.frames });
      if (!bootstraps.ok || bootstraps.bootstraps.length !== 1) throw new Error("offline_bootstrap_required");
      this.pendingRecipient = { recipient, state: this.state };
      return { recipient };
    });
  }
  cancelOfflineReview() { this.pendingRecipient = null; this.pendingOffline = null; }
  private async offlineStateCurrent(state: PreviewState) {
    const captured = await this.native.open();
    if (state !== this.state || captured.keyStatus !== "available" || captured.publicKey !== this.state.publicKey ||
      JSON.stringify(parseState(captured.record)) !== JSON.stringify(this.state)) throw new Error("stale_offline_review");
  }
  /** Explicit founder confirmation of the independently compared recipient key. Routes are not needed. */
  issueOfflineInvitation(confirmedRecipient: string) {
    return this.exclusive(async () => {
      const pending = this.pendingRecipient;
      if (!pending || pending.recipient !== confirmedRecipient) throw new Error("no_pending_offline_review");
      await this.offlineStateCurrent(pending.state);
      const space = this.spaceProfile();
      const existing = carrierOpsToSemanticOps(space.frames, {}, treehouseCommandDecoders("Treehouse.Space"))
        .filter(op => op.kind === "command" && op.command === "issue_invitation" && op.commandArgs?.[0] === pending.recipient)
        .map(op => reviewTreehouseInvitation({ replica: space.replica, frames: space.frames, invitationId: op.id, recipient: pending.recipient }))
        .find(review => review.ok);
      if (existing?.ok) {
        const held = new Set(this.state.profiles.map(profile => profile.replica));
        if (existing.threads.some(replica => !held.has(replica))) throw new Error("thread_scope_not_held");
        const text = await buildOfflineInvitation({ space: space.replica, frames: space.frames, invitationId: existing.invitationId, recipient: pending.recipient });
        this.pendingRecipient = null;
        return text;
      }
      const authored = await authorTreehouseOfflineInvitation({ signer: this.signer(), replica: space.replica,
        frames: space.frames, threadFrames: this.threadFrames(), heldReplicas: this.state.profiles.map(profile => profile.replica), recipient: pending.recipient });
      const text = await buildOfflineInvitation({ space: space.replica, frames: [...space.frames, authored.frame], invitationId: authored.frame.id, recipient: pending.recipient });
      const next = structuredClone(this.state);
      const target = next.profiles.find(profile => profile.replica === space.replica)!;
      target.frames.push(authored.frame); target.outbox.push(authored.frame.id);
      await this.persist(next, [target]);
      return text;
    });
  }
  /** Joiner candidate review is memory-only. Neither Space history nor routes enter PreviewState. */
  reviewOfflineInvitation(bytes: Uint8Array) {
    return this.exclusive(async () => {
      this.pendingOffline = null;
      if (this.state.intent) throw new Error("creation_incomplete");
      if (!this.state.publicKey || this.state.profiles.length) throw new Error("offline_join_not_available");
      const review = await decodeOfflineInvitation(bytes, this.state.publicKey);
      this.pendingOffline = { review, state: this.state };
      return structuredClone(review);
    });
  }
  /** Explicit out-of-band group fingerprint confirmation precedes the recipient-bound signature. */
  acceptOfflineInvitation(confirmedFingerprint: string) {
    return this.exclusive(async () => {
      const pending = this.pendingOffline;
      if (!pending || pending.review.fingerprint !== confirmedFingerprint) throw new Error("no_pending_offline_review");
      await this.offlineStateCurrent(pending.state);
      const acceptance = await signTreehouseAcceptance({ replica: pending.review.space, frames: pending.review.frames,
        invitationId: pending.review.invitationId, signer: this.signer() });
      this.pendingOffline = null;
      return encodeTreehouseAcceptance(acceptance);
    });
  }
  /** Founder: sign an `issue_invitation` over the full honored Thread scope and return the offer text. */
  issueInvitation(joinRequest: string, joinerRealm: string) {
    return this.exclusive(async () => {
      const { publicKey: recipient } = decodeTreehouseJoinRequest(joinRequest);
      const localRealm = validateLocalRealm(joinerRealm);
      if (this.state.intent) throw new Error("creation_incomplete");
      const space = this.spaceProfile();
      const relay = this.state.relay;
      if (relay === null || !relay.routes.some((r) => r.replica === space.replica))
        throw new Error("routes_not_configured");
      // Both the reuse and the authoring path need the issue_invitation capability.
      if (!this.snapshot().canIssueInvitation) throw new Error("no_capability");
      // An honored, unrevoked invitation for this recipient with a current scope is reused.
      const existing = carrierOpsToSemanticOps(
        space.frames,
        {},
        treehouseCommandDecoders("Treehouse.Space"),
      )
        .filter(
          (op) =>
            op.kind === "command" &&
            op.command === "issue_invitation" &&
            op.commandArgs?.[0] === recipient,
        )
        .map((op) =>
          reviewTreehouseInvitation({
            replica: space.replica,
            frames: space.frames,
            invitationId: op.id,
            recipient,
          }),
        )
        .find((review) => review.ok);
      let invitationId: string;
      let threads: { replica: string; archived: boolean }[];
      if (existing && existing.ok) {
        const routed = new Set(relay.routes.map((r) => r.replica));
        if (
          existing.threads.length > TREEHOUSE_LITE_THREAD_CAP ||
          existing.threads.some((replica) => !routed.has(replica))
        )
          throw new Error("thread_scope_exceeds_routes");
        invitationId = existing.invitationId;
        threads = existing.threads.map((replica) => ({
          replica,
          archived: this.archived(replica),
        }));
      } else {
        const authored = await authorTreehouseIssueInvitation({
          signer: this.signer(),
          replica: space.replica,
          frames: space.frames,
          threadFrames: this.threadFrames(),
          routes: relay.routes,
          recipient,
        });
        const next = structuredClone(this.state);
        const target = next.profiles.find((p) => p.replica === space.replica)!;
        target.frames.push(authored.frame);
        target.outbox.push(authored.frame.id);
        await this.persist(next, [target]);
        invitationId = authored.frame.id;
        threads = authored.threads;
      }
      const inScope = new Set([space.replica, ...threads.map((t) => t.replica)]);
      return encodeTreehouseOffer({
        space: space.replica,
        invitationId,
        localRealm,
        routes: relay.routes.filter((r) => inScope.has(r.replica)).map(offerRoute),
        threads,
      });
    });
  }
  /** Joiner, Use: decode and review an offer. Nothing is persisted until confirmOffer. */
  useOffer(offerText: string) {
    return this.exclusive(async (): Promise<OfferReview> => {
      const offer = decodeTreehouseOffer(offerText);
      if (this.state.publicKey === null) throw new Error("join_not_begun");
      if (this.state.intent) throw new Error("creation_incomplete");
      const held = this.state.profiles.find((p) => p.product === "Treehouse.Space");
      if (held && held.replica !== offer.space) throw new Error("wrong_replica");
      const localRealm = validateLocalRealm(offer.localRealm);
      const routes = routesForOffer(offer.routes, {
        space: offer.space,
        threads: offer.threads.map((t) => t.replica),
      });
      let invitationVerified = false;
      let admitted = false;
      if (held) {
        const checked = reviewTreehouseInvitation({
          replica: held.replica,
          frames: held.frames,
          invitationId: offer.invitationId,
          recipient: this.state.publicKey,
          offerThreads: offer.threads.map((t) => t.replica),
        });
        if (!checked.ok) throw new Error(checked.reason);
        invitationVerified = true;
        admitted = checked.admitted;
      }
      const review: OfferReview = {
        space: offer.space,
        invitationId: offer.invitationId,
        localRealm,
        threads: offer.threads,
        routes,
        invitationVerified,
        admitted,
      };
      this.pendingOffer = { review, relay: { localRealm, routes } };
      return review;
    });
  }
  /** Joiner, confirm: persist the reviewed routes. Confirming the same offer again changes nothing. */
  confirmOffer() {
    return this.exclusive(async () => {
      const pending = this.pendingOffer;
      if (!pending) throw new Error("no_pending_offer");
      const merged = mergeRelay(this.state.relay, pending.relay);
      if (merged !== null) await this.persist({ ...structuredClone(this.state), relay: merged });
      this.pendingOffer = null;
    });
  }
  /** Joiner, Sign: review the invitation against the pulled Space, then sign the recipient-bound acceptance. */
  acceptInvitation(offerText: string) {
    return this.exclusive(async () => {
      const offer = decodeTreehouseOffer(offerText);
      const scope = offer.threads.map((t) => t.replica);
      const routes = routesForOffer(offer.routes, { space: offer.space, threads: scope });
      if (this.state.intent) throw new Error("creation_incomplete");
      const space = this.spaceProfile();
      const checked = reviewTreehouseInvitation({
        replica: space.replica,
        frames: space.frames,
        invitationId: offer.invitationId,
        recipient: this.state.publicKey ?? "",
        offerThreads: scope,
      });
      if (!checked.ok) throw new Error(checked.reason);
      const relay = this.state.relay;
      if (
        space.replica !== offer.space ||
        relay === null ||
        relay.localRealm !== offer.localRealm ||
        routes.some((r) => !relay.routes.some((c) => JSON.stringify(c) === JSON.stringify(r)))
      )
        throw new Error("offer_not_confirmed");
      return encodeTreehouseAcceptance(
        await signTreehouseAcceptance({
          replica: space.replica,
          frames: space.frames,
          invitationId: offer.invitationId,
          signer: this.signer(),
        }),
      );
    });
  }
  /**
   * Founder: admit the recipient and grant exact-audience Thread capabilities for the whole signed scope,
   * persisted as one commit. Replaying the same acceptance authors and persists nothing. Like its button, it
   * needs an honored `admit_member` capability even for an acceptance already admitted (row 199).
   */
  admitAndGrant(acceptanceText: string) {
    return this.exclusive(async () => {
      const acceptance = decodeTreehouseAcceptance(acceptanceText);
      if (this.state.intent) throw new Error("creation_incomplete");
      const space = this.spaceProfile();
      if (!this.snapshot().canAdmit) throw new Error("no_capability");
      const invitation = reviewTreehouseInvitation({ replica: space.replica, frames: space.frames,
        invitationId: acceptance.invitationId, recipient: acceptance.recipient });
      if (!invitation.ok) throw new Error(invitation.reason);
      const threadSigners: Record<string, ReturnType<TreehouseWorkflow["signer"]>> = {};
      for (const profile of this.state.profiles.filter((p) => invitation.threads.includes(p.replica) && p.replica.includes("#authority:"))) {
        const complete = liveTreehouseDelegations(profile.product, profile.frames, profile.replica).some((d) =>
          d.audience === acceptance.recipient && ["post", "author_edit", "author_tombstone"].every((op) => d.ops.includes(op)));
        const key = this.ownedThreadRoots.get(profile.replica);
        if (!key || !this.native.signThread) {
          if (!complete) throw new Error("thread_key_unavailable");
          continue;
        }
        const nonce = profile.replica.split(":")[3]!.split("#")[0]!;
        threadSigners[profile.replica] = { publicKey: fromBase64(key), sign: (bytes) => this.native.signThread!(nonce, bytes) };
      }
      const authored = await authorTreehouseAdmitAndGrant({
        signer: this.signer(),
        replica: space.replica,
        frames: space.frames,
        threadFrames: this.threadFrames(),
        acceptance,
        threadSigners,
      });
      if (authored.admit === null && authored.grants.length === 0)
        return { admit: null, grants: [] as string[] };
      const next = structuredClone(this.state);
      const changed: LocalProfile[] = [];
      if (authored.admit) {
        const target = next.profiles.find((p) => p.replica === space.replica)!;
        target.frames.push(authored.admit);
        target.outbox.push(authored.admit.id);
        changed.push(target);
      }
      for (const grant of authored.grants) {
        const target = next.profiles.find((p) => p.replica === grant.replica)!;
        target.frames.push(grant.frame);
        target.outbox.push(grant.frame.id);
        changed.push(target);
      }
      await this.persist(next, changed);
      return {
        admit: authored.admit?.id ?? null,
        grants: authored.grants.map((g) => g.frame.id),
      };
    });
  }
  /**
   * Plan 181 slice 3: merge a verified relay pull and relay acknowledgements in one CAS commit. Pulled
   * frames are retained and acked together; `ackedIds` may name only retained ids this device authored.
   * Nothing is written when the merge adds nothing. A pull that fails `verifyProfile` (a missing
   * dependency, a bad root, a Thread the Space does not reference) writes nothing. This runs on the
   * same queue as every other writer, so a hint-triggered pull cannot race a user post.
   */
  mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]) {
    return this.exclusive(async () => {
      if (this.state.publicKey === null || !this.keyAvailable)
        throw new Error("identity_unavailable");
      if (this.state.intent) throw new Error("creation_incomplete");
      if (!this.state.relay?.routes.some((r) => r.replica === replica))
        throw new Error("unknown_route_replica");
      const next = structuredClone(this.state);
      let profile = next.profiles.find((p) => p.replica === replica);
      const created = profile === undefined;
      if (!profile) {
        profile = {
          product: productOf(replica),
          replica,
          frames: [],
          outbox: [],
          acked: [],
        };
        next.profiles.push(profile);
      }
      const held = new Map(profile.frames.map((f) => [f.id, f]));
      const acked = new Set(profile.acked);
      let added = 0;
      let newlyAcked = 0;
      for (const frame of pulled) {
        if (frame.replica !== replica) throw new Error("wrong_replica");
        const have = held.get(frame.id);
        if (have) {
          if (canonicalJson(have) !== canonicalJson(frame))
            throw new Error("frame_conflict");
        } else {
          const copy = structuredClone(frame);
          profile.frames.push(copy);
          held.set(copy.id, copy);
          added++;
        }
        if (!acked.has(frame.id)) {
          acked.add(frame.id);
          profile.acked.push(frame.id);
          newlyAcked++;
        }
      }
      for (const id of ackedIds) {
        if (!held.has(id) || !profile.outbox.includes(id))
          throw new Error("unknown_ack");
        if (!acked.has(id)) {
          acked.add(id);
          profile.acked.push(id);
          newlyAcked++;
        }
      }
      if (!created && added === 0 && newlyAcked === 0) return { added, acked: 0 };
      if (profile.product === "Treehouse.Thread" && next.active === null)
        next.active = replica;
      await this.persist(next, [profile]);
      return { added, acked: newlyAcked };
    });
  }
  select(replica: string) {
    return this.exclusive(async () => {
      if (!this.state.profiles.some((p) => p.replica === replica))
        throw new Error("unknown_profile");
      if (!this.keyAvailable) {
        this.state = { ...this.state, active: replica };
        return;
      }
      await this.persist({ ...structuredClone(this.state), active: replica });
    });
  }
  async draft(replica: string): Promise<Draft> {
    const saved = (await this.native.loadDraft(replica)) ?? {
      version: 1,
      revision: 0,
      text: "",
    };
    return {
      ...saved,
      text:
        saved.revision <= (this.state.clearedDrafts[replica] ?? -1)
          ? ""
          : saved.text,
    };
  }
  async saveDraft(
    replica: string,
    expectedRevision: number,
    text: string,
  ): Promise<Draft> {
    if (byteLength(text) > DRAFT_BYTES) throw new Error("draft_too_large");
    const saved = await this.native.saveDraft(replica, expectedRevision, text);
    if (!saved) throw new Error("draft_changed_in_another_window");
    return saved;
  }
}
