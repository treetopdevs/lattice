import { canonicalBase64Bytes } from "./codec";

export interface ContinuationProfile {
  mode: "bounded_continuation";
  version: 1;
  product: "treehouse";
  kind: "space" | "thread";
  role: "admin" | "moderator";
  nominee: string;
  witnesses: string[];
  threshold: number;
  maxLeaseEpochs: number;
}

const profileKeys = [
  "mode", "version", "product", "kind", "role", "nominee", "witnesses",
  "threshold", "maxLeaseEpochs",
] as const;

/** Validate the closed profile and copy witnesses into unsigned byte order. */
export function normalizeContinuationProfile(value: unknown): ContinuationProfile | null {
  if (!exactRecord(value, profileKeys) ||
    value.mode !== "bounded_continuation" || value.version !== 1 || value.product !== "treehouse" ||
    !kindRoleMatch(value.kind, value.role) || !publicKey(value.nominee) ||
    !Array.isArray(value.witnesses) || value.witnesses.length === 0 ||
    !integerIn(value.threshold, 1, value.witnesses.length) ||
    !integerIn(value.maxLeaseEpochs, 1, 65_535)) return null;

  const witnesses: string[] = [];
  for (const witness of value.witnesses) {
    if (!publicKey(witness) || witnesses.includes(witness)) return null;
    witnesses.push(witness);
  }
  witnesses.sort(comparePublicKeys);
  return {
    mode: "bounded_continuation", version: 1, product: "treehouse",
    kind: value.kind as ContinuationProfile["kind"],
    role: value.role as ContinuationProfile["role"],
    nominee: value.nominee, witnesses, threshold: value.threshold,
    maxLeaseEpochs: value.maxLeaseEpochs,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function kindRoleMatch(kind: unknown, role: unknown): boolean {
  return kind === "space" && role === "admin" || kind === "thread" && role === "moderator";
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function publicKey(value: unknown): value is string {
  return canonicalBase64Bytes(value, 32) !== null;
}

function comparePublicKeys(left: string, right: string): number {
  const a = canonicalBase64Bytes(left, 32)!;
  const b = canonicalBase64Bytes(right, 32)!;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
