/**
 * Product-neutral carrier pairing seam.
 *
 * Extracted from the Township shell's `township_carrier_peer.ts`: peer-config
 * validation, the versioned pairing handoff codec, the peer fingerprint, and
 * the Ed25519 verifier helpers. Every product string (handoff prefix, default
 * replica) arrives through `PairingHandoffOptions`, so Toolshed and Treehouse
 * shells reuse the exact same validation and wire behavior.
 */
import type { CarrierVerifier, Verifier } from "@treetopdevs/lattice-client";
export type CarrierSubmission = "push" | "relay";
export interface CarrierPeerConfig {
    url: string;
    localRealm: string;
    expectedPeerRealm: string;
    expectedPeerPubkey: string;
    replica: string;
    keyId?: string;
    submission?: CarrierSubmission;
}
export interface CarrierPeerConfigInput {
    url?: string | null | undefined;
    localRealm?: string | null | undefined;
    expectedPeerRealm?: string | null | undefined;
    expectedPeerPubkey?: string | null | undefined;
    replica?: string | null | undefined;
    keyId?: string | null | undefined;
    submission?: string | null | undefined;
}
export type CarrierPeerConfigError = "invalid_expected_peer_pubkey" | "invalid_submission" | "invalid_url" | "missing_expected_peer_pubkey" | "missing_expected_peer_realm" | "missing_local_realm" | "missing_url";
export type CarrierPeerConfigValidation = {
    ok: true;
    config: CarrierPeerConfig;
} | {
    ok: false;
    errors: CarrierPeerConfigError[];
    message: string;
};
export type CarrierPairingHandoffError = CarrierPeerConfigError | "invalid_pairing_format" | "invalid_pairing_payload" | "unsupported_pairing_version";
export type CarrierPairingHandoffValidation = {
    ok: true;
    draft: CarrierPeerConfigInput;
    peerFingerprint: string;
} | {
    ok: false;
    errors: CarrierPairingHandoffError[];
    message: string;
};
export interface PairingHandoffOptions {
    /** Versioned handoff prefix, e.g. `township-pairing:v1:`. */
    handoffPrefix: string;
    /** Version-less family prefix, e.g. `township-pairing:`, used to refuse other versions. */
    legacyHandoffPrefix: string;
    /** Replica assumed when the handoff carries none. */
    defaultReplica: string;
}
export declare function normalizeCarrierPeerConfig(input: CarrierPeerConfigInput, options: Pick<PairingHandoffOptions, "defaultReplica">): CarrierPeerConfigValidation;
export declare function exportCarrierPairingHandoff(config: CarrierPeerConfig, options: Pick<PairingHandoffOptions, "handoffPrefix">): string;
export declare function importCarrierPairingHandoff(value: string, options: PairingHandoffOptions): CarrierPairingHandoffValidation;
export declare function validateCarrierPairingDraft(input: CarrierPeerConfigInput, options: Pick<PairingHandoffOptions, "defaultReplica">): CarrierPairingHandoffValidation;
export declare function carrierPeerFingerprint(expectedPeerPubkey: string): string;
export declare function carrierPeerConfigsEqual(left: CarrierPeerConfig, right: CarrierPeerConfig): boolean;
export declare function createWebCryptoCarrierVerifier(subtle?: SubtleCrypto | undefined): CarrierVerifier;
export declare function carrierVerifierAsOperationVerifier(verifier: CarrierVerifier): Verifier;
export declare function createWebCryptoOperationVerifier(subtle?: SubtleCrypto | undefined): Verifier;
export declare function pairingErrorMessage(errors: CarrierPeerConfigError[]): string;
export declare function base64ToBytes(value: string): Uint8Array;
