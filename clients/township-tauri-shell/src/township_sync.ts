import {
  carrierOpsToSemanticOps,
  integrate,
  materialize,
  syncCarrierOnce,
  verifyCarrierOp,
  type CarrierOpFrame,
  type CarrierStateReport,
  type CarrierVerifier,
  type CarrierSyncClient,
  type Verifier,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
  withTownshipPersistenceWrite,
} from "./native_workflow";
import {
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "./township_actions";
import {
  carrierVerifierAsOperationVerifier,
  connectTownshipCarrierPeer,
  createWebCryptoCarrierVerifier,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";
import { townshipMatterSchema } from "./township_preview";

export { TOWNSHIP_REALM_BY_PUBKEY, TOWNSHIP_REPLICA };

export type TownshipSyncFailureReason =
  | "carrier_unconfigured"
  | "native_unavailable"
  | "sync_failed";

export interface SyncTownshipOutboxOptions extends TownshipNativeWorkflowOptions {
  client?: CarrierSyncClient;
  peer?: TownshipCarrierPeerConfig;
  expectedReplica?: string;
  operationVerifier?: Verifier;
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
  strandedReplicaFrameIds: string[];
  unboundReplicaFrameIds: string[];
  unverifiableFrameIds: string[];
  unverifiableArchiveFrameIds: string[];
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
  carrierAcceptedRevocationCount: number;
  carrierAcceptedRevocationIds: string[];
  authorityQuarantinedRevocationCount: number;
  authorityQuarantinedRevocationIds: string[];
  authorityRevokedCapabilityCount: number;
  authorityRevokedCapabilityIds: string[];
  authorityRevokedCapabilityAttributionCount: number;
  authorityRevokedCapabilityAttributions: TownshipRevokedCapabilityAttribution[];
  authorityRevokedCapabilityUnattributedCount: number;
  authorityRevokedCapabilityUnattributedIds: string[];
}

export interface TownshipSyncFailure {
  ok: false;
  reason: TownshipSyncFailureReason;
  message: string;
}

export type TownshipOutboxSync = TownshipSyncSuccess | TownshipSyncFailure;

export interface TownshipRevokedCapabilityAttribution {
  commandId: string;
  delegationId: string;
}

interface CarrierStateReporter {
  stateReport(): Promise<CarrierStateReport>;
}

interface AuthorityRevokedCapabilitySummary {
  ids: string[];
  attributions: TownshipRevokedCapabilityAttribution[];
  unattributedIds: string[];
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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
  const sessionVerifier = options.verifier ?? createWebCryptoCarrierVerifier();
  const operationVerifier = options.operationVerifier ?? carrierVerifierAsOperationVerifier(sessionVerifier);
  if (!client && options.peer) {
    try {
      const connectOptions = {
        workflow,
        peer: options.peer,
        verifier: sessionVerifier,
      };
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
    const realmByPubkey = options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY;
    const expectedReplica = options.peer?.replica ?? options.expectedReplica;
    if (expectedReplica === undefined) {
      return {
        ok: false,
        reason: "sync_failed",
        message: "Expected replica is required for a direct carrier client.",
      };
    }
    const localSyncFrames = mergeCarrierFrames([
      ...localDelegationFrames,
      ...localCarrierFrames,
    ]);
    const syncCandidateFrames = localSyncFrames.filter(
      (frame) => frame.replica === expectedReplica,
    );
    const synced = await syncCarrierOnce(
      client,
      localOps,
      syncCandidateFrames,
      realmByPubkey,
      {
        verifier: operationVerifier,
        submission: options.peer?.submission ?? "push",
        expectedReplica,
      },
    );
    const submittedFrameIds = new Set(synced.pushedFrames.map(frameId));
    const devicePublicKey = bytesBase64(workflow.signer.publicKey);
    const locallyAuthoredCandidates = syncCandidateFrames.filter(
      (frame) =>
        submittedFrameIds.has(frame.id) &&
        frame.author === devicePublicKey,
    );
    const authorityQuarantinedGrantIds = frameIdsForAuthorityQuarantine(
      locallyAuthoredCandidates,
      synced.pushReport.quarantined,
      "grant",
    );
    const carrierAcceptedRevocationIds = frameIdsForAcceptedCommand(
      locallyAuthoredCandidates,
      synced.pushReport.accepted,
      "revoke",
    );
    const authorityQuarantinedRevocationIds = frameIdsForAuthorityQuarantine(
      locallyAuthoredCandidates,
      synced.pushReport.quarantined,
      "revoke",
    );
    const peerReportedFrameIds = new Set(synced.peerReportedFrameIds);
    const persisted = await withTownshipPersistenceWrite(workflow, async () => {
      const [currentOps, currentCarrierFrames, currentDelegationFrames] = await Promise.all([
        workflow.localLog.load(),
        workflow.carrierFrames.load(),
        workflow.delegationFrames.load(),
      ]);
      const mergedOps = integrate(currentOps, synced.ops);
      const delegationFrames = mergeCarrierFrames([
        ...currentDelegationFrames,
        ...currentCarrierFrames,
        ...(synced.pulledFrames as CarrierOpFrame[]),
      ]);
      const compactedFrameIds = [
        ...new Set(
          currentCarrierFrames
            .filter((frame) => peerReportedFrameIds.has(frameId(frame)))
            .map(frameId),
        ),
      ];
      const compactedCarrierFrames = currentCarrierFrames.filter(
        (frame) => !peerReportedFrameIds.has(frameId(frame)),
      );
      const strandedReplicaFrameIds = [
        ...new Set(
          currentCarrierFrames
            .filter(
              (frame) =>
                typeof frame.replica === "string" &&
                frame.replica !== expectedReplica,
            )
            .map(frameId),
        ),
      ];
      const unboundReplicaFrameIds = [
        ...new Set(
          currentCarrierFrames
            .filter((frame) => typeof frame.replica !== "string")
            .map(frameId),
        ),
      ];
      await Promise.all([
        workflow.localLog.save(mergedOps),
        workflow.delegationFrames.save(delegationFrames),
      ]);
      await workflow.carrierFrames.save(compactedCarrierFrames);
      return {
        mergedOps,
        delegationFrames,
        compactedCarrierFrames,
        compactedFrameIds,
        strandedReplicaFrameIds,
        unboundReplicaFrameIds,
      };
    });
    const {
      mergedOps,
      delegationFrames,
      compactedCarrierFrames,
      compactedFrameIds,
      strandedReplicaFrameIds,
      unboundReplicaFrameIds,
    } = persisted;
    const authorityFrameVerification = await partitionVerifiedCarrierFrames(
      delegationFrames.filter((frame) => frame.replica === expectedReplica),
      operationVerifier,
    );
    const authorityRevokedCapabilities = await authorityRevokedCapabilitySummaryWithCrossCheck(
      client,
      authorityFrameVerification.verifiedFrames,
      realmByPubkey,
      expectedReplica,
    );

    return {
      ok: true,
      localOpCount: mergedOps.length,
      carrierFrameCount: compactedCarrierFrames.length,
      pulledFrameCount: synced.pulledFrames.length,
      pulledOpCount: synced.pulledOps.length,
      pushedFrameCount: synced.pushedFrames.length,
      pushedFrameIds: synced.pushedFrames.map(frameId),
      strandedReplicaFrameIds,
      unboundReplicaFrameIds,
      unverifiableFrameIds: synced.unverifiableFrameIds,
      unverifiableArchiveFrameIds:
        authorityFrameVerification.unverifiableFrameIds,
      compactedFrameCount: compactedFrameIds.length,
      compactedFrameIds,
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
      carrierAcceptedRevocationCount: carrierAcceptedRevocationIds.length,
      carrierAcceptedRevocationIds,
      authorityQuarantinedRevocationCount: authorityQuarantinedRevocationIds.length,
      authorityQuarantinedRevocationIds,
      authorityRevokedCapabilityCount: authorityRevokedCapabilities.ids.length,
      authorityRevokedCapabilityIds: authorityRevokedCapabilities.ids,
      authorityRevokedCapabilityAttributionCount: authorityRevokedCapabilities.attributions.length,
      authorityRevokedCapabilityAttributions: authorityRevokedCapabilities.attributions,
      authorityRevokedCapabilityUnattributedCount: authorityRevokedCapabilities.unattributedIds.length,
      authorityRevokedCapabilityUnattributedIds: authorityRevokedCapabilities.unattributedIds,
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

function bytesBase64(bytes: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...bytes));
}

async function partitionVerifiedCarrierFrames(
  frames: CarrierOpFrame[],
  verifier: Verifier,
): Promise<{
  verifiedFrames: CarrierOpFrame[];
  unverifiableFrameIds: string[];
}> {
  const results = await Promise.all(
    frames.map(async (frame): Promise<boolean> => {
      try {
        const verification = await verifyCarrierOp(frame, verifier);
        return verification.valid;
      } catch {
        return false;
      }
    }),
  );
  const verifiedFrames = frames.filter((_frame, index) => results[index] === true);
  const unverifiableFrameIds = frames
    .filter((_frame, index) => results[index] !== true)
    .map(frameId);
  return { verifiedFrames, unverifiableFrameIds };
}

function frameIdsForAcceptedCommand(
  frames: CarrierOpFrame[],
  accepted: readonly string[],
  commandName: string,
): string[] {
  const acceptedIds = new Set(accepted);
  return frames
    .filter((frame) => acceptedIds.has(frame.id) && frameCommandName(frame) === commandName)
    .map(frameId);
}

function frameIdsForAuthorityQuarantine(
  frames: CarrierOpFrame[],
  quarantined: readonly (readonly [string, string])[],
  commandName: string,
): string[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  return quarantined
    .filter(([id, reason]) => reason === "authority" && frameCommandName(byId.get(id)) === commandName)
    .map(([id]) => id);
}

async function authorityRevokedCapabilitySummaryWithCrossCheck(
  client: CarrierSyncClient,
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
  expectedReplica: string,
): Promise<AuthorityRevokedCapabilitySummary> {
  const localSummary = localAuthorityRevokedCapabilitySummary(
    frames,
    realmByPubkey,
    expectedReplica,
  );
  if (!canReportCarrierState(client)) return localSummary;

  let report: CarrierStateReport;
  try {
    report = await client.stateReport();
  } catch {
    return localSummary;
  }

  if (!sameStringSet(report.op_ids, frames.map(frameId))) return localSummary;

  const reportedIds = quarantineIdsForReason(report.authority_quarantine, "revoked_capability");
  if (!sameStringSet(reportedIds, localSummary.ids)) {
    throw new Error(
      `authority_report_divergence: local revoked_capability ids ${JSON.stringify(localSummary.ids)} ` +
        `do not match carrier ids ${JSON.stringify(reportedIds)}`,
    );
  }

  return localSummary;
}

function localAuthorityRevokedCapabilitySummary(
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
  expectedReplica: string,
): AuthorityRevokedCapabilitySummary {
  const semanticOps = carrierOpsToSemanticOps(mergeCarrierFrames(frames), realmByPubkey);
  const local = materialize(
    townshipMatterSchema,
    semanticOps,
    undefined,
    null,
    expectedReplica,
  );
  return authorityRevokedCapabilitySummary([...local.quarantineReasons], frames);
}

function canReportCarrierState(client: CarrierSyncClient): client is CarrierSyncClient & CarrierStateReporter {
  return typeof (client as Partial<CarrierStateReporter>).stateReport === "function";
}

function quarantineIdsForReason(
  quarantined: readonly (readonly [string, string])[],
  reason: string,
): string[] {
  return [...new Set(quarantined.filter(([, entryReason]) => entryReason === reason).map(([id]) => id))].sort();
}

function authorityRevokedCapabilitySummary(
  quarantined: readonly (readonly [string, string])[],
  frames: CarrierOpFrame[],
): AuthorityRevokedCapabilitySummary {
  const ids = quarantineIdsForReason(quarantined, "revoked_capability");
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  const attributedIds = new Set<string>();
  const attributions = ids
    .flatMap((id) => {
      const delegationId = delegationIdFromCapTerm(framesById.get(id)?.cap);
      if (delegationId === null) return [];
      attributedIds.add(id);
      return [{ commandId: id, delegationId }];
    })
    .sort((left, right) => left.commandId.localeCompare(right.commandId));
  const unattributedIds = ids.filter((id) => !attributedIds.has(id));

  return { ids, attributions, unattributedIds };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function delegationIdFromCapTerm(cap: CarrierOpFrame["cap"] | undefined): string | null {
  if (cap?.[0] !== "bin") return null;
  const delegationId = base64Utf8(cap[1]);
  return delegationId && delegationId.length > 0 ? delegationId : null;
}

function base64Utf8(value: string): string | null {
  try {
    const decoded = globalThis.atob(value);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
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
