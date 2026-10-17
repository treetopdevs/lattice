import type { AuthorityEvidence, CommandError, CustodyConsentEvidence, Mutation, Op, OpKind } from "./op";
import type { Verifier } from "./identity";
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
    /** Aborting closes the socket and rejects a handshake still waiting on the server. */
    signal?: AbortSignal;
    /**
     * Bound on the whole dial (socket open, server nonce, challenge signing, hello). Expiry closes the
     * socket and rejects with `carrier connect timeout`. Defaults to `carrierDialTimeoutMs`. The hello
     * step is also a request, so a dial bound longer than the request bound sees a stalled hello fail as
     * `carrier request timeout` instead; both are transient to callers.
     */
    dialTimeoutMs?: number;
    /**
     * Bound on every later request over the connected client; see `CarrierWebSocketClientOptions`.
     * Defaults to `carrierRequestTimeoutMs`.
     */
    requestTimeoutMs?: number;
}
export interface CarrierWebSocketClientOptions {
    /**
     * Bound on one request/response round trip. The protocol allows one request in flight, so a reply
     * that never arrives would otherwise pin the client forever; expiry fails the socket closed and
     * rejects the request with `carrier request timeout`. Defaults to `carrierRequestTimeoutMs`.
     */
    requestTimeoutMs?: number;
}
/**
 * Row 196 (D3, 2026-10-14): the dial and every request/response round trip are bounded at this one
 * boundary. A dial gets 10 s and each request 30 s; neither can be disabled, only shortened or
 * lengthened. The bound is per request, so a paged `advertise()` or `pull()` is bounded per page, and
 * a subscription's `next()` waits for pushed hints until the socket closes or fails, by design.
 */
export declare const carrierDialTimeoutMs = 10000;
export declare const carrierRequestTimeoutMs = 30000;
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
    /** Product command decoders; omitted keeps the default Township-first table byte for byte. */
    commandDecoders?: CommandDecoderMap;
    /**
     * Relay mode only: what a relay error reply to one submitted frame does. `"throw"` (the default) rethrows
     * every reply except `rate_limited`, discarding the call's gathered result. `"stop"` ends submission at
     * that frame and returns what was gathered, with the reply in `submitStop`. Transport failures and an
     * error from the duplicate-confirming advertise always throw.
     */
    onRelayError?: "throw" | "stop";
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
    /** Unsigned peer-reported presence; callers must not treat this as a durable receipt. */
    peerReportedFrameIds: string[];
    /** Locally unverifiable push candidates omitted from egress. */
    unverifiableFrameIds: string[];
    /** Relay mode: the frame whose submit ended this call's submission early, and the relay's error reason. */
    submitStop?: {
        frameId: string;
        reason: string;
    };
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
export type CarrierTerm = ["nil"] | ["bool", boolean] | ["int", number | string] | ["bin", string] | ["atom", string] | ["list", CarrierTerm[]] | ["tuple", CarrierTerm[]] | ["map", [CarrierTerm, CarrierTerm][]] | ["mapset", CarrierTerm[]] | ["delegation", CarrierDelegation];
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
export declare function carrierDelegationsFromFrames(frames: readonly CarrierOpFrame[]): CarrierDelegation[];
export type DecodedTerm = null | boolean | number | {
    type: "invalid_beacon_integer";
} | {
    type: "legacy_beacon_epoch";
    decimal: string;
} | BinTerm | AtomTerm | ListTerm | TupleTerm | MapTerm | MapSetTerm | DelegationTerm;
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
export interface Payload {
    field: string;
    mutation: Mutation;
    value: unknown;
    command: string;
    effects?: import("./op").CommandEffect[];
    commandArgs?: unknown[];
    commandError?: CommandError;
    authority?: AuthorityEvidence;
    consent?: Omit<CustodyConsentEvidence, "authorPub">;
}
export interface CommandDecoder {
    arity: number;
    decode: (args: DecodedTerm[], realmByPubkey: Record<string, string>) => Payload;
}
export interface CommandDecoderMap extends ReadonlyMap<string, CommandDecoder> {
    readonly product?: string;
}
/** Command names decoded for the Township matter carrier boundary. */
export declare function townshipCarrierCommandNames(): string[];
/** Command names and arities decoded for the Township matter carrier boundary. */
export declare function townshipCarrierCommandTable(): [string, number][];
/** Command names decoded for the Toolshed tool carrier boundary. */
export declare function toolshedCarrierCommandNames(): string[];
/** Command names and arities decoded for the Toolshed tool carrier boundary. */
export declare function toolshedCarrierCommandTable(): [string, number][];
interface WebSocketConstructor {
    new (url: string): WebSocketLike;
}
interface WebSocketLike {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open", listener: () => void, options?: {
        once?: boolean;
    }): void;
    addEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    addEventListener(type: "error", listener: (event: unknown) => void, options?: {
        once?: boolean;
    }): void;
    addEventListener(type: "close", listener: () => void, options?: {
        once?: boolean;
    }): void;
}
export declare function carrierTranscriptBytes(challenge: CarrierChallenge, realm: string, pubkey: Uint8Array): Uint8Array;
export declare function carrierTranscriptHex(challenge: CarrierChallenge, realm: string, pubkey: Uint8Array): string;
export declare function signCarrierChallenge(challenge: CarrierChallenge, signer: CarrierSigner): Promise<SignedCarrierChallenge>;
export declare function carrierChallenge(localRealm: string, replica: string, opts: {
    serverNonce: string;
    wireVersion?: number;
    sessionVersion?: number;
    nonce?: string;
}): CarrierChallenge;
export declare function verifyCarrierHello(challenge: CarrierChallenge, hello: unknown, expectedRealm: string, expectedPubkey: Uint8Array, verifier: CarrierVerifier): Promise<CarrierHello>;
export declare function connectCarrierWebSocket(opts: ConnectCarrierWebSocketOptions): Promise<CarrierWebSocketClient>;
export declare class CarrierWebSocketClient {
    private readonly socket;
    private pendingServerNonce;
    private pendingRequest;
    private availabilityRoute;
    private closed;
    private readonly requestTimeoutMs;
    constructor(socket: WebSocketLike, options?: CarrierWebSocketClientOptions);
    advertise(): Promise<string[]>;
    pull(have: string[]): Promise<unknown[]>;
    private readPages;
    push(ops: unknown[]): Promise<CarrierPushReport>;
    relay(op: CarrierOpFrame): Promise<CarrierPushReport>;
    status(): Promise<string>;
    stateReport(): Promise<CarrierStateReport>;
    shutdown(): Promise<void>;
    subscribeAvailability(): Promise<CarrierAvailabilitySubscription>;
    close(): void;
    receiveServerNonce(expectedWireVersion: number, expectedSessionVersion: number): Promise<string>;
    request(envelope: unknown): Promise<unknown>;
    private receive;
    private rejectPending;
    private rejectServerNonce;
    private failClient;
    private unsubscribeAvailability;
    private closeAvailability;
}
export declare function syncCarrierOnce(client: CarrierSyncClient, localOps: Op[], localCarrierFrames: unknown[], realmByPubkey: Record<string, string> | undefined, options: SyncCarrierOptions): Promise<SyncCarrierResult>;
/** An error reply from the carrier peer (`{type: "error", reason}`); the socket stays open. */
export declare class CarrierPeerError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/**
 * The reason of a carrier peer error reply, or null for anything else (a transport failure, a timeout, a
 * decode error). A plain `Error` carrying the same message is accepted so scripted clients and fakes that
 * throw one keep working.
 */
export declare function carrierPeerErrorReason(error: unknown): string | null;
export declare function carrierOpsToSemanticOps(frames: unknown[], realmByPubkey?: Record<string, string>, commandDecoders?: CommandDecoderMap): Op[];
export declare function decodeCarrierOpFrame(frame: unknown): CarrierOpFrame;
export declare function carrierOpToSemanticOp(frame: unknown, realmByPubkey?: Record<string, string>, commandDecoders?: CommandDecoderMap): Op;
/**
 * Deterministic `Lattice.Canonical` bytes for the JS value subset the client
 * signs over (nil/bool/uint/string/bytes/array). Strings and byte arrays both
 * encode as CBOR major-2, exactly like Elixir binaries.
 */
export declare function canonicalTerm(value: unknown): Uint8Array;
/**
 * Throw if a carrier frame's body, cap or any nested delegation names an atom outside
 * `WIRE_VOCABULARY`. Admission depends only on the frame bytes and that list, as on BEAM.
 */
export declare function assertWireVocabulary(frame: unknown): void;
export declare function base64ToBytes(value: string): Uint8Array;
export {};
