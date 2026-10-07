import type {
  CarrierOpFrame,
  TreehouseProduct,
} from "@treetopdevs/lattice-client";

/** Preview envelope only; this is not the per-Thread pilot capacity claim. */
export const HISTORY_BYTES = 1_048_576;
export const DRAFT_BYTES = 16_384;
/** One Space route plus at most three Thread routes (plan 181 decision 4). */
export const MAX_ROUTES = 4;
/** The join intent carries no user text; this constant satisfies the non-empty name rule. */
export const JOIN_INTENT_NAME = "join";
export interface LocalProfile {
  product: TreehouseProduct;
  replica: string;
  frames: CarrierOpFrame[];
  /** Ids this device authored. Never shrinks. */
  outbox: string[];
  /** Ids known durable on the relay. Grows only; a subset of the retained frame ids. */
  acked: string[];
}
export interface CreationIntent {
  kind: "space" | "thread" | "join";
  name: string;
  nonce: string;
}
export interface RelayRoute {
  replica: string;
  url: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
}
export interface RelayConfig {
  localRealm: string;
  routes: RelayRoute[];
}
export interface PreviewState {
  version: 2;
  product: "treehouse";
  revision: number;
  publicKey: string | null;
  profiles: LocalProfile[];
  active: string | null;
  intent: CreationIntent | null;
  clearedDrafts: Record<string, number>;
  relay: RelayConfig | null;
}
export interface Draft {
  version: 1;
  revision: number;
  text: string;
}
export interface OpenResult {
  record: string | null;
  publicKey: string | null;
  keyStatus: "absent" | "available" | "missing" | "mismatch";
}
export interface PreviewNative {
  open(): Promise<OpenResult>;
  initialize(): Promise<string>;
  commit(expectedRevision: number, next: string): Promise<boolean>;
  loadDraft(replica: string): Promise<Draft | null>;
  saveDraft(
    replica: string,
    expectedRevision: number,
    text: string,
  ): Promise<Draft | null>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export const emptyState = (): PreviewState => ({
  version: 2,
  product: "treehouse",
  revision: 0,
  publicKey: null,
  profiles: [],
  active: null,
  intent: null,
  clearedDrafts: {},
  relay: null,
});
export const byteLength = (value: string) =>
  new TextEncoder().encode(value).length;

export function parseState(record: string | null): PreviewState {
  if (record === null) return emptyState();
  if (byteLength(record) > HISTORY_BYTES)
    throw new Error("preview_storage_limit");
  let value: unknown = JSON.parse(record);
  // Closed pre-release N-1 envelope: history is unchanged; only draft metadata is new.
  if (
    object(value) &&
    value.version === 0 &&
    keys(value, [
      "version",
      "product",
      "revision",
      "publicKey",
      "profiles",
      "active",
      "intent",
    ])
  ) {
    value = { ...value, version: 1, clearedDrafts: {} };
  }
  // Closed v1 envelope: migrates in memory only. Opening never writes; the next
  // explicit commit persists v2.
  if (
    object(value) &&
    value.version === 1 &&
    keys(value, [
      "version",
      "product",
      "revision",
      "publicKey",
      "profiles",
      "active",
      "intent",
      "clearedDrafts",
    ]) &&
    Array.isArray(value.profiles)
  ) {
    value = {
      ...value,
      version: 2,
      relay: null,
      profiles: value.profiles.map((p: unknown) =>
        object(p) && keys(p, ["product", "replica", "frames", "outbox"])
          ? { ...p, acked: [] }
          : p,
      ),
    };
  }
  if (
    !object(value) ||
    !keys(value, [
      "version",
      "product",
      "revision",
      "publicKey",
      "profiles",
      "active",
      "intent",
      "clearedDrafts",
      "relay",
    ]) ||
    value.version !== 2 ||
    value.product !== "treehouse" ||
    !revision(value.revision) ||
    !(value.publicKey === null || publicKey(value.publicKey)) ||
    !(value.active === null || typeof value.active === "string") ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 13 ||
    !object(value.clearedDrafts) ||
    !Object.values(value.clearedDrafts).every(revision)
  )
    throw new Error("invalid_preview_record");
  if (!relay(value.relay)) throw new Error("invalid_relay");
  if (
    value.intent !== null &&
    (!object(value.intent) ||
      !keys(value.intent, ["kind", "name", "nonce"]) ||
      !["space", "thread", "join"].includes(value.intent.kind as string) ||
      typeof value.intent.name !== "string" ||
      !value.intent.name.trim() ||
      byteLength(value.intent.name) > DRAFT_BYTES ||
      (value.intent.kind === "join" && value.intent.name !== JOIN_INTENT_NAME) ||
      typeof value.intent.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.intent.nonce))
  )
    throw new Error("invalid_creation_intent");
  const replicas = new Set<string>();
  for (const p of value.profiles) {
    if (
      !object(p) ||
      !keys(p, ["product", "replica", "frames", "outbox", "acked"]) ||
      !["Treehouse.Space", "Treehouse.Thread"].includes(p.product as string) ||
      typeof p.replica !== "string" ||
      !Array.isArray(p.frames) ||
      !Array.isArray(p.outbox) ||
      !p.outbox.every((id) => typeof id === "string") ||
      !ackedSet(p.acked, p.frames) ||
      replicas.has(p.replica)
    )
      throw new Error("invalid_local_profile");
    replicas.add(p.replica);
  }
  if (Object.keys(value.clearedDrafts).some((key) => !replicas.has(key)))
    throw new Error("invalid_draft_watermark");
  if (value.active !== null && !replicas.has(value.active))
    throw new Error("invalid_active_profile");
  if (value.profiles.length && value.publicKey === null)
    throw new Error("missing_public_identity");
  return value as unknown as PreviewState;
}
/** Unique ids, each the id of a retained frame. */
function ackedSet(acked: unknown, frames: unknown[]): boolean {
  if (!Array.isArray(acked) || new Set(acked).size !== acked.length) return false;
  const ids = new Set(frames.map((f) => (object(f) ? f.id : undefined)));
  return acked.every((id) => typeof id === "string" && ids.has(id));
}
function text(value: unknown, limit: number): boolean {
  return (
    typeof value === "string" && !!value.trim() && byteLength(value) <= limit
  );
}
function relay(value: unknown): boolean {
  if (value === null) return true;
  if (
    !object(value) ||
    !keys(value, ["localRealm", "routes"]) ||
    !text(value.localRealm, 256) ||
    !Array.isArray(value.routes) ||
    value.routes.length === 0 ||
    value.routes.length > MAX_ROUTES
  )
    return false;
  const replicas = new Set<string>();
  for (const r of value.routes) {
    if (
      !object(r) ||
      !keys(r, ["replica", "url", "expectedPeerRealm", "expectedPeerPubkey"]) ||
      !text(r.replica, 512) ||
      !text(r.url, 2048) ||
      !text(r.expectedPeerRealm, 256) ||
      !publicKey(r.expectedPeerPubkey) ||
      replicas.has(r.replica as string)
    )
      return false;
    replicas.add(r.replica as string);
  }
  return true;
}
/**
 * Retained history, the outbox and the acknowledged set only grow. The native store
 * enforces the same rule; this is the earlier, in-process check.
 */
export function assertRetainedMonotonic(
  old: PreviewState,
  next: PreviewState,
): void {
  for (const previous of old.profiles) {
    const retained = next.profiles.find((p) => p.replica === previous.replica);
    if (!retained || retained.product !== previous.product)
      throw new Error("retained_history_changed");
    const outbox = new Set(retained.outbox);
    const acked = new Set(retained.acked);
    const frames = new Set(retained.frames.map((f) => f.id));
    if (
      previous.outbox.some((id) => !outbox.has(id)) ||
      previous.acked.some((id) => !acked.has(id)) ||
      previous.frames.some((f) => !frames.has(f.id))
    )
      throw new Error("retained_history_changed");
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function publicKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const bytes = atob(value);
    return bytes.length === 32 && btoa(bytes) === value;
  } catch {
    return false;
  }
}
