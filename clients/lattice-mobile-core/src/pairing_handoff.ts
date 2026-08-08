/**
 * Product-neutral carrier pairing seam.
 *
 * Extracted from the Township shell's `township_carrier_peer.ts`: peer-config
 * validation, the versioned pairing handoff codec, the peer fingerprint, and
 * the Ed25519 verifier helpers. Every product string (handoff prefix, default
 * replica) arrives through `PairingHandoffOptions`, so Toolshed and Treehouse
 * shells reuse the exact same validation and wire behavior.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
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

export type CarrierPeerConfigError =
  | "invalid_expected_peer_pubkey"
  | "invalid_submission"
  | "invalid_url"
  | "missing_expected_peer_pubkey"
  | "missing_expected_peer_realm"
  | "missing_local_realm"
  | "missing_url";

export type CarrierPeerConfigValidation =
  | { ok: true; config: CarrierPeerConfig }
  | { ok: false; errors: CarrierPeerConfigError[]; message: string };

export type CarrierPairingHandoffError =
  | CarrierPeerConfigError
  | "invalid_pairing_format"
  | "invalid_pairing_payload"
  | "unsupported_pairing_version";

export type CarrierPairingHandoffValidation =
  | { ok: true; draft: CarrierPeerConfigInput; peerFingerprint: string }
  | { ok: false; errors: CarrierPairingHandoffError[]; message: string };

export interface PairingHandoffOptions {
  /** Versioned handoff prefix, e.g. `township-pairing:v1:`. */
  handoffPrefix: string;
  /** Version-less family prefix, e.g. `township-pairing:`, used to refuse other versions. */
  legacyHandoffPrefix: string;
  /** Replica assumed when the handoff carries none. */
  defaultReplica: string;
}

export function normalizeCarrierPeerConfig(
  input: CarrierPeerConfigInput,
  options: Pick<PairingHandoffOptions, "defaultReplica">,
): CarrierPeerConfigValidation {
  const url = present(input.url);
  const localRealm = present(input.localRealm);
  const expectedPeerRealm = present(input.expectedPeerRealm);
  const expectedPeerPubkey = present(input.expectedPeerPubkey);
  const errors: CarrierPeerConfigError[] = [];
  const submission = normalizeCarrierSubmission(input.submission, errors);

  if (!url) errors.push("missing_url");
  else if (!validCarrierUrl(url)) errors.push("invalid_url");

  if (!localRealm) errors.push("missing_local_realm");
  if (!expectedPeerRealm) errors.push("missing_expected_peer_realm");
  if (!expectedPeerPubkey) errors.push("missing_expected_peer_pubkey");
  else if (!validPeerPublicKey(expectedPeerPubkey)) errors.push("invalid_expected_peer_pubkey");

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      message: pairingErrorMessage(errors),
    };
  }

  const config: CarrierPeerConfig = {
    url: url as string,
    localRealm: localRealm as string,
    expectedPeerRealm: expectedPeerRealm as string,
    expectedPeerPubkey: expectedPeerPubkey as string,
    replica: present(input.replica) ?? options.defaultReplica,
  };
  const keyId = present(input.keyId);
  if (keyId) config.keyId = keyId;
  if (submission === "relay") config.submission = submission;
  return { ok: true, config };
}

export function exportCarrierPairingHandoff(
  config: CarrierPeerConfig,
  options: Pick<PairingHandoffOptions, "handoffPrefix">,
): string {
  const payload: Record<string, string> = {
    url: config.url,
    expectedPeerRealm: config.expectedPeerRealm,
    expectedPeerPubkey: config.expectedPeerPubkey,
    replica: config.replica,
  };
  if (config.submission === "relay") payload.submission = config.submission;

  return `${options.handoffPrefix}${base64UrlEncodeText(JSON.stringify(payload))}`;
}

export function importCarrierPairingHandoff(
  value: string,
  options: PairingHandoffOptions,
): CarrierPairingHandoffValidation {
  const raw = present(value);
  if (!raw) return pairingHandoffParseError("invalid_pairing_format", options);
  if (raw.startsWith(options.legacyHandoffPrefix) && !raw.startsWith(options.handoffPrefix)) {
    return pairingHandoffParseError("unsupported_pairing_version", options);
  }
  if (!raw.startsWith(options.handoffPrefix)) {
    return pairingHandoffParseError("invalid_pairing_format", options);
  }

  const encoded = raw.slice(options.handoffPrefix.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeText(encoded));
  } catch {
    return pairingHandoffParseError("invalid_pairing_payload", options);
  }
  if (!plainRecord(parsed)) return pairingHandoffParseError("invalid_pairing_payload", options);

  const draft = handoffDraftFromRecord(parsed);
  if (draft === null) return pairingHandoffParseError("invalid_pairing_payload", options);

  const validated = validateCarrierPairingDraft(draft, options);
  if (!validated.ok) return validated;

  return {
    ok: true,
    draft: validated.draft,
    peerFingerprint: carrierPeerFingerprint(validated.draft.expectedPeerPubkey as string),
  };
}

export function validateCarrierPairingDraft(
  input: CarrierPeerConfigInput,
  options: Pick<PairingHandoffOptions, "defaultReplica">,
): CarrierPairingHandoffValidation {
  const url = present(input.url);
  const expectedPeerRealm = present(input.expectedPeerRealm);
  const expectedPeerPubkey = present(input.expectedPeerPubkey);
  const errors: CarrierPeerConfigError[] = [];
  const submission = normalizeCarrierSubmission(input.submission, errors);

  if (!url) errors.push("missing_url");
  else if (!validCarrierUrl(url)) errors.push("invalid_url");

  if (!expectedPeerRealm) errors.push("missing_expected_peer_realm");
  if (!expectedPeerPubkey) errors.push("missing_expected_peer_pubkey");
  else if (!validPeerPublicKey(expectedPeerPubkey)) errors.push("invalid_expected_peer_pubkey");

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      message: pairingErrorMessage(errors),
    };
  }

  const draft: CarrierPeerConfigInput = {
    url: url as string,
    expectedPeerRealm: expectedPeerRealm as string,
    expectedPeerPubkey: expectedPeerPubkey as string,
    replica: present(input.replica) ?? options.defaultReplica,
    submission,
  };

  return {
    ok: true,
    draft,
    peerFingerprint: carrierPeerFingerprint(expectedPeerPubkey as string),
  };
}

// Expects a normalized base64 Ed25519 public key.
export function carrierPeerFingerprint(expectedPeerPubkey: string): string {
  const bytes = base64ToBytes(expectedPeerPubkey);
  return `${hexBytes(bytes.slice(0, 4))}...${hexBytes(bytes.slice(-4))}`;
}

export function carrierPeerConfigsEqual(left: CarrierPeerConfig, right: CarrierPeerConfig): boolean {
  return (
    left.url === right.url &&
    left.localRealm === right.localRealm &&
    left.expectedPeerRealm === right.expectedPeerRealm &&
    left.expectedPeerPubkey === right.expectedPeerPubkey &&
    left.replica === right.replica &&
    (left.keyId ?? null) === (right.keyId ?? null) &&
    (left.submission ?? "push") === (right.submission ?? "push")
  );
}

export function createWebCryptoCarrierVerifier(
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): CarrierVerifier {
  return {
    async verify(pubkey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (subtle) {
        try {
          const algorithm = "Ed25519" as AlgorithmIdentifier;
          const key = await subtle.importKey("raw", arrayBufferBytes(pubkey), algorithm, false, ["verify"]);
          return subtle.verify(algorithm, key, arrayBufferBytes(signature), arrayBufferBytes(bytes));
        } catch (error) {
          if (!webCryptoEd25519Unavailable(error)) throw error;
        }
      }
      return ed25519.verify(signature, bytes, pubkey, { zip215: false });
    },
  };
}

export function carrierVerifierAsOperationVerifier(verifier: CarrierVerifier): Verifier {
  return {
    verify(author: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
      return Promise.resolve(verifier.verify(base64ToBytes(author), bytes, signature));
    },
  };
}

export function createWebCryptoOperationVerifier(
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Verifier {
  return carrierVerifierAsOperationVerifier(createWebCryptoCarrierVerifier(subtle));
}

export function pairingErrorMessage(errors: CarrierPeerConfigError[]): string {
  const labels = errors.map((error) => {
    switch (error) {
      case "invalid_expected_peer_pubkey":
        return "peer public key must be 32-byte base64";
      case "invalid_submission":
        return "submission must be push or relay";
      case "invalid_url":
        return "Carrier URL must start with ws:// or wss://";
      case "missing_expected_peer_pubkey":
        return "peer public key is required";
      case "missing_expected_peer_realm":
        return "peer realm is required";
      case "missing_local_realm":
        return "local realm is required";
      case "missing_url":
        return "Carrier URL is required";
    }
  });
  return `Pairing config invalid: ${labels.join("; ")}.`;
}

function webCryptoEd25519Unavailable(error: unknown): boolean {
  const name = typeof (error as { name?: unknown })?.name === "string" ? (error as { name: string }).name : "";
  if (name === "NotSupportedError") return true;
  if (!(error instanceof Error)) return false;
  return /algorithm/i.test(error.message) && /unrecognized|unsupported|not supported/i.test(error.message);
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function base64ToBytes(value: string): Uint8Array {
  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function validCarrierUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

function validPeerPublicKey(value: string): boolean {
  try {
    return base64ToBytes(value).byteLength === 32;
  } catch {
    return false;
  }
}

function handoffDraftFromRecord(record: Record<string, unknown>): CarrierPeerConfigInput | null {
  const url = handoffStringField(record, "url");
  const expectedPeerRealm = handoffStringField(record, "expectedPeerRealm");
  const expectedPeerPubkey = handoffStringField(record, "expectedPeerPubkey");
  const replica = handoffStringField(record, "replica");
  const submission = handoffStringField(record, "submission");
  if (
    url === false ||
    expectedPeerRealm === false ||
    expectedPeerPubkey === false ||
    replica === false ||
    submission === false
  ) {
    return null;
  }

  return {
    url,
    expectedPeerRealm,
    expectedPeerPubkey,
    replica,
    submission,
  };
}

function handoffStringField(record: Record<string, unknown>, field: string): string | null | undefined | false {
  const value = record[field];
  if (value === undefined || value === null || typeof value === "string") return value;
  return false;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pairingHandoffParseError(
  error: Extract<
    CarrierPairingHandoffError,
    "invalid_pairing_format" | "invalid_pairing_payload" | "unsupported_pairing_version"
  >,
  options: Pick<PairingHandoffOptions, "handoffPrefix">,
): CarrierPairingHandoffValidation {
  const prefixLabel = options.handoffPrefix.replace(/:$/u, "");
  const message =
    error === "invalid_pairing_format"
      ? `Pairing handoff invalid: expected ${prefixLabel} payload.`
      : error === "unsupported_pairing_version"
        ? "Pairing handoff invalid: unsupported version."
        : "Pairing handoff invalid: payload could not be decoded.";
  return { ok: false, errors: [error], message };
}

function normalizeCarrierSubmission(
  value: string | null | undefined,
  errors: CarrierPeerConfigError[],
): CarrierSubmission {
  const submission = present(value);
  if (submission === null || submission === "push") return "push";
  if (submission === "relay") return submission;
  errors.push("invalid_submission");
  return "push";
}

function base64UrlEncodeText(value: string): string {
  const encoder = new TextEncoder();
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlDecodeText(value: string): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return decoder.decode(base64UrlToBytes(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoaFn(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return base64ToBytes(padded);
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
