import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTownshipGenesis,
  authorTreehouseAdmitAndGrant,
  authorTreehouseCommand,
  authorTreehouseIssueInvitation,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  decodeTreehouseAcceptance,
  decodeTreehouseJoinRequest,
  decodeTreehouseOffer,
  encodeTreehouseAcceptance,
  encodeTreehouseJoinRequest,
  encodeTreehouseOffer,
  memberCapability,
  observeTreehouse,
  prepareTreehouseSpaceCreation,
  reviewTreehouseInvitation,
  signTreehouseAcceptance,
  townshipReplicaCommitment,
  townshipReplicaRootTag,
  TREEHOUSE_LITE_THREAD_CAP,
  treehouseCommandDecoders,
  verifyCarrierOp,
} from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  TreehouseCommand,
  Verifier,
} from "@treetopdevs/lattice-client";
import {
  assertRetainedMonotonic,
  emptyState,
  parseState,
  byteLength,
  HISTORY_BYTES,
  DRAFT_BYTES,
  JOIN_INTENT_NAME,
} from "./treehouse_state";
import type {
  PreviewNative,
  PreviewState,
  LocalProfile,
  Draft,
  RelayConfig,
  RelayRoute,
} from "./treehouse_state";
import {
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
  keyAvailable = false;
  /** Reviewed but unconfirmed offer routes. Memory only: Use never persists. */
  private pendingOffer: { review: OfferReview; relay: RelayConfig } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
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
    this.state = next;
    this.views = views;
    this.pendingOffer = null;
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
    if (
      !new RegExp(
        `^replica:treehouse:${kind}:[A-Za-z0-9_-]{43}#root:[A-Za-z0-9_-]{43}$`,
      ).test(profile.replica)
    )
      throw new Error("invalid_profile_replica");
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
  createThread(name: string) {
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
      if (!this.rootCapability(space)) throw new Error("root_capability_unavailable");
      // Lite shell: with routes configured, the Space plus three Threads is the whole route set.
      if (
        this.state.relay !== null &&
        (this.views.get(space.replica)!.state.threads as unknown[]).length >=
          TREEHOUSE_LITE_THREAD_CAP
      )
        throw new Error("thread_cap_reached");
      await this.creation("thread", name);
    });
  }
  resumeCreation() {
    const intent = this.state.intent;
    if (!intent) throw new Error("no_incomplete_creation");
    if (intent.kind === "join") return this.beginJoin().then(() => undefined);
    return intent.kind === "space"
      ? this.createSpace(intent.name)
      : this.createThread(intent.name);
  }
  private async creation(kind: "space" | "thread", name: string) {
    if (!name.trim() || byteLength(name) > DRAFT_BYTES)
      throw new Error("invalid_name");
    if (this.state.intent === null) {
      await this.persist({
        ...structuredClone(this.state),
        intent: { kind, name, nonce: nonce() },
      });
    }
    const intent = this.state.intent!;
    if (intent.kind !== kind || intent.name !== name)
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
      const prepared = await prepareTreehouseSpaceCreation({
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
  /** The local key's own root delegation, if it authored one in this profile. */
  private rootCapability(profile: LocalProfile) {
    return carrierDelegationsFromFrames(profile.frames).find(
      (d) => d.issuer === this.state.publicKey && d.parent_id === null,
    );
  }
  /** Root delegation for the founder, otherwise an honored exact-audience grant that carries `command`. */
  private capabilityFor(profile: LocalProfile, command: string): string | null {
    const root = this.rootCapability(profile);
    if (root) return root.id;
    if (this.state.publicKey === null) return null;
    return (
      memberCapability(profile.frames, this.state.publicKey, profile.replica, {
        command,
        product: profile.product,
      })?.id ?? null
    );
  }
  /** True when this key holds a capability for `command` in the profile (the Post button's gate). */
  canAuthor(replica: string, command: string): boolean {
    const profile = this.state.profiles.find((p) => p.replica === replica);
    return profile !== undefined && this.capabilityFor(profile, command) !== null;
  }
  private async author(profile: LocalProfile, command: TreehouseCommand) {
    const capId = this.capabilityFor(profile, command.command);
    if (!capId) throw new Error("no_capability");
    return authorTreehouseCommand({
      product: profile.product,
      replica: profile.replica,
      deps: frontier(profile.frames),
      signer: this.signer(),
      capId,
      command,
    });
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
      const space = this.spaceProfile();
      if (!this.rootCapability(space)) throw new Error("root_capability_unavailable");
      const known = new Set(this.state.profiles.map((p) => p.replica));
      if (config.routes.some((r) => !known.has(r.replica)))
        throw new Error("unknown_route_replica");
      const merged = mergeRelay(this.state.relay, config);
      if (merged === null) return;
      await this.persist({ ...structuredClone(this.state), relay: merged });
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
   * persisted as one commit. Replaying the same acceptance authors and persists nothing.
   */
  admitAndGrant(acceptanceText: string) {
    return this.exclusive(async () => {
      const acceptance = decodeTreehouseAcceptance(acceptanceText);
      if (this.state.intent) throw new Error("creation_incomplete");
      const space = this.spaceProfile();
      const authored = await authorTreehouseAdmitAndGrant({
        signer: this.signer(),
        replica: space.replica,
        frames: space.frames,
        threadFrames: this.threadFrames(),
        acceptance,
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
