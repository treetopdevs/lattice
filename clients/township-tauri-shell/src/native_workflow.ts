import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  createJsonCarrierFrameStore,
  createJsonLocalOpLogStore,
  createTauriKeyValueStore,
  createTauriNativeCarrierSigner,
} from "@treetopdevs/lattice-client";
import type {
  CarrierFrameStore,
  CarrierSigner,
  LocalKeyValueStore,
  LocalOpLogStore,
  TauriInvoke,
} from "@treetopdevs/lattice-client";

export const TOWNSHIP_NATIVE_KEY_ID = "township-resident";
export const TOWNSHIP_STORAGE_NAMESPACE = "township:zoning-variance-24";
export const TOWNSHIP_LOCAL_OP_LOG_KEY = "local_ops";
export const TOWNSHIP_CARRIER_OUTBOX_KEY = "carrier_frames";
export const TOWNSHIP_DELEGATION_FRAMES_KEY = "delegation_frames";

const TOWNSHIP_NATIVE_PROBE_KEY = "native_probe";
const TOWNSHIP_NATIVE_PROBE_VALUE = "native invoke ready";
const TOWNSHIP_NATIVE_PROBE_CHALLENGE = "township-native-probe";
const TOWNSHIP_TRACE_DEV_EVENT_COMMAND = "lattice_trace_dev_event";
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
  const invoke = options.invoke ?? tauriInvoke;
  const storageNamespace = options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE;
  return createTauriKeyValueStore(invoke, { namespace: storageNamespace });
}

export async function createTownshipNativeWorkflow(
  options: TownshipNativeWorkflowOptions = {},
): Promise<TownshipNativeWorkflow> {
  const invoke = options.invoke ?? tauriInvoke;
  const keyId = options.keyId ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace = options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE;
  const storage = createTownshipNativeStorage({ invoke, storageNamespace });
  const signer = await createTauriNativeCarrierSigner(invoke, { keyId });

  return {
    keyId,
    storageNamespace,
    storage,
    localLog: createJsonLocalOpLogStore(storage, TOWNSHIP_LOCAL_OP_LOG_KEY),
    carrierFrames: createJsonCarrierFrameStore(storage, TOWNSHIP_CARRIER_OUTBOX_KEY),
    delegationFrames: createJsonCarrierFrameStore(storage, TOWNSHIP_DELEGATION_FRAMES_KEY),
    signer,
  };
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
  await invoke(TOWNSHIP_TRACE_DEV_EVENT_COMMAND, { event });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
