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

export interface ContinuationClaim {
  version: 1;
  product: "treehouse";
  kind: "space" | "thread";
  replica: string;
  role: "admin" | "moderator";
  profileId: string;
  profileGenesis: string;
  holder: string;
  holderEpoch: string;
  successor: string;
  delegationId: string;
  author: string;
  deps: string[];
  epoch: number;
  epochBasis: string[];
}

export interface ContinuationSignature {
  witness: string;
  signature: string;
}

export interface ContinuationCertificate {
  claim: ContinuationClaim;
  signatures: ContinuationSignature[];
}

const claimKeys = [
  "version", "product", "kind", "replica", "role", "profileId", "profileGenesis",
  "holder", "holderEpoch", "successor", "delegationId", "author", "deps", "epoch", "epochBasis",
] as const;

/** Shape validation only: authority must derive the expected claim from verified history. */
export function normalizeContinuationClaim(value: unknown): ContinuationClaim | null {
  if (!exactRecord(value, claimKeys) || value.version !== 1 || value.product !== "treehouse" ||
    !kindRoleMatch(value.kind, value.role) || typeof value.replica !== "string" || value.replica.length === 0 ||
    !digestId(value.profileId) || !digestId(value.profileGenesis) || !digestId(value.holderEpoch) ||
    !digestId(value.delegationId) || !publicKey(value.holder) || !publicKey(value.successor) ||
    !publicKey(value.author) || !sortedIds(value.deps) || !sortedIds(value.epochBasis) ||
    !integerIn(value.epoch, 0, Number.MAX_SAFE_INTEGER)) return null;

  return {
    version: 1, product: "treehouse", kind: value.kind as ContinuationClaim["kind"],
    replica: value.replica, role: value.role as ContinuationClaim["role"],
    profileId: value.profileId, profileGenesis: value.profileGenesis,
    holder: value.holder, holderEpoch: value.holderEpoch, successor: value.successor,
    delegationId: value.delegationId, author: value.author,
    deps: [...value.deps], epoch: value.epoch, epochBasis: [...value.epochBasis],
  };
}

/** Preserve signature order; quorum, order, membership and validity belong to verification. */
export function normalizeContinuationCertificate(value: unknown): ContinuationCertificate | null {
  if (!exactRecord(value, ["claim", "signatures"]) || !Array.isArray(value.signatures)) return null;
  const claim = normalizeContinuationClaim(value.claim);
  if (claim === null) return null;
  const signatures: ContinuationSignature[] = [];
  for (const entry of value.signatures) {
    if (!exactRecord(entry, ["witness", "signature"]) || !publicKey(entry.witness) ||
      typeof entry.signature !== "string" || canonicalBase64Bytes(entry.signature, 64) === null) return null;
    signatures.push({ witness: entry.witness, signature: entry.signature });
  }
  return { claim, signatures };
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

function digestId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return canonicalBase64Bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=", 32) !== null;
}

function sortedIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  let previous: string | null = null;
  for (const id of value) {
    if (!digestId(id) || previous !== null && previous >= id) return false;
    previous = id;
  }
  return true;
}

function comparePublicKeys(left: string, right: string): number {
  const a = canonicalBase64Bytes(left, 32)!;
  const b = canonicalBase64Bytes(right, 32)!;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
