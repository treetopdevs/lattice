import {
  authorTownshipCommand,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  frontier,
  type CarrierOpFrame,
  type CarrierVerifier,
  type Op,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  logTownshipProbeEvent,
  TOWNSHIP_NATIVE_KEY_ID,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import {
  submitTownshipDelegation,
  submitTownshipPost,
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
  type TownshipDelegationSubmission,
  type TownshipPostSubmission,
} from "./township_actions";
import {
  connectTownshipCarrierPeer,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";
import { townshipReleaseTransportProbeHostClass } from "./township_release_transport_probe";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

export const TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX = "township-release-author-probe";
export const TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE = "township:release-author-probe";
export const TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_POST_TEXT = "release probe post";
export const TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_BAD_SUMMARY_TEXT = "release probe unauthorized summary";
export const TOWNSHIP_RELEASE_AUTHOR_PROBE_EXPECTED_BAD_AUTHORITY_REASON = "operation_not_granted";
export const TOWNSHIP_RELEASE_AUTHOR_PROBE_METADATA_KEY = "release_author_probe_metadata";

export interface TownshipReleaseAuthorProbeEnv {
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_REPLICA?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_KEY_ID?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_POST_TEXT?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_BAD_SUMMARY_TEXT?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_TIMEOUT_MS?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_RETRY_DELAY_MS?: string;
  VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PAUSE_AFTER_AUTHOR_MS?: string;
}

export interface TownshipReleaseAuthorProbeConfig {
  peer: TownshipCarrierPeerConfig;
  keyId: string;
  storageNamespace: string;
  grantAudiencePubkey?: string;
  postText: string;
  badSummaryText: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  pauseAfterAuthorMs?: number;
}

export type TownshipReleaseAuthorProbeResult =
  | {
      phase: "native_key";
      publicKeyBase64: string;
      localRealm: string;
      storageNamespace: string;
    }
  | {
      phase: "reload";
      outcome: "loaded";
      localOpIds: string[];
      delegationFrameIds: string[];
      carrierFrameCount: number;
    }
  | {
      phase: "pull";
      outcome: "synced";
      elapsedMs: number;
      pulledOpIds: string[];
      localOpIds: string[];
      delegationFrameIds: string[];
      carrierFrameCount: number;
      pushedFrameCount: number;
      acceptedCount: number;
      grantDelegationId: string;
    }
  | {
      phase: "grant";
      outcome: "authored";
      grantFrameId: string;
      grantDelegationId: string;
      grantAudiencePubkey: string;
      grantOps: string[];
      parentId: string | null;
      authorPublicKeyBase64: string;
      localOpCount: number;
      carrierFrameCount: number;
      delegationFrameCount: number;
    }
  | {
      phase: "author";
      outcome: "authored";
      postFrameId: string;
      badFrameId: string;
      capId: string;
      authorPublicKeyBase64: string;
      localOpCount: number;
      carrierFrameCount: number;
    }
  | {
      phase: "push";
      outcome: "synced";
      elapsedMs: number;
      pushedFrameIds: string[];
      acceptedCount: number;
      carrierFrameCount: number;
      pendingCount: number;
    }
  | {
      phase: "peer";
      outcome: "reported";
      postFrameId: string;
      badFrameId: string;
      postMaterialized: boolean;
      badAuthorityReason: string;
      appGrantFrameId?: string;
      appGrantAuthorityAccepted?: boolean;
      carrierFrameCount: number;
    }
  | {
      phase: "pull" | "grant" | "author" | "push" | "peer";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    };

export interface TownshipReleaseAuthorProbeSyncOptions {
  phase: "pull" | "push";
  config: TownshipReleaseAuthorProbeConfig;
  workflow: TownshipNativeWorkflow;
  realmByPubkey: Record<string, string>;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleaseAuthorProbeSubmitPostOptions {
  config: TownshipReleaseAuthorProbeConfig;
  workflow: TownshipNativeWorkflow;
  realmByPubkey: Record<string, string>;
}

export interface TownshipReleaseAuthorProbeSubmitGrantOptions extends TownshipReleaseAuthorProbeSubmitPostOptions {
  grantDelegationId: string;
}

export interface TownshipReleaseAuthorProbeBadFrameOptions extends TownshipReleaseAuthorProbeSubmitPostOptions {
  capId: string;
}

export interface TownshipReleaseAuthorProbeStateReportOptions extends TownshipReleaseAuthorProbeBadFrameOptions {
  appGrantFrameId?: string;
  postFrameId: string;
  badFrameId: string;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleaseAuthorProbeStateReportResult {
  ok: boolean;
  postMaterialized: boolean;
  badAuthorityReason: string;
  appGrantAuthorityAccepted?: boolean;
  message?: string;
}

interface TownshipReleaseAuthorProbeMetadata {
  stage: "authored" | "pushed";
  appGrantFrameId?: string;
  appGrantDelegationId?: string;
  grantAudiencePubkey?: string;
  grantParentId?: string | null;
  postFrameId: string;
  badFrameId: string;
  capId: string;
  authorPublicKeyBase64: string;
}

export interface TownshipReleaseAuthorProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  workflow?: TownshipNativeWorkflow;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  timeoutMs?: number;
  retryDelayMs?: number;
  sync?(options: TownshipReleaseAuthorProbeSyncOptions): Promise<TownshipOutboxSync>;
  submitGrant?(options: TownshipReleaseAuthorProbeSubmitGrantOptions): Promise<TownshipDelegationSubmission>;
  submitPost?(options: TownshipReleaseAuthorProbeSubmitPostOptions): Promise<TownshipPostSubmission>;
  authorBadFrame?(options: TownshipReleaseAuthorProbeBadFrameOptions): Promise<{ frameId: string }>;
  findGrantDelegationId?(workflow: TownshipNativeWorkflow, audiencePublicKeyBase64: string): Promise<string>;
  stateReport?(options: TownshipReleaseAuthorProbeStateReportOptions): Promise<TownshipReleaseAuthorProbeStateReportResult>;
}

export function townshipReleaseAuthorProbeConfigFromEnv(
  env: TownshipReleaseAuthorProbeEnv,
): TownshipReleaseAuthorProbeConfig | null {
  const url = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL);
  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_LOCAL_REALM);
  const expectedPeerRealm = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_REALM);
  const expectedPeerPubkey = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY);
  const replica = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_REPLICA) ?? TOWNSHIP_REPLICA;
  const keyId = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_KEY_ID) ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace =
    present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE) ?? TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE;
  const grantAudiencePubkey = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY);
  const postText = present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_POST_TEXT) ?? TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_POST_TEXT;
  const badSummaryText =
    present(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_BAD_SUMMARY_TEXT) ??
    TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_BAD_SUMMARY_TEXT;
  const timeoutMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_RETRY_DELAY_MS);
  const pauseAfterAuthorMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PAUSE_AFTER_AUTHOR_MS);

  if (
    !url ||
    !validProbeUrl(url) ||
    !localRealm ||
    !expectedPeerRealm ||
    !validPublicKey(expectedPeerPubkey) ||
    (grantAudiencePubkey !== null && !validPublicKey(grantAudiencePubkey))
  ) {
    return null;
  }

  const config: TownshipReleaseAuthorProbeConfig = {
    peer: {
      url,
      localRealm,
      expectedPeerRealm,
      expectedPeerPubkey: expectedPeerPubkey as string,
      replica,
      keyId,
    },
    keyId,
    storageNamespace,
    postText,
    badSummaryText,
  };
  if (grantAudiencePubkey !== null) config.grantAudiencePubkey = grantAudiencePubkey;
  if (timeoutMs !== null) config.timeoutMs = timeoutMs;
  if (retryDelayMs !== null) config.retryDelayMs = retryDelayMs;
  if (pauseAfterAuthorMs !== null) config.pauseAfterAuthorMs = pauseAfterAuthorMs;
  return config;
}

export async function logTownshipReleaseAuthorProbeFromEnv(
  env: TownshipReleaseAuthorProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleaseAuthorProbeEnv }).env ?? {}),
  options: TownshipReleaseAuthorProbeOptions = {},
): Promise<TownshipReleaseAuthorProbeResult | null> {
  const config = townshipReleaseAuthorProbeConfigFromEnv(env);
  if (!config) return null;

  const workflowOptions: TownshipNativeWorkflowOptions = {
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (options.invoke !== undefined) workflowOptions.invoke = options.invoke;
  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions));
  const nativeKeyResult: TownshipReleaseAuthorProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.peer.localRealm,
    storageNamespace: config.storageNamespace,
  };
  await logTownshipProbeEvent(townshipReleaseAuthorProbeLogLine(nativeKeyResult), options);
  await logTownshipProbeEvent(townshipReleaseAuthorProbeLogLine(await townshipReleaseAuthorReloadResult(workflow)), options);

  return probeTownshipReleaseAuthor({
    ...options,
    config,
    workflow,
    onResult: async (result) => {
      await logTownshipProbeEvent(townshipReleaseAuthorProbeLogLine(result), options);
    },
  });
}

export async function probeTownshipReleaseAuthor(
  options: TownshipReleaseAuthorProbeOptions & {
    config: TownshipReleaseAuthorProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseAuthorProbeResult): Promise<void>;
  },
): Promise<TownshipReleaseAuthorProbeResult> {
  const authorPublicKeyBase64 = bytesBase64(options.workflow.signer.publicKey);
  const realmByPubkey = {
    ...TOWNSHIP_REALM_BY_PUBKEY,
    [authorPublicKeyBase64]: options.config.peer.localRealm,
  };
  const prePullReload = await reload(options.workflow);
  const metadata = await loadAuthorMetadata(options.workflow);

  if (metadata?.stage === "pushed" || (metadata?.stage === "authored" && prePullReload.carrierFrameCount === 0)) {
    return reportAuthored(options, realmByPubkey, metadata);
  }

  if (metadata?.stage === "authored" && prePullReload.carrierFrameCount > 0) {
    return pushAndReport(options, realmByPubkey, metadata);
  }

  const pullSync = await retrySync("pull", options, realmByPubkey);
  if (!pullSync.ok) {
    const result = failureResult("pull", pullSync);
    await options.onResult?.(result);
    return result;
  }

  const grantDelegationId = await (options.findGrantDelegationId ?? findPostOnlyGrantDelegationId)(
    options.workflow,
    authorPublicKeyBase64,
  );
  const pullReload = await reload(options.workflow);
  const pullResult: TownshipReleaseAuthorProbeResult = {
    phase: "pull",
    outcome: "synced",
    elapsedMs: pullSync.elapsedMs,
    pulledOpIds: difference(pullReload.localOpIds, prePullReload.localOpIds),
    localOpIds: pullReload.localOpIds,
    delegationFrameIds: pullReload.delegationFrameIds,
    carrierFrameCount: pullReload.carrierFrameCount,
    pushedFrameCount: pullSync.sync.pushedFrameCount,
    acceptedCount: pullSync.sync.acceptedCount,
    grantDelegationId,
  };
  await options.onResult?.(pullResult);

  const appGrant = await submitReleaseAuthorAppGrant(options, realmByPubkey, grantDelegationId, authorPublicKeyBase64);
  if (isReleaseAuthorAppGrantFailure(appGrant)) {
    await options.onResult?.(appGrant);
    return appGrant;
  }

  const post = await (options.submitPost ?? submitReleaseAuthorPost)({
    config: options.config,
    workflow: options.workflow,
    realmByPubkey,
  });
  if (!post.ok) {
    const result: TownshipReleaseAuthorProbeResult = {
      phase: "author",
      outcome: "error",
      elapsedMs: 0,
      message: post.message,
    };
    await options.onResult?.(result);
    return result;
  }

  const badFrame = await (options.authorBadFrame ?? authorReleaseBadSummaryFrame)({
    config: options.config,
    workflow: options.workflow,
    realmByPubkey,
    capId: post.capId,
  });
  const authorReload = await reload(options.workflow);
  const authored: TownshipReleaseAuthorProbeMetadata = {
    stage: "authored",
    ...appGrant,
    postFrameId: post.frameId,
    badFrameId: badFrame.frameId,
    capId: post.capId,
    authorPublicKeyBase64,
  };
  await saveAuthorMetadata(options.workflow, authored);
  const authorResult: TownshipReleaseAuthorProbeResult = {
    phase: "author",
    outcome: "authored",
    postFrameId: post.frameId,
    badFrameId: badFrame.frameId,
    capId: post.capId,
    authorPublicKeyBase64,
    localOpCount: authorReload.localOpIds.length,
    carrierFrameCount: authorReload.carrierFrameCount,
  };
  await options.onResult?.(authorResult);
  await delay(options.config.pauseAfterAuthorMs ?? 0);

  return pushAndReport(options, realmByPubkey, authored);
}

async function pushAndReport(
  options: TownshipReleaseAuthorProbeOptions & {
    config: TownshipReleaseAuthorProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseAuthorProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  authored: TownshipReleaseAuthorProbeMetadata,
): Promise<TownshipReleaseAuthorProbeResult> {
  const pushSync = await retrySync("push", options, realmByPubkey);
  if (!pushSync.ok) {
    const result = failureResult("push", pushSync);
    await options.onResult?.(result);
    return result;
  }
  const pushReload = await reload(options.workflow);
  const pushResult: TownshipReleaseAuthorProbeResult = {
    phase: "push",
    outcome: "synced",
    elapsedMs: pushSync.elapsedMs,
    pushedFrameIds: pushSync.sync.pushedFrameIds,
    acceptedCount: pushSync.sync.acceptedCount,
    carrierFrameCount: pushReload.carrierFrameCount,
    pendingCount: pushSync.sync.pendingCount,
  };
  // Mark pushed only after the carrier sync returns and the reload reflects the post-push outbox.
  await saveAuthorMetadata(options.workflow, { ...authored, stage: "pushed" });
  await options.onResult?.(pushResult);

  return reportAuthored(options, realmByPubkey, authored);
}

async function reportAuthored(
  options: TownshipReleaseAuthorProbeOptions & {
    config: TownshipReleaseAuthorProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseAuthorProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  authored: TownshipReleaseAuthorProbeMetadata,
): Promise<TownshipReleaseAuthorProbeResult> {
  const stateReportOptions: TownshipReleaseAuthorProbeStateReportOptions = {
    config: options.config,
    workflow: options.workflow,
    realmByPubkey,
    capId: authored.capId,
    postFrameId: authored.postFrameId,
    badFrameId: authored.badFrameId,
  };
  if (authored.appGrantFrameId !== undefined) stateReportOptions.appGrantFrameId = authored.appGrantFrameId;
  if (options.verifier !== undefined) stateReportOptions.verifier = options.verifier;
  if (options.webSocket !== undefined) stateReportOptions.webSocket = options.webSocket;
  const report = await (options.stateReport ?? releaseAuthorStateReport)(stateReportOptions);
  if (!report.ok) {
    const result: TownshipReleaseAuthorProbeResult = {
      phase: "peer",
      outcome: "error",
      elapsedMs: 0,
      message: report.message ?? "peer state report failed",
    };
    await options.onResult?.(result);
    return result;
  }
  if (!report.postMaterialized || report.badAuthorityReason !== TOWNSHIP_RELEASE_AUTHOR_PROBE_EXPECTED_BAD_AUTHORITY_REASON) {
    const result: TownshipReleaseAuthorProbeResult = {
      phase: "peer",
      outcome: "error",
      elapsedMs: 0,
      message: `unexpected_peer_report_${report.postMaterialized}_${report.badAuthorityReason}`,
    };
    await options.onResult?.(result);
    return result;
  }
  if (authored.appGrantFrameId !== undefined && report.appGrantAuthorityAccepted !== true) {
    const result: TownshipReleaseAuthorProbeResult = {
      phase: "peer",
      outcome: "error",
      elapsedMs: 0,
      message: `unexpected_app_grant_authority_${report.appGrantAuthorityAccepted === false ? "false" : "missing"}`,
    };
    await options.onResult?.(result);
    return result;
  }
  const finalReload = await reload(options.workflow);
  const peerResult: TownshipReleaseAuthorProbeResult = {
    phase: "peer",
    outcome: "reported",
    postFrameId: authored.postFrameId,
    badFrameId: authored.badFrameId,
    postMaterialized: report.postMaterialized,
    badAuthorityReason: report.badAuthorityReason,
    carrierFrameCount: finalReload.carrierFrameCount,
  };
  if (authored.appGrantFrameId !== undefined) {
    peerResult.appGrantFrameId = authored.appGrantFrameId;
    peerResult.appGrantAuthorityAccepted = true;
  }
  await options.onResult?.(peerResult);
  return peerResult;
}

export function townshipReleaseAuthorProbeLogLine(result: TownshipReleaseAuthorProbeResult): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `storage_namespace=${probeToken(result.storageNamespace)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  if (result.phase === "reload" && result.outcome === "loaded") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=reload",
      "outcome=loaded",
      `local_op_ids=${probeIdList(result.localOpIds)}`,
      `delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  if (result.outcome === "error" || result.outcome === "timeout") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      `phase=${result.phase}`,
      `outcome=${result.outcome}`,
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
      `message=${probeToken(result.message)}`,
    ].join(" ");
  }

  if (result.phase === "pull" && result.outcome === "synced") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=pull",
      "outcome=synced",
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
      `pulled_op_ids=${probeIdList(result.pulledOpIds)}`,
      `local_op_ids=${probeIdList(result.localOpIds)}`,
      `delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
      `pushed_frame_count=${result.pushedFrameCount}`,
      `accepted_count=${result.acceptedCount}`,
      `grant_delegation_id=${probeToken(result.grantDelegationId)}`,
    ].join(" ");
  }

  if (result.phase === "author" && result.outcome === "authored") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=author",
      "outcome=authored",
      `post_frame_id=${probeToken(result.postFrameId)}`,
      `bad_frame_id=${probeToken(result.badFrameId)}`,
      `cap_id=${probeToken(result.capId)}`,
      `author_b64url=${base64UrlEncode(result.authorPublicKeyBase64)}`,
      `local_op_count=${result.localOpCount}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  if (result.phase === "grant" && result.outcome === "authored") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=grant",
      "outcome=authored",
      `grant_frame_id=${probeToken(result.grantFrameId)}`,
      `grant_delegation_id=${probeToken(result.grantDelegationId)}`,
      `grant_audience_b64url=${base64UrlEncode(result.grantAudiencePubkey)}`,
      `grant_ops=${probeIdList(result.grantOps)}`,
      `parent_id=${probeToken(result.parentId ?? "none")}`,
      `author_b64url=${base64UrlEncode(result.authorPublicKeyBase64)}`,
      `local_op_count=${result.localOpCount}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
      `delegation_frame_count=${result.delegationFrameCount}`,
    ].join(" ");
  }

  if (result.phase === "push" && result.outcome === "synced") {
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=push",
      "outcome=synced",
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
      `pushed_frame_ids=${probeIdList(result.pushedFrameIds)}`,
      `accepted_count=${result.acceptedCount}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
      `pending_count=${result.pendingCount}`,
    ].join(" ");
  }

  if (result.phase === "peer" && result.outcome === "reported") {
    const appGrantFields =
      result.appGrantFrameId === undefined
        ? []
        : [
            `grant_frame_id=${probeToken(result.appGrantFrameId)}`,
            `grant_authority_accepted=${result.appGrantAuthorityAccepted === true}`,
          ];
    return [
      TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
      "phase=peer",
      "outcome=reported",
      `post_frame_id=${probeToken(result.postFrameId)}`,
      `bad_frame_id=${probeToken(result.badFrameId)}`,
      `post_materialized=${result.postMaterialized}`,
      `bad_authority_reason=${probeToken(result.badAuthorityReason)}`,
      ...appGrantFields,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  return [
    TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX,
    `phase=${result.phase}`,
    "outcome=error",
    "elapsed_ms=0",
    "message=unexpected_probe_result",
  ].join(" ");
}

interface ReloadResult {
  localOpIds: string[];
  delegationFrameIds: string[];
  carrierFrameCount: number;
}

export async function townshipReleaseAuthorReloadResult(
  workflow: TownshipNativeWorkflow,
): Promise<TownshipReleaseAuthorProbeResult> {
  const loaded = await reload(workflow);
  return {
    phase: "reload",
    outcome: "loaded",
    localOpIds: loaded.localOpIds,
    delegationFrameIds: loaded.delegationFrameIds,
    carrierFrameCount: loaded.carrierFrameCount,
  };
}

type RetrySyncResult =
  | {
      ok: true;
      elapsedMs: number;
      sync: Extract<TownshipOutboxSync, { ok: true }>;
    }
  | {
      ok: false;
      elapsedMs: number;
      outcome: "error" | "timeout";
      message: string;
    };

async function retrySync(
  phase: "pull" | "push",
  options: TownshipReleaseAuthorProbeOptions & {
    config: TownshipReleaseAuthorProbeConfig;
    workflow: TownshipNativeWorkflow;
  },
  realmByPubkey: Record<string, string>,
): Promise<RetrySyncResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? options.config.timeoutMs ?? 60_000);
  let lastMessage = "carrier peer unavailable";

  while (Date.now() <= deadline) {
    const syncOptions: TownshipReleaseAuthorProbeSyncOptions = {
      phase,
      config: options.config,
      workflow: options.workflow,
      realmByPubkey,
    };
    if (options.verifier !== undefined) syncOptions.verifier = options.verifier;
    if (options.webSocket !== undefined) syncOptions.webSocket = options.webSocket;
    const sync = await (options.sync ?? syncReleaseAuthorOnce)(syncOptions);

    if (sync.ok) {
      return { ok: true, elapsedMs: Date.now() - started, sync };
    }

    lastMessage = sync.message;
    await delay(options.retryDelayMs ?? options.config.retryDelayMs ?? 500);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - started,
    outcome: "timeout",
    message: lastMessage,
  };
}

function failureResult(phase: "pull" | "push", result: Extract<RetrySyncResult, { ok: false }>): TownshipReleaseAuthorProbeResult {
  return {
    phase,
    outcome: result.outcome,
    elapsedMs: result.elapsedMs,
    message: result.message,
  };
}

async function syncReleaseAuthorOnce(options: TownshipReleaseAuthorProbeSyncOptions): Promise<TownshipOutboxSync> {
  const syncOptions = {
    workflow: options.workflow,
    peer: options.config.peer,
    storageNamespace: options.config.storageNamespace,
    keyId: options.config.keyId,
    realmByPubkey: options.realmByPubkey,
  };
  if (options.verifier !== undefined) Object.assign(syncOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(syncOptions, { webSocket: options.webSocket });
  return syncTownshipOutbox(syncOptions);
}

async function loadAuthorMetadata(
  workflow: TownshipNativeWorkflow,
): Promise<TownshipReleaseAuthorProbeMetadata | null> {
  const raw = await workflow.storage.getItem(TOWNSHIP_RELEASE_AUTHOR_PROBE_METADATA_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<TownshipReleaseAuthorProbeMetadata>;
    if (
      (parsed.stage === "authored" || parsed.stage === "pushed") &&
      typeof parsed.postFrameId === "string" &&
      typeof parsed.badFrameId === "string" &&
      typeof parsed.capId === "string" &&
      typeof parsed.authorPublicKeyBase64 === "string"
    ) {
      const metadata: TownshipReleaseAuthorProbeMetadata = {
        stage: parsed.stage,
        postFrameId: parsed.postFrameId,
        badFrameId: parsed.badFrameId,
        capId: parsed.capId,
        authorPublicKeyBase64: parsed.authorPublicKeyBase64,
      };
      if (
        typeof parsed.appGrantFrameId === "string" &&
        typeof parsed.appGrantDelegationId === "string" &&
        typeof parsed.grantAudiencePubkey === "string" &&
        (typeof parsed.grantParentId === "string" || parsed.grantParentId === null)
      ) {
        metadata.appGrantFrameId = parsed.appGrantFrameId;
        metadata.appGrantDelegationId = parsed.appGrantDelegationId;
        metadata.grantAudiencePubkey = parsed.grantAudiencePubkey;
        metadata.grantParentId = parsed.grantParentId;
      }
      return metadata;
    }
  } catch {
    return null;
  }
  return null;
}

async function saveAuthorMetadata(
  workflow: TownshipNativeWorkflow,
  metadata: TownshipReleaseAuthorProbeMetadata,
): Promise<void> {
  await workflow.storage.setItem(TOWNSHIP_RELEASE_AUTHOR_PROBE_METADATA_KEY, JSON.stringify(metadata));
}

interface ReleaseAuthorAppGrantMetadata {
  appGrantFrameId?: string;
  appGrantDelegationId?: string;
  grantAudiencePubkey?: string;
  grantParentId?: string | null;
}

interface ReleaseAuthorAppGrantFailure {
  phase: "grant";
  outcome: "error";
  elapsedMs: number;
  message: string;
}

type ReleaseAuthorAppGrantResult = ReleaseAuthorAppGrantMetadata | ReleaseAuthorAppGrantFailure;

function isReleaseAuthorAppGrantFailure(result: ReleaseAuthorAppGrantResult): result is ReleaseAuthorAppGrantFailure {
  return "phase" in result;
}

async function submitReleaseAuthorAppGrant(
  options: TownshipReleaseAuthorProbeOptions & {
    config: TownshipReleaseAuthorProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseAuthorProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  grantDelegationId: string,
  authorPublicKeyBase64: string,
): Promise<ReleaseAuthorAppGrantResult> {
  if (options.config.grantAudiencePubkey === undefined) return {};

  const grant = await (options.submitGrant ?? submitReleaseAuthorGrant)({
    config: options.config,
    workflow: options.workflow,
    realmByPubkey,
    grantDelegationId,
  });
  if (!grant.ok) {
    return {
      phase: "grant",
      outcome: "error",
      elapsedMs: 0,
      message: grant.message,
    };
  }

  const grantReload = await reload(options.workflow);
  const result: TownshipReleaseAuthorProbeResult = {
    phase: "grant",
    outcome: "authored",
    grantFrameId: grant.frameId,
    grantDelegationId: grant.delegationId,
    grantAudiencePubkey: grant.audiencePubkey,
    grantOps: grant.ops,
    parentId: grant.parentId,
    authorPublicKeyBase64,
    localOpCount: grantReload.localOpIds.length,
    carrierFrameCount: grantReload.carrierFrameCount,
    delegationFrameCount: grant.delegationFrameCount,
  };
  await options.onResult?.(result);

  return {
    appGrantFrameId: grant.frameId,
    appGrantDelegationId: grant.delegationId,
    grantAudiencePubkey: grant.audiencePubkey,
    grantParentId: grant.parentId,
  };
}

async function submitReleaseAuthorGrant(
  options: TownshipReleaseAuthorProbeSubmitGrantOptions,
): Promise<TownshipDelegationSubmission> {
  if (options.config.grantAudiencePubkey === undefined) {
    return {
      ok: false,
      reason: "empty_audience",
      message: "No release author probe grant audience was configured.",
    };
  }

  return submitTownshipDelegation({
    workflow: options.workflow,
    replica: options.config.peer.replica,
    audiencePubkey: options.config.grantAudiencePubkey,
    ops: ["post"],
    roles: [],
    live: false,
    realmByPubkey: options.realmByPubkey,
  });
}

async function submitReleaseAuthorPost(
  options: TownshipReleaseAuthorProbeSubmitPostOptions,
): Promise<TownshipPostSubmission> {
  return submitTownshipPost({
    workflow: options.workflow,
    replica: options.config.peer.replica,
    text: options.config.postText,
    realmByPubkey: options.realmByPubkey,
  });
}

async function authorReleaseBadSummaryFrame(
  options: TownshipReleaseAuthorProbeBadFrameOptions,
): Promise<{ frameId: string }> {
  const localOps = await options.workflow.localLog.load();
  const frame = await authorTownshipCommand({
    replica: options.config.peer.replica,
    deps: frontier(localOps),
    command: { command: "set_summary", text: options.config.badSummaryText },
    capId: options.capId,
    signer: options.workflow.signer,
  });
  const op = carrierOpsToSemanticOps([frame], options.realmByPubkey)[0];
  if (!op) throw new Error(`authored release probe frame ${frame.id} did not produce a semantic op`);
  await options.workflow.localLog.append(op);
  await options.workflow.carrierFrames.append(frame);
  return { frameId: frame.id };
}

async function findPostOnlyGrantDelegationId(
  workflow: TownshipNativeWorkflow,
  audiencePublicKeyBase64: string,
): Promise<string> {
  const frames = await workflow.delegationFrames.load();
  const delegation = carrierDelegationsFromFrames(frames).find(
    (candidate) =>
      candidate.audience === audiencePublicKeyBase64 &&
      candidate.ops.length === 1 &&
      candidate.ops[0] === "post",
  );
  if (!delegation) throw new Error("release probe did not pull a post-only grant for this device key");
  return delegation.id;
}

async function releaseAuthorStateReport(
  options: TownshipReleaseAuthorProbeStateReportOptions,
): Promise<TownshipReleaseAuthorProbeStateReportResult> {
  const connectOptions = {
    workflow: options.workflow,
    peer: options.config.peer,
  };
  if (options.verifier !== undefined) Object.assign(connectOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(connectOptions, { webSocket: options.webSocket });
  const client = await connectTownshipCarrierPeer(connectOptions);
  try {
  const report = await client.stateReport();
  const state = (report as { state?: { posts?: unknown[] } }).state;
  const authorityQuarantine = (report as { authority_quarantine?: unknown }).authority_quarantine;
    const result: TownshipReleaseAuthorProbeStateReportResult = {
      ok: true,
      postMaterialized: Array.isArray(state?.posts) && state.posts.includes(options.config.postText),
      badAuthorityReason: authorityReason(authorityQuarantine, options.badFrameId),
    };
    if (options.appGrantFrameId !== undefined) {
      const opIds = (report as { op_ids?: unknown }).op_ids;
      result.appGrantAuthorityAccepted =
        Array.isArray(opIds) &&
        opIds.includes(options.appGrantFrameId) &&
        authorityReason(authorityQuarantine, options.appGrantFrameId) === "missing";
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      postMaterialized: false,
      badAuthorityReason: "unknown",
      message: errorMessage(error),
    };
  } finally {
    client.close();
  }
}

async function reload(workflow: TownshipNativeWorkflow): Promise<ReloadResult> {
  const [localOps, carrierFrames, delegationFrames] = await Promise.all([
    workflow.localLog.load(),
    workflow.carrierFrames.load(),
    workflow.delegationFrames.load(),
  ]);

  return {
    localOpIds: opIds(localOps),
    delegationFrameIds: frameIds(delegationFrames),
    carrierFrameCount: carrierFrames.length,
  };
}

function authorityReason(authorityQuarantine: unknown, frameId: string): string {
  if (!Array.isArray(authorityQuarantine)) return "missing";
  for (const entry of authorityQuarantine) {
    if (Array.isArray(entry) && entry[0] === frameId && typeof entry[1] === "string") return entry[1];
  }
  return "missing";
}

function validProbeUrl(value: string): boolean {
  return probeUrlScheme(value) !== "invalid" && townshipReleaseTransportProbeHostClass(value) === "loopback";
}

function probeUrlScheme(value: string): "ws" | "wss" | "invalid" {
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "ws:") return "ws";
    if (protocol === "wss:") return "wss";
  } catch {
    return "invalid";
  }
  return "invalid";
}

function validPublicKey(value: string | null): value is string {
  if (!value) return false;
  try {
    return base64Bytes(value).byteLength === 32;
  } catch {
    return false;
  }
}

function opIds(ops: readonly Op[]): string[] {
  return sortedIds(ops.map((op) => op.id));
}

function frameIds(frames: readonly CarrierOpFrame[]): string[] {
  return sortedIds(frames.map((frame) => frame.id));
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function difference(after: readonly string[], before: readonly string[]): string[] {
  const beforeIds = new Set(before);
  return after.filter((id) => !beforeIds.has(id));
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveInteger(value: string | null | undefined): number | null {
  const parsed = Number(present(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function bytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function base64UrlEncode(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function probeIdList(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.map(probeToken).sort().join(",");
}

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
