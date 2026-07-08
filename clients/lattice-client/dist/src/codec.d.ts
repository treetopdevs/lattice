import type { CarrierOpFrame, CarrierTerm } from "./carrier";
import type { Verifier } from "./identity";
import type { Op } from "./op";
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
export declare const canonicalSuite = "lattice-cbor-v1";
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
/**
 * Encode the signed/hashable core of a BEAM carrier op frame using the same
 * narrow CBOR-shaped subset as `Lattice.Canonical.op_payload/1`.
 */
export declare function canonicalBytesForCarrierOp(frame: CarrierOpFrame): Uint8Array;
/** Hash canonical signed bytes to the Lattice op id format. */
export declare function canonicalHash(bytes: Uint8Array): Promise<string>;
export declare function verifyCarrierOpHash(frame: CarrierOpFrame): Promise<boolean>;
export declare function verifyCarrierOp(frame: CarrierOpFrame, verifier: Verifier): Promise<CarrierOpVerification>;
export declare function authorCarrierOp(input: AuthorCarrierOpInput): Promise<CarrierOpFrame>;
/**
 * Placeholder for semantic op authoring. Carrier-frame canonical byte/hash
 * parity exists above, but this interface cannot honestly encode a reducer-level
 * `OpCore` until it also carries the real Lattice body/cap term and signer flow.
 */
export declare const UnavailableCodec: CanonicalCodec;
