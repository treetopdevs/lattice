import type {
  CarrierOpFrame,
  TreehouseProduct,
} from "@treetopdevs/lattice-client";
import { validateLocalRealm, validateRoutes } from "./treehouse_routes";

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
/** Desktop creation bounds keep the signed policy and final transaction within native limits. */
export const MAX_THREAD_WITNESSES = 16;
export const THREAD_CREATION_RESERVE_BYTES = 131_072;
export interface ThreadSetup {
  nominee: string;
  witnesses: string[];
  threshold: number;
  maxLeaseEpochs: number;
}
export interface CreationIntent {
  kind: "space" | "thread" | "join";
  name: string;
  nonce: string;
  setup?: ThreadSetup;
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
  initializeThread?(nonce: string): Promise<string>;
  threadIdentity?(nonce: string): Promise<string>;
  signThread?(nonce: string, bytes: Uint8Array): Promise<Uint8Array>;
  commit(expectedRevision: number, next: string): Promise<boolean>;
  loadDraft(replica: string): Promise<Draft | null>;
  saveDraft(
    replica: string,
    expectedRevision: number,
    text: string,
  ): Promise<Draft | null>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** Write public export bytes to a new file in the user's downloads folder; resolves to the written path. */
  exportSpaceFrames(fileName: string, contents: string): Promise<string>;
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
      !(keys(value.intent, ["kind", "name", "nonce"]) ||
        (keys(value.intent, ["kind", "name", "nonce", "setup"]) && value.intent.kind === "thread" && validThreadSetup(value.intent.setup))) ||
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
/** The same semantic rules the route list was accepted under (treehouse_routes.ts). */
function relay(value: unknown): boolean {
  if (value === null) return true;
  if (!object(value) || !keys(value, ["localRealm", "routes"]) || !Array.isArray(value.routes))
    return false;
  try {
    validateLocalRealm(value.localRealm);
    validateRoutes(value.routes);
    return true;
  } catch {
    return false;
  }
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

/** Closed public setup persisted in the intent so a retry signs the same policy. */
export function validThreadSetup(value: unknown): value is ThreadSetup {
  if (!object(value) || !keys(value, ["nominee", "witnesses", "threshold", "maxLeaseEpochs"])) return false;
  const pub = (key: unknown) => typeof key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(key) &&
    /[AEIMQUYcgkosw048]=$/.test(key);
  return pub(value.nominee) && Array.isArray(value.witnesses) && value.witnesses.length > 0 && value.witnesses.length <= MAX_THREAD_WITNESSES &&
    value.witnesses.every((key) => pub(key) && key !== value.nominee) && new Set(value.witnesses).size === value.witnesses.length &&
    Number.isInteger(value.threshold) && Number(value.threshold) >= 1 && Number(value.threshold) <= value.witnesses.length &&
    Number.isInteger(value.maxLeaseEpochs) && Number(value.maxLeaseEpochs) >= 1 && Number(value.maxLeaseEpochs) <= 65535;
}
