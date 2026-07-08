import type { Mutation, Op, OpKind } from "./op";
import { integrate } from "./sync";

export interface CarrierChallenge {
  type: "carrier_challenge";
  local_realm: string;
  replica: string;
  nonce: string;
  wire_version: number;
}

export interface CarrierSigner {
  publicKey: Uint8Array;
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface CarrierVerifier {
  verify(pubkey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

export interface SignedCarrierChallenge extends CarrierChallenge {
  pubkey: string;
  signature: string;
}

export interface CarrierHello {
  type: "carrier_hello";
  realm: string;
  pubkey: string;
  signature: string;
}

export interface ConnectCarrierWebSocketOptions {
  url: string;
  localRealm: string;
  replica: string;
  signer: CarrierSigner;
  expectedPeerRealm: string;
  expectedPeerPubkey: Uint8Array;
  verifier: CarrierVerifier;
  wireVersion?: number;
  webSocket?: WebSocketConstructor;
}

export interface CarrierPushReport {
  accepted: string[];
  quarantined: [string, string][];
  rejected: [string, string][];
  pending: string[];
}

export interface CarrierSyncClient {
  advertise(): Promise<string[]>;
  pull(have: string[]): Promise<unknown[]>;
  push(ops: unknown[]): Promise<CarrierPushReport>;
}

export interface CarrierStateReport {
  state_b64: string;
  op_ids: string[];
  frontier: string[];
  structural_quarantine: [string, string][];
  authority_quarantine: [string, string][];
  log_size: number;
}

export interface SyncCarrierResult {
  ops: Op[];
  pulledFrames: unknown[];
  pulledOps: Op[];
  pushedFrames: unknown[];
  pushReport: CarrierPushReport;
}

export interface CarrierOpFrame {
  v: number;
  id: string;
  replica: string;
  author: string;
  deps: string[];
  kind: OpKind;
  body: CarrierTerm;
  cap: CarrierTerm;
  sig: string;
}

export type CarrierTerm =
  | ["nil"]
  | ["bool", boolean]
  | ["int", number | string]
  | ["bin", string]
  | ["atom", string]
  | ["list", CarrierTerm[]]
  | ["tuple", CarrierTerm[]]
  | ["map", [CarrierTerm, CarrierTerm][]]
  | ["mapset", CarrierTerm[]]
  | ["delegation", CarrierDelegation];

export interface CarrierDelegation {
  id: string;
  replica: string;
  issuer: string;
  audience: string;
  parent_id: string | null;
  ops: string[];
  roles: string[];
  live: boolean;
  sig: string;
}

export function carrierDelegationsFromFrames(frames: readonly CarrierOpFrame[]): CarrierDelegation[] {
  return frames.flatMap((frame) => carrierDelegationsFromTerm(frame.body));
}

function carrierDelegationsFromTerm(term: CarrierTerm): CarrierDelegation[] {
  switch (term[0]) {
    case "delegation":
      return [term[1]];
    case "list":
    case "tuple":
    case "mapset":
      return term[1].flatMap(carrierDelegationsFromTerm);
    case "map":
      return term[1].flatMap(([key, value]) => [
        ...carrierDelegationsFromTerm(key),
        ...carrierDelegationsFromTerm(value),
      ]);
    case "nil":
    case "bool":
    case "int":
    case "bin":
    case "atom":
      return [];
  }
}

type DecodedTerm =
  | null
  | boolean
  | number
  | BinTerm
  | AtomTerm
  | ListTerm
  | TupleTerm
  | MapTerm
  | MapSetTerm
  | DelegationTerm;

interface BinTerm {
  type: "bin";
  bytes: Uint8Array;
  text: string;
}

interface AtomTerm {
  type: "atom";
  value: string;
}

interface ListTerm {
  type: "list";
  values: DecodedTerm[];
}

interface TupleTerm {
  type: "tuple";
  values: DecodedTerm[];
}

interface MapTerm {
  type: "map";
  pairs: [DecodedTerm, DecodedTerm][];
}

interface MapSetTerm {
  type: "mapset";
  values: DecodedTerm[];
}

interface DelegationTerm extends CarrierDelegation {
  type: "delegation";
}

interface Payload {
  field: string;
  mutation: Mutation;
  value: unknown;
  command: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const uint64Max = 18_446_744_073_709_551_615n;
const atomTag = 60_000;
const tupleTag = 60_001;
const carrierWireVersion = 1;

interface WebSocketConstructor {
  new (url: string): WebSocketLike;
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
}

export function carrierTranscriptBytes(
  challenge: CarrierChallenge,
  realm: string,
  pubkey: Uint8Array,
): Uint8Array {
  return canonicalTerm([
    "carrier-session-v1",
    challenge.local_realm,
    challenge.replica,
    challenge.nonce,
    challenge.wire_version,
    realm,
    pubkey,
  ]);
}

export function carrierTranscriptHex(
  challenge: CarrierChallenge,
  realm: string,
  pubkey: Uint8Array,
): string {
  return [...carrierTranscriptBytes(challenge, realm, pubkey)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function signCarrierChallenge(
  challenge: CarrierChallenge,
  signer: CarrierSigner,
): Promise<SignedCarrierChallenge> {
  const transcript = carrierTranscriptBytes(challenge, challenge.local_realm, signer.publicKey);
  const signature = await signer.sign(transcript);

  return {
    ...challenge,
    pubkey: bytesToBase64(signer.publicKey),
    signature: bytesToBase64(signature),
  };
}

export function carrierChallenge(
  localRealm: string,
  replica: string,
  opts: { wireVersion?: number; nonce?: string } = {},
): CarrierChallenge {
  return {
    type: "carrier_challenge",
    local_realm: localRealm,
    replica,
    nonce: opts.nonce ?? randomNonce(),
    wire_version: opts.wireVersion ?? carrierWireVersion,
  };
}

export async function verifyCarrierHello(
  challenge: CarrierChallenge,
  hello: unknown,
  expectedRealm: string,
  expectedPubkey: Uint8Array,
  verifier: CarrierVerifier,
): Promise<CarrierHello> {
  if (!hello || typeof hello !== "object") throw new Error("malformed carrier hello");
  const response = hello as Record<string, unknown>;

  if (
    response.type !== "carrier_hello" ||
    response.realm !== expectedRealm ||
    typeof response.pubkey !== "string" ||
    typeof response.signature !== "string"
  ) {
    throw new Error("malformed carrier hello");
  }

  const claimedPubkey = base64ToBytes(response.pubkey);
  if (!bytesEqual(claimedPubkey, expectedPubkey)) throw new Error("carrier hello pubkey mismatch");

  const signature = base64ToBytes(response.signature);
  const transcript = carrierTranscriptBytes(challenge, expectedRealm, expectedPubkey);
  if (!(await verifier.verify(expectedPubkey, transcript, signature))) {
    throw new Error("carrier hello bad signature");
  }

  return {
    type: "carrier_hello",
    realm: response.realm,
    pubkey: response.pubkey,
    signature: response.signature,
  };
}

export async function connectCarrierWebSocket(
  opts: ConnectCarrierWebSocketOptions,
): Promise<CarrierWebSocketClient> {
  const WebSocketImpl = opts.webSocket ?? defaultWebSocket();
  const socket = new WebSocketImpl(opts.url);
  await waitForOpen(socket);

  const client = new CarrierWebSocketClient(socket);
  const challenge =
    opts.wireVersion === undefined
      ? carrierChallenge(opts.localRealm, opts.replica)
      : carrierChallenge(opts.localRealm, opts.replica, { wireVersion: opts.wireVersion });
  const hello = await client.request(await signCarrierChallenge(challenge, opts.signer));

  await verifyCarrierHello(
    challenge,
    hello,
    opts.expectedPeerRealm,
    opts.expectedPeerPubkey,
    opts.verifier,
  );

  return client;
}

export class CarrierWebSocketClient {
  private queue: unknown[] = [];
  private waiters: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
  private closed = false;

  constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("error", (event) => this.failPending(event));
    socket.addEventListener("close", () => {
      this.closed = true;
      this.failPending(new Error("carrier websocket closed"));
    });
  }

  async advertise(): Promise<string[]> {
    const response = await this.request({ type: "frontier" });
    return stringListField(response, "ids", "frontier_result");
  }

  async pull(have: string[]): Promise<unknown[]> {
    const response = await this.request({ type: "pull", have: [...have].sort() });
    if (!hasType(response, "ops") || !Array.isArray(response.ops)) throw new Error("malformed carrier ops response");
    return response.ops;
  }

  async push(ops: unknown[]): Promise<CarrierPushReport> {
    const response = await this.request({ type: "push", ops });
    if (!hasType(response, "push_result")) throw new Error("malformed carrier push response");
    return decodePushReport(response);
  }

  async status(): Promise<string> {
    const response = await this.request({ type: "status" });
    if (!hasType(response, "status_result") || typeof response.phase !== "string") {
      throw new Error("malformed carrier status response");
    }
    return response.phase;
  }

  async stateReport(): Promise<CarrierStateReport> {
    const response = await this.request({ type: "state" });
    if (!hasType(response, "state_result")) throw new Error("malformed carrier state response");
    return decodeStateReport(response);
  }

  async shutdown(): Promise<void> {
    const response = await this.request({ type: "shutdown" });
    if (!hasType(response, "shutdown_result")) throw new Error("malformed carrier shutdown response");
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  async request(envelope: unknown): Promise<unknown> {
    if (this.closed) throw new Error("carrier websocket closed");

    const response = new Promise<unknown>((resolve, reject) => {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        resolve(queued);
      } else {
        this.waiters.push({ resolve, reject });
      }
    });

    this.socket.send(JSON.stringify(envelope));
    const decoded = await response;
    if (hasType(decoded, "error")) throw new Error(`carrier peer error: ${String(decoded.reason)}`);
    return decoded;
  }

  private receive(data: unknown): void {
    const decoded = decodeEnvelope(data);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(decoded);
    else this.queue.push(decoded);
  }

  private failPending(reason: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }
}

export async function syncCarrierOnce(
  client: CarrierSyncClient,
  localOps: Op[],
  localCarrierFrames: unknown[],
  realmByPubkey: Record<string, string> = {},
): Promise<SyncCarrierResult> {
  const peerIds = new Set(await client.advertise());
  const pulledFrames = await client.pull(localOps.map((op) => op.id));
  const pulledOps = carrierOpsToSemanticOps(pulledFrames, realmByPubkey);

  const pushedFrames = localCarrierFrames.filter((frame) => {
    const op = carrierOpToSemanticOp(frame, realmByPubkey);
    return !peerIds.has(op.id);
  });

  const pushReport =
    pushedFrames.length === 0
      ? emptyPushReport()
      : await client.push(pushedFrames);

  return {
    ops: integrate(localOps, pulledOps),
    pulledFrames,
    pulledOps,
    pushedFrames,
    pushReport,
  };
}

export function carrierOpsToSemanticOps(
  frames: unknown[],
  realmByPubkey: Record<string, string> = {},
): Op[] {
  return frames.map((frame) => carrierOpToSemanticOp(frame, realmByPubkey));
}

export function carrierOpToSemanticOp(
  frame: unknown,
  realmByPubkey: Record<string, string> = {},
): Op {
  const op = assertCarrierOpFrame(frame);
  const body = decodeCarrierTerm(op.body);
  const payload = payloadFromBody(op.kind, body, realmByPubkey);

  return {
    id: op.id,
    deps: op.deps,
    kind: op.kind,
    author: realmForPubkey(op.author, realmByPubkey),
    field: payload.field,
    mutation: payload.mutation,
    value: payload.value,
    hash: op.id,
    command: payload.command,
  };
}

function canonicalTerm(value: unknown): Uint8Array {
  if (value === null) return bytes(0xf6);
  if (value === false) return bytes(0xf4);
  if (value === true) return bytes(0xf5);

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`unsupported canonical integer: ${value}`);
    return major(0, BigInt(value));
  }

  if (typeof value === "string") {
    const encoded = textEncoder.encode(value);
    return concat(major(2, BigInt(encoded.length)), encoded);
  }

  if (value instanceof Uint8Array) {
    return concat(major(2, BigInt(value.length)), value);
  }

  if (Array.isArray(value)) {
    return concat(major(4, BigInt(value.length)), ...value.map(canonicalTerm));
  }

  throw new Error(`unsupported canonical term: ${String(value)}`);
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

function canonicalAtom(value: string): Uint8Array {
  return concat(major(6, BigInt(atomTag)), canonicalTerm(value));
}

function canonicalTuple(values: unknown[]): Uint8Array {
  return concat(major(6, BigInt(tupleTag)), canonicalTerm(values));
}

function decodeCarrierTerm(term: CarrierTerm): DecodedTerm {
  const [tag] = term;

  switch (tag) {
    case "nil":
      return null;
    case "bool":
      return term[1];
    case "int": {
      const value = term[1];
      return typeof value === "number" ? value : Number.parseInt(value, 10);
    }
    case "bin": {
      const bytes = base64ToBytes(term[1]);
      return { type: "bin", bytes, text: textDecoder.decode(bytes) };
    }
    case "atom":
      return { type: "atom", value: term[1] };
    case "list":
      return { type: "list", values: term[1].map(decodeCarrierTerm) };
    case "tuple":
      return { type: "tuple", values: term[1].map(decodeCarrierTerm) };
    case "map":
      return { type: "map", pairs: term[1].map(([key, value]) => [decodeCarrierTerm(key), decodeCarrierTerm(value)]) };
    case "mapset":
      return { type: "mapset", values: term[1].map(decodeCarrierTerm) };
    case "delegation":
      return { type: "delegation", ...term[1] };
  }
}

function payloadFromBody(
  kind: OpKind,
  body: DecodedTerm,
  realmByPubkey: Record<string, string>,
): Payload {
  if (kind === "command" && isTuple(body)) {
    const command = atomName(body.values[0]);
    const args = listValues(body.values[1]);

    switch (command) {
      case "set_title":
        return { field: "title", mutation: "write", value: binText(args[0]), command };
      case "set_summary":
        return { field: "summary", mutation: "write", value: binText(args[0]), command };
      case "post":
        return { field: "posts", mutation: "append", value: binText(args[0]), command };
      case "admit":
        return { field: "members", mutation: "add", value: binText(args[0]), command };
      case "remove_member":
        return { field: "members", mutation: "remove", value: binText(args[0]), command };
      case "close_matter":
        return { field: "clerk_locked", mutation: "write", value: true, command };
      case "reopen_matter":
        return { field: "clerk_locked", mutation: "write", value: false, command };
    }
  }

  if (kind === "authority" && isTuple(body)) {
    const command = atomName(body.values[0]);

    switch (command) {
      case "genesis": {
        const delegation = delegationTerm(body.values[1]);
        if (delegation.roles.includes("clerk")) {
          return {
            field: "clerk",
            mutation: "write",
            value: realmForPubkey(delegation.issuer, realmByPubkey),
            command: "genesis clerk",
          };
        }
        return neutralPayload("genesis");
      }
      case "transfer": {
        const role = atomName(body.values[1]);
        const delegation = delegationTerm(body.values[2]);
        return {
          field: role,
          mutation: "write",
          value: realmForPubkey(delegation.audience, realmByPubkey),
          command: `transfer ${role}`,
        };
      }
      case "succeed": {
        const role = atomName(body.values[1]);
        const delegation = delegationTerm(body.values[2]);
        return {
          field: role,
          mutation: "write",
          value: realmForPubkey(delegation.audience, realmByPubkey),
          command: `succeed ${role}`,
        };
      }
      case "grant": {
        const delegation = delegationTerm(body.values[1]);
        return neutralPayload(`grant ${realmForPubkey(delegation.audience, realmByPubkey)}`);
      }
      case "revoke":
        return neutralPayload(`revoke ${String(body.values[1])}`);
    }
  }

  return neutralPayload(kind);
}

function neutralPayload(command: string): Payload {
  return { field: "__authority", mutation: "write", value: null, command };
}

function assertCarrierOpFrame(frame: unknown): CarrierOpFrame {
  if (!frame || typeof frame !== "object") throw new Error("malformed carrier op");
  const op = frame as Record<string, unknown>;

  if (
    op.v !== 1 ||
    typeof op.id !== "string" ||
    typeof op.replica !== "string" ||
    typeof op.author !== "string" ||
    !Array.isArray(op.deps) ||
    !op.deps.every((dep) => typeof dep === "string") ||
    !isOpKind(op.kind) ||
    !Array.isArray(op.body) ||
    !Array.isArray(op.cap) ||
    typeof op.sig !== "string"
  ) {
    throw new Error("malformed carrier op");
  }

  return op as unknown as CarrierOpFrame;
}

function isOpKind(value: unknown): value is OpKind {
  return value === "command" || value === "authority" || value === "inbox" || value === "tombstone";
}

function isTuple(term: DecodedTerm): term is TupleTerm {
  return typeof term === "object" && term !== null && "type" in term && term.type === "tuple";
}

function atomName(term: DecodedTerm | undefined): string {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "atom") return term.value;
  throw new Error("expected atom term");
}

function listValues(term: DecodedTerm | undefined): DecodedTerm[] {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "list") return term.values;
  throw new Error("expected list term");
}

function binText(term: DecodedTerm | undefined): string {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "bin") return term.text;
  throw new Error("expected bin term");
}

function delegationTerm(term: DecodedTerm | undefined): DelegationTerm {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "delegation") return term;
  throw new Error("expected delegation term");
}

function realmForPubkey(pubkeyBase64: string, realmByPubkey: Record<string, string>): string {
  return realmByPubkey[pubkeyBase64] ?? pubkeyBase64;
}

function defaultWebSocket(): WebSocketConstructor {
  const WebSocketImpl = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocketImpl) throw new Error("WebSocket unavailable; pass a WebSocket implementation");
  return WebSocketImpl;
}

function waitForOpen(socket: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
}

function decodeEnvelope(data: unknown): unknown {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof Uint8Array) return JSON.parse(textDecoder.decode(data));
  if (data instanceof ArrayBuffer) return JSON.parse(textDecoder.decode(new Uint8Array(data)));
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  throw new Error("unsupported carrier frame data");
}

function hasType(value: unknown, type: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).type === type;
}

function stringListField(value: unknown, field: string, type: string): string[] {
  if (!hasType(value, type)) throw new Error(`malformed carrier ${type} response`);
  const list = value[field];
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new Error(`malformed carrier ${field} list`);
  }
  return list;
}

function decodePushReport(value: Record<string, unknown>): CarrierPushReport {
  return {
    accepted: stringList(value.accepted, "accepted"),
    quarantined: reasonPairs(value.quarantined, "quarantined"),
    rejected: reasonPairs(value.rejected, "rejected"),
    pending: stringList(value.pending, "pending"),
  };
}

function emptyPushReport(): CarrierPushReport {
  return { accepted: [], quarantined: [], rejected: [], pending: [] };
}

function decodeStateReport(value: Record<string, unknown>): CarrierStateReport {
  if (
    typeof value.state_b64 !== "string" ||
    !Array.isArray(value.op_ids) ||
    !value.op_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.frontier) ||
    !value.frontier.every((id) => typeof id === "string") ||
    typeof value.log_size !== "number"
  ) {
    throw new Error("malformed carrier state response");
  }

  return {
    state_b64: value.state_b64,
    op_ids: value.op_ids,
    frontier: value.frontier,
    structural_quarantine: reasonPairs(value.structural_quarantine, "structural_quarantine"),
    authority_quarantine: reasonPairs(value.authority_quarantine, "authority_quarantine"),
    log_size: value.log_size,
  };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`malformed carrier ${field} list`);
  }
  return value;
}

function reasonPairs(value: unknown, field: string): [string, string][] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is [string, string] =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        typeof item[1] === "string",
    )
  ) {
    throw new Error(`malformed carrier ${field} pairs`);
  }
  return value;
}

function randomNonce(): string {
  const cryptoObj = (globalThis as unknown as {
    crypto?: { getRandomValues?: <T extends Uint8Array>(array: T) => T };
  }).crypto;
  if (!cryptoObj?.getRandomValues) throw new Error("crypto.getRandomValues unavailable");
  const nonce = cryptoObj.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(nonce);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
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

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...value));
}

function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Keep these helpers typechecked against the Elixir tag constants; they are used
// by future carrier-session tests for authority payloads.
void canonicalAtom;
void canonicalTuple;
