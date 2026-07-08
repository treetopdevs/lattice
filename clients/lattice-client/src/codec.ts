import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "./carrier";
import type { Verifier } from "./identity";
import type { Op } from "./op";

// ── Tier B: byte-identical canonical encoding ────────────────────────────────
//
// The BEAM substrate now signs and hashes `Lattice.Canonical` bytes
// (`lattice-cbor-v1`), a deliberately narrow CBOR-shaped subset documented in
// ADR 0001. This file implements the cross-runtime byte/hash parity path for
// carrier wire ops: given the same body/cap terms the BEAM realm puts on the
// carrier, TypeScript can reproduce `Lattice.Op.canonical_encoding/1` and the
// base64url SHA-256 op id.
//
// Client-side semantic authoring still starts with a shell building the real
// Lattice body/cap term, but this module now owns the byte-identical
// hash/sign/frame step once those terms and a key-custody signer are available.

export interface CanonicalCodec {
  /** Deterministically encode an op's signed core to bytes. */
  encode(core: OpCore): Uint8Array;
  /** Hash the canonical bytes to the op id / hash (base64url SHA-256). */
  hash(bytes: Uint8Array): Promise<string>;
}

/** The fields that are canonically encoded and signed (mirror the Elixir tuple). */
export interface OpCore {
  replica: string;
  author: string;
  deps: string[];
  kind: Op["kind"];
  field: string;
  mutation: Op["mutation"];
  value: unknown;
  cap?: string;
}

export const canonicalSuite = "lattice-cbor-v1";

export interface CarrierOpVerification {
  hash: boolean;
  signature: boolean;
  valid: boolean;
}

export interface CarrierOpSigner {
  publicKey: Uint8Array;
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface AuthorCarrierOpInput {
  replica: string;
  deps: string[];
  kind: CarrierOpFrame["kind"];
  body: CarrierTerm;
  cap: CarrierTerm;
  signer: CarrierOpSigner;
}

const textEncoder = new TextEncoder();
const uint64Max = 18_446_744_073_709_551_615n;
const atomTag = 60_000;
const tupleTag = 60_001;
const mapsetTag = 60_002;
const delegationTermTag = 60_003;
const opTag = "lattice-op-v2";

/**
 * Encode the signed/hashable core of a BEAM carrier op frame using the same
 * narrow CBOR-shaped subset as `Lattice.Canonical.op_payload/1`.
 */
export function canonicalBytesForCarrierOp(frame: CarrierOpFrame): Uint8Array {
  return encodeArray([
    encodeBinaryString(opTag),
    encodeBinaryString(frame.replica),
    encodeBytes(base64ToBytes(frame.author)),
    encodeArray(uniqueSorted(frame.deps).map(encodeBinaryString)),
    encodeAtom(frame.kind),
    encodeCarrierTerm(frame.body),
    encodeCarrierTerm(frame.cap),
  ]);
}

/** Hash canonical signed bytes to the Lattice op id format. */
export async function canonicalHash(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto.subtle unavailable");

  const digestInput = new Uint8Array(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", digestInput));
  return bytesToBase64Url(digest);
}

export async function verifyCarrierOpHash(frame: CarrierOpFrame): Promise<boolean> {
  return (await canonicalHash(canonicalBytesForCarrierOp(frame))) === frame.id;
}

export async function verifyCarrierOp(
  frame: CarrierOpFrame,
  verifier: Verifier,
): Promise<CarrierOpVerification> {
  const canonicalBytes = canonicalBytesForCarrierOp(frame);
  const hash = (await canonicalHash(canonicalBytes)) === frame.id;
  const signature = await verifier.verify(frame.author, canonicalBytes, base64ToBytes(frame.sig));

  return { hash, signature, valid: hash && signature };
}

export async function authorCarrierOp(input: AuthorCarrierOpInput): Promise<CarrierOpFrame> {
  const unsignedFrame: CarrierOpFrame = {
    v: 1,
    id: "",
    replica: input.replica,
    author: bytesToBase64(input.signer.publicKey),
    deps: uniqueSorted(input.deps),
    kind: input.kind,
    body: input.body,
    cap: input.cap,
    sig: "",
  };
  const canonicalBytes = canonicalBytesForCarrierOp(unsignedFrame);
  const id = await canonicalHash(canonicalBytes);
  const signature = await input.signer.sign(canonicalBytes);

  return {
    ...unsignedFrame,
    id,
    sig: bytesToBase64(signature),
  };
}

function encodeCarrierTerm(term: CarrierTerm): Uint8Array {
  const [tag] = term;

  switch (tag) {
    case "nil":
      return bytes(0xf6);
    case "bool":
      return bytes(term[1] ? 0xf5 : 0xf4);
    case "int":
      return encodeUint(term[1]);
    case "bin":
      return encodeBytes(base64ToBytes(term[1]));
    case "atom":
      return encodeAtom(term[1]);
    case "list":
      return encodeArray(term[1].map(encodeCarrierTerm));
    case "tuple":
      return encodeTagged(tupleTag, encodeArray(term[1].map(encodeCarrierTerm)));
    case "map":
      return encodeMap(term[1]);
    case "mapset":
      return encodeTagged(
        mapsetTag,
        encodeArray(term[1].map(encodeCarrierTerm).sort(compareBytes)),
      );
    case "delegation":
      return encodeDelegation(term[1]);
  }
}

function encodeDelegation(delegation: CarrierDelegation): Uint8Array {
  return encodeTagged(
    delegationTermTag,
    encodeArray([
      encodeBinaryString(delegation.id),
      encodeBinaryString(delegation.replica),
      encodeBytes(base64ToBytes(delegation.issuer)),
      encodeBytes(base64ToBytes(delegation.audience)),
      delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
      encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
      encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
      bytes(delegation.live ? 0xf5 : 0xf4),
      encodeBytes(base64ToBytes(delegation.sig)),
    ]),
  );
}

function encodeMap(pairs: [CarrierTerm, CarrierTerm][]): Uint8Array {
  const encoded = pairs
    .map(([key, value]) => [encodeCarrierTerm(key), encodeCarrierTerm(value)] as const)
    .sort(([left], [right]) => compareBytes(left, right));

  return concat(major(5, BigInt(encoded.length)), ...encoded.flatMap(([key, value]) => [key, value]));
}

function encodeTagged(tag: number, encodedValue: Uint8Array): Uint8Array {
  return concat(major(6, BigInt(tag)), encodedValue);
}

function encodeArray(elements: Uint8Array[]): Uint8Array {
  return concat(major(4, BigInt(elements.length)), ...elements);
}

function encodeAtom(value: string): Uint8Array {
  return encodeTagged(atomTag, encodeBinaryString(value));
}

function encodeBinaryString(value: string): Uint8Array {
  return encodeBytes(textEncoder.encode(value));
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concat(major(2, BigInt(value.length)), value);
}

function encodeUint(value: number | string): Uint8Array {
  const parsed = parseUint(value);
  return major(0, parsed);
}

function parseUint(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`unsupported canonical integer: ${value}`);
    }

    return BigInt(value);
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`unsupported canonical integer: ${value}`);
  }

  return BigInt(value);
}

function major(majorType: number, n: bigint): Uint8Array {
  if (n < 0n || n > uint64Max) throw new Error(`unsupported canonical integer: ${n}`);
  if (n < 24n) return bytes((majorType << 5) | Number(n));
  if (n < 256n) return bytes((majorType << 5) | 24, Number(n));
  if (n < 65_536n) return bytes((majorType << 5) | 25, Number(n >> 8n), Number(n & 0xffn));
  if (n < 4_294_967_296n) {
    return bytes(
      (majorType << 5) | 26,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    );
  }

  return bytes(
    (majorType << 5) | 27,
    Number((n >> 56n) & 0xffn),
    Number((n >> 48n) & 0xffn),
    Number((n >> 40n) & 0xffn),
    Number((n >> 32n) & 0xffn),
    Number((n >> 24n) & 0xffn),
    Number((n >> 16n) & 0xffn),
    Number((n >> 8n) & 0xffn),
    Number(n & 0xffn),
  );
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));

  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...value));
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/**
 * Placeholder for semantic op authoring. Carrier-frame canonical byte/hash
 * parity exists above, but this interface cannot honestly encode a reducer-level
 * `OpCore` until it also carries the real Lattice body/cap term and signer flow.
 */
export const UnavailableCodec: CanonicalCodec = {
  encode(): Uint8Array {
    throw new Error(
      "semantic op authoring unavailable: build the real Lattice body/cap term and signer flow before using OpCore.",
    );
  },
  async hash(): Promise<string> {
    throw new Error("semantic op hashing unavailable for OpCore; use canonicalHash over canonical bytes.");
  },
};
