import type { Op, OpKind } from "./op";
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
}
export declare function carrierDelegationsFromFrames(frames: readonly CarrierOpFrame[]): CarrierDelegation[];
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
export declare function carrierChallenge(localRealm: string, replica: string, opts?: {
    wireVersion?: number;
    nonce?: string;
}): CarrierChallenge;
export declare function verifyCarrierHello(challenge: CarrierChallenge, hello: unknown, expectedRealm: string, expectedPubkey: Uint8Array, verifier: CarrierVerifier): Promise<CarrierHello>;
export declare function connectCarrierWebSocket(opts: ConnectCarrierWebSocketOptions): Promise<CarrierWebSocketClient>;
export declare class CarrierWebSocketClient {
    private readonly socket;
    private queue;
    private waiters;
    private closed;
    constructor(socket: WebSocketLike);
    advertise(): Promise<string[]>;
    pull(have: string[]): Promise<unknown[]>;
    push(ops: unknown[]): Promise<CarrierPushReport>;
    status(): Promise<string>;
    stateReport(): Promise<CarrierStateReport>;
    shutdown(): Promise<void>;
    close(): void;
    request(envelope: unknown): Promise<unknown>;
    private receive;
    private failPending;
}
export declare function syncCarrierOnce(client: CarrierSyncClient, localOps: Op[], localCarrierFrames: unknown[], realmByPubkey?: Record<string, string>): Promise<SyncCarrierResult>;
export declare function carrierOpsToSemanticOps(frames: unknown[], realmByPubkey?: Record<string, string>): Op[];
export declare function carrierOpToSemanticOp(frame: unknown, realmByPubkey?: Record<string, string>): Op;
export {};
