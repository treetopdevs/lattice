import {
  createTownshipNativeWorkflow,
  logTownshipProbeEvent,
  TOWNSHIP_NATIVE_KEY_ID,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import {
  loadTownshipCarrierPeerConfig,
  townshipCarrierPeerFingerprint,
  type TownshipCarrierPeerConfig,
} from "./township_carrier_peer";
import {
  probeTownshipReleaseAuthor,
  townshipReleaseAuthorProbeLogLine,
  TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_BAD_SUMMARY_TEXT,
  TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_POST_TEXT,
  type TownshipReleaseAuthorProbeConfig,
  type TownshipReleaseAuthorProbeOptions,
  type TownshipReleaseAuthorProbeResult,
} from "./township_release_author_probe";
import {
  probeTownshipReleasePairing,
  townshipReleasePairingProbeLogLine,
  townshipReleasePairingReloadResult,
  type TownshipReleasePairingProbeConfig,
  type TownshipReleasePairingProbeOptions,
  type TownshipReleasePairingProbeResult,
} from "./township_release_pairing_probe";

export const TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX = "township-release-onboarding-probe";
export const TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE = "township:release-onboarding-probe";

export interface TownshipReleaseOnboardingProbeEnv {
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_TIMEOUT_MS?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_RETRY_DELAY_MS?: string;
  VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_PAUSE_AFTER_AUTHOR_MS?: string;
}

export interface TownshipReleaseOnboardingProbeConfig {
  localRealm: string;
  keyId: string;
  storageNamespace: string;
  armState?: string;
  stateExchangeUrl?: string;
  postText: string;
  badSummaryText: string;
  grantAudiencePubkey?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  pauseAfterAuthorMs?: number;
}

export type TownshipReleaseOnboardingProbeResult =
  | {
      phase: "native_key";
      publicKeyBase64: string;
      localRealm: string;
      storageNamespace: string;
    }
  | {
      phase: "complete";
      outcome: "reported";
      peerFingerprint: string;
      postMaterialized: boolean;
      badAuthorityReason: string;
    }
  | {
      phase: "pairing" | "author";
      outcome: "error";
      message: string;
    };

export interface TownshipReleaseOnboardingProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  workflow?: TownshipNativeWorkflow;
  pair?(
    options: TownshipReleasePairingProbeOptions & {
      config: TownshipReleasePairingProbeConfig;
      workflow: TownshipNativeWorkflow;
      onResult?(result: TownshipReleasePairingProbeResult): Promise<void>;
    },
  ): Promise<TownshipReleasePairingProbeResult>;
  loadPeer?(workflow: TownshipNativeWorkflow): Promise<TownshipCarrierPeerConfig | null>;
  author?(
    options: TownshipReleaseAuthorProbeOptions & {
      config: TownshipReleaseAuthorProbeConfig;
      workflow: TownshipNativeWorkflow;
      onResult?(result: TownshipReleaseAuthorProbeResult): Promise<void>;
    },
  ): Promise<TownshipReleaseAuthorProbeResult>;
}

export function townshipReleaseOnboardingProbeConfigFromEnv(
  env: TownshipReleaseOnboardingProbeEnv & Record<string, string | undefined>,
): TownshipReleaseOnboardingProbeConfig | null {
  if (forbiddenPeerEnvPresent(env)) return null;

  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOCAL_REALM);
  const keyId = present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_KEY_ID) ?? TOWNSHIP_NATIVE_KEY_ID;
  const storageNamespace =
    present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE) ??
    TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE;
  const armState = present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE);
  const stateExchangeUrl = present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL);
  const postText =
    present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT) ??
    TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_POST_TEXT;
  const badSummaryText =
    present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_BAD_SUMMARY_TEXT) ??
    TOWNSHIP_RELEASE_AUTHOR_PROBE_DEFAULT_BAD_SUMMARY_TEXT;
  const grantAudiencePubkey = present(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY);
  const timeoutMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_RETRY_DELAY_MS);
  const pauseAfterAuthorMs = positiveInteger(env.VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_PAUSE_AFTER_AUTHOR_MS);

  if (
    !localRealm ||
    (armState === null && stateExchangeUrl === null) ||
    (armState !== null && !validArmState(armState)) ||
    (stateExchangeUrl !== null && !validStateExchangeUrl(stateExchangeUrl)) ||
    (armState !== null && stateExchangeUrl !== null) ||
    (grantAudiencePubkey !== null && !validPublicKey(grantAudiencePubkey))
  ) {
    return null;
  }

  const config: TownshipReleaseOnboardingProbeConfig = {
    localRealm,
    keyId,
    storageNamespace,
    postText,
    badSummaryText,
  };
  if (armState !== null) config.armState = armState;
  if (stateExchangeUrl !== null) config.stateExchangeUrl = stateExchangeUrl;
  if (grantAudiencePubkey !== null) config.grantAudiencePubkey = grantAudiencePubkey;
  if (timeoutMs !== null) config.timeoutMs = timeoutMs;
  if (retryDelayMs !== null) config.retryDelayMs = retryDelayMs;
  if (pauseAfterAuthorMs !== null) config.pauseAfterAuthorMs = pauseAfterAuthorMs;
  return config;
}

export async function logTownshipReleaseOnboardingProbeFromEnv(
  env: TownshipReleaseOnboardingProbeEnv & Record<string, string | undefined> = ((import.meta as ImportMeta & {
    env?: TownshipReleaseOnboardingProbeEnv & Record<string, string | undefined>;
  }).env ?? {}),
  options: TownshipReleaseOnboardingProbeOptions = {},
): Promise<TownshipReleaseOnboardingProbeResult | null> {
  const config = townshipReleaseOnboardingProbeConfigFromEnv(env);
  if (!config) return null;

  const workflowOptions: TownshipNativeWorkflowOptions = {
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (options.invoke !== undefined) workflowOptions.invoke = options.invoke;
  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(workflowOptions));
  const nativeKeyResult: TownshipReleaseOnboardingProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.localRealm,
    storageNamespace: config.storageNamespace,
  };
  await logTownshipProbeEvent(townshipReleaseOnboardingProbeLogLine(nativeKeyResult), options);
  await logTownshipProbeEvent(
    townshipReleasePairingProbeLogLine({
      ...nativeKeyResult,
      phase: "native_key",
    }),
    options,
  );
  const pairingReload = await townshipReleasePairingReloadResult(workflow);
  await logTownshipProbeEvent(townshipReleasePairingProbeLogLine(pairingReload), options);

  const pairingConfig: TownshipReleasePairingProbeConfig = {
    localRealm: config.localRealm,
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
  };
  if (config.armState !== undefined) pairingConfig.armState = config.armState;
  if (config.stateExchangeUrl !== undefined) pairingConfig.stateExchangeUrl = config.stateExchangeUrl;
  if (config.timeoutMs !== undefined) pairingConfig.timeoutMs = config.timeoutMs;
  if (config.retryDelayMs !== undefined) pairingConfig.retryDelayMs = config.retryDelayMs;

  let peer: TownshipCarrierPeerConfig | null = null;
  if (pairingReload.peer && pairingReload.carrierFrameCount > 0) {
    peer = pairingReload.peer;
  } else {
    const pairing = await (options.pair ?? probeTownshipReleasePairing)({
      config: pairingConfig,
      workflow,
      onResult: async (result) => {
        await logTownshipProbeEvent(townshipReleasePairingProbeLogLine(result), options);
      },
    });
    if (pairing.phase !== "sync" || pairing.outcome !== "synced") {
      const result: TownshipReleaseOnboardingProbeResult = {
        phase: "pairing",
        outcome: "error",
        message: phaseOutcome(pairing),
      };
      await logTownshipProbeEvent(townshipReleaseOnboardingProbeLogLine(result), options);
      return result;
    }
    peer = await (options.loadPeer ?? loadOnboardingPeer)(workflow);
  }
  if (!peer) {
    const result: TownshipReleaseOnboardingProbeResult = {
      phase: "pairing",
      outcome: "error",
      message: "pairing_config_not_persisted",
    };
    await logTownshipProbeEvent(townshipReleaseOnboardingProbeLogLine(result), options);
    return result;
  }

  const authorConfig: TownshipReleaseAuthorProbeConfig = {
    peer,
    keyId: config.keyId,
    storageNamespace: config.storageNamespace,
    postText: config.postText,
    badSummaryText: config.badSummaryText,
  };
  if (config.grantAudiencePubkey !== undefined) authorConfig.grantAudiencePubkey = config.grantAudiencePubkey;
  if (config.timeoutMs !== undefined) authorConfig.timeoutMs = config.timeoutMs;
  if (config.retryDelayMs !== undefined) authorConfig.retryDelayMs = config.retryDelayMs;
  if (config.pauseAfterAuthorMs !== undefined) authorConfig.pauseAfterAuthorMs = config.pauseAfterAuthorMs;

  const authored = await (options.author ?? probeTownshipReleaseAuthor)({
    config: authorConfig,
    workflow,
    onResult: async (result) => {
      await logTownshipProbeEvent(townshipReleaseAuthorProbeLogLine(result), options);
    },
  });
  if (authored.phase !== "peer" || authored.outcome !== "reported") {
    const result: TownshipReleaseOnboardingProbeResult = {
      phase: "author",
      outcome: "error",
      message: phaseOutcome(authored),
    };
    await logTownshipProbeEvent(townshipReleaseOnboardingProbeLogLine(result), options);
    return result;
  }

  const result: TownshipReleaseOnboardingProbeResult = {
    phase: "complete",
    outcome: "reported",
    peerFingerprint: townshipCarrierPeerFingerprint(peer.expectedPeerPubkey),
    postMaterialized: authored.postMaterialized,
    badAuthorityReason: authored.badAuthorityReason,
  };
  await logTownshipProbeEvent(townshipReleaseOnboardingProbeLogLine(result), options);
  return result;
}

export function townshipReleaseOnboardingProbeLogLine(result: TownshipReleaseOnboardingProbeResult): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `storage_namespace=${probeToken(result.storageNamespace)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  if (result.phase === "complete") {
    return [
      TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX,
      "phase=complete",
      "outcome=reported",
      `peer_fingerprint=${probeToken(result.peerFingerprint)}`,
      `post_materialized=${result.postMaterialized}`,
      `bad_authority_reason=${probeToken(result.badAuthorityReason)}`,
    ].join(" ");
  }

  return [
    TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX,
    `phase=${result.phase}`,
    `outcome=${result.outcome}`,
    `message=${probeToken(result.message)}`,
  ].join(" ");
}

async function loadOnboardingPeer(workflow: TownshipNativeWorkflow): Promise<TownshipCarrierPeerConfig | null> {
  return loadTownshipCarrierPeerConfig(workflow.storage, {});
}

function forbiddenPeerEnvPresent(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some((key) => /^VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)$/.test(key));
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

function validPublicKey(value: string): boolean {
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

function validStateExchangeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return false;
    return ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function bytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64UrlEncode(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function phaseOutcome(result: { phase: string; outcome?: string }): string {
  return `${result.phase}_${result.outcome ?? "unknown"}`;
}
