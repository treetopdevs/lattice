import type { CarrierOpFrame, CarrierVerifier, Op } from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  logTownshipProbeEvent,
  TOWNSHIP_NATIVE_KEY_ID,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import {
  createOneShotTownshipPairingDeepLinkGate,
  createTownshipPairingDeepLinkListener,
  parseTownshipPairingDeepLink,
  type TownshipPairingDeepLinkBlockedReason,
  type TownshipPairingDeepLinkGate,
  type TownshipPairingDeepLinkParse,
  type TownshipPairingDeepLinkSource,
} from "./township_pairing_deeplink";
import { createTauriPairingDeepLinkSource } from "./township_pairing_deeplink_source";
import {
  loadTownshipCarrierPeerConfig,
  saveTownshipCarrierPeerConfig,
  townshipCarrierPeerFingerprint,
  TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierWebSocket,
} from "./township_carrier_peer";
import { TOWNSHIP_REALM_BY_PUBKEY } from "./township_actions";
import {
  townshipReleaseTransportProbeHostClass,
  type TownshipReleaseTransportProbeHostClass,
} from "./township_release_transport_probe";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

export const TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX = "township-release-pairing-probe";
export const TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE = "township:release-pairing-probe";

export interface TownshipReleasePairingProbeEnv {
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_RETRY_DELAY_MS?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_PEER_REALM?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_REPLICA?: string;
}

export interface TownshipReleasePairingProbeConfig {
  localRealm: string;
  keyId: string;
  storageNamespace: string;
  armState?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export type TownshipReleasePairingProbeResult =
  | {
      phase: "native_key";
      publicKeyBase64: string;
      localRealm: string;
      storageNamespace: string;
    }
  | {
      phase: "reload";
      outcome: "loaded";
      paired: boolean;
      peerFingerprint?: string;
      hostClass?: TownshipReleaseTransportProbeHostClass;
      urlPort?: string;
      localOpIds?: string[];
      delegationFrameIds?: string[];
      carrierFrameCount: number;
      peer?: TownshipCarrierPeerConfig | null;
    }
  | {
      phase: "pairing";
      outcome: "saved";
      peerFingerprint: string;
      hostClass: TownshipReleaseTransportProbeHostClass;
      urlPort: string;
    }
  | {
      phase: "arming";
      outcome: "armed";
      stateRequired: boolean;
    }
  | {
      phase: "sync";
      outcome: "synced";
      elapsedMs: number;
      peerFingerprint?: string;
      pulledOpIds: string[];
      localOpIds: string[];
      delegationFrameIds: string[];
      carrierFrameCount: number;
      pushedFrameCount: number;
      acceptedCount: number;
    }
  | {
      phase: "pairing" | "sync";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    }
  | {
      phase: "deeplink";
      outcome: "listener_mounted" | "current" | "callback" | "blocked";
      urlCount: number;
      pairingUrlCount: number;
      firstRoute?: string;
      firstParseReason?: string;
      blockedReason?: TownshipPairingDeepLinkBlockedReason;
    };

type TownshipReleasePairingPhaseResult =
  | Extract<TownshipReleasePairingProbeResult, { phase: "pairing"; outcome: "saved" }>
  | {
      phase: "pairing";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    };

type TownshipReleasePairingSyncResult =
  | Extract<TownshipReleasePairingProbeResult, { phase: "sync"; outcome: "synced" }>
  | {
      phase: "sync";
      outcome: "error" | "timeout";
      elapsedMs: number;
      message: string;
    };

export interface TownshipReleasePairingProbeSyncOptions {
  config: TownshipReleasePairingProbeConfig;
  workflow: TownshipNativeWorkflow;
  peer: TownshipCarrierPeerConfig;
  realmByPubkey: Record<string, string>;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export interface TownshipReleasePairingProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  workflow?: TownshipNativeWorkflow;
  source?: TownshipPairingDeepLinkSource;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
  timeoutMs?: number;
  retryDelayMs?: number;
  sync?(options: TownshipReleasePairingProbeSyncOptions): Promise<TownshipOutboxSync>;
}

export function townshipReleasePairingProbeConfigFromEnv(
  env: TownshipReleasePairingProbeEnv,
): TownshipReleasePairingProbeConfig | null {
  if (
    present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL) ||
    present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_PEER_REALM) ||
    present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_PEER_PUBKEY) ||
    present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_REPLICA)
  ) {
    return null;
  }

  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM);
  const keyId = present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID) ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace =
    present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE) ??
    TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE;
  const armState = present(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE);
  const timeoutMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_RETRY_DELAY_MS);

  if (!localRealm || !keyId || !storageNamespace || (armState !== null && !validArmState(armState))) return null;

  const config: TownshipReleasePairingProbeConfig = {
    localRealm,
    keyId,
    storageNamespace,
  };
  if (armState !== null) config.armState = armState;
  if (timeoutMs !== null) config.timeoutMs = timeoutMs;
  if (retryDelayMs !== null) config.retryDelayMs = retryDelayMs;
  return config;
}

export async function logTownshipReleasePairingProbeFromEnv(
  env: TownshipReleasePairingProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleasePairingProbeEnv }).env ?? {}),
  options: TownshipReleasePairingProbeOptions = {},
): Promise<TownshipReleasePairingProbeResult | null> {
  const config = townshipReleasePairingProbeConfigFromEnv(env);
  if (!config) return null;

  const workflowOptions: TownshipNativeWorkflowOptions = {
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (options.invoke !== undefined) workflowOptions.invoke = options.invoke;
  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions));
  const nativeKeyResult: TownshipReleasePairingProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.localRealm,
    storageNamespace: config.storageNamespace,
  };
  await logTownshipProbeEvent(townshipReleasePairingProbeLogLine(nativeKeyResult), options);
  await logTownshipProbeEvent(
    townshipReleasePairingProbeLogLine(await townshipReleasePairingReloadResult(workflow)),
    options,
  );

  return probeTownshipReleasePairing({
    ...options,
    config,
    workflow,
    onResult: async (result) => {
      await logTownshipProbeEvent(townshipReleasePairingProbeLogLine(result), options);
    },
  });
}

export async function probeTownshipReleasePairing(
  options: TownshipReleasePairingProbeOptions & {
    config: TownshipReleasePairingProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleasePairingProbeResult): Promise<void>;
  },
): Promise<TownshipReleasePairingProbeResult> {
  let reload = await townshipReleasePairingReloadResult(options.workflow);
  if (!reload.peer) {
    const pairing = await waitForReleasePairing(options);
    if (pairing.outcome !== "saved") {
      await options.onResult?.(pairing);
      return pairing;
    }
    await options.onResult?.(pairing);

    reload = await townshipReleasePairingReloadResult(options.workflow);
    await options.onResult?.(reload);
  }

  if (!reload.peer) {
    const result: TownshipReleasePairingProbeResult = {
      phase: "pairing",
      outcome: "error",
      elapsedMs: 0,
      message: "pairing_config_not_persisted",
    };
    await options.onResult?.(result);
    return result;
  }

  const result = await retrySync(options, reload.peer);
  await options.onResult?.(result);
  return result;
}

export async function townshipReleasePairingReloadResult(
  workflow: TownshipNativeWorkflow,
): Promise<Extract<TownshipReleasePairingProbeResult, { phase: "reload" }>> {
  const [peer, localOps, carrierFrames, delegationFrames] = await Promise.all([
    loadTownshipCarrierPeerConfig(workflow.storage, {}),
    workflow.localLog.load(),
    workflow.carrierFrames.load(),
    workflow.delegationFrames.load(),
  ]);

  const result: Extract<TownshipReleasePairingProbeResult, { phase: "reload" }> = {
    phase: "reload",
    outcome: "loaded",
    paired: peer !== null,
    localOpIds: opIds(localOps),
    delegationFrameIds: frameIds(delegationFrames),
    carrierFrameCount: carrierFrames.length,
    peer,
  };
  if (peer) {
    result.peerFingerprint = townshipCarrierPeerFingerprint(peer.expectedPeerPubkey);
    result.hostClass = townshipReleaseTransportProbeHostClass(peer.url);
    result.urlPort = urlPort(peer.url);
  }
  return result;
}

export function townshipReleasePairingProbeLogLine(result: TownshipReleasePairingProbeResult): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `storage_namespace=${probeToken(result.storageNamespace)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  if (result.phase === "reload") {
    const fields = [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=reload",
      "outcome=loaded",
      `paired=${result.paired}`,
      `outbox_frame_count=${result.carrierFrameCount}`,
    ];
    if (result.peerFingerprint) fields.push(`peer_fingerprint=${probeToken(result.peerFingerprint)}`);
    if (result.hostClass) fields.push(`host_class=${result.hostClass}`);
    if (result.urlPort) fields.push(`url_port=${probeToken(result.urlPort)}`);
    if (result.localOpIds) fields.push(`local_op_ids=${probeIdList(result.localOpIds)}`);
    if (result.delegationFrameIds) fields.push(`delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`);
    return fields.join(" ");
  }

  if (result.phase === "pairing" && result.outcome === "saved") {
    return [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=pairing",
      "outcome=saved",
      `peer_fingerprint=${probeToken(result.peerFingerprint)}`,
      `host_class=${result.hostClass}`,
      `url_port=${probeToken(result.urlPort)}`,
    ].join(" ");
  }

  if (result.phase === "arming") {
    return [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=arming",
      "outcome=armed",
      `state_required=${result.stateRequired}`,
    ].join(" ");
  }

  if (result.phase === "sync" && result.outcome === "synced") {
    const fields = [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=sync",
      "outcome=synced",
      `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
    ];
    if (result.peerFingerprint) fields.push(`peer_fingerprint=${probeToken(result.peerFingerprint)}`);
    fields.push(`pulled_op_ids=${probeIdList(result.pulledOpIds)}`);
    fields.push(`local_op_ids=${probeIdList(result.localOpIds)}`);
    fields.push(`delegation_frame_ids=${probeIdList(result.delegationFrameIds)}`);
    fields.push(`outbox_frame_count=${result.carrierFrameCount}`);
    fields.push(`pushed_frame_count=${result.pushedFrameCount}`);
    fields.push(`accepted_count=${result.acceptedCount}`);
    return fields.join(" ");
  }

  if (result.phase === "deeplink") {
    const fields = [
      TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
      "phase=deeplink",
      `outcome=${result.outcome}`,
      `url_count=${result.urlCount}`,
      `pairing_url_count=${result.pairingUrlCount}`,
    ];
    if (result.firstRoute) fields.push(`first_route=${probeRouteToken(result.firstRoute)}`);
    if (result.firstParseReason) fields.push(`first_parse_reason=${probeToken(result.firstParseReason)}`);
    if (result.blockedReason) fields.push(`blocked_reason=${probeToken(result.blockedReason)}`);
    return fields.join(" ");
  }

  return [
    TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX,
    `phase=${result.phase}`,
    `outcome=${result.outcome}`,
    `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
    `message=${probeToken(result.message)}`,
  ].join(" ");
}

async function waitForReleasePairing(
  options: TownshipReleasePairingProbeOptions & {
    config: TownshipReleasePairingProbeConfig;
    workflow: TownshipNativeWorkflow;
    onResult?(result: TownshipReleasePairingProbeResult): Promise<void>;
  },
): Promise<TownshipReleasePairingPhaseResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? options.config.timeoutMs ?? 60_000;
  const deadline = started + timeoutMs;
  const retryDelayMs = options.retryDelayMs ?? options.config.retryDelayMs ?? 500;
  const source = tracedPairingDeepLinkSource(options.source ?? createTauriPairingDeepLinkSource(), options);
  const listenerRef: { stop?: () => void } = {};
  const gate = releasePairingGate(options.config);

  if (gate !== null) {
    gate.arm();
    await options.onResult?.({
      phase: "arming",
      outcome: "armed",
      stateRequired: true,
    });
  }

  try {
    const parse = await new Promise<TownshipPairingDeepLinkParse | "timeout">((resolve) => {
      let settled = false;
      const settle = (value: TownshipPairingDeepLinkParse | "timeout") => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const timer = setTimeout(() => settle("timeout"), timeoutMs);
      const settleIfActionable = (candidate: TownshipPairingDeepLinkParse) => {
        if (candidate.ok || candidate.reason !== "invalid_pairing_deeplink") {
          const consumption = gate?.consume(candidate) ?? { ok: true };
          if (!consumption.ok) {
            void options.onResult?.({
              phase: "deeplink",
              outcome: "blocked",
              urlCount: 1,
              pairingUrlCount: candidate.ok ? 1 : 0,
              blockedReason: consumption.reason,
            });
            return;
          }
          clearTimeout(timer);
          settle(candidate);
        }
      };
      const pollCurrent = async () => {
        while (!settled && Date.now() <= deadline) {
          await delay(retryDelayMs);
          if (settled) return;
          const urls = await source.current();
          const candidate = firstActionablePairingParse(urls);
          if (candidate) {
            clearTimeout(timer);
            settle(candidate);
            return;
          }
        }
      };
      void createTownshipPairingDeepLinkListener({
        source,
        apply(candidate) {
          settleIfActionable(candidate);
        },
      })
        .then((created) => {
          listenerRef.stop = () => created.stop();
          void options.onResult?.({
            phase: "deeplink",
            outcome: "listener_mounted",
            urlCount: 0,
            pairingUrlCount: 0,
          });
          void pollCurrent().catch((error) => {
            clearTimeout(timer);
            settle({
              ok: false,
              reason: "invalid_pairing_deeplink",
              message: errorMessage(error),
            });
          });
        })
        .catch((error) => {
          clearTimeout(timer);
          settle({
            ok: false,
            reason: "invalid_pairing_deeplink",
            message: errorMessage(error),
          });
        });
    });

    if (parse === "timeout") {
      return {
        phase: "pairing",
        outcome: "timeout",
        elapsedMs: Date.now() - started,
        message: "pairing_deeplink_unavailable",
      };
    }
    if (!parse.ok) {
      return {
        phase: "pairing",
        outcome: "error",
        elapsedMs: Date.now() - started,
        message: parse.reason,
      };
    }

    const secretReason = pairingHandoffSecretReason(parse.handoff);
    if (secretReason) {
      return {
        phase: "pairing",
        outcome: "error",
        elapsedMs: Date.now() - started,
        message: secretReason,
      };
    }

    const url = present(parse.draft.url);
    if (!url || !validProbeUrl(url)) {
      return {
        phase: "pairing",
        outcome: "error",
        elapsedMs: Date.now() - started,
        message: "pairing_url_not_loopback",
      };
    }

    const saved = await saveTownshipCarrierPeerConfig(
      options.workflow.storage,
      {
        ...parse.draft,
        localRealm: options.config.localRealm,
        keyId: options.config.keyId,
      },
      {
        origin: "release_probe",
        confirmed: true,
      },
    );
    if (!saved.ok) {
      return {
        phase: "pairing",
        outcome: "error",
        elapsedMs: Date.now() - started,
        message: saved.errors[0] ?? "pairing_config_invalid",
      };
    }

    return {
      phase: "pairing",
      outcome: "saved",
      peerFingerprint: parse.peerFingerprint,
      hostClass: townshipReleaseTransportProbeHostClass(saved.config.url),
      urlPort: urlPort(saved.config.url),
    };
  } finally {
    listenerRef.stop?.();
    if (Date.now() > deadline + 1_000) {
      await delay(0);
    }
  }
}

function releasePairingGate(config: TownshipReleasePairingProbeConfig): TownshipPairingDeepLinkGate | null {
  if (config.armState === undefined) return null;
  return createOneShotTownshipPairingDeepLinkGate({ createState: () => config.armState as string });
}

function firstActionablePairingParse(urls: readonly string[] | null): TownshipPairingDeepLinkParse | null {
  for (const url of urls ?? []) {
    const candidate = parseTownshipPairingDeepLink(url);
    if (candidate.ok || candidate.reason !== "invalid_pairing_deeplink") return candidate;
  }
  return null;
}

async function retrySync(
  options: TownshipReleasePairingProbeOptions & {
    config: TownshipReleasePairingProbeConfig;
    workflow: TownshipNativeWorkflow;
  },
  peer: TownshipCarrierPeerConfig,
): Promise<TownshipReleasePairingSyncResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? options.config.timeoutMs ?? 60_000);
  let lastMessage = "carrier peer unavailable";
  const authorPublicKeyBase64 = bytesBase64(options.workflow.signer.publicKey);
  const realmByPubkey = {
    ...TOWNSHIP_REALM_BY_PUBKEY,
    [authorPublicKeyBase64]: peer.localRealm,
  };

  while (Date.now() <= deadline) {
    const before = await townshipReleasePairingReloadResult(options.workflow);
    const syncOptions: TownshipReleasePairingProbeSyncOptions = {
      config: options.config,
      workflow: options.workflow,
      peer,
      realmByPubkey,
    };
    if (options.verifier !== undefined) syncOptions.verifier = options.verifier;
    if (options.webSocket !== undefined) syncOptions.webSocket = options.webSocket;
    const sync = await (options.sync ?? syncReleasePairingOnce)(syncOptions);

    if (sync.ok) {
      const after = await townshipReleasePairingReloadResult(options.workflow);
      return {
        phase: "sync",
        outcome: "synced",
        elapsedMs: Date.now() - started,
        peerFingerprint: townshipCarrierPeerFingerprint(peer.expectedPeerPubkey),
        pulledOpIds: difference(after.localOpIds ?? [], before.localOpIds ?? []),
        localOpIds: after.localOpIds ?? [],
        delegationFrameIds: after.delegationFrameIds ?? [],
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

async function syncReleasePairingOnce(options: TownshipReleasePairingProbeSyncOptions): Promise<TownshipOutboxSync> {
  const syncOptions = {
    workflow: options.workflow,
    peer: options.peer,
    storageNamespace: options.config.storageNamespace,
    keyId: options.config.keyId,
    realmByPubkey: options.realmByPubkey,
  };
  if (options.verifier !== undefined) Object.assign(syncOptions, { verifier: options.verifier });
  if (options.webSocket !== undefined) Object.assign(syncOptions, { webSocket: options.webSocket });
  return syncTownshipOutbox(syncOptions);
}

function tracedPairingDeepLinkSource(
  source: TownshipPairingDeepLinkSource,
  options: {
    onResult?(result: TownshipReleasePairingProbeResult): Promise<void>;
  },
): TownshipPairingDeepLinkSource {
  return {
    async current() {
      const urls = await source.current();
      const result: TownshipReleasePairingProbeResult = {
        phase: "deeplink",
        outcome: "current",
        urlCount: urls?.length ?? 0,
        pairingUrlCount: pairingDeepLinkCount(urls),
      };
      const firstRoute = firstRouteShape(urls);
      if (firstRoute !== undefined) result.firstRoute = firstRoute;
      const firstParseReason = firstPairingParseReason(urls);
      if (firstParseReason !== undefined) result.firstParseReason = firstParseReason;
      await options.onResult?.(result);
      return urls;
    },
    async onOpenUrl(callback) {
      return source.onOpenUrl((urls) => {
        const result: TownshipReleasePairingProbeResult = {
          phase: "deeplink",
          outcome: "callback",
          urlCount: urls.length,
          pairingUrlCount: pairingDeepLinkCount(urls),
        };
        const firstRoute = firstRouteShape(urls);
        if (firstRoute !== undefined) result.firstRoute = firstRoute;
        const firstParseReason = firstPairingParseReason(urls);
        if (firstParseReason !== undefined) result.firstParseReason = firstParseReason;
        void options.onResult?.(result);
        callback(urls);
      });
    },
  };
}

function pairingDeepLinkCount(urls: readonly string[] | null): number {
  return (urls ?? []).filter((url) => parseTownshipPairingDeepLink(url).ok).length;
}

function firstRouteShape(urls: readonly string[] | null): string | undefined {
  const value = urls?.[0];
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.replace(/:$/, "") || "unknown";
    const host = parsed.hostname || "nohost";
    const path = routePathShape(parsed);
    return `${protocol}:${host}:${path}`;
  } catch {
    return "invalid";
  }
}

function firstPairingParseReason(urls: readonly string[] | null): string | undefined {
  const value = urls?.[0];
  if (!value) return undefined;
  const parsed = parseTownshipPairingDeepLink(value);
  return parsed.ok ? "ok" : parsed.reason;
}

function routePathShape(url: URL): string {
  const path = url.pathname || "/";
  const normalized = path.replace(/^\//, "");
  if (url.protocol === "township:" && url.hostname === "nohost" && normalized.startsWith("_pairing")) {
    return normalized === "_pairing" ? "_pairing" : "_pairing_payload";
  }
  if (url.protocol === "township:" && normalized.startsWith("nohost:_pairing")) {
    return normalized === "nohost:_pairing" ? "nohost:_pairing" : "nohost:_pairing_payload";
  }
  if (url.protocol === "township:" && normalized.startsWith("pairing")) {
    return normalized === "pairing" ? "pairing" : "pairing_payload";
  }
  return path.length > 48 ? `${path.slice(0, 48)}_truncated` : path;
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

function pairingHandoffSecretReason(value: string): string | null {
  if (!value.startsWith(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      base64UrlDecodeText(value.slice(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX.length)),
    ) as unknown;
    const field = findForbiddenSecretField(parsed);
    return field ? `pairing_handoff_forbidden_field_${probeToken(field)}` : null;
  } catch {
    return "pairing_handoff_secret_check_failed";
  }
}

function findForbiddenSecretField(value: unknown): string | null {
  if (!plainRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenSecretField(key)) return key;
    const child = findForbiddenSecretField(nested);
    if (child) return child;
  }
  return null;
}

function forbiddenSecretField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (
    normalized === "keyid" ||
    normalized.includes("privatekey") ||
    normalized.includes("secretkey") ||
    normalized.includes("seed")
  );
}

function urlPort(value: string): string {
  try {
    const url = new URL(value);
    if (url.port) return url.port;
    return url.protocol === "wss:" ? "443" : "80";
  } catch {
    return "invalid";
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

function validArmState(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function bytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64UrlEncode(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probeIdList(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.map(probeToken).sort().join(",");
}

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function probeRouteToken(value: string): string {
  return probeToken(value).replace(/(_pairing)(?:_[A-Za-z0-9_.:-]+)?$/, "$1");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
