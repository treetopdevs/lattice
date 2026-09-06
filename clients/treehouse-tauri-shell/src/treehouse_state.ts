import type {
  CarrierOpFrame,
  TreehouseProduct,
} from "@treetopdevs/lattice-client";

/** Preview envelope only; this is not the per-Thread pilot capacity claim. */
export const HISTORY_BYTES = 1_048_576;
export const DRAFT_BYTES = 16_384;
export interface LocalProfile {
  product: TreehouseProduct;
  replica: string;
  frames: CarrierOpFrame[];
  outbox: string[];
}
export interface CreationIntent {
  kind: "space" | "thread";
  name: string;
  nonce: string;
}
export interface PreviewState {
  version: 1;
  product: "treehouse";
  revision: number;
  publicKey: string | null;
  profiles: LocalProfile[];
  active: string | null;
  intent: CreationIntent | null;
  clearedDrafts: Record<string, number>;
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
  version: 1,
  product: "treehouse",
  revision: 0,
  publicKey: null,
  profiles: [],
  active: null,
  intent: null,
  clearedDrafts: {},
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
    ]) ||
    value.version !== 1 ||
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
  if (
    value.intent !== null &&
    (!object(value.intent) ||
      !keys(value.intent, ["kind", "name", "nonce"]) ||
      !["space", "thread"].includes(value.intent.kind as string) ||
      typeof value.intent.name !== "string" ||
      !value.intent.name.trim() ||
      byteLength(value.intent.name) > DRAFT_BYTES ||
      typeof value.intent.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.intent.nonce))
  )
    throw new Error("invalid_creation_intent");
  const replicas = new Set<string>();
  for (const p of value.profiles) {
    if (
      !object(p) ||
      !keys(p, ["product", "replica", "frames", "outbox"]) ||
      !["Treehouse.Space", "Treehouse.Thread"].includes(p.product as string) ||
      typeof p.replica !== "string" ||
      !Array.isArray(p.frames) ||
      !Array.isArray(p.outbox) ||
      !p.outbox.every((id) => typeof id === "string") ||
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
