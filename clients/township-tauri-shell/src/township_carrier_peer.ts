import {
  connectCarrierWebSocket,
  type CarrierVerifier,
  type CarrierWebSocketClient,
  type ConnectCarrierWebSocketOptions,
  type LocalKeyValueStore,
} from "@treetopdevs/lattice-client";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  createTownshipNativeWorkflow,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import { TOWNSHIP_REPLICA } from "./township_actions";

export const TOWNSHIP_CARRIER_PAIRING_KEY = "carrier_peer_config";
export const TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX = "township-pairing:v1:";

export type TownshipCarrierSubmission = "push" | "relay";

export interface TownshipCarrierPeerConfig {
  url: string;
  localRealm: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
  replica: string;
  keyId?: string;
  submission?: TownshipCarrierSubmission;
}

export interface TownshipCarrierPeerEnv {
  VITE_TOWNSHIP_CARRIER_URL?: string;
  VITE_TOWNSHIP_LOCAL_REALM?: string;
  VITE_TOWNSHIP_PEER_REALM?: string;
  VITE_TOWNSHIP_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_REPLICA?: string;
  VITE_TOWNSHIP_CARRIER_KEY_ID?: string;
  VITE_TOWNSHIP_CARRIER_SUBMISSION?: string;
}

export interface TownshipCarrierPeerConfigInput {
  url?: string | null | undefined;
  localRealm?: string | null | undefined;
  expectedPeerRealm?: string | null | undefined;
  expectedPeerPubkey?: string | null | undefined;
  replica?: string | null | undefined;
  keyId?: string | null | undefined;
  submission?: string | null | undefined;
}

export type TownshipCarrierPeerConfigError =
  | "invalid_expected_peer_pubkey"
  | "invalid_submission"
  | "invalid_url"
  | "missing_expected_peer_pubkey"
  | "missing_expected_peer_realm"
  | "missing_local_realm"
  | "missing_url";

export type TownshipCarrierPeerConfigValidation =
  | { ok: true; config: TownshipCarrierPeerConfig }
  | { ok: false; errors: TownshipCarrierPeerConfigError[]; message: string };

export type TownshipCarrierPairingDraftOrigin =
  | "manual"
  | "handoff"
  | "deep_link"
  | "qr_image"
  | "qr_camera"
  | "discovery"
  | "release_probe";

export type TownshipCarrierPeerConfigSaveError = TownshipCarrierPeerConfigError | "confirmation_required";

export type TownshipCarrierPeerConfigSaveValidation =
  | { ok: true; config: TownshipCarrierPeerConfig }
  | { ok: false; errors: TownshipCarrierPeerConfigSaveError[]; message: string };

export interface SaveTownshipCarrierPeerConfigOptions {
  origin?: TownshipCarrierPairingDraftOrigin;
  confirmed?: boolean;
}

export type TownshipCarrierPairingHandoffError =
  | TownshipCarrierPeerConfigError
  | "invalid_pairing_format"
  | "invalid_pairing_payload"
  | "unsupported_pairing_version";

export type TownshipCarrierPairingHandoffValidation =
  | { ok: true; draft: TownshipCarrierPeerConfigInput; peerFingerprint: string }
  | { ok: false; errors: TownshipCarrierPairingHandoffError[]; message: string };

export type TownshipCarrierWebSocket = NonNullable<ConnectCarrierWebSocketOptions["webSocket"]>;

export interface ConnectTownshipCarrierPeerOptions {
  workflow: TownshipNativeWorkflow;
  peer: TownshipCarrierPeerConfig;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export type TownshipCarrierHealthFailureReason =
  | "carrier_unconfigured"
  | "native_unavailable"
  | "probe_failed";

export type TownshipCarrierHealthResult =
  | { ok: true; phase: string; peerRealm: string }
  | { ok: false; reason: TownshipCarrierHealthFailureReason; message: string };

export interface CheckTownshipCarrierPeerHealthOptions extends TownshipNativeWorkflowOptions {
  peer?: TownshipCarrierPeerConfig | null | undefined;
  workflow?: TownshipNativeWorkflow | undefined;
  verifier?: CarrierVerifier | undefined;
  webSocket?: TownshipCarrierWebSocket | undefined;
}

export function townshipCarrierPeerFromEnv(
  env: TownshipCarrierPeerEnv = ((import.meta as ImportMeta & { env?: TownshipCarrierPeerEnv }).env ?? {}),
): TownshipCarrierPeerConfig | null {
  const normalized = normalizeTownshipCarrierPeerConfig({
    url: env.VITE_TOWNSHIP_CARRIER_URL,
    localRealm: env.VITE_TOWNSHIP_LOCAL_REALM,
    expectedPeerRealm: env.VITE_TOWNSHIP_PEER_REALM,
    expectedPeerPubkey: env.VITE_TOWNSHIP_PEER_PUBKEY,
    replica: env.VITE_TOWNSHIP_REPLICA,
    keyId: env.VITE_TOWNSHIP_CARRIER_KEY_ID,
    submission: env.VITE_TOWNSHIP_CARRIER_SUBMISSION,
  });
  return normalized.ok ? normalized.config : null;
}

export function normalizeTownshipCarrierPeerConfig(
  input: TownshipCarrierPeerConfigInput,
): TownshipCarrierPeerConfigValidation {
  const url = present(input.url);
  const localRealm = present(input.localRealm);
  const expectedPeerRealm = present(input.expectedPeerRealm);
  const expectedPeerPubkey = present(input.expectedPeerPubkey);
  const errors: TownshipCarrierPeerConfigError[] = [];
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

  const config: TownshipCarrierPeerConfig = {
    url: url as string,
    localRealm: localRealm as string,
    expectedPeerRealm: expectedPeerRealm as string,
    expectedPeerPubkey: expectedPeerPubkey as string,
    replica: present(input.replica) ?? TOWNSHIP_REPLICA,
  };
  const keyId = present(input.keyId);
  if (keyId) config.keyId = keyId;
  if (submission === "relay") config.submission = submission;
  return { ok: true, config };
}

export async function loadTownshipCarrierPeerConfig(
  storage: LocalKeyValueStore,
  env?: TownshipCarrierPeerEnv,
): Promise<TownshipCarrierPeerConfig | null> {
  const envConfig = townshipCarrierPeerFromEnv(env);

  let raw: string | null | undefined;
  try {
    raw = await storage.getItem(TOWNSHIP_CARRIER_PAIRING_KEY);
  } catch {
    return envConfig;
  }
  if (!raw) return envConfig;

  let parsed: TownshipCarrierPeerConfigInput;
  try {
    parsed = JSON.parse(raw) as TownshipCarrierPeerConfigInput;
  } catch {
    return null;
  }

  const normalized = normalizeTownshipCarrierPeerConfig(parsed);
  return normalized.ok ? normalized.config : null;
}

export async function saveTownshipCarrierPeerConfig(
  storage: LocalKeyValueStore,
  input: TownshipCarrierPeerConfigInput,
  options: SaveTownshipCarrierPeerConfigOptions = {},
): Promise<TownshipCarrierPeerConfigSaveValidation> {
  const normalized = normalizeTownshipCarrierPeerConfig(input);
  if (!normalized.ok) return normalized;

  const current = await currentTownshipCarrierPeerConfig(storage);
  if (current !== null && townshipCarrierPeerConfigsEqual(current, normalized.config)) {
    return normalized;
  }

  if (requiresPairingSaveConfirmation(options.origin ?? "manual", current) && options.confirmed !== true) {
    return {
      ok: false,
      errors: ["confirmation_required"],
      message: pairingConfirmationRequiredMessage(current),
    };
  }

  await storage.setItem(TOWNSHIP_CARRIER_PAIRING_KEY, JSON.stringify(normalized.config));
  return normalized;
}

export function exportTownshipCarrierPairingHandoff(config: TownshipCarrierPeerConfig): string {
  const payload: Record<string, string> = {
    url: config.url,
    expectedPeerRealm: config.expectedPeerRealm,
    expectedPeerPubkey: config.expectedPeerPubkey,
    replica: config.replica,
  };
  if (config.submission === "relay") payload.submission = config.submission;

  return `${TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX}${base64UrlEncodeText(JSON.stringify(payload))}`;
}

export function importTownshipCarrierPairingHandoff(value: string): TownshipCarrierPairingHandoffValidation {
  const raw = present(value);
  if (!raw) return pairingHandoffParseError("invalid_pairing_format");
  if (raw.startsWith("township-pairing:") && !raw.startsWith(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX)) {
    return pairingHandoffParseError("unsupported_pairing_version");
  }
  if (!raw.startsWith(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX)) {
    return pairingHandoffParseError("invalid_pairing_format");
  }

  const encoded = raw.slice(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeText(encoded));
  } catch {
    return pairingHandoffParseError("invalid_pairing_payload");
  }
  if (!plainRecord(parsed)) return pairingHandoffParseError("invalid_pairing_payload");

  const draft = handoffDraftFromRecord(parsed);
  if (draft === null) return pairingHandoffParseError("invalid_pairing_payload");

  const validated = validateTownshipCarrierPairingDraft(draft);
  if (!validated.ok) return validated;

  return {
    ok: true,
    draft: validated.draft,
    peerFingerprint: townshipCarrierPeerFingerprint(validated.draft.expectedPeerPubkey as string),
  };
}

// Expects a normalized base64 Ed25519 public key.
export function townshipCarrierPeerFingerprint(expectedPeerPubkey: string): string {
  const bytes = base64ToBytes(expectedPeerPubkey);
  return `${hexBytes(bytes.slice(0, 4))}...${hexBytes(bytes.slice(-4))}`;
}

export async function connectTownshipCarrierPeer(
  options: ConnectTownshipCarrierPeerOptions,
): Promise<CarrierWebSocketClient> {
  const connectOptions: ConnectCarrierWebSocketOptions = {
    url: options.peer.url,
    localRealm: options.peer.localRealm,
    replica: options.peer.replica,
    signer: options.workflow.signer,
    expectedPeerRealm: options.peer.expectedPeerRealm,
    expectedPeerPubkey: base64ToBytes(options.peer.expectedPeerPubkey),
    verifier: options.verifier ?? createWebCryptoCarrierVerifier(),
  };
  if (options.webSocket !== undefined) connectOptions.webSocket = options.webSocket;
  return connectCarrierWebSocket(connectOptions);
}

export async function checkTownshipCarrierPeerHealth(
  options: CheckTownshipCarrierPeerHealthOptions = {},
): Promise<TownshipCarrierHealthResult> {
  if (!options.peer) {
    return {
      ok: false,
      reason: "carrier_unconfigured",
      message: "Save a carrier pairing before checking health.",
    };
  }

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(healthWorkflowOptions(options, options.peer)));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to check carrier health.",
    };
  }

  let client: CarrierWebSocketClient | null = null;
  try {
    const connectOptions: ConnectTownshipCarrierPeerOptions = {
      workflow,
      peer: options.peer,
    };
    if (options.verifier !== undefined) connectOptions.verifier = options.verifier;
    if (options.webSocket !== undefined) connectOptions.webSocket = options.webSocket;
    client = await connectTownshipCarrierPeer(connectOptions);
    const phase = await client.status();
    return {
      ok: true,
      phase,
      peerRealm: options.peer.expectedPeerRealm,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "probe_failed",
      message: errorMessage(error),
    };
  } finally {
    client?.close();
  }
}

export function createWebCryptoCarrierVerifier(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): CarrierVerifier {
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

function base64ToBytes(value: string): Uint8Array {
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

function validateTownshipCarrierPairingDraft(
  input: TownshipCarrierPeerConfigInput,
): TownshipCarrierPairingHandoffValidation {
  const url = present(input.url);
  const expectedPeerRealm = present(input.expectedPeerRealm);
  const expectedPeerPubkey = present(input.expectedPeerPubkey);
  const errors: TownshipCarrierPeerConfigError[] = [];
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

  const draft: TownshipCarrierPeerConfigInput = {
    url: url as string,
    expectedPeerRealm: expectedPeerRealm as string,
    expectedPeerPubkey: expectedPeerPubkey as string,
    replica: present(input.replica) ?? TOWNSHIP_REPLICA,
    submission,
  };

  return {
    ok: true,
    draft,
    peerFingerprint: townshipCarrierPeerFingerprint(expectedPeerPubkey as string),
  };
}

async function currentTownshipCarrierPeerConfig(storage: LocalKeyValueStore): Promise<TownshipCarrierPeerConfig | null> {
  return loadTownshipCarrierPeerConfig(storage, {});
}

export function townshipCarrierPeerConfigsEqual(
  left: TownshipCarrierPeerConfig,
  right: TownshipCarrierPeerConfig,
): boolean {
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

function requiresPairingSaveConfirmation(
  origin: TownshipCarrierPairingDraftOrigin,
  current: TownshipCarrierPeerConfig | null,
): boolean {
  if (origin === "release_probe") return false;
  if (current !== null) return true;
  return origin !== "manual";
}

function pairingConfirmationRequiredMessage(current: TownshipCarrierPeerConfig | null): string {
  return current === null
    ? "Confirm this imported carrier pairing before saving."
    : "Confirm before replacing the saved carrier pairing.";
}

function handoffDraftFromRecord(record: Record<string, unknown>): TownshipCarrierPeerConfigInput | null {
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
  error: Extract<TownshipCarrierPairingHandoffError, "invalid_pairing_format" | "invalid_pairing_payload" | "unsupported_pairing_version">,
): TownshipCarrierPairingHandoffValidation {
  const message =
    error === "invalid_pairing_format"
      ? "Pairing handoff invalid: expected township-pairing:v1 payload."
      : error === "unsupported_pairing_version"
        ? "Pairing handoff invalid: unsupported version."
        : "Pairing handoff invalid: payload could not be decoded.";
  return { ok: false, errors: [error], message };
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

function pairingErrorMessage(errors: TownshipCarrierPeerConfigError[]): string {
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

function normalizeCarrierSubmission(
  value: string | null | undefined,
  errors: TownshipCarrierPeerConfigError[],
): TownshipCarrierSubmission {
  const submission = present(value);
  if (submission === null || submission === "push") return "push";
  if (submission === "relay") return submission;
  errors.push("invalid_submission");
  return "push";
}

function healthWorkflowOptions(
  options: CheckTownshipCarrierPeerHealthOptions,
  peer: TownshipCarrierPeerConfig,
): TownshipNativeWorkflowOptions {
  const workflow: TownshipNativeWorkflowOptions = {};
  if (options.invoke !== undefined) workflow.invoke = options.invoke;
  if (options.storageNamespace !== undefined) workflow.storageNamespace = options.storageNamespace;
  const keyId = options.keyId ?? peer.keyId;
  if (keyId !== undefined) workflow.keyId = keyId;
  return workflow;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
