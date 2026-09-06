import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBase64Bytes, canonicalBytesForCarrierTerm } from "./codec";
import type { CarrierTerm } from "./carrier";

/** Pure signed record shapes. Valid signatures do not establish installed trust or authority. */
export interface CatalogBootstrap {
  version: 1;
  product: "treehouse";
  space: string;
  spaceRoot: string;
  profileGenesis: string;
  profileId: string;
  replacementRule: "bounded_space_admin_v1";
  catalogKey: string;
  serviceId: string;
  serviceKey: string;
  origin: string;
  nonce: string;
}
export interface CatalogEntry {
  product: "treehouse";
  replica: string;
  kind: "space" | "thread";
  schema: "treehouse_space_v1" | "treehouse_thread_v1";
  root: string;
  genesis: string;
  creation: string;
  reference: string;
  route: string;
  serviceId: string;
  serviceKey: string;
}
export interface TransportCatalog {
  version: 1;
  product: "treehouse";
  space: string;
  bootstrap: string;
  binding: string;
  revision: number;
  previous: string | null;
  entries: CatalogEntry[];
}
export interface CatalogEnvelope { catalog: TransportCatalog; signature: string; }
export interface CatalogCutoff { replica: string; frontier: string[]; logDigest: string; }
export interface CatalogRotation {
  version: 1;
  product: "treehouse";
  space: string;
  bootstrap: string;
  parent: string;
  priorCatalog: string;
  generation: number;
  newCatalogKey: string;
  nonce: string;
  inventoryDigest: string;
  cutoffs: CatalogCutoff[];
}
export interface CatalogRotationEnvelope { rotation: CatalogRotation; oldSignature: string; newSignature: string; }

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const catalogDomain = "lattice-treehouse-transport-catalog-v1";
const rotationDomain = "lattice-treehouse-catalog-rotation-v1";
const possessionDomain = "lattice-treehouse-transport-possession-v1";
const inventoryDomain = "lattice-treehouse-route-inventory-v1";

// These adapters only select existing CarrierTerm tags. Canonical encoding stays in codec.ts.
interface ValueCodec<T> {
  normalize(value: unknown): T | undefined;
  encode(value: T): CarrierTerm;
  decode(value: unknown): T | undefined;
}
type Field<T> = readonly [keyof T & string, string, ValueCodec<unknown>];
const textValue: ValueCodec<string> = {
  normalize(value) {
    return typeof value === "string" && value.length > 0 &&
      textDecoder.decode(textEncoder.encode(value)) === value ? value : undefined;
  },
  encode: textTerm,
  decode(value) {
    const bytes = binaryBytes(value);
    if (bytes === null) return undefined;
    try { return this.normalize(textDecoder.decode(bytes)); } catch { return undefined; }
  },
};
const idValue = constrained(textValue, (value) => /^[A-Za-z0-9_-]{43}$/.test(value) &&
  canonicalBase64Bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=", 32) !== null);
const originValue = constrained(textValue, canonicalOrigin);
const routeValue = constrained(textValue, (value) => value.startsWith("/r/") && idValue.normalize(value.slice(3)) !== undefined);
const keyValue = rawBinary(32);
const signatureValue = rawBinary(64);
const integerValue: ValueCodec<number> = {
  normalize(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; },
  encode(value) { return ["int", value]; },
  decode(value) {
    if (!tagged(value, "int")) return undefined;
    const number = typeof value[1] === "string" && /^(0|[1-9][0-9]*)$/.test(value[1]) ? Number(value[1]) : value[1];
    return this.normalize(number);
  },
};
const versionValue = constrained(integerValue, (value) => value === 1) as ValueCodec<1>;
const productValue = atomValue("treehouse");
const optionalId: ValueCodec<string | null> = {
  normalize(value) { return value === null ? null : idValue.normalize(value); },
  encode(value) { return value === null ? ["nil"] : idValue.encode(value); },
  decode(value) { return Array.isArray(value) && value.length === 1 && value[0] === "nil" ? null : idValue.decode(value); },
};
const bootstrapCodec = recordCodec<CatalogBootstrap>([
  ["version", "version", versionValue], ["product", "product", productValue],
  ["space", "space", textValue], ["spaceRoot", "space_root", keyValue],
  ["profileGenesis", "profile_genesis", idValue], ["profileId", "profile_id", idValue],
  ["replacementRule", "replacement_rule", atomValue("bounded_space_admin_v1")],
  ["catalogKey", "catalog_key", keyValue], ["serviceId", "service_id", idValue],
  ["serviceKey", "service_key", keyValue], ["origin", "origin", originValue], ["nonce", "nonce", idValue],
], (value) => value.catalogKey !== value.serviceKey);
const entryCodec = recordCodec<CatalogEntry>([
  ["product", "product", productValue], ["replica", "replica", textValue],
  ["kind", "kind", atomValue("space", "thread")], ["schema", "schema", atomValue("treehouse_space_v1", "treehouse_thread_v1")],
  ["root", "root", keyValue], ["genesis", "genesis", idValue], ["creation", "creation", idValue],
  ["reference", "reference", idValue], ["route", "route", routeValue], ["serviceId", "service_id", idValue], ["serviceKey", "service_key", keyValue],
], (value) => value.schema === `treehouse_${value.kind}_v1`);
const entriesCodec = constrained(listCodec(entryCodec), (entries) =>
  entries.length >= 1 && entries.length <= 13 && strictlySorted(entries.map((entry) => entry.replica)) &&
  entries.filter((entry) => entry.kind === "space").length === 1 &&
  new Set(entries.map((entry) => entry.route)).size === entries.length &&
  entries.every((entry) => entry.serviceId === entries[0]!.serviceId && entry.serviceKey === entries[0]!.serviceKey));
const catalogCodec = recordCodec<TransportCatalog>([
  ["version", "version", versionValue], ["product", "product", productValue], ["space", "space", textValue],
  ["bootstrap", "bootstrap", idValue], ["binding", "binding", idValue], ["revision", "revision", integerValue],
  ["previous", "previous", optionalId], ["entries", "entries", entriesCodec],
], (value) => {
  const space = value.entries.find((entry) => entry.kind === "space")!;
  return (value.revision === 0) === (value.previous === null) && space.replica === value.space && space.reference === value.bootstrap;
});
const envelopeCodec = recordCodec<CatalogEnvelope>([["catalog", "catalog", catalogCodec], ["signature", "signature", signatureValue]]);
const cutoffCodec = recordCodec<CatalogCutoff>([
  ["replica", "replica", textValue], ["frontier", "frontier", constrained(listCodec(idValue), strictlySorted)], ["logDigest", "log_digest", idValue],
]);
const cutoffsCodec = constrained(listCodec(cutoffCodec), (cutoffs) => cutoffs.length >= 1 && cutoffs.length <= 13 && strictlySorted(cutoffs.map((cutoff) => cutoff.replica)));
const rotationCodec = recordCodec<CatalogRotation>([
  ["version", "version", versionValue], ["product", "product", productValue], ["space", "space", textValue],
  ["bootstrap", "bootstrap", idValue], ["parent", "parent", idValue], ["priorCatalog", "prior_catalog", idValue],
  ["generation", "generation", constrained(integerValue, (value) => value >= 1)], ["newCatalogKey", "new_catalog_key", keyValue],
  ["nonce", "nonce", idValue], ["inventoryDigest", "inventory_digest", idValue], ["cutoffs", "cutoffs", cutoffsCodec],
]);
const rotationEnvelopeCodec = recordCodec<CatalogRotationEnvelope>([
  ["rotation", "rotation", rotationCodec], ["oldSignature", "old_signature", signatureValue], ["newSignature", "new_signature", signatureValue],
]);

export function normalizeCatalogBootstrap(value: unknown): CatalogBootstrap | null { return bootstrapCodec.normalize(value) ?? null; }
export function catalogBootstrapToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(bootstrapCodec, value); }
export function catalogBootstrapFromCarrierTerm(value: unknown): CatalogBootstrap | null { return bootstrapCodec.decode(value) ?? null; }
export function normalizeCatalogEntry(value: unknown): CatalogEntry | null { return entryCodec.normalize(value) ?? null; }
export function catalogEntryToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(entryCodec, value); }
export function catalogEntryFromCarrierTerm(value: unknown): CatalogEntry | null { return entryCodec.decode(value) ?? null; }
export function normalizeTransportCatalog(value: unknown): TransportCatalog | null { return catalogCodec.normalize(value) ?? null; }
export function transportCatalogToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(catalogCodec, value); }
export function transportCatalogFromCarrierTerm(value: unknown): TransportCatalog | null { return catalogCodec.decode(value) ?? null; }
export function normalizeCatalogEnvelope(value: unknown): CatalogEnvelope | null { return envelopeCodec.normalize(value) ?? null; }
export function catalogEnvelopeToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(envelopeCodec, value); }
export function catalogEnvelopeFromCarrierTerm(value: unknown): CatalogEnvelope | null { return envelopeCodec.decode(value) ?? null; }
export function normalizeCatalogCutoff(value: unknown): CatalogCutoff | null { return cutoffCodec.normalize(value) ?? null; }
export function catalogCutoffToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(cutoffCodec, value); }
export function catalogCutoffFromCarrierTerm(value: unknown): CatalogCutoff | null { return cutoffCodec.decode(value) ?? null; }
export function normalizeCatalogRotation(value: unknown): CatalogRotation | null { return rotationCodec.normalize(value) ?? null; }
export function catalogRotationToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(rotationCodec, value); }
export function catalogRotationFromCarrierTerm(value: unknown): CatalogRotation | null { return rotationCodec.decode(value) ?? null; }
export function normalizeCatalogRotationEnvelope(value: unknown): CatalogRotationEnvelope | null { return rotationEnvelopeCodec.normalize(value) ?? null; }
export function catalogRotationEnvelopeToCarrierTerm(value: unknown): CarrierTerm | null { return toTerm(rotationEnvelopeCodec, value); }
export function catalogRotationEnvelopeFromCarrierTerm(value: unknown): CatalogRotationEnvelope | null { return rotationEnvelopeCodec.decode(value) ?? null; }

export function canonicalBytesForTransportCatalog(value: unknown): Uint8Array { return domainBytes(catalogDomain, requireTerm(catalogCodec, value)); }
export function transportCatalogId(value: unknown): string { return digest(canonicalBytesForTransportCatalog(value)); }
export function canonicalBytesForCatalogRotation(value: unknown): Uint8Array { return domainBytes(rotationDomain, requireTerm(rotationCodec, value)); }
export function canonicalBytesForCatalogRotationPossession(value: unknown): Uint8Array {
  return canonicalBytesForCarrierTerm(["list", [textTerm(possessionDomain), ["atom", "catalog"], requireTerm(rotationCodec, value)]]);
}
/** The binding ID commits both signatures, not just the unsigned rotation record. */
export function catalogRotationId(value: unknown): string { return digest(domainBytes(rotationDomain, requireTerm(rotationEnvelopeCodec, value))); }
export function canonicalBytesForCatalogInventory(value: unknown): Uint8Array { return domainBytes(inventoryDomain, requireTerm(entriesCodec, value)); }
export function catalogInventoryId(value: unknown): string { return digest(canonicalBytesForCatalogInventory(value)); }
export function catalogServiceRealm(value: unknown): string {
  const serviceId = idValue.normalize(value);
  if (serviceId === undefined) throw new TypeError("malformed Treehouse service ID");
  return `treehouse-service:${serviceId}`;
}
/** Signature validity under the caller's trusted key only; no history or route readiness judgment. */
export function verifyCatalogEnvelope(value: unknown, expectedCatalogKey: unknown): boolean {
  try {
    const envelope = normalizeCatalogEnvelope(value);
    const key = canonicalBase64Bytes(expectedCatalogKey, 32);
    return envelope !== null && key !== null && ed25519.verify(canonicalBase64Bytes(envelope.signature, 64)!,
      canonicalBytesForTransportCatalog(envelope.catalog), key, { zip215: false });
  } catch { return false; }
}
/** Old-key approval and new-key possession only; the caller independently resolves parent/head trust. */
export function verifyCatalogRotationEnvelope(value: unknown, expectedOldKey: unknown): boolean {
  try {
    const envelope = normalizeCatalogRotationEnvelope(value);
    const oldKey = canonicalBase64Bytes(expectedOldKey, 32);
    if (envelope === null || oldKey === null || expectedOldKey === envelope.rotation.newCatalogKey) return false;
    return ed25519.verify(canonicalBase64Bytes(envelope.oldSignature, 64)!, canonicalBytesForCatalogRotation(envelope.rotation), oldKey, { zip215: false }) &&
      ed25519.verify(canonicalBase64Bytes(envelope.newSignature, 64)!, canonicalBytesForCatalogRotationPossession(envelope.rotation),
        canonicalBase64Bytes(envelope.rotation.newCatalogKey, 32)!, { zip215: false });
  } catch { return false; }
}

function recordCodec<T extends object>(fields: readonly Field<T>[], valid: (value: T) => boolean = () => true): ValueCodec<T> {
  return {
    normalize(value) {
      if (!closedRecord(value, fields.map(([key]) => key))) return undefined;
      const result: Record<string, unknown> = {};
      for (const [key, , codec] of fields) {
        const normalized = codec.normalize(value[key]);
        if (normalized === undefined) return undefined;
        result[key] = normalized;
      }
      const normalized = result as T;
      return valid(normalized) ? normalized : undefined;
    },
    encode(value) { return ["map", fields.map(([key, wireKey, codec]): [CarrierTerm, CarrierTerm] => [["atom", wireKey], codec.encode(value[key])])]; },
    decode(value) {
      if (!tagged(value, "map") || !Array.isArray(value[1]) || value[1].length !== fields.length) return undefined;
      const wire = new Map<string, unknown>();
      for (const pair of value[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || !tagged(pair[0], "atom") || typeof pair[0][1] !== "string" ||
          wire.has(pair[0][1]) || !fields.some(([, key]) => key === pair[0][1])) return undefined;
        wire.set(pair[0][1], pair[1]);
      }
      const result: Record<string, unknown> = {};
      for (const [key, wireKey, codec] of fields) {
        const decoded = codec.decode(wire.get(wireKey));
        if (decoded === undefined) return undefined;
        result[key] = decoded;
      }
      return this.normalize(result);
    },
  };
}
function constrained<T>(codec: ValueCodec<T>, valid: (value: T) => boolean): ValueCodec<T> {
  const check = (value: T | undefined) => value !== undefined && valid(value) ? value : undefined;
  return { normalize(value) { return check(codec.normalize(value)); }, encode(value) { return codec.encode(value); }, decode(value) { return check(codec.decode(value)); } };
}
function listCodec<T>(codec: ValueCodec<T>): ValueCodec<T[]> {
  function read(value: unknown, decode: boolean): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const result: T[] = [];
    for (const item of value) {
      const parsed = decode ? codec.decode(item) : codec.normalize(item);
      if (parsed === undefined) return undefined;
      result.push(parsed);
    }
    return result;
  }
  return { normalize(value) { return read(value, false); }, encode(value) { return ["list", value.map((item) => codec.encode(item))]; },
    decode(value) { return tagged(value, "list") ? read(value[1], true) : undefined; } };
}
function atomValue<const T extends string>(...allowed: T[]): ValueCodec<T> {
  return { normalize(value) { return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined; },
    encode(value) { return ["atom", value]; }, decode(value) { return tagged(value, "atom") ? this.normalize(value[1]) : undefined; } };
}
function rawBinary(length: number): ValueCodec<string> {
  return { normalize(value) { return canonicalBase64Bytes(value, length) === null ? undefined : value as string; },
    encode(value) { return ["bin", value]; }, decode(value) { return tagged(value, "bin") ? this.normalize(value[1]) : undefined; } };
}
function toTerm<T>(codec: ValueCodec<T>, value: unknown): CarrierTerm | null {
  const normalized = codec.normalize(value);
  return normalized === undefined ? null : codec.encode(normalized);
}
function requireTerm<T>(codec: ValueCodec<T>, value: unknown): CarrierTerm {
  const term = toTerm(codec, value);
  if (term === null) throw new TypeError("malformed Treehouse catalog record");
  return term;
}
function tagged(value: unknown, tag: string): value is [string, unknown] { return Array.isArray(value) && value.length === 2 && value[0] === tag; }
function binaryBytes(value: unknown): Uint8Array | null { return tagged(value, "bin") ? canonicalBase64Bytes(value[1]) : null; }
function textTerm(value: string): CarrierTerm { return ["bin", base64(textEncoder.encode(value))]; }
function domainBytes(domain: string, term: CarrierTerm): Uint8Array { return canonicalBytesForCarrierTerm(["list", [textTerm(domain), term]]); }
function digest(bytes: Uint8Array): string { return base64(sha256(bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function base64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return globalThis.btoa(binary);
}
function closedRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => typeof key === "string" && fields.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function strictlySorted(values: string[]): boolean {
  for (let index = 1; index < values.length; index++) {
    const left = textEncoder.encode(values[index - 1]!);
    const right = textEncoder.encode(values[index]!);
    let difference = 0;
    for (let byte = 0; byte < Math.min(left.length, right.length); byte++) {
      difference = left[byte]! - right[byte]!;
      if (difference !== 0) break;
    }
    if ((difference || left.length - right.length) >= 0) return false;
  }
  return true;
}
function canonicalOrigin(value: string): boolean {
  const match = /^wss:\/\/([a-z0-9.-]+)(?::([1-9][0-9]*))?$/.exec(value);
  if (match === null) return false;
  const host = match[1]!;
  if (host.length > 253 || !host.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  const port = match[2];
  if (port !== undefined && (port === "443" || Number(port) > 65_535)) return false;
  // URL's host parser catches IPv4 literals and alternate numeric forms, never selecting a route.
  try {
    const url = new URL(value);
    return url.hostname === host && !/^[0-9]+(?:\.[0-9]+){3}$/.test(url.hostname);
  } catch { return false; }
}
