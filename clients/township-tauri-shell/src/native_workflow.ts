import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBytesForWitnessedSuccessionClaim } from "@treetopdevs/lattice-client";
import type {
  CarrierFrameStore,
  CarrierSigner,
  LocalKeyValueStore,
  LocalOpLogStore,
  TauriInvoke,
  WitnessedSuccessionClaimEvidence,
} from "@treetopdevs/lattice-client";
import {
  createProductNativeStorage,
  createProductNativeWorkflow,
  withProductPersistenceWrite,
} from "@treetopdevs/lattice-mobile-core";

// The product-neutral workflow composition lives in
// @treetopdevs/lattice-mobile-core (plan 158 seam extraction); this module
// binds it to the Township key ID, storage namespace, and Tauri invoke.
export const TOWNSHIP_NATIVE_KEY_ID = "township-resident";
export const TOWNSHIP_STORAGE_NAMESPACE = "township:zoning-variance-24";
export const TOWNSHIP_LOCAL_OP_LOG_KEY = "local_ops";
export const TOWNSHIP_CARRIER_OUTBOX_KEY = "carrier_frames";
export const TOWNSHIP_DELEGATION_FRAMES_KEY = "delegation_frames";
export const TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND =
  "lattice_ensure_governance_witness_key";
export const TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND =
  "lattice_governance_witness_public_key";
export const TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND = "lattice_sign_governance_witness";

const TOWNSHIP_NATIVE_PROBE_KEY = "native_probe";
const TOWNSHIP_NATIVE_PROBE_VALUE = "native invoke ready";
const TOWNSHIP_NATIVE_PROBE_CHALLENGE = "township-native-probe";
const TOWNSHIP_TRACE_DEV_EVENT_COMMAND = "lattice_trace_dev_event";
const TOWNSHIP_TRACE_DEV_MAX_ATTEMPTS = 3;
const TOWNSHIP_TRACE_DEV_RETRY_DELAY_MS = 25;
export const TOWNSHIP_LOG_PROBE_COMMAND = "lattice_log_probe";
export const TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX = "dev-trace-shortcut-keydown:";
export const TOWNSHIP_TRACE_DEV_RUNTIME_READY = "dev-trace-runtime-ready";
export const TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED = "pairing-link-load-settled";
export const TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED = "pairing-config-save-submitted";
export const TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED = "sync-outbox-started";
export const TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED = "carrier-health-started";
export const TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX = "carrier-feed-dom:";
export const TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR = "carrier-feed-dom-error";

export interface TownshipNativeWorkflowOptions {
  invoke?: TauriInvoke;
  keyId?: string;
  storageNamespace?: string;
}

export interface TownshipGovernanceWitnessNativeOptions {
  invoke?: TauriInvoke;
}

export interface TownshipGovernanceWitnessSignature {
  witness: string;
  signature: string;
  payloadDigest: string;
}

export interface TownshipNativeWorkflow {
  keyId: string;
  storageNamespace: string;
  storage: LocalKeyValueStore;
  localLog: LocalOpLogStore;
  carrierFrames: CarrierFrameStore;
  delegationFrames: CarrierFrameStore;
  signer: CarrierSigner;
}

export interface TownshipNativeReadyStatus {
  ready: true;
  keyId: string;
  storageNamespace: string;
  publicKeyBase64: string;
  storageEcho: string | null;
  signatureBytes: number;
}

export interface TownshipNativeUnavailableStatus {
  ready: false;
  keyId: string;
  storageNamespace: string;
  error: string;
}

export type TownshipNativeStatus = TownshipNativeReadyStatus | TownshipNativeUnavailableStatus;

export function createTownshipNativeStorage(
  options: TownshipNativeWorkflowOptions = {},
): LocalKeyValueStore {
  return createProductNativeStorage({
    invoke: options.invoke ?? tauriInvoke,
    storageNamespace: options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE,
  });
}

export async function createTownshipNativeWorkflow(
  options: TownshipNativeWorkflowOptions = {},
): Promise<TownshipNativeWorkflow> {
  return createProductNativeWorkflow({
    invoke: options.invoke ?? tauriInvoke,
    keyId: options.keyId ?? TOWNSHIP_NATIVE_KEY_ID,
    storageNamespace: options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE,
  });
}

export async function ensureGovernanceWitnessKey(
  options: TownshipGovernanceWitnessNativeOptions = {},
): Promise<string> {
  const invoke = options.invoke ?? tauriInvoke;
  const witness = await invoke<unknown>(TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND, {});
  canonicalBase64Bytes(witness, 32, "governance witness public key");
  return witness as string;
}

export async function loadGovernanceWitnessPublicKey(
  options: TownshipGovernanceWitnessNativeOptions = {},
): Promise<string> {
  const invoke = options.invoke ?? tauriInvoke;
  const witness = await invoke<unknown>(TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND, {});
  canonicalBase64Bytes(witness, 32, "governance witness public key");
  return witness as string;
}

export async function signGovernanceWitnessClaim(
  claim: WitnessedSuccessionClaimEvidence,
  expectedWitness: string,
  options: TownshipGovernanceWitnessNativeOptions = {},
): Promise<TownshipGovernanceWitnessSignature> {
  const invoke = options.invoke ?? tauriInvoke;
  const result = await invoke<unknown>(TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND, { claim });
  const signature = parseGovernanceWitnessSignature(result);
  const expectedWitnessBytes = canonicalBase64Bytes(
    expectedWitness,
    32,
    "expected governance witness public key",
  );
  const witnessBytes = canonicalBase64Bytes(
    signature.witness,
    32,
    "governance witness public key",
  );
  const signatureBytes = canonicalBase64Bytes(
    signature.signature,
    64,
    "governance witness signature",
  );
  if (signature.witness !== expectedWitness) {
    throw new Error("governance witness identity changed before signing");
  }

  const payload = canonicalBytesForWitnessedSuccessionClaim(claim);
  const payloadBuffer = new ArrayBuffer(payload.byteLength);
  new Uint8Array(payloadBuffer).set(payload);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", payloadBuffer));
  const expectedDigest = bytesBase64Url(digest);
  if (signature.payloadDigest !== expectedDigest) {
    throw new Error("governance witness payload digest mismatch");
  }
  if (!ed25519.verify(signatureBytes, payload, witnessBytes, { zip215: false })) {
    throw new Error("governance witness signature verification failed");
  }
  if (!bytesEqual(witnessBytes, expectedWitnessBytes)) {
    throw new Error("governance witness public key mismatch");
  }

  return signature;
}

export function verifyGovernanceWitnessSignature(
  claim: WitnessedSuccessionClaimEvidence,
  witness: string,
  signature: string,
): boolean {
  try {
    const witnessBytes = canonicalBase64Bytes(witness, 32, "governance witness public key");
    const signatureBytes = canonicalBase64Bytes(signature, 64, "governance witness signature");
    return ed25519.verify(
      signatureBytes,
      canonicalBytesForWitnessedSuccessionClaim(claim),
      witnessBytes,
      { zip215: false },
    );
  } catch {
    return false;
  }
}

export async function withTownshipPersistenceWrite<T>(
  workflow: Pick<TownshipNativeWorkflow, "storageNamespace">,
  operation: () => Promise<T>,
): Promise<T> {
  return withProductPersistenceWrite(workflow, operation);
}

export async function probeTownshipNativeWorkflow(
  options: TownshipNativeWorkflowOptions = {},
): Promise<TownshipNativeReadyStatus> {
  const workflow = await createTownshipNativeWorkflow(options);
  await workflow.storage.setItem(TOWNSHIP_NATIVE_PROBE_KEY, TOWNSHIP_NATIVE_PROBE_VALUE);
  const storageEcho = (await workflow.storage.getItem(TOWNSHIP_NATIVE_PROBE_KEY)) ?? null;
  const signature = await workflow.signer.sign(new TextEncoder().encode(TOWNSHIP_NATIVE_PROBE_CHALLENGE));

  return {
    ready: true,
    keyId: workflow.keyId,
    storageNamespace: workflow.storageNamespace,
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    storageEcho,
    signatureBytes: signature.byteLength,
  };
}

export async function loadTownshipNativeStatus(
  options: TownshipNativeWorkflowOptions = {},
): Promise<TownshipNativeStatus> {
  try {
    return await probeTownshipNativeWorkflow(options);
  } catch (error) {
    return {
      ready: false,
      keyId: options.keyId ?? TOWNSHIP_NATIVE_KEY_ID,
      storageNamespace: options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE,
      error: errorMessage(error),
    };
  }
}

export async function traceTownshipDevEvent(
  event: string,
  options: Pick<TownshipNativeWorkflowOptions, "invoke"> = {},
): Promise<void> {
  const invoke = options.invoke ?? tauriInvoke;
  for (let attempt = 1; attempt <= TOWNSHIP_TRACE_DEV_MAX_ATTEMPTS; attempt += 1) {
    try {
      await invoke(TOWNSHIP_TRACE_DEV_EVENT_COMMAND, { event });
      return;
    } catch (error) {
      if (attempt === TOWNSHIP_TRACE_DEV_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, TOWNSHIP_TRACE_DEV_RETRY_DELAY_MS));
    }
  }
}

export async function logTownshipProbeEvent(
  event: string,
  options: Pick<TownshipNativeWorkflowOptions, "invoke"> = {},
): Promise<void> {
  const invoke = options.invoke ?? tauriInvoke;
  await invoke(TOWNSHIP_LOG_PROBE_COMMAND, { event });
}

function bytesBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function parseGovernanceWitnessSignature(value: unknown): TownshipGovernanceWitnessSignature {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("malformed governance witness native response");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "payloadDigest" ||
    keys[1] !== "signature" ||
    keys[2] !== "witness" ||
    typeof record.witness !== "string" ||
    typeof record.signature !== "string" ||
    typeof record.payloadDigest !== "string"
  ) {
    throw new Error("malformed governance witness native response");
  }
  canonicalBase64UrlBytes(record.payloadDigest, 32, "governance witness payload digest");
  return {
    witness: record.witness,
    signature: record.signature,
    payloadDigest: record.payloadDigest,
  };
}

function canonicalBase64Bytes(value: unknown, length: number, label: string): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  const decoded = atobFn(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== length || bytesBase64(bytes) !== value) {
    throw new Error(`${label} is not canonical ${length}-byte base64`);
  }
  return bytes;
}

function canonicalBase64UrlBytes(value: string, length: number, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const bytes = canonicalBase64Bytes(padded, length, label);
  if (bytesBase64Url(bytes) !== value) {
    throw new Error(`${label} is not canonical ${length}-byte base64url`);
  }
  return bytes;
}

function bytesBase64Url(bytes: Uint8Array): string {
  return bytesBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
