// The LocalStore port (03, 07 M1a.3): device-local facts only. Petnames, drafts, read markers and settings
// live here, never in the replica store and never in a signed op; other members do not see them. First-seen
// times are not held here: ReplicaStore owns them (03). This file imports nothing outside src/local, so the
// session can hold a LocalStore without reaching signing, codecs or frames.

/** A message by lineage: the root post id plus the latest edit id (02). `author_edit` needs both. */
export interface MessageRef {
  root: string;
  latest: string;
}

/** Unsent text for one Thread; `editOf` is set when the draft edits an existing message. */
export interface Draft {
  text: string;
  editOf?: MessageRef;
}

/** Device settings. `syncEnabled: false` is the person turning sync off (the Offline pill in 03). */
export interface Settings {
  syncEnabled: boolean;
  /**
   * Which replica store each key opens, by public key (M1a.7): 0 is the first; a re-sync after history_invalid
   * moves one key to a fresh store and never touches the old one. Device-local, never part of a signed op.
   */
  replicaStoreEpochs: Readonly<Record<string, number>>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ syncEnabled: true, replicaStoreEpochs: Object.freeze({}) });

export type LocalKind = "petname" | "draft" | "read" | "setting";

export interface LocalStore {
  petname(pubkey: string): string | null;
  setPetname(pubkey: string, name: string | null): Promise<void>;
  draft(thread: string): Draft | null;
  saveDraft(thread: string, draft: Draft | null): Promise<void>;
  readIds(thread: string): ReadonlySet<string>;
  markRead(thread: string, ids: readonly string[]): Promise<void>;
  setting<K extends keyof Settings>(key: K): Settings[K];
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
  onChange(listener: (kind: LocalKind) => void): () => void;
}

export const PETNAME_MAX = 40;

/** Trims and caps a petname at 40 code points (never splitting a surrogate pair); blank clears it. */
export function normalizePetname(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const points = Array.from(trimmed);
  return points.length > PETNAME_MAX ? points.slice(0, PETNAME_MAX).join("").trimEnd() : trimmed;
}

function normalizeDraft(draft: Draft | null): Draft | null {
  if (draft === null) return null;
  const out: Draft = { text: String(draft.text) };
  if (draft.editOf) out.editOf = { root: draft.editOf.root, latest: draft.editOf.latest };
  return out;
}

const sameDraft = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

/** Everything a LocalStore holds, as loaded from its durable backend on open. */
export interface LocalSnapshot {
  petnames: Record<string, string>;
  drafts: Record<string, Draft>;
  read: Record<string, string[]>;
  settings: Partial<Settings>;
}

/** The durable side of a LocalStore. Each method is one write; it resolves only once the write is durable. */
export interface LocalBackend {
  putPetname(pubkey: string, name: string | null): Promise<void>;
  putDraft(thread: string, draft: Draft | null): Promise<void>;
  /** Adds ids (all new to this thread) to its read marker. */
  addRead(thread: string, ids: string[]): Promise<void>;
  putSetting(key: keyof Settings, value: Settings[keyof Settings]): Promise<void>;
}

/**
 * Synchronous reads over an in-memory cache, writes serialised through one queue so saves land in call order.
 * Each write is durable before the cache changes and listeners fire; an unchanged value writes nothing.
 * Read sets are replaced, never mutated, so a caller can compare them by identity.
 */
export function createCachedLocalStore(snapshot: LocalSnapshot, backend: LocalBackend): LocalStore {
  const petnames = new Map(Object.entries(snapshot.petnames));
  const drafts = new Map(Object.entries(snapshot.drafts).map(([t, d]) => [t, normalizeDraft(d)!]));
  const read = new Map<string, ReadonlySet<string>>(Object.entries(snapshot.read).map(([t, ids]) => [t, new Set(ids)]));
  const settings: Settings = { ...DEFAULT_SETTINGS, ...snapshot.settings };
  const listeners = new Set<(kind: LocalKind) => void>();
  const EMPTY: ReadonlySet<string> = new Set();
  let queue: Promise<unknown> = Promise.resolve();

  function write(kind: LocalKind, step: () => Promise<boolean>): Promise<void> {
    const run = queue.then(step);
    queue = run.catch(() => undefined);
    return run.then((changed) => {
      if (changed) for (const listener of [...listeners]) listener(kind);
    });
  }

  return {
    petname: (pubkey) => petnames.get(pubkey) ?? null,
    setPetname(pubkey, name) {
      return write("petname", async () => {
        const next = normalizePetname(name);
        if ((petnames.get(pubkey) ?? null) === next) return false;
        await backend.putPetname(pubkey, next);
        if (next === null) petnames.delete(pubkey);
        else petnames.set(pubkey, next);
        return true;
      });
    },
    draft(thread) {
      const draft = drafts.get(thread);
      return draft ? normalizeDraft(draft) : null;
    },
    saveDraft(thread, draft) {
      return write("draft", async () => {
        const next = normalizeDraft(draft);
        if (sameDraft(drafts.get(thread) ?? null, next)) return false;
        await backend.putDraft(thread, next);
        if (next === null) drafts.delete(thread);
        else drafts.set(thread, next);
        return true;
      });
    },
    readIds: (thread) => read.get(thread) ?? EMPTY,
    markRead(thread, ids) {
      return write("read", async () => {
        const current = read.get(thread) ?? EMPTY;
        const fresh = [...new Set(ids)].filter((id) => !current.has(id));
        if (fresh.length === 0) return false;
        await backend.addRead(thread, fresh);
        read.set(thread, new Set([...current, ...fresh]));
        return true;
      });
    },
    setting: (key) => settings[key],
    setSetting(key, value) {
      return write("setting", async () => {
        if (settings[key] === value) return false;
        await backend.putSetting(key, value);
        settings[key] = value;
        return true;
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Durable state shared by every memory LocalStore opened on it, so a test can reopen over the same "disk". */
export class MemoryLocalDisk {
  snapshot: LocalSnapshot = { petnames: {}, drafts: {}, read: {}, settings: {} };
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The in-memory adapter, used by Core tests. */
export async function openMemoryLocalStore(disk: MemoryLocalDisk = new MemoryLocalDisk()): Promise<LocalStore> {
  const backend: LocalBackend = {
    async putPetname(pubkey, name) {
      const petnames = { ...disk.snapshot.petnames };
      if (name === null) delete petnames[pubkey];
      else petnames[pubkey] = name;
      disk.snapshot = { ...disk.snapshot, petnames };
    },
    async putDraft(thread, draft) {
      const drafts = { ...disk.snapshot.drafts };
      if (draft === null) delete drafts[thread];
      else drafts[thread] = copy(draft);
      disk.snapshot = { ...disk.snapshot, drafts };
    },
    async addRead(thread, ids) {
      const read = { ...disk.snapshot.read, [thread]: [...(disk.snapshot.read[thread] ?? []), ...ids] };
      disk.snapshot = { ...disk.snapshot, read };
    },
    async putSetting(key, value) {
      disk.snapshot = { ...disk.snapshot, settings: { ...disk.snapshot.settings, [key]: value } };
    },
  };
  return createCachedLocalStore(copy(disk.snapshot), backend);
}
