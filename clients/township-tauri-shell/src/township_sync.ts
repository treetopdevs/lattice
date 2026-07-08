import {
  syncCarrierOnce,
  type CarrierOpFrame,
  type CarrierVerifier,
  type CarrierSyncClient,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import {
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "./township_actions";
import {
  connectTownshipCarrierPeer,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";

export { TOWNSHIP_REALM_BY_PUBKEY, TOWNSHIP_REPLICA };

export type TownshipSyncFailureReason =
  | "carrier_unconfigured"
  | "native_unavailable"
  | "sync_failed";

export interface SyncTownshipOutboxOptions extends TownshipNativeWorkflowOptions {
  client?: CarrierSyncClient;
  peer?: TownshipCarrierPeerConfig;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  realmByPubkey?: Record<string, string>;
  workflow?: TownshipNativeWorkflow;
}

export interface TownshipSyncSuccess {
  ok: true;
  localOpCount: number;
  carrierFrameCount: number;
  pulledFrameCount: number;
  pulledOpCount: number;
  pushedFrameCount: number;
  pushedFrameIds: string[];
  compactedFrameCount: number;
  compactedFrameIds: string[];
  delegationFrameCount: number;
  acceptedCount: number;
  acceptedIds: string[];
  quarantinedCount: number;
  quarantined: [string, string][];
  rejectedCount: number;
  rejected: [string, string][];
  pendingCount: number;
  pending: string[];
  authorityQuarantinedGrantCount: number;
  authorityQuarantinedGrantIds: string[];
}

export interface TownshipSyncFailure {
  ok: false;
  reason: TownshipSyncFailureReason;
  message: string;
}

export type TownshipOutboxSync = TownshipSyncSuccess | TownshipSyncFailure;

export async function syncTownshipOutbox(
  options: SyncTownshipOutboxOptions = {},
): Promise<TownshipOutboxSync> {
  if (!options.client && !options.peer) {
    return {
      ok: false,
      reason: "carrier_unconfigured",
      message: "Connect a carrier peer before syncing.",
    };
  }

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions(options)));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to load local logs before syncing.",
    };
  }

  let client = options.client;
  let connectedClient: (CarrierSyncClient & { close(): void }) | null = null;
  if (!client && options.peer) {
    try {
      const connectOptions = {
        workflow,
        peer: options.peer,
      };
      if (options.verifier !== undefined) Object.assign(connectOptions, { verifier: options.verifier });
      if (options.webSocket !== undefined) Object.assign(connectOptions, { webSocket: options.webSocket });
      connectedClient = await connectTownshipCarrierPeer(connectOptions);
      client = connectedClient;
    } catch (error) {
      return {
        ok: false,
        reason: "sync_failed",
        message: errorMessage(error),
      };
    }
  }
  if (!client) {
    return {
      ok: false,
      reason: "carrier_unconfigured",
      message: "Connect a carrier peer before syncing.",
    };
  }

  let localOps;
  let localCarrierFrames;
  let localDelegationFrames;
  try {
    [localOps, localCarrierFrames, localDelegationFrames] = await Promise.all([
      workflow.localLog.load(),
      workflow.carrierFrames.load(),
      workflow.delegationFrames.load(),
    ]);
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to load local logs before syncing.",
    };
  }

  try {
    const synced = await syncCarrierOnce(
      client,
      localOps,
      localCarrierFrames,
      options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
    );
    const authorityQuarantinedGrantIds = grantFrameIdsForAuthorityQuarantine(
      localCarrierFrames,
      synced.pushReport.quarantined,
    );
    await workflow.localLog.save(synced.ops);
    const delegationFrames = mergeCarrierFrames([
      ...localDelegationFrames,
      ...localCarrierFrames,
      ...(synced.pulledFrames as CarrierOpFrame[]),
    ]);
    const acknowledgedFrameIds = new Set(synced.acknowledgedFrameIds);
    const compactedCarrierFrames = localCarrierFrames.filter((frame) => !acknowledgedFrameIds.has(frameId(frame)));
    await Promise.all([
      workflow.delegationFrames.save(delegationFrames),
      workflow.carrierFrames.save(compactedCarrierFrames),
    ]);

    return {
      ok: true,
      localOpCount: synced.ops.length,
      carrierFrameCount: compactedCarrierFrames.length,
      pulledFrameCount: synced.pulledFrames.length,
      pulledOpCount: synced.pulledOps.length,
      pushedFrameCount: synced.pushedFrames.length,
      pushedFrameIds: synced.pushedFrames.map(frameId),
      compactedFrameCount: synced.acknowledgedFrameIds.length,
      compactedFrameIds: synced.acknowledgedFrameIds,
      delegationFrameCount: delegationFrames.length,
      acceptedCount: synced.pushReport.accepted.length,
      acceptedIds: synced.pushReport.accepted,
      quarantinedCount: synced.pushReport.quarantined.length,
      quarantined: synced.pushReport.quarantined,
      rejectedCount: synced.pushReport.rejected.length,
      rejected: synced.pushReport.rejected,
      pendingCount: synced.pushReport.pending.length,
      pending: synced.pushReport.pending,
      authorityQuarantinedGrantCount: authorityQuarantinedGrantIds.length,
      authorityQuarantinedGrantIds,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "sync_failed",
      message: errorMessage(error),
    };
  } finally {
    connectedClient?.close();
  }
}

function mergeCarrierFrames(frames: CarrierOpFrame[]): CarrierOpFrame[] {
  return [...new Map(frames.map((frame) => [frame.id, frame])).values()];
}

function grantFrameIdsForAuthorityQuarantine(
  frames: CarrierOpFrame[],
  quarantined: readonly (readonly [string, string])[],
): string[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  return quarantined
    .filter(([id, reason]) => reason === "authority" && frameCommandName(byId.get(id)) === "grant")
    .map(([id]) => id);
}

function frameCommandName(frame: CarrierOpFrame | undefined): string | null {
  const body = frame?.body;
  if (body?.[0] !== "tuple") return null;

  const command = body[1][0];
  return command?.[0] === "atom" ? command[1] : null;
}

function workflowOptions(options: SyncTownshipOutboxOptions): TownshipNativeWorkflowOptions {
  const workflow: TownshipNativeWorkflowOptions = {};
  if (options.invoke !== undefined) workflow.invoke = options.invoke;
  if (options.storageNamespace !== undefined) workflow.storageNamespace = options.storageNamespace;
  const keyId = options.keyId ?? options.peer?.keyId;
  if (keyId !== undefined) workflow.keyId = keyId;
  return workflow;
}

function frameId(frame: unknown): string {
  if (frame && typeof frame === "object" && typeof (frame as { id?: unknown }).id === "string") {
    return (frame as { id: string }).id;
  }

  throw new Error("carrier frame missing id");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
