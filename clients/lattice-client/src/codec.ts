import { parseCanonicalUint64 } from "./uint64";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "./carrier";
import type { Verifier } from "./identity";
import { isWireVocabularyName } from "./wire_vocabulary";
import type {
  Op,
  WitnessedBeaconClaimEvidence,
  WitnessedRecoveryPolicyEvidence,
  WitnessedSuccessionClaimEvidence,
} from "./op";

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

export interface CarrierDelegationCore {
  replica: string;
  issuer: string;
  audience: string;
  parent_id: string | null;
  ops: readonly string[];
  roles: readonly string[];
  live: boolean;
  /** Plan 149 lease — present only on leased (v3) delegations. */
  expires_epoch?: number;
}

export interface AuthorCarrierDelegationInput {
  replica: string;
  audiencePubkey: string | Uint8Array;
  parentId?: string | null;
  ops?: readonly string[];
  roles?: readonly string[];
  live?: boolean;
  expiresEpoch?: number;
  signer: CarrierOpSigner;
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
const delegationPayloadTag = "lattice-delegation-v2";
const delegationV3PayloadTag = "lattice-delegation-v3";
const witnessedRecoveryPolicyDomain = "lattice-recovery-policy-v1";
const witnessedSuccessionClaimDomain = "lattice-succession-witness-v1";
const witnessedSuccessionArtifactDomain = "lattice-succession-witness-artifact-v1";

/**
 * Encode the signed/hashable core of a BEAM carrier op frame using the same
 * narrow CBOR-shaped subset as `Lattice.Canonical.op_payload/1`.
 */
export function canonicalBytesForCarrierOp(frame: CarrierOpFrame): Uint8Array {
  return encodeArray([
    encodeBinaryString(opTag),
    encodeBinaryString(frame.replica),
    encodeBytes(requireCanonicalBase64Bytes(frame.author, 32)),
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
  const signature = await verifier.verify(
    frame.author,
    canonicalBytes,
    requireCanonicalBase64Bytes(frame.sig, 64),
  );

  return { hash, signature, valid: hash && signature };
}

/**
 * Plan 190: refuse any atom name or delegation op/role name outside the closed wire
 * vocabulary. Walks the raw carrier term grammar, so it never needs a decoded term and
 * ignores malformed shapes (the decoders own those), except that an atom term's arity and
 * name type are checked here: the BEAM refuses the whole batch for a malformed atom term.
 */
export function assertWireVocabularyTerm(term: unknown, depth: number = maxTermDepth): void {
  if (!Array.isArray(term)) return;
  const [tag, value] = term as [unknown, unknown];
  switch (tag) {
    case "atom":
      if (term.length !== 2) throw new Error("malformed carrier op");
      assertWireVocabularyName(value);
      return;
    case "list":
    case "tuple":
    case "mapset":
      // Entering a container spends one level, as `Lattice.Carrier.Wire` does; refuse on descent.
      if (depth <= 0) throw new Error("malformed carrier op");
      if (Array.isArray(value)) value.forEach((child) => assertWireVocabularyTerm(child, depth - 1));
      return;
    case "map":
      if (depth <= 0) throw new Error("malformed carrier op");
      if (Array.isArray(value)) {
        for (const pair of value) {
          if (Array.isArray(pair)) pair.forEach((child) => assertWireVocabularyTerm(child, depth - 1));
        }
      }
      return;
    case "delegation":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const key of ["ops", "roles"]) {
          const names: unknown = Reflect.get(value, key);
          if (Array.isArray(names)) names.forEach(assertWireVocabularyName);
        }
      }
      return;
  }
}

function assertWireVocabularyName(name: unknown): void {
  if (typeof name !== "string") throw new Error("malformed carrier op");
  if (!isWireVocabularyName(name)) {
    throw new Error(`atom name outside the wire vocabulary: ${name}`);
  }
}

export async function authorCarrierOp(input: AuthorCarrierOpInput): Promise<CarrierOpFrame> {
  // Refuse before anything is hashed or signed: every peer would refuse an off-list name.
  assertWireVocabularyTerm(input.body);
  assertWireVocabularyTerm(input.cap);
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

export function canonicalBytesForCarrierDelegation(delegation: CarrierDelegationCore): Uint8Array {
  const expiresEpoch = delegation.expires_epoch;
  const leased = expiresEpoch !== undefined && expiresEpoch !== null;
  const shared = [
    encodeBinaryString(delegation.replica),
    encodeBytes(requireCanonicalBase64Bytes(delegation.issuer, 32)),
    encodeBytes(requireCanonicalBase64Bytes(delegation.audience, 32)),
    delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
    encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
    encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
    bytes(delegation.live ? 0xf5 : 0xf4),
  ];

  // Plan 149: unleased delegations keep the v2 bytes verbatim; a lease selects
  // the v3 tag with the epoch as the final element — mirroring
  // Lattice.Canonical.delegation_bytes/8.
  if (!leased) {
    return encodeArray([encodeBinaryString(delegationPayloadTag), ...shared]);
  }
  return encodeArray([
    encodeBinaryString(delegationV3PayloadTag),
    ...shared,
    encodeUint(expiresEpoch),
  ]);
}

/** Canonical policy-id preimage shared with `Lattice.Authority.SuccessionCertificate`. */
export function canonicalBytesForWitnessedRecoveryPolicy(
  policy: WitnessedRecoveryPolicyEvidence,
): Uint8Array {
  const witnesses = policy.witnesses.map(canonicalEvidenceBytes).sort(compareBytes);

  return encodeArray([
    encodeBinaryString(witnessedRecoveryPolicyDomain),
    encodeCanonicalMap([
      ["mode", encodeAtom("witnessed")],
      ["version", encodeUint(policy.version)],
      ["witnesses", encodeArray(witnesses.map(encodeBytes))],
      ["threshold", encodeUint(policy.threshold)],
    ]),
  ]);
}

/** Construct the exact five-field authoring claim before witnesses sign it.
 * Received claims remain exact evidence and are never normalized by verification.
 */
export function createWitnessedBeaconClaim(
  replica: string,
  epoch: number,
  author: string,
  deps: readonly string[],
): WitnessedBeaconClaimEvidence {
  return { version: 1, replica, epoch, author, deps: uniqueSorted(deps) };
}

/** Canonical preimage for the exact author and frontier authorized by beacon witnesses. */
export function canonicalBytesForWitnessedBeaconClaim(
  claim: WitnessedBeaconClaimEvidence,
): Uint8Array {
  return encodeArray([
    encodeBinaryString("lattice-beacon-witness-v1"),
    encodeCanonicalMap([
      ["version", encodeUint(claim.version)],
      ["replica", encodeBinaryString(claim.replica)],
      ["epoch", encodeUint(claim.epoch)],
      ["author", encodeBytes(canonicalEvidenceBytes(claim.author))],
      ["deps", encodeArray(claim.deps.map(encodeBinaryString))],
    ]),
  ]);
}

/** Canonical witness-signature payload shared with the BEAM certificate verifier. */
export function canonicalBytesForWitnessedSuccessionClaim(
  claim: WitnessedSuccessionClaimEvidence,
): Uint8Array {
  return encodeArray([
    encodeBinaryString(witnessedSuccessionClaimDomain),
    encodeCanonicalMap([
      ["version", encodeUint(claim.version)],
      ["replica", encodeBinaryString(claim.replica)],
      ["role", encodeAtom(claim.role)],
      ["holder", encodeBytes(canonicalEvidenceBytes(claim.holder))],
      ["holder_epoch", encodeBinaryString(claim.holderEpoch)],
      ["successor", encodeBytes(canonicalEvidenceBytes(claim.successor))],
      ["policy_id", encodeBinaryString(claim.policyId)],
    ]),
  ]);
}

/** Canonical storage-locator preimage for one public succession witness artifact. */
export function canonicalBytesForWitnessedSuccessionArtifactId(
  claim: WitnessedSuccessionClaimEvidence,
  witness: string,
): Uint8Array {
  return encodeArray([
    encodeBinaryString(witnessedSuccessionArtifactDomain),
    encodeBytes(canonicalBytesForWitnessedSuccessionClaim(claim)),
    encodeBytes(canonicalEvidenceBytes(witness)),
  ]);
}

export async function authorCarrierDelegation(
  input: AuthorCarrierDelegationInput,
): Promise<CarrierDelegation> {
  const unsignedDelegation: CarrierDelegationCore = {
    replica: input.replica,
    issuer: bytesToBase64(input.signer.publicKey),
    audience: pubkeyBase64(input.audiencePubkey),
    parent_id: input.parentId ?? null,
    ops: uniqueSorted(input.ops ?? []),
    roles: uniqueSorted(input.roles ?? []),
    live: input.live ?? false,
  };
  if (input.expiresEpoch !== undefined) unsignedDelegation.expires_epoch = input.expiresEpoch;
  const canonicalBytes = canonicalBytesForCarrierDelegation(unsignedDelegation);
  const id = await canonicalHash(canonicalBytes);
  const signature = await input.signer.sign(canonicalBytes);

  return {
    ...unsignedDelegation,
    ops: [...unsignedDelegation.ops],
    roles: [...unsignedDelegation.roles],
    id,
    sig: bytesToBase64(signature),
  };
}

/** Encode the existing closed carrier term grammar without an op envelope. */
export function canonicalBytesForCarrierTerm(term: CarrierTerm): Uint8Array {
  return encodeCarrierTerm(term);
}

/**
 * Row 237: the carrier JSON term `Lattice.Carrier.Wire` would emit for the same value, derived
 * by decoding this module's own signing bytes. Map pair, mapset element, and delegation
 * op/role order plus the int representation therefore cannot drift from the encoder.
 */
export function canonicalCarrierTerm(term: CarrierTerm): CarrierTerm {
  return carrierTermFromCanonicalBytes(canonicalBytesForCarrierTerm(term));
}

/**
 * Strictly decode one `lattice-cbor-v1` carrier term: shortest heads, no indefinite lengths,
 * only the four Lattice tags, strictly ascending map keys and mapset elements, and no trailing
 * bytes. Grammar only; the wire vocabulary stays with `assertWireVocabularyTerm`.
 */
export function carrierTermFromCanonicalBytes(input: Uint8Array): CarrierTerm {
  const reader = { input, offset: 0 };
  const term = decodeCarrierTerm(reader, maxTermDepth);
  if (reader.offset !== input.length) throw new Error("trailing bytes after canonical term");
  return term;
}

interface CanonicalReader {
  input: Uint8Array;
  offset: number;
}

// Mirrors `Lattice.Carrier.Wire`'s @max_decode_depth container budget.
export const maxTermDepth = 64;
const maxJsonSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeCarrierTerm(reader: CanonicalReader, depth: number): CarrierTerm {
  const start = reader.offset;
  const initial = readByte(reader);

  switch (initial) {
    case 0xf4:
      return ["bool", false];
    case 0xf5:
      return ["bool", true];
    case 0xf6:
      return ["nil"];
  }

  reader.offset = start;
  const [majorType, argument] = readHead(reader);

  switch (majorType) {
    case 0:
      return ["int", carrierInt(argument)];
    case 2:
      return ["bin", bytesToBase64(readSlice(reader, argument))];
    case 4:
      return ["list", decodeTermArray(reader, argument, containerDepth(depth))];
    case 5:
      return ["map", decodeTermMap(reader, argument, containerDepth(depth))];
    case 6:
      return decodeTagged(reader, argument, depth);
    default:
      throw new Error(`unsupported canonical major type: ${majorType}`);
  }
}

function decodeTagged(reader: CanonicalReader, tag: bigint, depth: number): CarrierTerm {
  switch (tag) {
    case BigInt(atomTag):
      return ["atom", readUtf8Bytes(reader)];
    case BigInt(tupleTag):
      return ["tuple", decodeTermArray(reader, readArrayHead(reader), containerDepth(depth))];
    case BigInt(mapsetTag): {
      const length = readArrayHead(reader);
      // Charged before the elements, as Wire charges a mapset (even an empty one) one level.
      const elementDepth = containerDepth(depth);
      const elements: CarrierTerm[] = [];
      let previous: Uint8Array | null = null;
      for (let i = 0n; i < length; i++) {
        const start = reader.offset;
        elements.push(decodeCarrierTerm(reader, elementDepth));
        const encoded = reader.input.subarray(start, reader.offset);
        if (previous !== null && compareBytes(previous, encoded) >= 0) {
          throw new Error("non-canonical mapset order");
        }
        previous = encoded;
      }
      return ["mapset", elements];
    }
    case BigInt(delegationTermTag):
      return ["delegation", decodeDelegationTerm(reader)];
    default:
      throw new Error(`unsupported canonical tag: ${tag}`);
  }
}

function decodeDelegationTerm(reader: CanonicalReader): CarrierDelegation {
  const length = readArrayHead(reader);
  if (length !== 9n && length !== 10n) throw new Error("malformed canonical delegation");

  const id = readUtf8Bytes(reader);
  const replica = readUtf8Bytes(reader);
  const issuer = bytesToBase64(readFixedBytes(reader, 32));
  const audience = bytesToBase64(readFixedBytes(reader, 32));
  const parentId = readOptionalUtf8Bytes(reader);
  const ops = readAtomNames(reader);
  const roles = readAtomNames(reader);
  const live = readBoolean(reader);
  const sig = bytesToBase64(readFixedBytes(reader, 64));
  const delegation: CarrierDelegation = {
    id,
    replica,
    issuer,
    audience,
    parent_id: parentId,
    ops,
    roles,
    live,
    sig,
  };

  // A lease epoch above 2^53-1 is refused here although Wire admits it up to 2^64-1: the term
  // carries it as a JSON number, which cannot hold it exactly. Deliberate fail-closed bound.
  if (length === 10n) {
    const [majorType, epoch] = readHead(reader);
    if (majorType !== 0 || epoch > maxJsonSafeInteger) {
      throw new Error("unsupported canonical delegation lease");
    }
    delegation.expires_epoch = Number(epoch);
  }

  return delegation;
}

function decodeTermArray(reader: CanonicalReader, length: bigint, depth: number): CarrierTerm[] {
  const elements: CarrierTerm[] = [];
  for (let i = 0n; i < length; i++) elements.push(decodeCarrierTerm(reader, depth));
  return elements;
}

function decodeTermMap(
  reader: CanonicalReader,
  length: bigint,
  depth: number,
): [CarrierTerm, CarrierTerm][] {
  const pairs: [CarrierTerm, CarrierTerm][] = [];
  let previousKey: Uint8Array | null = null;
  for (let i = 0n; i < length; i++) {
    const start = reader.offset;
    const key = decodeCarrierTerm(reader, depth);
    const encodedKey = reader.input.subarray(start, reader.offset);
    if (previousKey !== null && compareBytes(previousKey, encodedKey) >= 0) {
      throw new Error("non-canonical map key order");
    }
    previousKey = encodedKey;
    pairs.push([key, decodeCarrierTerm(reader, depth)]);
  }
  return pairs;
}

/** Delegation op/role names: strictly ascending in the encoder's `uniqueSorted` order. */
function readAtomNames(reader: CanonicalReader): string[] {
  const length = readArrayHead(reader);
  const names: string[] = [];
  for (let i = 0n; i < length; i++) {
    const [majorType, tag] = readHead(reader);
    if (majorType !== 6 || tag !== BigInt(atomTag)) throw new Error("malformed canonical atom");
    const name = readUtf8Bytes(reader);
    const previous = names[names.length - 1];
    if (previous !== undefined && !(previous < name)) {
      throw new Error("non-canonical delegation name order");
    }
    names.push(name);
  }
  return names;
}

function readOptionalUtf8Bytes(reader: CanonicalReader): string | null {
  if (peekByte(reader) !== 0xf6) return readUtf8Bytes(reader);
  reader.offset++;
  return null;
}

function readBoolean(reader: CanonicalReader): boolean {
  const value = readByte(reader);
  if (value === 0xf5) return true;
  if (value === 0xf4) return false;
  throw new Error("malformed canonical boolean");
}

function readArrayHead(reader: CanonicalReader): bigint {
  const [majorType, length] = readHead(reader);
  if (majorType !== 4) throw new Error("expected canonical array");
  return length;
}

function readFixedBytes(reader: CanonicalReader, length: number): Uint8Array {
  const [majorType, size] = readHead(reader);
  if (majorType !== 2 || size !== BigInt(length)) throw new Error("malformed canonical bytes");
  return readSlice(reader, size);
}

function readUtf8Bytes(reader: CanonicalReader): string {
  const [majorType, size] = readHead(reader);
  if (majorType !== 2) throw new Error("expected canonical byte string");
  return strictUtf8.decode(readSlice(reader, size));
}

/** One shortest-form CBOR head; additional info 28-31 (incl. indefinite) is refused. */
function readHead(reader: CanonicalReader): [number, bigint] {
  const initial = readByte(reader);
  const majorType = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return [majorType, BigInt(info)];

  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (width === 0) throw new Error("unsupported canonical head");
  let value = 0n;
  for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(readByte(reader));
  const floor = info === 24 ? 24n : 1n << BigInt(8 * (width / 2));
  if (value < floor) throw new Error("non-shortest canonical head");
  return [majorType, value];
}

function carrierInt(value: bigint): number | string {
  return value <= maxJsonSafeInteger ? Number(value) : value.toString();
}

function containerDepth(depth: number): number {
  if (depth <= 0) throw new Error("canonical term too deep");
  return depth - 1;
}

function readSlice(reader: CanonicalReader, length: bigint): Uint8Array {
  if (length > BigInt(reader.input.length - reader.offset)) {
    throw new Error("truncated canonical term");
  }
  const start = reader.offset;
  reader.offset += Number(length);
  return reader.input.subarray(start, reader.offset);
}

function peekByte(reader: CanonicalReader): number {
  const value = reader.input[reader.offset];
  if (value === undefined) throw new Error("truncated canonical term");
  return value;
}

function readByte(reader: CanonicalReader): number {
  const value = peekByte(reader);
  reader.offset++;
  return value;
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
      return encodeBytes(requireCanonicalBase64Bytes(term[1]));
    case "atom":
      return encodeAtom(term[1]);
    case "list":
      return encodeArray(term[1].map(encodeCarrierTerm));
    case "tuple":
      return encodeTagged(tupleTag, encodeArray(term[1].map(encodeCarrierTerm)));
    case "map":
      return encodeMap(term[1]);
    case "mapset": {
      const elements = term[1].map(encodeCarrierTerm).sort(compareBytes);
      for (let i = 1; i < elements.length; i++) {
        if (compareBytes(elements[i - 1]!, elements[i]!) === 0) {
          throw new Error("duplicate canonical mapset element");
        }
      }
      return encodeTagged(mapsetTag, encodeArray(elements));
    }
    case "delegation":
      return encodeDelegation(term[1]);
  }
}

function encodeDelegation(delegation: CarrierDelegation): Uint8Array {
  const fields = [
    encodeBinaryString(delegation.id),
    encodeBinaryString(delegation.replica),
    encodeBytes(requireCanonicalBase64Bytes(delegation.issuer, 32)),
    encodeBytes(requireCanonicalBase64Bytes(delegation.audience, 32)),
    delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
    encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
    encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
    bytes(delegation.live ? 0xf5 : 0xf4),
    encodeBytes(requireCanonicalBase64Bytes(delegation.sig, 64)),
  ];

  if (delegation.expires_epoch !== undefined && delegation.expires_epoch !== null) {
    fields.push(encodeUint(delegation.expires_epoch));
  }

  return encodeTagged(delegationTermTag, encodeArray(fields));
}

function encodeMap(pairs: [CarrierTerm, CarrierTerm][]): Uint8Array {
  const encoded = pairs
    .map(([key, value]) => [encodeCarrierTerm(key), encodeCarrierTerm(value)] as const)
    .sort(([left], [right]) => compareBytes(left, right));

  for (let i = 1; i < encoded.length; i++) {
    if (compareBytes(encoded[i - 1]![0], encoded[i]![0]) === 0) {
      throw new Error("duplicate canonical map key");
    }
  }

  return concat(major(5, BigInt(encoded.length)), ...encoded.flatMap(([key, value]) => [key, value]));
}

function encodeCanonicalMap(pairs: [string, Uint8Array][]): Uint8Array {
  const encoded = pairs
    .map(([key, value]) => [encodeAtom(key), value] as const)
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
  return parseCanonicalUint64(value);
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

function uniqueSorted(values: readonly string[]): string[] {
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

/** Decode canonical standard Base64, refusing malformed text or an unexpected byte length. */
export function canonicalBase64Bytes(value: unknown, length?: number): Uint8Array | null {
  if (typeof value !== "string") return null;

  try {
    const decoded = base64ToBytes(value);
    if (bytesToBase64(decoded) !== value) return null;
    return length === undefined || decoded.length === length ? decoded : null;
  } catch {
    return null;
  }
}

function requireCanonicalBase64Bytes(value: unknown, length?: number): Uint8Array {
  const decoded = canonicalBase64Bytes(value, length);
  if (decoded === null) throw new Error("non-canonical base64");
  return decoded;
}

function canonicalEvidenceBytes(value: string): Uint8Array {
  const decoded = canonicalBase64Bytes(value, 32);
  if (decoded === null) throw new Error("non-canonical base64 evidence");
  return decoded;
}

function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  // Binary terms can exceed the browser's function-argument limit during round-trip validation.
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 8192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
  }
  return btoaFn(binary);
}

function pubkeyBase64(value: string | Uint8Array): string {
  return typeof value === "string" ? value : bytesToBase64(value);
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
