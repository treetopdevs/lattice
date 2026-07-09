import {
  connectCarrierWebSocket,
  type CarrierStateReport,
  type CarrierVerifier,
  type CarrierWebSocketClient,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  logTownshipProbeEvent,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";
import { TOWNSHIP_REPLICA } from "./township_actions";
import { createWebCryptoCarrierVerifier } from "./township_carrier_peer";
import {
  townshipReleaseTransportProbeHostClass,
  type TownshipReleaseTransportProbeHostClass,
} from "./township_release_transport_probe";

export const TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX = "township-release-beam-probe";
export const TOWNSHIP_RELEASE_BEAM_PROBE_URL_ENV = "VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL";

export interface TownshipReleaseBeamProbeEnv {
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM?: string;
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM?: string;
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_RELEASE_BEAM_PROBE_REPLICA?: string;
}

export interface TownshipReleaseBeamProbeConfig {
  url: string;
  localRealm: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
  replica: string;
}

export type TownshipReleaseBeamProbeOutcome = "connected" | "error" | "timeout";

export type TownshipReleaseBeamProbeResult =
  | {
      phase: "native_key";
      publicKeyBase64: string;
      localRealm: string;
    }
  | {
      phase: "carrier";
      urlScheme: "ws" | "wss" | "invalid";
      hostClass: TownshipReleaseTransportProbeHostClass;
      outcome: TownshipReleaseBeamProbeOutcome;
      elapsedMs: number;
      status?: string;
      opCount?: number;
      authorityQuarantineCount?: number;
      message?: string;
    };

export interface TownshipReleaseBeamProbeClient {
  status(): Promise<string>;
  stateReport(): Promise<CarrierStateReport>;
  close(): void;
}

export interface TownshipReleaseBeamProbeConnectOptions {
  config: TownshipReleaseBeamProbeConfig;
  workflow: TownshipNativeWorkflow;
  verifier?: CarrierVerifier;
}

export interface TownshipReleaseBeamProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke" | "keyId"> {
  workflow?: TownshipNativeWorkflow;
  timeoutMs?: number;
  retryDelayMs?: number;
  connect?(options: TownshipReleaseBeamProbeConnectOptions): Promise<TownshipReleaseBeamProbeClient>;
  verifier?: CarrierVerifier;
}

export function townshipReleaseBeamProbeConfigFromEnv(
  env: TownshipReleaseBeamProbeEnv,
): TownshipReleaseBeamProbeConfig | null {
  const url = present(env.VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL);
  const localRealm = present(env.VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM);
  const expectedPeerRealm = present(env.VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM);
  const expectedPeerPubkey = present(env.VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY);
  const replica = present(env.VITE_TOWNSHIP_RELEASE_BEAM_PROBE_REPLICA) ?? TOWNSHIP_REPLICA;

  if (!url || !validProbeUrl(url) || !localRealm || !expectedPeerRealm || !validPublicKey(expectedPeerPubkey)) {
    return null;
  }

  return {
    url,
    localRealm,
    expectedPeerRealm,
    expectedPeerPubkey: expectedPeerPubkey as string,
    replica,
  };
}

export async function logTownshipReleaseBeamProbeFromEnv(
  env: TownshipReleaseBeamProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleaseBeamProbeEnv }).env ?? {}),
  options: TownshipReleaseBeamProbeOptions = {},
): Promise<TownshipReleaseBeamProbeResult | null> {
  const config = townshipReleaseBeamProbeConfigFromEnv(env);
  if (!config) return null;

  const workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  const nativeKeyResult: TownshipReleaseBeamProbeResult = {
    phase: "native_key",
    publicKeyBase64: bytesBase64(workflow.signer.publicKey),
    localRealm: config.localRealm,
  };
  await logTownshipProbeEvent(townshipReleaseBeamProbeLogLine(nativeKeyResult), options);

  const result = await probeTownshipReleaseBeam({ ...options, config, workflow });
  await logTownshipProbeEvent(townshipReleaseBeamProbeLogLine(result), options);
  return result;
}

export async function probeTownshipReleaseBeam(
  options: TownshipReleaseBeamProbeOptions & {
    config: TownshipReleaseBeamProbeConfig;
    workflow: TownshipNativeWorkflow;
  },
): Promise<TownshipReleaseBeamProbeResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 60_000);
  let lastMessage = "carrier peer unavailable";

  while (Date.now() <= deadline) {
    let client: TownshipReleaseBeamProbeClient | null = null;
    try {
      const connectOptions: TownshipReleaseBeamProbeConnectOptions = {
        config: options.config,
        workflow: options.workflow,
      };
      if (options.verifier !== undefined) connectOptions.verifier = options.verifier;
      client = await (options.connect ?? connectTownshipReleaseBeamProbe)(connectOptions);
      const status = await client.status();
      const report = await client.stateReport();
      client.close();
      return carrierResult(options.config.url, "connected", started, {
        status,
        opCount: report.op_ids.length,
        authorityQuarantineCount: report.authority_quarantine.length,
      });
    } catch (error) {
      lastMessage = errorMessage(error);
      try {
        client?.close();
      } catch {
        // Best-effort cleanup before retrying the bounded release probe.
      }
      await delay(options.retryDelayMs ?? 500);
    }
  }

  return carrierResult(options.config.url, "timeout", started, { message: lastMessage });
}

export function townshipReleaseBeamProbeLogLine(result: TownshipReleaseBeamProbeResult): string {
  if (result.phase === "native_key") {
    return [
      TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX,
      "phase=native_key",
      `local_realm=${probeToken(result.localRealm)}`,
      `public_key_b64url=${base64UrlEncode(result.publicKeyBase64)}`,
    ].join(" ");
  }

  const fields = [
    TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX,
    "phase=carrier",
    `url_scheme=${probeToken(result.urlScheme)}`,
    `host_class=${probeToken(result.hostClass)}`,
    `outcome=${probeToken(result.outcome)}`,
    `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
  ];
  if (result.status) fields.push(`status=${probeToken(result.status)}`);
  if (result.opCount !== undefined) fields.push(`op_count=${result.opCount}`);
  if (result.authorityQuarantineCount !== undefined) {
    fields.push(`authority_quarantine_count=${result.authorityQuarantineCount}`);
  }
  if (result.message) fields.push(`message=${probeToken(result.message)}`);
  return fields.join(" ");
}

async function connectTownshipReleaseBeamProbe(
  options: TownshipReleaseBeamProbeConnectOptions,
): Promise<TownshipReleaseBeamProbeClient> {
  return connectCarrierWebSocket({
    url: options.config.url,
    localRealm: options.config.localRealm,
    replica: options.config.replica,
    signer: options.workflow.signer,
    expectedPeerRealm: options.config.expectedPeerRealm,
    expectedPeerPubkey: base64Bytes(options.config.expectedPeerPubkey),
    verifier: options.verifier ?? createWebCryptoCarrierVerifier(),
  }) as Promise<CarrierWebSocketClient>;
}

function carrierResult(
  url: string,
  outcome: TownshipReleaseBeamProbeOutcome,
  started: number,
  fields: Pick<TownshipReleaseBeamProbeResult & { phase: "carrier" }, "authorityQuarantineCount" | "message" | "opCount" | "status"> = {},
): TownshipReleaseBeamProbeResult {
  return {
    phase: "carrier",
    urlScheme: probeUrlScheme(url),
    hostClass: townshipReleaseTransportProbeHostClass(url),
    outcome,
    elapsedMs: Date.now() - started,
    ...fields,
  };
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

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof (error as { message?: unknown })?.message === "string") return (error as { message: string }).message;
  return "carrier probe failed";
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

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}
