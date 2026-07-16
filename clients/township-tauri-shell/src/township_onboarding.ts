import {
  type CarrierOpFrame,
  type CarrierSyncClient,
  type CarrierVerifier,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeStorage,
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import {
  importTownshipCarrierPairingHandoff,
  saveTownshipCarrierPeerConfig,
  type TownshipCarrierPairingDraftOrigin,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";
import {
  syncTownshipOutbox,
  type TownshipSyncSuccess,
} from "./township_sync";
import {
  submitTownshipPost,
  type TownshipPostSuccess,
} from "./township_actions";

export type TownshipDesktopOnboardingFailureReason =
  | "final_sync_failed"
  | "initial_sync_failed"
  | "invalid_pairing"
  | "native_unavailable"
  | "pairing_save_failed"
  | "post_failed";

export interface TownshipDesktopOnboardingOptions extends TownshipNativeWorkflowOptions {
  pairingHandoff: string;
  localRealm: string;
  confirmed?: boolean;
  origin?: TownshipCarrierPairingDraftOrigin;
  client?: CarrierSyncClient;
  peer?: TownshipCarrierPeerConfig;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  realmByPubkey?: Record<string, string>;
  postText: string;
}

export interface TownshipDesktopOnboardingSuccess {
  ok: true;
  pairing: TownshipCarrierPeerConfig;
  initialSync: TownshipSyncSuccess;
  post: TownshipPostSuccess;
  finalSync: TownshipSyncSuccess;
  localOpIds: string[];
  pendingOutboxIds: string[];
  delegationFrameIds: string[];
}

export interface TownshipDesktopOnboardingFailure {
  ok: false;
  reason: TownshipDesktopOnboardingFailureReason;
  message: string;
}

export type TownshipDesktopOnboarding = TownshipDesktopOnboardingSuccess | TownshipDesktopOnboardingFailure;

export async function onboardTownshipDesktop(
  options: TownshipDesktopOnboardingOptions,
): Promise<TownshipDesktopOnboarding> {
  const imported = importTownshipCarrierPairingHandoff(options.pairingHandoff);
  if (!imported.ok) {
    return { ok: false, reason: "invalid_pairing", message: imported.message };
  }

  const storage = createTownshipNativeStorage(options);
  let pairing: TownshipCarrierPeerConfig;
  try {
    const saveOptions = {
      origin: options.origin ?? "handoff",
      ...(options.confirmed !== undefined ? { confirmed: options.confirmed } : {}),
    };
    const saved = await saveTownshipCarrierPeerConfig(
      storage,
      {
        ...imported.draft,
        localRealm: options.localRealm,
        ...(options.keyId !== undefined ? { keyId: options.keyId } : {}),
      },
      saveOptions,
    );
    if (!saved.ok) return { ok: false, reason: "pairing_save_failed", message: saved.message };
    pairing = saved.config;
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to save carrier pairing before onboarding.",
    };
  }

  const initialSync = await syncTownshipOutbox(syncOptions(options, pairing));
  if (!initialSync.ok) return { ok: false, reason: "initial_sync_failed", message: initialSync.message };

  const post = await submitTownshipPost(postOptions(options, pairing));
  if (!post.ok) return { ok: false, reason: "post_failed", message: post.message };

  const finalSync = await syncTownshipOutbox(syncOptions(options, pairing));
  if (!finalSync.ok) return { ok: false, reason: "final_sync_failed", message: finalSync.message };

  const [localOps, pendingOutbox, delegationFrames] = await Promise.all([
    loadJsonArray<{ id: string }>(storage, TOWNSHIP_LOCAL_OP_LOG_KEY),
    loadJsonArray<CarrierOpFrame>(storage, TOWNSHIP_CARRIER_OUTBOX_KEY),
    loadJsonArray<CarrierOpFrame>(storage, TOWNSHIP_DELEGATION_FRAMES_KEY),
  ]);

  return {
    ok: true,
    pairing,
    initialSync,
    post,
    finalSync,
    localOpIds: localOps.map((op) => op.id),
    pendingOutboxIds: pendingOutbox.map((frame) => frame.id),
    delegationFrameIds: delegationFrames.map((frame) => frame.id),
  };
}

function syncOptions(
  options: TownshipDesktopOnboardingOptions,
  pairing: TownshipCarrierPeerConfig,
) {
  return {
    ...(options.invoke !== undefined ? { invoke: options.invoke } : {}),
    ...((pairing.keyId ?? options.keyId) !== undefined ? { keyId: pairing.keyId ?? options.keyId } : {}),
    ...(options.storageNamespace !== undefined ? { storageNamespace: options.storageNamespace } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    peer: options.peer ?? pairing,
    ...(options.verifier !== undefined ? { verifier: options.verifier } : {}),
    ...(options.webSocket !== undefined ? { webSocket: options.webSocket } : {}),
    ...(options.realmByPubkey !== undefined ? { realmByPubkey: options.realmByPubkey } : {}),
  };
}

function postOptions(
  options: TownshipDesktopOnboardingOptions,
  pairing: TownshipCarrierPeerConfig,
) {
  return {
    ...(options.invoke !== undefined ? { invoke: options.invoke } : {}),
    ...((pairing.keyId ?? options.keyId) !== undefined ? { keyId: pairing.keyId ?? options.keyId } : {}),
    ...(options.storageNamespace !== undefined ? { storageNamespace: options.storageNamespace } : {}),
    ...(options.realmByPubkey !== undefined ? { realmByPubkey: options.realmByPubkey } : {}),
    text: options.postText,
  };
}

async function loadJsonArray<T>(storage: ReturnType<typeof createTownshipNativeStorage>, key: string): Promise<T[]> {
  const raw = await storage.getItem(key);
  if (!raw) return [];
  return JSON.parse(raw) as T[];
}
