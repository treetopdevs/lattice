import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTownshipGenesis,
  authorTreehouseCommand,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  observeTreehouse,
  prepareTreehouseSpaceCreation,
  treehouseCommandDecoders,
  verifyCarrierOp,
} from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  TreehouseCommand,
} from "@treetopdevs/lattice-client";
import {
  emptyState,
  parseState,
  byteLength,
  HISTORY_BYTES,
  DRAFT_BYTES,
} from "./treehouse_state";
import type {
  PreviewNative,
  PreviewState,
  LocalProfile,
  Draft,
} from "./treehouse_state";

export type Observation = ReturnType<typeof observeTreehouse>;
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const nonce = () =>
  base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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
      const checked = await verifyCarrierOp(frame, {
        verify: async (pub, bytes, sig) =>
          ed25519.verify(sig, bytes, fromBase64(pub), { zip215: false }),
      });
      if (!checked.valid) throw new Error("invalid_retained_history");
    }
    if (
      !ids.size ||
      profile.frames.some((f) => f.deps.some((id) => !ids.has(id))) ||
      new Set(profile.outbox).size !== profile.outbox.length ||
      profile.outbox.some((id) => !ids.has(id))
    )
      throw new Error("incomplete_retained_history");
    const ops = carrierOpsToSemanticOps(
      profile.frames,
      {},
      treehouseCommandDecoders(profile.product),
    );
    const root = ops.find(
      (op) => op.deps.length === 0 && op.authority?.type === "genesis",
    );
    if (
      !root ||
      profile.frames.find((frame) => frame.id === root.id)?.author !== publicKey
    )
      throw new Error("wrong_profile_root");
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
      if (!this.state.profiles.some((p) => p.product === "Treehouse.Space"))
        throw new Error("space_unavailable");
      await this.creation("thread", name);
    });
  }
  resumeCreation() {
    const intent = this.state.intent;
    if (!intent) throw new Error("no_incomplete_creation");
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
  private async author(profile: LocalProfile, command: TreehouseCommand) {
    const capId = carrierDelegationsFromFrames(profile.frames).find(
      (d) => d.issuer === this.state.publicKey && d.parent_id === null,
    )?.id;
    if (!capId) throw new Error("root_capability_unavailable");
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
