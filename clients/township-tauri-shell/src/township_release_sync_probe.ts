import { bytesBase64 } from "./base64";
import type { CarrierOpFrame, CarrierVerifier, Op } from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  logTownshipProbeEvent,
  TOWNSHIP_NATIVE_KEY_ID,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import { TOWNSHIP_REPLICA } from "./township_actions";
import {
  townshipReleaseTransportProbeHostClass,
  type TownshipReleaseTransportProbeHostClass,
} from "./township_release_transport_probe";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";
import type { TownshipCarrierPeerConfig, TownshipCarrierWebSocket } from "./township_carrier_peer";

export const TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX = "township-release-sync-probe";
export const TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE = "township:release-sync-probe";

export interface TownshipReleaseSyncProbeEnv {
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_REPLICA?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_KEY_ID?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_TIMEOUT_MS?: string;
  VITE_TOWNSHIP_RELEASE_SYNC_PROBE_RETRY_DELAY_MS?: string;
}

export interface TownshipReleaseSyncProbeConfig {
  peer: TownshipCarrierPeerConfig;
  keyId: string;
  storageNamespace: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export type TownshipReleaseSyncProbeOutcome = "error" | "loaded" | "synced" | "timeout";

export type TownshipReleaseSyncProbeResult =
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
      phase: "sync";
      outcome: "synced";
      elapsedMs: number;
      pulledOpIds: string[];
      localOpIds: string[];
      delegationFrameIds: string[];
      carrierFrameCount: number;
      pushedFrameCount: number;
      acceptedCount: number;
    }
  | {
      phase: "sync";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    };

export interface TownshipReleaseSyncProbeSyncOptions {
  config: TownshipReleaseSyncProbeConfig;
  workflow: TownshipNativeWorkflow;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleaseSyncProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  workflow?: TownshipNativeWorkflow;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  timeoutMs?: number;
  retryDelayMs?: number;
  sync?(options: TownshipReleaseSyncProbeSyncOptions): Promise<TownshipOutboxSync>;
}

export function townshipReleaseSyncProbeConfigFromEnv(
  env: TownshipReleaseSyncProbeEnv,
): TownshipReleaseSyncProbeConfig | null {
  const url = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL);
  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_LOCAL_REALM);
  const expectedPeerRealm = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_REALM);
  const expectedPeerPubkey = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY);
  const replica = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_REPLICA) ?? TOWNSHIP_REPLICA;
  const keyId = present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_KEY_ID) ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace =
    present(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE) ?? TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE;
  const timeoutMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_SYNC_PROBE_RETRY_DELAY_MS);

  if (!url || !validProbeUrl(url) || !localRealm || !expectedPeerRealm || !validPublicKey(expectedPeerPubkey)) {
    return null;
  }

  const config: TownshipReleaseSyncProbeConfig = {
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
  };
  if (timeoutMs !== null) config.timeoutMs = timeoutMs;
  if (retryDelayMs !== null) config.retryDelayMs = retryDelayMs;
  return config;
}

export async function logTownshipReleaseSyncProbeFromEnv(
  env: TownshipReleaseSyncProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleaseSyncProbeEnv }).env ?? {}),
  options: TownshipReleaseSyncProbeOptions = {},
): Promise<TownshipReleaseSyncProbeResult | null> {
  const config = townshipReleaseSyncProbeConfigFromEnv(env);
  if (!config) return null;

  const workflowOptions: TownshipNativeWorkflowOptions = {
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (options.invoke !== undefined) workflowOptions.invoke = options.invoke;
  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions));
  const nativeKeyResult: TownshipReleaseSyncProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.peer.localRealm,
    storageNamespace: config.storageNamespace,
  };
  await logTownshipProbeEvent(townshipReleaseSyncProbeLogLine(nativeKeyResult), options);

  const reload = await townshipReleaseSyncReloadResult(workflow);
  await logTownshipProbeEvent(townshipReleaseSyncProbeLogLine(reload), options);

  const result = await probeTownshipReleaseSync({ ...options, config, workflow });
  await logTownshipProbeEvent(townshipReleaseSyncProbeLogLine(result), options);
  return result;
}

export async function townshipReleaseSyncReloadResult(
  workflow: TownshipNativeWorkflow,
): Promise<Extract<TownshipReleaseSyncProbeResult, { phase: "reload" }>> {
  const [localOps, carrierFrames, delegationFrames] = await Promise.all([
    workflow.localLog.load(),
    workflow.carrierFrames.load(),
    workflow.delegationFrames.load(),
  ]);

  return {
    phase: "reload",
    outcome: "loaded",
    localOpIds: opIds(localOps),
    delegationFrameIds: frameIds(delegationFrames),
    carrierFrameCount: carrierFrames.length,
  };
}

export async function probeTownshipReleaseSync(
  options: TownshipReleaseSyncProbeOptions & {
    config: TownshipReleaseSyncProbeConfig;
    workflow: TownshipNativeWorkflow;
  },
): Promise<TownshipReleaseSyncProbeResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? options.config.timeoutMs ?? 60_000);
  let lastMessage = "carrier peer unavailable";

  while (Date.now() <= deadline) {
    const before = await townshipReleaseSyncReloadResult(options.workflow);
    const syncOptions: TownshipReleaseSyncProbeSyncOptions = {
      config: options.config,
      workflow: options.workflow,
    };
    if (options.verifier !== undefined) syncOptions.verifier = options.verifier;
    if (options.webSocket !== undefined) syncOptions.webSocket = options.webSocket;
    const sync = await (options.sync ?? syncTownshipReleaseProbeOnce)(syncOptions);

    if (sync.ok) {
      const after = await townshipReleaseSyncReloadResult(options.workflow);
      return {
        phase: "sync",
        outcome: "synced",
        elapsedMs: Date.now() - started,
        pulledOpIds: difference(after.localOpIds, before.localOpIds),
        localOpIds: after.localOpIds,
        delegationFrameIds: after.delegationFrameIds,
        carrierFrameCount: after.carrierFrameCount,
        pushedFrameCount: sync.pushedFrameCount,
        acceptedCount: sync.acceptedCount,
      };
    }

    lastMessage = sync.message;
    await delay(options.retryDelayMs ?? options.config.retryDelayMs ?? 500);
  }

  return {
    phase: "sync",
    outcome: "timeout",
    elapsedMs: Date.now() - started,
    message: lastMessage,
  };
}

export function townshipReleaseSyncProbeLogLine(result: TownshipReleaseSyncProbeResult): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `storage_namespace=${probeToken(result.storageNamespace)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  if (result.phase === "reload") {
    return [
      TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX,
      "phase=reload",
      `outcome=${result.outcome}`,
      `local_op_ids=${probeIdList(result.localOpIds)}`,
      `delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`,
      `carrier_frame_count=${result.carrierFrameCount}`,
    ].join(" ");
  }

  const fields = [
    TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX,
    "phase=sync",
    `outcome=${result.outcome}`,
    `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
  ];
  if (result.outcome === "synced") {
    fields.push(`pulled_op_ids=${probeIdList(result.pulledOpIds)}`);
    fields.push(`local_op_ids=${probeIdList(result.localOpIds)}`);
    fields.push(`delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`);
    fields.push(`carrier_frame_count=${result.carrierFrameCount}`);
    fields.push(`pushed_frame_count=${result.pushedFrameCount}`);
    fields.push(`accepted_count=${result.acceptedCount}`);
  } else {
    fields.push(`message=${probeToken(result.message)}`);
  }
  return fields.join(" ");
}

async function syncTownshipReleaseProbeOnce(
  options: TownshipReleaseSyncProbeSyncOptions,
): Promise<TownshipOutboxSync> {
  const syncOptions = {
    workflow: options.workflow,
    peer: options.config.peer,
    storageNamespace: options.config.storageNamespace,
    keyId: options.config.keyId,
  };
  if (options.verifier !== undefined) Object.assign(syncOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(syncOptions, { webSocket: options.webSocket });
  return syncTownshipOutbox(syncOptions);
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
