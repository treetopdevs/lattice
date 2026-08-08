import {
  connectCarrierWebSocket,
  type CarrierVerifier,
  type CarrierWebSocketClient,
  type ConnectCarrierWebSocketOptions,
  type LocalKeyValueStore,
} from "@treetopdevs/lattice-client";
import {
  base64ToBytes,
  carrierPeerConfigsEqual,
  carrierPeerFingerprint,
  carrierVerifierAsOperationVerifier,
  createWebCryptoCarrierVerifier,
  createWebCryptoOperationVerifier,
  exportCarrierPairingHandoff,
  importCarrierPairingHandoff,
  normalizeCarrierPeerConfig,
  type CarrierPeerConfigInput,
  type PairingHandoffOptions,
} from "@treetopdevs/lattice-mobile-core";
import {
  createTownshipNativeWorkflow,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import { TOWNSHIP_REPLICA } from "./township_actions";

// The product-neutral pairing/carrier seam lives in
// @treetopdevs/lattice-mobile-core (plan 158 seam extraction); this module
// binds it to the Township handoff prefix, default replica, and workflow.
export const TOWNSHIP_CARRIER_PAIRING_KEY = "carrier_peer_config";
export const TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX = "township-pairing:v1:";

const TOWNSHIP_PAIRING_HANDOFF_OPTIONS: PairingHandoffOptions = {
  handoffPrefix: TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  legacyHandoffPrefix: "township-pairing:",
  defaultReplica: TOWNSHIP_REPLICA,
};

export type TownshipCarrierSubmission = "push" | "relay";

// Structurally identical to the neutral CarrierPeerConfig; spelled out so the
// Township surface remains self-documenting.
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

export type TownshipCarrierPeerConfigInput = CarrierPeerConfigInput;

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
  return normalizeCarrierPeerConfig(input, TOWNSHIP_PAIRING_HANDOFF_OPTIONS) as TownshipCarrierPeerConfigValidation;
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
  return exportCarrierPairingHandoff(config, TOWNSHIP_PAIRING_HANDOFF_OPTIONS);
}

export function importTownshipCarrierPairingHandoff(value: string): TownshipCarrierPairingHandoffValidation {
  return importCarrierPairingHandoff(
    value,
    TOWNSHIP_PAIRING_HANDOFF_OPTIONS,
  ) as TownshipCarrierPairingHandoffValidation;
}

// Expects a normalized base64 Ed25519 public key.
export function townshipCarrierPeerFingerprint(expectedPeerPubkey: string): string {
  return carrierPeerFingerprint(expectedPeerPubkey);
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

export { createWebCryptoCarrierVerifier, carrierVerifierAsOperationVerifier, createWebCryptoOperationVerifier };

export function townshipCarrierPeerConfigsEqual(
  left: TownshipCarrierPeerConfig,
  right: TownshipCarrierPeerConfig,
): boolean {
  return carrierPeerConfigsEqual(left, right);
}

async function currentTownshipCarrierPeerConfig(storage: LocalKeyValueStore): Promise<TownshipCarrierPeerConfig | null> {
  return loadTownshipCarrierPeerConfig(storage, {});
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
