import type {
  AuthorityDelegationEvidence,
  AuthorityEvidence,
  CommandError,
  CustodyConsentEvidence,
  Mutation,
  Op,
  OpKind,
  SuccessionProofEvidence,
  SuccessionPolicyEvidence,
  WitnessedRecoveryPolicyEvidence,
  WitnessedSuccessionCertificateEvidence,
  WitnessedSuccessionClaimEvidence,
  WitnessedSuccessionSignatureEvidence,
} from "./op";
import { verifyCarrierOp } from "./codec";
import type { Verifier } from "./identity";
import { integrate } from "./sync";

export interface CarrierChallenge {
  type: "carrier_challenge";
  local_realm: string;
  replica: string;
  nonce: string;
  server_nonce: string;
  wire_version: number;
  session_version: number;
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
  sessionVersion?: number;
  webSocket?: WebSocketConstructor;
}

export interface CarrierPushReport {
  accepted: string[];
  quarantined: [string, string][];
  rejected: [string, string][];
  pending: string[];
}

export interface CarrierAvailability {
  generation: number;
  frontier: string[];
  frontierTruncated: boolean;
}

export interface CarrierAvailabilitySubscription {
  readonly baseline: CarrierAvailability;
  next(): Promise<CarrierAvailability>;
  unsubscribe(): Promise<void>;
}

export interface CarrierSyncClient {
  advertise(): Promise<string[]>;
  pull(have: string[]): Promise<unknown[]>;
  push(ops: unknown[]): Promise<CarrierPushReport>;
}

export interface CarrierRelayClient {
  relay(op: CarrierOpFrame): Promise<CarrierPushReport>;
}

export type CarrierSubmission = "push" | "relay";

export interface SyncCarrierOptions {
  verifier: Verifier;
  submission?: CarrierSubmission;
  expectedReplica: string;
}

export interface CarrierStateReport {
  state_b64: string;
  state?: Record<string, unknown>;
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
  acknowledgedFrameIds: string[];
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
  /** Plan 149 lease — on the wire only when set. */
  expires_epoch?: number;
}

export function carrierDelegationsFromFrames(frames: readonly CarrierOpFrame[]): CarrierDelegation[] {
  return frames.flatMap((frame) => carrierDelegationsFromTerm(frame.body));
}

function carrierDelegationsFromTerm(term: CarrierTerm): CarrierDelegation[] {
  switch (term[0]) {
    case "delegation":
      return isCarrierDelegation(term[1]) ? [term[1]] : [];
    case "list":
    case "tuple":
    case "mapset":
      return Array.isArray(term[1])
        ? term[1].flatMap(carrierDelegationsFromTerm)
        : [];
    case "map":
      return Array.isArray(term[1])
        ? term[1].flatMap((pair) =>
            Array.isArray(pair) && pair.length === 2
              ? [
                  ...carrierDelegationsFromTerm(pair[0]),
                  ...carrierDelegationsFromTerm(pair[1]),
                ]
              : []
          )
        : [];
    case "nil":
    case "bool":
    case "int":
    case "bin":
    case "atom":
      return [];
  }

  return [];
}

function isCarrierDelegation(value: unknown): value is CarrierDelegation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const field = (key: string): unknown => Reflect.get(value, key);
  const expiresEpoch = field("expires_epoch");
  return (
    typeof field("id") === "string" &&
    typeof field("replica") === "string" &&
    typeof field("issuer") === "string" &&
    typeof field("audience") === "string" &&
    (field("parent_id") === null ||
      typeof field("parent_id") === "string") &&
    isStringArray(field("ops")) &&
    isStringArray(field("roles")) &&
    typeof field("live") === "boolean" &&
    typeof field("sig") === "string" &&
    (expiresEpoch === undefined ||
      (typeof expiresEpoch === "number" &&
        Number.isSafeInteger(expiresEpoch) &&
        expiresEpoch >= 0))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
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
  commandError?: CommandError;
  authority?: AuthorityEvidence;
  consent?: Omit<CustodyConsentEvidence, "authorPub">;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
const uint64Max = 18_446_744_073_709_551_615n;
const atomTag = 60_000;
const tupleTag = 60_001;
const carrierOpWireVersion = 1;
const carrierSessionVersion = 2;

interface CommandDecoder {
  arity: number;
  decode: (
    args: DecodedTerm[],
    realmByPubkey: Record<string, string>,
  ) => Payload;
}

function commandDecoder(
  arity: number,
  decode: CommandDecoder["decode"],
): CommandDecoder {
  return { arity, decode };
}

const townshipCommandDecoders: ReadonlyMap<string, CommandDecoder> = new Map([
  [
    "set_title",
    commandDecoder(1, (args) => ({
      field: "title",
      mutation: "write",
      value: commandValue(args[0]),
      command: "set_title",
    })),
  ],
  [
    "set_summary",
    commandDecoder(1, (args) => ({
      field: "summary",
      mutation: "write",
      value: commandValue(args[0]),
      command: "set_summary",
    })),
  ],
  [
    "post",
    commandDecoder(1, (args) => ({
      field: "posts",
      mutation: "append",
      value: commandValue(args[0]),
      command: "post",
    })),
  ],
  [
    "admit",
    commandDecoder(1, (args) => ({
      field: "members",
      mutation: "add",
      value: commandValue(args[0]),
      command: "admit",
    })),
  ],
  [
    "remove_member",
    commandDecoder(1, (args) => ({
      field: "members",
      mutation: "remove",
      value: commandValue(args[0]),
      command: "remove_member",
    })),
  ],
  ["link_election", commandDecoder(1, () => neutralPayload("link_election"))],
  [
    "close_matter",
    commandDecoder(0, () => ({
      field: "clerk_locked",
      mutation: "write",
      value: true,
      command: "close_matter",
    })),
  ],
  [
    "reopen_matter",
    commandDecoder(0, () => ({
      field: "clerk_locked",
      mutation: "write",
      value: false,
      command: "reopen_matter",
    })),
  ],
]);

const toolshedCommandDecoders: ReadonlyMap<string, CommandDecoder> = new Map([
  [
    "describe",
    commandDecoder(1, (args) => ({
      field: "description",
      mutation: "write",
      value: commandValue(args[0]),
      command: "describe",
    })),
  ],
  [
    "note_condition",
    commandDecoder(1, (args) => ({
      field: "condition_notes",
      mutation: "append",
      value: commandValue(args[0]),
      command: "note_condition",
    })),
  ],
  [
    "custody_transfer",
    commandDecoder(3, (args, realmByPubkey) => {
      // ADR 0007: the holder write projects the recipient's realm; the
      // request id and consent signature ride as validity evidence for the
      // consent conjunct (src/consent.ts), never as state.
      const toBytes = binaryBytes(args[0]);
      const toPub = toBytes === null ? "" : bytesToBase64(toBytes);
      const requestOpId = binaryUtf8(args[1]) ?? "";
      const signatureBytes = binaryBytes(args[2]);
      const signatureMissing = args[2] === null || signatureBytes === null;
      return {
        field: "holder",
        mutation: "write",
        value:
          toBytes === null
            ? commandValue(args[0])
            : realmForPubkey(toPub, realmByPubkey),
        command: "custody_transfer",
        consent: {
          toPub,
          requestOpId,
          sig:
            signatureMissing
              ? null
              : bytesToBase64(signatureBytes),
        },
      };
    }),
  ],
]);

/** Command names decoded for the Township matter carrier boundary. */
export function townshipCarrierCommandNames(): string[] {
  return [...townshipCommandDecoders.keys()].sort();
}

/** Command names and arities decoded for the Township matter carrier boundary. */
export function townshipCarrierCommandTable(): [string, number][] {
  return commandTable(townshipCommandDecoders);
}

/** Command names decoded for the Toolshed tool carrier boundary. */
export function toolshedCarrierCommandNames(): string[] {
  return [...toolshedCommandDecoders.keys()].sort();
}

/** Command names and arities decoded for the Toolshed tool carrier boundary. */
export function toolshedCarrierCommandTable(): [string, number][] {
  return commandTable(toolshedCommandDecoders);
}

function commandTable(
  decoders: ReadonlyMap<string, CommandDecoder>,
): [string, number][] {
  return [...decoders]
    .map(([name, decoder]): [string, number] => [name, decoder.arity])
    .sort(([left], [right]) => left.localeCompare(right));
}

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
    "carrier-session-v2",
    challenge.local_realm,
    challenge.replica,
    challenge.nonce,
    challenge.server_nonce,
    challenge.wire_version,
    challenge.session_version,
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
  opts: {
    serverNonce: string;
    wireVersion?: number;
    sessionVersion?: number;
    nonce?: string;
  },
): CarrierChallenge {
  return {
    type: "carrier_challenge",
    local_realm: localRealm,
    replica,
    nonce: opts.nonce ?? randomNonce(),
    server_nonce: opts.serverNonce,
    wire_version: opts.wireVersion ?? carrierOpWireVersion,
    session_version: opts.sessionVersion ?? carrierSessionVersion,
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
  const client = new CarrierWebSocketClient(socket);
  const wireVersion = opts.wireVersion ?? carrierOpWireVersion;
  const sessionVersion = opts.sessionVersion ?? carrierSessionVersion;
  const serverNoncePromise = client.receiveServerNonce(wireVersion, sessionVersion);

  try {
    const [, serverNonce] = await Promise.all([waitForOpen(socket), serverNoncePromise]);
    const challenge = carrierChallenge(opts.localRealm, opts.replica, {
      serverNonce,
      wireVersion,
      sessionVersion,
    });
    const hello = await client.request(await signCarrierChallenge(challenge, opts.signer));

    await verifyCarrierHello(
      challenge,
      hello,
      opts.expectedPeerRealm,
      opts.expectedPeerPubkey,
      opts.verifier,
    );

    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class CarrierAvailabilityRoute implements CarrierAvailabilitySubscription {
  private baselineValue: CarrierAvailability | null = null;
  private retained: CarrierAvailability | null = null;
  private highestGeneration: number | null = null;
  private waiter: {
    resolve: (availability: CarrierAvailability) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private closedReason: unknown | null = null;
  private unsubscribePromise: Promise<void> | null = null;

  constructor(
    private readonly unsubscribeRoute: (route: CarrierAvailabilityRoute) => Promise<void>,
  ) {}

  get baseline(): CarrierAvailability {
    if (!this.baselineValue) throw new Error("carrier availability subscription not established");
    return this.baselineValue;
  }

  establish(baseline: CarrierAvailability): void {
    this.baselineValue = baseline;

    if (this.retained && this.retained.generation <= baseline.generation) {
      this.retained = null;
    }

    this.highestGeneration = Math.max(
      baseline.generation,
      this.highestGeneration ?? baseline.generation,
    );
  }

  offer(availability: CarrierAvailability): void {
    if (this.closedReason !== null) return;

    if (this.highestGeneration !== null) {
      if (availability.generation < this.highestGeneration) {
        throw new Error("carrier availability generation regressed");
      }
      if (availability.generation === this.highestGeneration) return;
    }

    this.highestGeneration = availability.generation;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(availability);
    } else {
      this.retained = availability;
    }
  }

  next(): Promise<CarrierAvailability> {
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    if (this.retained) {
      const availability = this.retained;
      this.retained = null;
      return Promise.resolve(availability);
    }
    if (this.waiter) return Promise.reject(new Error("carrier availability receive already in flight"));

    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  unsubscribe(): Promise<void> {
    if (!this.unsubscribePromise) {
      this.unsubscribePromise = this.unsubscribeRoute(this).catch((error: unknown) => {
        this.unsubscribePromise = null;
        throw error;
      });
    }
    return this.unsubscribePromise;
  }

  close(reason: unknown): void {
    if (this.closedReason !== null) return;

    this.closedReason = reason;
    this.retained = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(reason);
  }
}

export class CarrierWebSocketClient {
  private pendingServerNonce: {
    expectedWireVersion: number;
    expectedSessionVersion: number;
    resolve: (nonce: string) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private pendingRequest: {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private availabilityRoute: CarrierAvailabilityRoute | null = null;
  private closed = false;

  constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("error", (event) =>
      this.failClient(event instanceof Error ? event : new Error("carrier websocket error")),
    );
    socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("carrier websocket closed");
      this.rejectServerNonce(error);
      this.rejectPending(error);
      this.closeAvailability(error);
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

  async relay(op: CarrierOpFrame): Promise<CarrierPushReport> {
    const response = await this.request({ type: "relay", op });
    if (!hasType(response, "relay_result")) throw new Error("malformed carrier relay response");
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

  async subscribeAvailability(): Promise<CarrierAvailabilitySubscription> {
    if (this.closed) throw new Error("carrier websocket closed");
    if (this.availabilityRoute) throw new Error("carrier availability subscription already active");

    const route = new CarrierAvailabilityRoute((activeRoute) =>
      this.unsubscribeAvailability(activeRoute),
    );
    this.availabilityRoute = route;

    try {
      const response = await this.request({ type: "subscribe" });
      let baseline: CarrierAvailability;
      try {
        baseline = decodeAvailability(response, "subscribe_result");
      } catch (error) {
        this.failClient(error);
        throw error;
      }
      route.establish(baseline);
      return route;
    } catch (error) {
      if (this.availabilityRoute === route) this.availabilityRoute = null;
      route.close(error);
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectServerNonce(new Error("carrier websocket closed"));
    this.rejectPending(new Error("carrier websocket closed"));
    this.closeAvailability(new Error("carrier websocket closed"));
    this.socket.close();
  }

  receiveServerNonce(expectedWireVersion: number, expectedSessionVersion: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("carrier websocket closed"));
    if (this.pendingServerNonce) return Promise.reject(new Error("carrier nonce receive already in flight"));
    if (this.pendingRequest) return Promise.reject(new Error("carrier request already in flight"));

    return new Promise((resolve, reject) => {
      this.pendingServerNonce = {
        expectedWireVersion,
        expectedSessionVersion,
        resolve,
        reject,
      };
    });
  }

  async request(envelope: unknown): Promise<unknown> {
    if (this.closed) throw new Error("carrier websocket closed");
    if (this.pendingServerNonce) throw new Error("carrier session setup in flight");
    if (this.pendingRequest) throw new Error("carrier request already in flight");

    let pending: NonNullable<CarrierWebSocketClient["pendingRequest"]>;
    const response = new Promise<unknown>((resolve, reject) => {
      pending = { resolve, reject };
      this.pendingRequest = pending;

      try {
        this.socket.send(JSON.stringify(envelope));
      } catch (error) {
        if (this.pendingRequest === pending) {
          this.pendingRequest = null;
          reject(error);
        }
      }
    });

    const decoded = await response;
    if (hasType(decoded, "error")) throw new Error(`carrier peer error: ${String(decoded.reason)}`);
    return decoded;
  }

  private receive(data: unknown): void {
    let decoded: unknown;
    try {
      decoded = decodeEnvelope(data);
    } catch {
      this.failClient(new Error("malformed carrier envelope"));
      return;
    }

    if (hasType(decoded, "ops_available")) {
      const route = this.availabilityRoute;
      if (!route) {
        this.failClient(new Error("unexpected carrier notification"));
        return;
      }

      try {
        route.offer(decodeAvailability(decoded, "ops_available"));
      } catch (error) {
        this.failClient(error);
      }
      return;
    }

    const pendingServerNonce = this.pendingServerNonce;
    if (pendingServerNonce) {
      this.pendingServerNonce = null;
      try {
        pendingServerNonce.resolve(
          decodeCarrierNonce(
            decoded,
            pendingServerNonce.expectedWireVersion,
            pendingServerNonce.expectedSessionVersion,
          ),
        );
      } catch (error) {
        pendingServerNonce.reject(error);
        this.failClient(error);
      }
      return;
    }

    const pending = this.pendingRequest;
    if (!pending) {
      this.failClient(new Error("unexpected carrier response"));
      return;
    }

    this.pendingRequest = null;
    pending.resolve(decoded);
  }

  private rejectPending(reason: unknown): void {
    const pending = this.pendingRequest;
    if (!pending) return;

    this.pendingRequest = null;
    pending.reject(reason);
  }

  private rejectServerNonce(reason: unknown): void {
    const pending = this.pendingServerNonce;
    if (!pending) return;

    this.pendingServerNonce = null;
    pending.reject(reason);
  }

  private failClient(reason: unknown): void {
    this.rejectServerNonce(reason);
    this.rejectPending(reason);
    this.closeAvailability(reason);
    if (this.closed) return;

    this.closed = true;
    this.socket.close();
  }

  private async unsubscribeAvailability(route: CarrierAvailabilityRoute): Promise<void> {
    if (this.availabilityRoute !== route) return;

    const response = await this.request({ type: "unsubscribe" });
    if (!hasType(response, "unsubscribe_result")) {
      const error = new Error("malformed carrier unsubscribe response");
      this.failClient(error);
      throw error;
    }

    if (this.availabilityRoute === route) {
      this.availabilityRoute = null;
      route.close(new Error("carrier availability subscription closed"));
    }
  }

  private closeAvailability(reason: unknown): void {
    const route = this.availabilityRoute;
    if (!route) return;

    this.availabilityRoute = null;
    route.close(reason);
  }
}

export async function syncCarrierOnce(
  client: CarrierSyncClient,
  localOps: Op[],
  localCarrierFrames: unknown[],
  realmByPubkey: Record<string, string> = {},
  options: SyncCarrierOptions,
): Promise<SyncCarrierResult> {
  const peerIds = new Set(await client.advertise());
  const pulledFrames = await client.pull(localOps.map((op) => op.id));
  const pulledCarrierFrames = pulledFrames.map(decodeCarrierOpFrame);

  for (const frame of pulledCarrierFrames) {
    if (frame.replica !== options.expectedReplica) {
      throw new Error(
        `carrier served foreign replica ${frame.replica}; expected ${options.expectedReplica}`,
      );
    }
    const verification = await verifyCarrierOp(frame, options.verifier);
    if (!verification.valid) throw new Error(`carrier op verification failed: ${frame.id}`);
  }

  const pulledOps = carrierOpsToSemanticOps(pulledCarrierFrames, realmByPubkey);
  const peerKnownFrameIds: string[] = [];

  const candidateFrames = localCarrierFrames.filter((frame) => {
    const op = carrierOpToSemanticOp(frame, realmByPubkey);
    if (!peerIds.has(op.id)) return true;
    peerKnownFrameIds.push(carrierFrameId(frame));
    return false;
  });

  const submission = options.submission ?? "push";
  const submitted = await submitCarrierFrames(client, candidateFrames, submission);
  const acknowledgedFrameIds = [
    ...new Set([
      ...peerKnownFrameIds,
      ...submitted.pushReport.accepted,
      ...submitted.confirmedDuplicateIds,
    ]),
  ];

  return {
    ops: integrate(localOps, pulledOps),
    pulledFrames,
    pulledOps,
    pushedFrames: submitted.pushedFrames,
    pushReport: submitted.pushReport,
    acknowledgedFrameIds,
  };
}

interface CarrierSubmissionResult {
  pushedFrames: unknown[];
  pushReport: CarrierPushReport;
  confirmedDuplicateIds: string[];
}

async function submitCarrierFrames(
  client: CarrierSyncClient,
  frames: unknown[],
  submission: CarrierSubmission,
): Promise<CarrierSubmissionResult> {
  if (submission === "push") {
    return {
      pushedFrames: frames,
      pushReport: frames.length === 0 ? emptyPushReport() : await client.push(frames),
      confirmedDuplicateIds: [],
    };
  }

  if (!canRelay(client)) throw new Error("carrier sync client does not support relay");

  const pushedFrames = stableCausalCarrierFrames(frames);
  const pushReport = emptyPushReport();
  const confirmedDuplicateIds: string[] = [];

  for (const frame of pushedFrames) {
    const report = await client.relay(frame);
    appendPushReport(pushReport, report);

    if (pushReportEmpty(report)) {
      const advertisedIds = new Set(await client.advertise());
      if (advertisedIds.has(frame.id)) confirmedDuplicateIds.push(frame.id);
    }
  }

  return { pushedFrames, pushReport, confirmedDuplicateIds };
}

function canRelay(client: CarrierSyncClient): client is CarrierSyncClient & CarrierRelayClient {
  return typeof (client as Partial<CarrierRelayClient>).relay === "function";
}

function stableCausalCarrierFrames(frames: unknown[]): CarrierOpFrame[] {
  const ops = frames.map((frame) => assertCarrierOpFrame(frame, false));
  const firstIndexById = new Map<string, number>();
  for (const [index, op] of ops.entries()) {
    if (!firstIndexById.has(op.id)) firstIndexById.set(op.id, index);
  }

  const indegree = ops.map(() => 0);
  const dependents = ops.map(() => [] as number[]);
  for (const [index, op] of ops.entries()) {
    const localDependencies = new Set<number>();
    for (const dependencyId of op.deps) {
      const dependencyIndex = firstIndexById.get(dependencyId);
      if (dependencyIndex !== undefined) localDependencies.add(dependencyIndex);
    }
    indegree[index] = localDependencies.size;
    for (const dependencyIndex of localDependencies) dependents[dependencyIndex]?.push(index);
  }

  const ready = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
  const ordered: CarrierOpFrame[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => left - right);
    const index = ready.shift();
    if (index === undefined) break;
    ordered.push(ops[index] as CarrierOpFrame);

    for (const dependent of dependents[index] ?? []) {
      indegree[dependent] = (indegree[dependent] ?? 0) - 1;
      if (indegree[dependent] === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== ops.length) throw new Error("carrier frame dependency cycle");
  return ordered;
}

function appendPushReport(target: CarrierPushReport, report: CarrierPushReport): void {
  target.accepted.push(...report.accepted);
  target.quarantined.push(...report.quarantined);
  target.rejected.push(...report.rejected);
  target.pending.push(...report.pending);
}

function pushReportEmpty(report: CarrierPushReport): boolean {
  return (
    report.accepted.length === 0 &&
    report.quarantined.length === 0 &&
    report.rejected.length === 0 &&
    report.pending.length === 0
  );
}

function carrierFrameId(frame: unknown): string {
  if (frame && typeof frame === "object" && typeof (frame as { id?: unknown }).id === "string") {
    return (frame as { id: string }).id;
  }

  throw new Error("carrier frame missing id");
}

export function carrierOpsToSemanticOps(
  frames: unknown[],
  realmByPubkey: Record<string, string> = {},
): Op[] {
  return frames.map((frame) => carrierOpToSemanticOp(frame, realmByPubkey));
}

export function decodeCarrierOpFrame(frame: unknown): CarrierOpFrame {
  return assertCarrierOpFrame(frame, true);
}

export function carrierOpToSemanticOp(
  frame: unknown,
  realmByPubkey: Record<string, string> = {},
): Op {
  const op = assertCarrierOpFrame(frame, false);
  let payload: Payload;
  let cap: string | null;
  let structuralError: "malformed_term" | undefined;
  try {
    const body = decodeCarrierTerm(op.body);
    payload = payloadFromBody(op.kind, body, realmByPubkey);
    cap = capabilityId(decodeCarrierTerm(op.cap));
  } catch {
    payload = neutralPayload("malformed_term");
    cap = null;
    structuralError = "malformed_term";
  }

  return {
    id: op.id,
    replica: op.replica,
    deps: op.deps,
    kind: op.kind,
    author: realmForPubkey(op.author, realmByPubkey),
    field: payload.field,
    mutation: payload.mutation,
    value: payload.value,
    hash: op.id,
    command: payload.command,
    ...(payload.commandError === undefined
      ? {}
      : { commandError: payload.commandError }),
    ...(structuralError === undefined ? {} : { structuralError }),
    cap,
    ...(payload.authority === undefined ? {} : { authority: payload.authority }),
    ...(payload.consent === undefined
      ? {}
      : { consent: { ...payload.consent, authorPub: op.author } }),
  };
}

/**
 * Deterministic `Lattice.Canonical` bytes for the JS value subset the client
 * signs over (nil/bool/uint/string/bytes/array). Strings and byte arrays both
 * encode as CBOR major-2, exactly like Elixir binaries.
 */
export function canonicalTerm(value: unknown): Uint8Array {
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
  const expectedLength = tag === "nil" ? 1 : 2;
  if (term.length !== expectedLength) {
    throw new Error("malformed carrier term arity");
  }

  switch (tag) {
    case "nil":
      return null;
    case "bool":
      if (typeof term[1] !== "boolean") throw new Error("malformed bool term");
      return term[1];
    case "int": {
      return parseCarrierInteger(term[1]);
    }
    case "bin": {
      if (typeof term[1] !== "string") throw new Error("malformed binary term");
      const bytes = base64ToBytes(term[1]);
      return { type: "bin", bytes, text: textDecoder.decode(bytes) };
    }
    case "atom": {
      if (typeof term[1] !== "string") throw new Error("malformed atom term");
      return { type: "atom", value: term[1] };
    }
    case "list": {
      if (!Array.isArray(term[1])) throw new Error("malformed list term");
      return { type: "list", values: term[1].map(decodeCarrierTerm) };
    }
    case "tuple": {
      if (!Array.isArray(term[1])) throw new Error("malformed tuple term");
      return { type: "tuple", values: term[1].map(decodeCarrierTerm) };
    }
    case "map": {
      if (!Array.isArray(term[1])) throw new Error("malformed map term");
      return {
        type: "map",
        pairs: term[1].map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2) {
            throw new Error("malformed map pair");
          }
          return [
            decodeCarrierTerm(pair[0]),
            decodeCarrierTerm(pair[1]),
          ];
        }),
      };
    }
    case "mapset": {
      if (!Array.isArray(term[1])) throw new Error("malformed mapset term");
      return { type: "mapset", values: term[1].map(decodeCarrierTerm) };
    }
    case "delegation": {
      if (!isCarrierDelegation(term[1])) {
        throw new Error("malformed delegation term");
      }
      base64ToBytes(term[1].issuer);
      base64ToBytes(term[1].audience);
      base64ToBytes(term[1].sig);
      return { ...term[1], type: "delegation" };
    }
  }

  throw new Error("malformed carrier term");
}

function payloadFromBody(
  kind: OpKind,
  body: DecodedTerm,
  realmByPubkey: Record<string, string>,
): Payload {
  if (kind === "command") {
    if (!isTuple(body) || body.values.length !== 2) {
      return neutralPayload("command", "malformed_command");
    }

    const args = listValuesOrNull(body.values[1]);
    if (args === null) {
      return neutralPayload("command", "malformed_command");
    }

    const command = atomValue(body.values[0]);
    if (command === null) {
      return body.values[0] === null
        ? neutralPayload("malformed_command", "malformed_command")
        : neutralPayload(commandAuditLabel(body.values[0]), "unknown_command");
    }

    const decoder =
      townshipCommandDecoders.get(command) ??
      toolshedCommandDecoders.get(command);
    if (decoder === undefined) {
      return neutralPayload(command, "unknown_command");
    }
    if (args.length !== decoder.arity) {
      return neutralPayload(command, "bad_command_arity");
    }
    try {
      return decoder.decode(args, realmByPubkey);
    } catch {
      return neutralPayload(command, "malformed_command");
    }
  }

  if (kind === "authority" && isTuple(body)) {
    const command = atomName(body.values[0]);

    switch (command) {
      case "genesis": {
        const delegation = delegationTerm(body.values[1]);
        const policies = successionPolicies(body.values[2], realmByPubkey);
        // A Sim genesis self-grant carries exactly the replica's authority
        // roles (canonically sorted), so the first role names the authority
        // field this genesis writes — "clerk" for Township.Matter, "custody"
        // for Toolshed.Tool. The delegation evidence must be retained either
        // way, or the whole capability chain collapses to no_capability.
        const role = delegation.roles[0];
        const authority = {
          type: "genesis" as const,
          delegation: delegationEvidence(delegation, realmByPubkey),
          ...(policies === undefined ? {} : { policies }),
        };
        if (role !== undefined) {
          return {
            field: role,
            mutation: "write",
            value: realmForPubkey(delegation.issuer, realmByPubkey),
            command: `genesis ${role}`,
            authority,
          };
        }
        return { ...neutralPayload("genesis"), authority };
      }
      case "heartbeat": {
        const role = atomName(body.values[1]);
        return {
          ...neutralPayload(`heartbeat ${role}`),
          authority: { type: "heartbeat", role, atTick: integerValue(body.values[2]) },
        };
      }
      case "transfer": {
        const role = atomName(body.values[1]);
        const delegation = delegationTerm(body.values[2]);
        return {
          field: role,
          mutation: "write",
          value: realmForPubkey(delegation.audience, realmByPubkey),
          command: `transfer ${role}`,
          authority: {
            type: "transfer",
            role,
            delegation: delegationEvidence(delegation, realmByPubkey),
            atTick: integerValue(body.values[3]),
          },
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
          authority: {
            type: "succeed",
            role,
            delegation: delegationEvidence(delegation, realmByPubkey),
            proof: successionProof(body.values[3]),
          },
        };
      }
      case "grant": {
        const delegation = delegationTerm(body.values[1]);
        return {
          ...neutralPayload(`grant ${realmForPubkey(delegation.audience, realmByPubkey)}`),
          authority: {
            type: "grant",
            delegation: delegationEvidence(delegation, realmByPubkey),
          },
        };
      }
      case "revoke": {
        const delegationId = binText(body.values[1]);
        return {
          ...neutralPayload(`revoke ${delegationId}`),
          authority: { type: "revoke", delegationId },
        };
      }
      case "beacon": {
        // Plan 149: retain the epoch as evidence even when malformed — a
        // non-integer epoch quarantines :stale_beacon in the oracle, so the
        // decode must not throw before the reducer can reach that verdict.
        const epochTerm = body.values[1];
        const epoch =
          typeof epochTerm === "number" && Number.isSafeInteger(epochTerm) ? epochTerm : null;
        return {
          ...neutralPayload(`beacon ${epoch ?? "malformed"}`),
          authority: { type: "beacon", epoch },
        };
      }
    }
  }

  return neutralPayload(kind);
}

function neutralPayload(command: string, commandError?: CommandError): Payload {
  return {
    field: "__authority",
    mutation: "write",
    value: null,
    command,
    ...(commandError === undefined ? {} : { commandError }),
  };
}

function assertCarrierOpFrame(
  frame: unknown,
  validateTerms: boolean,
): CarrierOpFrame {
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

  const carrierFrame = op as unknown as CarrierOpFrame;
  try {
    base64ToBytes(carrierFrame.author);
    base64ToBytes(carrierFrame.sig);
    if (validateTerms) {
      decodeCarrierTerm(carrierFrame.body);
      decodeCarrierTerm(carrierFrame.cap);
    }
  } catch {
    throw new Error("malformed carrier op");
  }

  return carrierFrame;
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

function commandValue(term: DecodedTerm | undefined): unknown {
  if (term === undefined) throw new Error("missing command value");
  if (term === null || typeof term === "boolean" || typeof term === "number") {
    return term;
  }
  if (term.type === "bin") return term.text;
  if (term.type === "atom") return term.value;
  if (term.type === "list" || term.type === "tuple") {
    return term.values.map(commandValue);
  }
  if (term.type === "mapset") {
    return term.values.map(commandValue);
  }
  if (term.type === "map") {
    return Object.fromEntries(
      term.pairs.map(([key, value]) => [
        String(commandValue(key)),
        commandValue(value),
      ]),
    );
  }
  if (term.type === "delegation") {
    const { type: _type, ...delegation } = term;
    return delegation;
  }
}

function commandAuditLabel(term: DecodedTerm | undefined): string {
  try {
    return String(commandValue(term));
  } catch {
    return "unknown_command";
  }
}

function binBytes(term: DecodedTerm | undefined): Uint8Array {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "bin") return term.bytes;
  throw new Error("expected bin term");
}

function capabilityId(term: DecodedTerm): string | null {
  if (term === null) return null;
  const value = binaryUtf8(term);
  if (value === null) throw new Error("expected capability id");
  return value;
}

function delegationTerm(term: DecodedTerm | undefined): DelegationTerm {
  if (typeof term === "object" && term !== null && "type" in term && term.type === "delegation") return term;
  throw new Error("expected delegation term");
}

function integerValue(term: DecodedTerm | undefined): number {
  if (typeof term === "number" && Number.isSafeInteger(term)) return term;
  throw new Error("expected integer term");
}

function delegationEvidence(
  delegation: DelegationTerm,
  realmByPubkey: Record<string, string>,
): AuthorityDelegationEvidence {
  return {
    id: delegation.id,
    replica: delegation.replica,
    issuer: delegation.issuer,
    audience: delegation.audience,
    issuerRealm: realmForPubkey(delegation.issuer, realmByPubkey),
    audienceRealm: realmForPubkey(delegation.audience, realmByPubkey),
    parentId: delegation.parent_id,
    ops: [...delegation.ops],
    roles: [...delegation.roles],
    live: delegation.live,
    sig: delegation.sig,
    ...(delegation.expires_epoch === undefined
      ? {}
      : { expiresEpoch: delegation.expires_epoch }),
  };
}

function successionPolicies(
  term: DecodedTerm | undefined,
  realmByPubkey: Record<string, string>,
): Record<string, SuccessionPolicyEvidence> | undefined {
  if (typeof term !== "object" || term === null || !("type" in term) || term.type !== "map") {
    return undefined;
  }

  const policies: Record<string, SuccessionPolicyEvidence> = {};
  for (const [roleTerm, policyTerm] of term.pairs) {
    const role = atomValue(roleTerm);
    const policy = atomMap(policyTerm);
    const successorBytes = binaryBytes(policy?.get("successor"), 32);
    if (role === null || policy === null || successorBytes === null) continue;

    const successor = bytesToBase64(successorBytes);
    const successorRealm = realmForPubkey(successor, realmByPubkey);
    const hasDormantTicks = policy.has("dormant_ticks");
    const hasRecovery = policy.has("recovery");

    if (hasDormantTicks === hasRecovery) {
      policies[role] = { mode: "invalid", successorRealm, successor };
      continue;
    }

    if (hasDormantTicks) {
      const dormantTicks = nonNegativeInteger(policy.get("dormant_ticks"));
      policies[role] =
        dormantTicks === null
          ? { mode: "invalid", successorRealm, successor }
          : { mode: "legacy", successorRealm, successor, dormantTicks };
      continue;
    }

    const recovery = witnessedRecoveryPolicy(policy.get("recovery"));
    policies[role] =
      recovery === null
        ? { mode: "invalid", successorRealm, successor }
        : { mode: "witnessed", successorRealm, successor, recovery };
  }

  return Object.keys(policies).length > 0 ? policies : undefined;
}

function successionProof(term: DecodedTerm | undefined): SuccessionProofEvidence {
  const atTick = nonNegativeInteger(term);
  if (atTick !== null) return { mode: "legacy", atTick };

  if (
    term !== undefined &&
    isTuple(term) &&
    term.values.length === 2 &&
    atomValue(term.values[0]) === "witnessed"
  ) {
    return { mode: "witnessed", certificate: witnessedCertificate(term.values[1]) };
  }

  return { mode: "invalid" };
}

function witnessedRecoveryPolicy(
  term: DecodedTerm | undefined,
): WitnessedRecoveryPolicyEvidence | null {
  const policy = exactAtomMap(term, ["mode", "version", "witnesses", "threshold"]);
  const mode = atomValue(policy?.get("mode"));
  const version = nonNegativeInteger(policy?.get("version"));
  const threshold = nonNegativeInteger(policy?.get("threshold"));
  const witnessTerms = listValuesOrNull(policy?.get("witnesses"));
  const witnessBytes = witnessTerms?.map((witness) => binaryBytes(witness, 32));

  if (
    mode !== "witnessed" ||
    version === null ||
    threshold === null ||
    witnessBytes === undefined ||
    witnessBytes.some((witness) => witness === null)
  ) {
    return null;
  }

  return {
    mode: "witnessed",
    version,
    witnesses: (witnessBytes as Uint8Array[]).map(bytesToBase64),
    threshold,
  };
}

function witnessedCertificate(
  term: DecodedTerm | undefined,
): WitnessedSuccessionCertificateEvidence | null {
  const certificate = exactAtomMap(term, ["claim", "signatures"]);
  const claim = witnessedClaim(certificate?.get("claim"));
  const signatureTerms = listValuesOrNull(certificate?.get("signatures"));
  const signatures = signatureTerms?.map(witnessedSignature);

  if (
    claim === null ||
    signatures === undefined ||
    signatures.some((signature) => signature === null)
  ) {
    return null;
  }

  return { claim, signatures: signatures as WitnessedSuccessionSignatureEvidence[] };
}

function witnessedClaim(term: DecodedTerm | undefined): WitnessedSuccessionClaimEvidence | null {
  const claim = exactAtomMap(term, [
    "version",
    "replica",
    "role",
    "holder",
    "holder_epoch",
    "successor",
    "policy_id",
  ]);
  const version = nonNegativeInteger(claim?.get("version"));
  const replica = binaryUtf8(claim?.get("replica"));
  const role = atomValue(claim?.get("role"));
  const holderBytes = binaryBytes(claim?.get("holder"), 32);
  const holderEpoch = binaryUtf8(claim?.get("holder_epoch"));
  const successorBytes = binaryBytes(claim?.get("successor"), 32);
  const policyId = binaryUtf8(claim?.get("policy_id"));

  if (
    version === null ||
    replica === null ||
    role === null ||
    holderBytes === null ||
    holderEpoch === null ||
    successorBytes === null ||
    policyId === null
  ) {
    return null;
  }

  return {
    version,
    replica,
    role,
    holder: bytesToBase64(holderBytes),
    holderEpoch,
    successor: bytesToBase64(successorBytes),
    policyId,
  };
}

function witnessedSignature(
  term: DecodedTerm,
): WitnessedSuccessionSignatureEvidence | null {
  const entry = exactAtomMap(term, ["witness", "signature"]);
  const witness = binaryBytes(entry?.get("witness"), 32);
  const signature = binaryBytes(entry?.get("signature"));
  return witness === null || signature === null
    ? null
    : { witness: bytesToBase64(witness), signature: bytesToBase64(signature) };
}

function exactAtomMap(
  term: DecodedTerm | undefined,
  expectedKeys: readonly string[],
): Map<string, DecodedTerm> | null {
  const map = atomMap(term);
  if (map === null || map.size !== expectedKeys.length) return null;
  return expectedKeys.every((key) => map.has(key)) ? map : null;
}

function atomMap(term: DecodedTerm | undefined): Map<string, DecodedTerm> | null {
  if (
    typeof term !== "object" ||
    term === null ||
    !("type" in term) ||
    term.type !== "map"
  ) {
    return null;
  }

  const entries = new Map<string, DecodedTerm>();
  for (const [keyTerm, valueTerm] of term.pairs) {
    const key = atomValue(keyTerm);
    if (key === null || entries.has(key)) return null;
    entries.set(key, valueTerm);
  }
  return entries;
}

function atomValue(term: DecodedTerm | undefined): string | null {
  return typeof term === "object" &&
    term !== null &&
    "type" in term &&
    term.type === "atom" &&
    typeof term.value === "string"
    ? term.value
    : null;
}

function listValuesOrNull(term: DecodedTerm | undefined): DecodedTerm[] | null {
  return typeof term === "object" && term !== null && "type" in term && term.type === "list"
    ? term.values
    : null;
}

function nonNegativeInteger(term: DecodedTerm | undefined): number | null {
  return typeof term === "number" && Number.isSafeInteger(term) && term >= 0 ? term : null;
}

function binaryBytes(term: DecodedTerm | undefined, length?: number): Uint8Array | null {
  if (
    typeof term !== "object" ||
    term === null ||
    !("type" in term) ||
    term.type !== "bin" ||
    (length !== undefined && term.bytes.length !== length)
  ) {
    return null;
  }
  return new Uint8Array(term.bytes);
}

function binaryUtf8(term: DecodedTerm | undefined): string | null {
  const value = binaryBytes(term);
  if (value === null) return null;
  try {
    return strictTextDecoder.decode(value);
  } catch {
    return null;
  }
}

function binBase64(term: DecodedTerm | undefined): string {
  if (typeof term !== "object" || term === null || !("type" in term) || term.type !== "bin") {
    throw new Error("expected binary term");
  }
  if (typeof Buffer !== "undefined") return Buffer.from(term.bytes).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...term.bytes));
}

function realmForPubkey(pubkeyBase64: string, realmByPubkey: Record<string, string>): string {
  const mapped = Object.hasOwn(realmByPubkey, pubkeyBase64)
    ? realmByPubkey[pubkeyBase64]
    : undefined;
  return mapped ?? pubkeyBase64;
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

function decodeCarrierNonce(
  value: unknown,
  expectedWireVersion: number,
  expectedSessionVersion: number,
): string {
  if (!hasType(value, "carrier_nonce")) throw new Error("malformed carrier nonce");
  if (value.wire_version !== expectedWireVersion) {
    throw new Error("unsupported carrier operation wire version");
  }
  if (value.session_version !== expectedSessionVersion) {
    throw new Error("unsupported carrier session version");
  }

  const nonce = value.nonce;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error("malformed carrier nonce");
  }

  const decoded = base64UrlToBytes(nonce);
  if (decoded.length !== 32 || bytesToBase64Url(decoded) !== nonce) {
    throw new Error("malformed carrier nonce");
  }
  return nonce;
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

function decodeAvailability(value: unknown, type: "subscribe_result" | "ops_available"): CarrierAvailability {
  if (!hasType(value, type)) throw new Error(`malformed carrier ${type} response`);
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw new Error(`malformed carrier ${type} generation`);
  }
  if (
    !Array.isArray(value.frontier) ||
    value.frontier.length > 64 ||
    !value.frontier.every((id) => typeof id === "string")
  ) {
    throw new Error(`malformed carrier ${type} frontier`);
  }
  if (typeof value.frontier_truncated !== "boolean") {
    throw new Error(`malformed carrier ${type} frontier_truncated`);
  }

  return {
    generation: value.generation as number,
    frontier: [...value.frontier],
    frontierTruncated: value.frontier_truncated,
  };
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

  const report: CarrierStateReport = {
    state_b64: value.state_b64,
    op_ids: value.op_ids,
    frontier: value.frontier,
    structural_quarantine: reasonPairs(value.structural_quarantine, "structural_quarantine"),
    authority_quarantine: reasonPairs(value.authority_quarantine, "authority_quarantine"),
    log_size: value.log_size,
  };
  if (plainRecord(value.state)) report.state = value.state;
  return report;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function base64ToBytes(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("malformed base64");
  }

  const decoded =
    typeof Buffer !== "undefined"
      ? new Uint8Array(Buffer.from(value, "base64"))
      : decodeBase64WithAtob(value);
  if (bytesToBase64(decoded) !== value) {
    throw new Error("non-canonical base64");
  }
  return decoded;
}

function decodeBase64WithAtob(value: string): Uint8Array {
  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function parseCarrierInteger(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("malformed integer term");
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error("malformed integer term");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("malformed integer term");
  }
  const parsed = BigInt(value);
  if (parsed > uint64Max || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("unsupported integer precision");
  }
  return Number(parsed);
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
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
