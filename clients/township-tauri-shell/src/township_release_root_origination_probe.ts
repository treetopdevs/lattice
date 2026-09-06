import { bytesBase64 } from "./base64";
import {
  authorCarrierDelegation,
  authorCarrierOp,
  authorTownshipGenesis,
  bindTownshipReplica,
  carrierOpsToSemanticOps,
  townshipGenesisBody,
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
  withTownshipPersistenceWrite,
} from "./native_workflow";
import {
  connectTownshipCarrierPeer,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";
import { townshipReleaseTransportProbeHostClass } from "./township_release_transport_probe";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX = "township-release-root-origination-probe";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE = "township:release-root-origination-probe";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_METADATA_KEY =
  "release_root_origination_probe_metadata";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME =
  "replica:matter:township-root-origination";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_EXPECTED_FORGED_REASON = "impostor_genesis";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_EXPECTED_GENESIS_OUTBOX = "outbox_frame_count=1";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_EXPECTED_ROOT_AUTHORITY = "root_authority_accepted=true";
export const TOWNSHIP_RELEASE_ROOT_ORIGINATION_EXPECTED_FORGED_AUTHORITY =
  "forged_authority_reason=impostor_genesis";

export interface TownshipReleaseRootOriginationProbeEnv {
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_KEY_ID?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_TIMEOUT_MS?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_RETRY_DELAY_MS?: string;
  VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PAUSE_AFTER_GENESIS_MS?: string;
}

export interface TownshipReleaseRootOriginationProbeConfig {
  peer: Omit<TownshipCarrierPeerConfig, "replica">;
  replicaName: string;
  keyId: string;
  storageNamespace: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  pauseAfterGenesisMs?: number;
}

export type TownshipReleaseRootOriginationProbeResult =
  | {
      phase: "native_key";
      publicKeyBase64: string;
      localRealm: string;
      storageNamespace: string;
    }
  | {
      phase: "reload";
      outcome: "loaded";
      rootReplica?: string;
      localOpIds: string[];
      delegationFrameIds: string[];
      carrierFrameCount: number;
    }
  | {
      phase: "genesis";
      outcome: "authored";
      rootReplica: string;
      genesisFrameId: string;
      rootPublicKeyBase64: string;
      localOpCount: number;
      carrierFrameCount: number;
    }
  | {
      phase: "push";
      outcome: "synced";
      elapsedMs: number;
      rootReplica: string;
      pushedFrameIds: string[];
      acceptedCount: number;
      carrierFrameCount: number;
      pendingCount: number;
    }
  | {
      phase: "peer";
      outcome: "reported";
      rootReplica: string;
      genesisFrameId: string;
      forgedFrameId: string;
      rootAuthorityAccepted: boolean;
      forgedAuthorityReason: string;
      carrierFrameCount: number;
    }
  | {
      phase: "genesis" | "push" | "peer";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    };

export interface TownshipReleaseRootOriginationProbeSyncOptions {
  config: TownshipReleaseRootOriginationProbeConfig;
  workflow: TownshipNativeWorkflow;
  rootReplica: string;
  realmByPubkey: Record<string, string>;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleaseRootOriginationProbeStateReportOptions {
  config: TownshipReleaseRootOriginationProbeConfig;
  workflow: TownshipNativeWorkflow;
  metadata: TownshipReleaseRootOriginationProbeMetadata;
  realmByPubkey: Record<string, string>;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleaseRootOriginationProbeStateReportResult {
  ok: boolean;
  rootAuthorityAccepted: boolean;
  forgedAuthorityReason: string;
  message?: string;
}

export interface TownshipReleaseRootOriginationProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  workflow?: TownshipNativeWorkflow;
  forgerWorkflow?: TownshipNativeWorkflow;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  timeoutMs?: number;
  retryDelayMs?: number;
  sync?(options: TownshipReleaseRootOriginationProbeSyncOptions): Promise<TownshipOutboxSync>;
  stateReport?(
    options: TownshipReleaseRootOriginationProbeStateReportOptions,
  ): Promise<TownshipReleaseRootOriginationProbeStateReportResult>;
  authorGenesis?(
    config: TownshipReleaseRootOriginationProbeConfig,
    workflow: TownshipNativeWorkflow,
    realmByPubkey: Record<string, string>,
  ): Promise<TownshipReleaseRootOriginationProbeMetadata>;
  authorForgedGenesis?(
    options: TownshipReleaseRootOriginationProbeOptions & {
      config: TownshipReleaseRootOriginationProbeConfig;
      workflow: TownshipNativeWorkflow;
      metadata: TownshipReleaseRootOriginationProbeMetadata;
      realmByPubkey: Record<string, string>;
    },
  ): Promise<TownshipReleaseRootOriginationProbeMetadata>;
}

export interface TownshipReleaseRootOriginationProbeMetadata {
  stage: "authored" | "pushed" | "forged";
  rootReplica: string;
  genesisFrameId: string;
  rootPublicKeyBase64: string;
  forgedFrameId?: string;
  forgedPublicKeyBase64?: string;
}

export function townshipReleaseRootOriginationProbeConfigFromEnv(
  env: TownshipReleaseRootOriginationProbeEnv,
): TownshipReleaseRootOriginationProbeConfig | null {
  const url = present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL);
  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM);
  const expectedPeerRealm = present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_REALM);
  const expectedPeerPubkey = present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PEER_PUBKEY);
  const replicaName =
    present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME) ??
    TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_REPLICA_NAME;
  const keyId = present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_KEY_ID) ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace =
    present(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE) ??
    TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE;
  const timeoutMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_RETRY_DELAY_MS);
  const pauseAfterGenesisMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_PAUSE_AFTER_GENESIS_MS);

  if (!url || !validProbeUrl(url) || !localRealm || !expectedPeerRealm || !validPublicKey(expectedPeerPubkey)) {
    return null;
  }

  const config: TownshipReleaseRootOriginationProbeConfig = {
    peer: {
      url,
      localRealm,
      expectedPeerRealm,
      expectedPeerPubkey: expectedPeerPubkey as string,
      keyId,
    },
    replicaName,
    keyId,
    storageNamespace,
  };
  if (timeoutMs !== null) config.timeoutMs = timeoutMs;
  if (retryDelayMs !== null) config.retryDelayMs = retryDelayMs;
  if (pauseAfterGenesisMs !== null) config.pauseAfterGenesisMs = pauseAfterGenesisMs;
  return config;
}

export async function logTownshipReleaseRootOriginationProbeFromEnv(
  env: TownshipReleaseRootOriginationProbeEnv = ((import.meta as ImportMeta & {
    env?: TownshipReleaseRootOriginationProbeEnv;
  }).env ?? {}),
  options: TownshipReleaseRootOriginationProbeOptions = {},
): Promise<TownshipReleaseRootOriginationProbeResult | null> {
  const config = townshipReleaseRootOriginationProbeConfigFromEnv(env);
  if (!config) return null;

  const workflowOptions: TownshipNativeWorkflowOptions = {
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (options.invoke !== undefined) workflowOptions.invoke = options.invoke;
  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions));
  const nativeKeyResult: TownshipReleaseRootOriginationProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.peer.localRealm,
    storageNamespace: config.storageNamespace,
  };
  await logTownshipProbeEvent(townshipReleaseRootOriginationProbeLogLine(nativeKeyResult), options);
  await logTownshipProbeEvent(
    townshipReleaseRootOriginationProbeLogLine(await townshipReleaseRootOriginationReloadResult(workflow)),
    options,
  );

  return probeTownshipReleaseRootOrigination({
    ...options,
    config,
    workflow,
    onResult: async (result) => {
      await logTownshipProbeEvent(townshipReleaseRootOriginationProbeLogLine(result), options);
    },
  });
}

export async function probeTownshipReleaseRootOrigination(
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseRootOriginationProbeResult): Promise<void>;
  },
): Promise<TownshipReleaseRootOriginationProbeResult> {
  const rootPublicKeyBase64 = bytesBase64(options.workflow.signer.publicKey);
  const realmByPubkey = {
    [rootPublicKeyBase64]: options.config.peer.localRealm,
  };
  const metadata = await loadRootOriginationMetadata(options.workflow);

  if (metadata?.stage === "forged") {
    return reportRootOrigination(options, realmByPubkey, metadata);
  }

  if (metadata?.stage === "pushed") {
    return forgeAndReport(options, realmByPubkey, metadata);
  }

  if (metadata?.stage === "authored") {
    return pushRootGenesis(options, realmByPubkey, metadata);
  }

  const authored = await (options.authorGenesis ?? authorRootGenesis)(options.config, options.workflow, realmByPubkey);
  await saveRootOriginationMetadata(options.workflow, authored);
  const authoredReload = await reload(options.workflow);
  const result: TownshipReleaseRootOriginationProbeResult = {
    phase: "genesis",
    outcome: "authored",
    rootReplica: authored.rootReplica,
    genesisFrameId: authored.genesisFrameId,
    rootPublicKeyBase64: authored.rootPublicKeyBase64,
    localOpCount: authoredReload.localOpIds.length,
    carrierFrameCount: authoredReload.carrierFrameCount,
  };
  await options.onResult?.(result);
  await delay(options.config.pauseAfterGenesisMs ?? 0);
  return pushRootGenesis(options, realmByPubkey, authored);
}

export function townshipReleaseRootOriginationProbeLogLine(
  result: TownshipReleaseRootOriginationProbeResult,
): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `storage_namespace=${probeToken(result.storageNamespace)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  if (result.phase === "reload" && result.outcome === "loaded") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      "phase=reload",
      "outcome=loaded",
      `root_replica=${probeToken(result.rootReplica ?? "none")}`,
      `local_op_ids=${probeIdList(result.localOpIds)}`,
      `delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  if (result.outcome === "error" || result.outcome === "timeout") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      `phase=${result.phase}`,
      `outcome=${result.outcome}`,
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
      `message=${probeToken(result.message)}`,
    ].join(" ");
  }

  if (result.phase === "genesis" && result.outcome === "authored") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      "phase=genesis",
      "outcome=authored",
      `root_replica=${probeToken(result.rootReplica)}`,
      `genesis_frame_id=${probeToken(result.genesisFrameId)}`,
      `root_author_b64url=${base64UrlEncode(result.rootPublicKeyBase64)}`,
      `local_op_count=${result.localOpCount}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  if (result.phase === "push" && result.outcome === "synced") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      "phase=push",
      "outcome=synced",
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
      `root_replica=${probeToken(result.rootReplica)}`,
      `pushed_frame_ids=${probeIdList(result.pushedFrameIds)}`,
      `accepted_count=${result.acceptedCount}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
      `pending_count=${result.pendingCount}`,
    ].join(" ");
  }

  if (result.phase === "peer" && result.outcome === "reported") {
    return [
      TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
      "phase=peer",
      "outcome=reported",
      `root_replica=${probeToken(result.rootReplica)}`,
      `genesis_frame_id=${probeToken(result.genesisFrameId)}`,
      `forged_frame_id=${probeToken(result.forgedFrameId)}`,
      `root_authority_accepted=${result.rootAuthorityAccepted}`,
      `forged_authority_reason=${probeToken(result.forgedAuthorityReason)}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  return [
    TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX,
    `phase=${result.phase}`,
    "outcome=error",
    "elapsed_ms=0",
    "message=unexpected_probe_result",
  ].join(" ");
}

export async function townshipReleaseRootOriginationReloadResult(
  workflow: TownshipNativeWorkflow,
): Promise<TownshipReleaseRootOriginationProbeResult> {
  const [loaded, metadata] = await Promise.all([reload(workflow), loadRootOriginationMetadata(workflow)]);
  const result: TownshipReleaseRootOriginationProbeResult = {
    phase: "reload",
    outcome: "loaded",
    localOpIds: loaded.localOpIds,
    delegationFrameIds: loaded.delegationFrameIds,
    carrierFrameCount: loaded.carrierFrameCount,
  };
  if (metadata?.rootReplica !== undefined) result.rootReplica = metadata.rootReplica;
  return result;
}

async function pushRootGenesis(
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseRootOriginationProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  metadata: TownshipReleaseRootOriginationProbeMetadata,
): Promise<TownshipReleaseRootOriginationProbeResult> {
  const pushed = await retrySync(options, realmByPubkey, metadata.rootReplica);
  if (!pushed.ok) {
    const result = failureResult("push", pushed);
    await options.onResult?.(result);
    return result;
  }
  const pushReload = await reload(options.workflow);
  const result: TownshipReleaseRootOriginationProbeResult = {
    phase: "push",
    outcome: "synced",
    elapsedMs: pushed.elapsedMs,
    rootReplica: metadata.rootReplica,
    pushedFrameIds: pushed.sync.pushedFrameIds,
    acceptedCount: pushed.sync.acceptedCount,
    carrierFrameCount: pushReload.carrierFrameCount,
    pendingCount: pushed.sync.pendingCount,
  };
  await saveRootOriginationMetadata(options.workflow, { ...metadata, stage: "pushed" });
  await options.onResult?.(result);
  return forgeAndReport(options, realmByPubkey, { ...metadata, stage: "pushed" });
}

async function forgeAndReport(
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseRootOriginationProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  metadata: TownshipReleaseRootOriginationProbeMetadata,
): Promise<TownshipReleaseRootOriginationProbeResult> {
  const forged = await (options.authorForgedGenesis ?? authorForgedRootGenesis)({
    ...options,
    metadata,
    realmByPubkey,
  });
  const forgedRealmByPubkey = {
    ...realmByPubkey,
  };
  if (forged.forgedPublicKeyBase64 !== undefined) {
    forgedRealmByPubkey[forged.forgedPublicKeyBase64] = `${options.config.peer.localRealm}-forger`;
  }
  const pushed = await retrySync(options, forgedRealmByPubkey, forged.rootReplica);
  if (!pushed.ok) {
    const result = failureResult("push", pushed);
    await options.onResult?.(result);
    return result;
  }
  await saveRootOriginationMetadata(options.workflow, { ...forged, stage: "forged" });
  return reportRootOrigination(options, forgedRealmByPubkey, { ...forged, stage: "forged" });
}

async function reportRootOrigination(
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleaseRootOriginationProbeResult): Promise<void>;
  },
  realmByPubkey: Record<string, string>,
  metadata: TownshipReleaseRootOriginationProbeMetadata,
): Promise<TownshipReleaseRootOriginationProbeResult> {
  const report = await (options.stateReport ?? releaseRootOriginationStateReport)({
    config: options.config,
    workflow: options.workflow,
    metadata,
    realmByPubkey,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
  });
  if (!report.ok || metadata.forgedFrameId === undefined) {
    const result: TownshipReleaseRootOriginationProbeResult = {
      phase: "peer",
      outcome: "error",
      elapsedMs: 0,
      message: report.message ?? "peer state report failed",
    };
    await options.onResult?.(result);
    return result;
  }
  if (
    !report.rootAuthorityAccepted ||
    report.forgedAuthorityReason !== TOWNSHIP_RELEASE_ROOT_ORIGINATION_EXPECTED_FORGED_REASON
  ) {
    const result: TownshipReleaseRootOriginationProbeResult = {
      phase: "peer",
      outcome: "error",
      elapsedMs: 0,
      message: `unexpected_peer_report_${report.rootAuthorityAccepted}_${report.forgedAuthorityReason}`,
    };
    await options.onResult?.(result);
    return result;
  }
  const finalReload = await reload(options.workflow);
  const result: TownshipReleaseRootOriginationProbeResult = {
    phase: "peer",
    outcome: "reported",
    rootReplica: metadata.rootReplica,
    genesisFrameId: metadata.genesisFrameId,
    forgedFrameId: metadata.forgedFrameId,
    rootAuthorityAccepted: report.rootAuthorityAccepted,
    forgedAuthorityReason: report.forgedAuthorityReason,
    carrierFrameCount: finalReload.carrierFrameCount,
  };
  await options.onResult?.(result);
  return result;
}

async function authorRootGenesis(
  config: TownshipReleaseRootOriginationProbeConfig,
  workflow: TownshipNativeWorkflow,
  realmByPubkey: Record<string, string>,
): Promise<TownshipReleaseRootOriginationProbeMetadata> {
  const rootPublicKeyBase64 = bytesBase64(workflow.signer.publicKey);
  const rootReplica = await bindTownshipReplica(config.replicaName, workflow.signer.publicKey);
  const frame = await authorTownshipGenesis({
    replica: config.replicaName,
    signer: workflow.signer,
  });
  await appendSemanticFrame(workflow, frame, { ...realmByPubkey, [rootPublicKeyBase64]: config.peer.localRealm });
  return {
    stage: "authored",
    rootReplica,
    genesisFrameId: frame.id,
    rootPublicKeyBase64,
  };
}

async function authorForgedRootGenesis(
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
    metadata: TownshipReleaseRootOriginationProbeMetadata;
    realmByPubkey: Record<string, string>;
  },
): Promise<TownshipReleaseRootOriginationProbeMetadata> {
  if (options.metadata.forgedFrameId !== undefined) return options.metadata;

  const forgerWorkflow =
    options.forgerWorkflow ??
    (await createTownshipNativeWorkflow({
      keyId: `${options.config.keyId}:forger`,
      storageNamespace: `${options.config.storageNamespace}:forger`,
      ...(options.invoke === undefined ? {} : { invoke: options.invoke }),
    }));
  const forgedPublicKeyBase64 = bytesBase64(forgerWorkflow.signer.publicKey);
  const delegation = await authorCarrierDelegation({
    replica: options.metadata.rootReplica,
    audiencePubkey: forgerWorkflow.signer.publicKey,
    parentId: null,
    live: true,
    signer: forgerWorkflow.signer,
  });
  const frame = await authorCarrierOp({
    replica: options.metadata.rootReplica,
    deps: [],
    kind: "authority",
    body: townshipGenesisBody(delegation),
    cap: ["nil"],
    signer: forgerWorkflow.signer,
  });
  await appendSemanticFrame(options.workflow, frame, {
    ...options.realmByPubkey,
    [forgedPublicKeyBase64]: `${options.config.peer.localRealm}-forger`,
  });
  return {
    ...options.metadata,
    forgedFrameId: frame.id,
    forgedPublicKeyBase64,
  };
}

async function appendSemanticFrame(
  workflow: TownshipNativeWorkflow,
  frame: CarrierOpFrame,
  realmByPubkey: Record<string, string>,
): Promise<void> {
  await withTownshipPersistenceWrite(workflow, async () => {
    const op = carrierOpsToSemanticOps([frame], realmByPubkey)[0];
    if (!op) throw new Error(`authored release root frame ${frame.id} did not produce a semantic op`);
    await workflow.localLog.append(op);
    await workflow.carrierFrames.append(frame);
  });
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
  options: TownshipReleaseRootOriginationProbeOptions & {
    config: TownshipReleaseRootOriginationProbeConfig;
    workflow: TownshipNativeWorkflow;
  },
  realmByPubkey: Record<string, string>,
  rootReplica: string,
): Promise<RetrySyncResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? options.config.timeoutMs ?? 60_000);
  let lastMessage = "carrier peer unavailable";

  while (Date.now() <= deadline) {
    const syncOptions: TownshipReleaseRootOriginationProbeSyncOptions = {
      config: options.config,
      workflow: options.workflow,
      rootReplica,
      realmByPubkey,
    };
    if (options.verifier !== undefined) syncOptions.verifier = options.verifier;
    if (options.webSocket !== undefined) syncOptions.webSocket = options.webSocket;
    const sync = await (options.sync ?? syncReleaseRootOriginationOnce)(syncOptions);

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

function failureResult(
  phase: "push",
  result: Extract<RetrySyncResult, { ok: false }>,
): TownshipReleaseRootOriginationProbeResult {
  return {
    phase,
    outcome: result.outcome,
    elapsedMs: result.elapsedMs,
    message: result.message,
  };
}

async function syncReleaseRootOriginationOnce(
  options: TownshipReleaseRootOriginationProbeSyncOptions,
): Promise<TownshipOutboxSync> {
  const syncOptions = {
    workflow: options.workflow,
    peer: peerConfig(options.config, options.rootReplica),
    storageNamespace: options.config.storageNamespace,
    keyId: options.config.keyId,
    realmByPubkey: options.realmByPubkey,
  };
  if (options.verifier !== undefined) Object.assign(syncOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(syncOptions, { webSocket: options.webSocket });
  return syncTownshipOutbox(syncOptions);
}

async function releaseRootOriginationStateReport(
  options: TownshipReleaseRootOriginationProbeStateReportOptions,
): Promise<TownshipReleaseRootOriginationProbeStateReportResult> {
  const connectOptions = {
    workflow: options.workflow,
    peer: peerConfig(options.config, options.metadata.rootReplica),
  };
  if (options.verifier !== undefined) Object.assign(connectOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(connectOptions, { webSocket: options.webSocket });
  const client = await connectTownshipCarrierPeer(connectOptions);
  try {
    const report = await client.stateReport();
    const opIds = (report as { op_ids?: unknown }).op_ids;
    const authorityQuarantine = (report as { authority_quarantine?: unknown }).authority_quarantine;
    return {
      ok: true,
      rootAuthorityAccepted:
        Array.isArray(opIds) &&
        opIds.includes(options.metadata.genesisFrameId) &&
        authorityReason(authorityQuarantine, options.metadata.genesisFrameId) === "missing",
      forgedAuthorityReason:
        options.metadata.forgedFrameId === undefined
          ? "missing"
          : authorityReason(authorityQuarantine, options.metadata.forgedFrameId),
    };
  } catch (error) {
    return {
      ok: false,
      rootAuthorityAccepted: false,
      forgedAuthorityReason: "unknown",
      message: errorMessage(error),
    };
  } finally {
    client.close();
  }
}

async function loadRootOriginationMetadata(
  workflow: TownshipNativeWorkflow,
): Promise<TownshipReleaseRootOriginationProbeMetadata | null> {
  const raw = await workflow.storage.getItem(TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_METADATA_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<TownshipReleaseRootOriginationProbeMetadata>;
    if (
      (parsed.stage === "authored" || parsed.stage === "pushed" || parsed.stage === "forged") &&
      typeof parsed.rootReplica === "string" &&
      typeof parsed.genesisFrameId === "string" &&
      typeof parsed.rootPublicKeyBase64 === "string"
    ) {
      const metadata: TownshipReleaseRootOriginationProbeMetadata = {
        stage: parsed.stage,
        rootReplica: parsed.rootReplica,
        genesisFrameId: parsed.genesisFrameId,
        rootPublicKeyBase64: parsed.rootPublicKeyBase64,
      };
      if (typeof parsed.forgedFrameId === "string" && typeof parsed.forgedPublicKeyBase64 === "string") {
        metadata.forgedFrameId = parsed.forgedFrameId;
        metadata.forgedPublicKeyBase64 = parsed.forgedPublicKeyBase64;
      }
      return metadata;
    }
  } catch {
    return null;
  }
  return null;
}

async function saveRootOriginationMetadata(
  workflow: TownshipNativeWorkflow,
  metadata: TownshipReleaseRootOriginationProbeMetadata,
): Promise<void> {
  await workflow.storage.setItem(TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_METADATA_KEY, JSON.stringify(metadata));
}

interface ReloadResult {
  localOpIds: string[];
  delegationFrameIds: string[];
  carrierFrameCount: number;
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

function peerConfig(
  config: TownshipReleaseRootOriginationProbeConfig,
  replica: string,
): TownshipCarrierPeerConfig {
  return {
    ...config.peer,
    replica,
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
  return value.trim().replace(/[^A-Za-z0-9_.:#-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
