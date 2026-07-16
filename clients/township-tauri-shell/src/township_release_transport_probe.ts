import { logTownshipProbeEvent, type TownshipNativeWorkflowOptions } from "./native_workflow";

export const TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX = "township-release-transport-probe";
export const TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL_ENV = "VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL";
export const TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS_ENV = "VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS";
export const TOWNSHIP_RELEASE_TRANSPORT_PROBE_FRAME = "township-release-transport-probe-frame";

export type TownshipReleaseTransportProbeOutcome = "connected" | "error" | "timeout" | "config_error";
export type TownshipReleaseTransportProbeHostClass = "android_host" | "invalid" | "lan" | "loopback" | "remote";

export interface TownshipReleaseTransportProbeResult {
  surface: "webview-websocket";
  urlScheme: "ws" | "wss" | "invalid";
  hostClass: TownshipReleaseTransportProbeHostClass;
  outcome: TownshipReleaseTransportProbeOutcome;
  elapsedMs: number;
  message?: string;
}

export interface TownshipReleaseTransportProbeEnv {
  VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL?: string;
  VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS?: string;
}

export interface TownshipReleaseTransportWebSocket {
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
  send(data: string): void;
}

export type TownshipReleaseTransportWebSocketConstructor = new (url: string) => TownshipReleaseTransportWebSocket;

export interface TownshipReleaseTransportProbeOptions extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  url: string;
  timeoutMs?: number;
  webSocket?: TownshipReleaseTransportWebSocketConstructor;
}

export function townshipReleaseTransportProbeUrlFromEnv(env: TownshipReleaseTransportProbeEnv): string | null {
  const url = env.VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL?.trim();
  if (!url || !validTransportProbeUrl(url)) return null;
  return url;
}

export function townshipReleaseTransportProbeUrlsFromEnv(env: TownshipReleaseTransportProbeEnv): string[] {
  const urls = env.VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS?.split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && validTransportProbeUrl(url));
  if (urls && urls.length > 0) return urls;

  const singleUrl = townshipReleaseTransportProbeUrlFromEnv(env);
  return singleUrl ? [singleUrl] : [];
}

export function townshipReleaseTransportProbeHostClass(value: string): TownshipReleaseTransportProbeHostClass {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }

  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "loopback";
  if (host === "10.0.2.2") return "android_host";
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return "lan";
  return "remote";
}

export async function logTownshipReleaseTransportProbeFromEnv(
  env: TownshipReleaseTransportProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleaseTransportProbeEnv }).env ?? {}),
  options: Omit<TownshipReleaseTransportProbeOptions, "url"> = {},
): Promise<boolean> {
  const url = townshipReleaseTransportProbeUrlFromEnv(env);
  if (!url) return false;
  await logTownshipReleaseTransportProbe({ ...options, url });
  return true;
}

export async function logTownshipReleaseTransportProbesFromEnv(
  env: TownshipReleaseTransportProbeEnv = ((import.meta as ImportMeta & { env?: TownshipReleaseTransportProbeEnv }).env ?? {}),
  options: Omit<TownshipReleaseTransportProbeOptions, "url"> = {},
): Promise<TownshipReleaseTransportProbeResult[]> {
  const urls = townshipReleaseTransportProbeUrlsFromEnv(env);
  const results: TownshipReleaseTransportProbeResult[] = [];
  for (const url of urls) {
    results.push(await logTownshipReleaseTransportProbe({ ...options, url }));
  }
  return results;
}

export async function logTownshipReleaseTransportProbe(
  options: TownshipReleaseTransportProbeOptions,
): Promise<TownshipReleaseTransportProbeResult> {
  const result = await probeTownshipReleaseTransport(options);
  await logTownshipProbeEvent(townshipReleaseTransportProbeLogLine(result), options);
  return result;
}

export async function probeTownshipReleaseTransport(
  options: TownshipReleaseTransportProbeOptions,
): Promise<TownshipReleaseTransportProbeResult> {
  const started = Date.now();
  if (!validTransportProbeUrl(options.url)) {
    return probeResult(options.url, "config_error", started, "invalid transport probe url");
  }

  const WebSocketCtor = (options.webSocket ?? globalThis.WebSocket) as
    | TownshipReleaseTransportWebSocketConstructor
    | undefined;
  if (!WebSocketCtor) {
    return probeResult(options.url, "config_error", started, "WebSocket unavailable");
  }

  return new Promise((resolve) => {
    let settled = false;
    let socket: TownshipReleaseTransportWebSocket | null = null;
    const settle = (outcome: TownshipReleaseTransportProbeOutcome, message?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing a failed browser WebSocket can throw on some runtimes; the probe result is settled.
      }
      resolve(probeResult(options.url, outcome, started, message));
    };
    const timer = setTimeout(() => settle("timeout", "open timed out"), options.timeoutMs ?? 5_000);

    try {
      const openedSocket = new WebSocketCtor(options.url);
      socket = openedSocket;
      openedSocket.onmessage = (event) => {
        if (String(event.data) === TOWNSHIP_RELEASE_TRANSPORT_PROBE_FRAME) {
          settle("connected", "frame roundtrip");
        }
      };
      openedSocket.onopen = () => {
        try {
          openedSocket.send(TOWNSHIP_RELEASE_TRANSPORT_PROBE_FRAME);
        } catch (error) {
          settle("error", errorMessage(error));
        }
      };
      openedSocket.onerror = (event) => settle("error", errorMessage(event));
    } catch (error) {
      settle("error", errorMessage(error));
    }
  });
}

export function townshipReleaseTransportProbeLogLine(result: TownshipReleaseTransportProbeResult): string {
  const fields = [
    TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX,
    `surface=${probeToken(result.surface)}`,
    `url_scheme=${probeToken(result.urlScheme)}`,
    `host_class=${probeToken(result.hostClass)}`,
    `outcome=${probeToken(result.outcome)}`,
    `elapsed_ms=${Math.max(0, Math.round(result.elapsedMs))}`,
  ];
  if (result.message) fields.push(`message=${probeToken(result.message)}`);
  return fields.join(" ");
}

function probeResult(
  url: string,
  outcome: TownshipReleaseTransportProbeOutcome,
  started: number,
  message?: string,
): TownshipReleaseTransportProbeResult {
  return {
    surface: "webview-websocket",
    urlScheme: transportProbeUrlScheme(url),
    hostClass: townshipReleaseTransportProbeHostClass(url),
    outcome,
    elapsedMs: Date.now() - started,
    ...(message ? { message } : {}),
  };
}

function validTransportProbeUrl(value: string): boolean {
  return transportProbeUrlScheme(value) !== "invalid";
}

function transportProbeUrlScheme(value: string): "ws" | "wss" | "invalid" {
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "ws:") return "ws";
    if (protocol === "wss:") return "wss";
  } catch {
    return "invalid";
  }
  return "invalid";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof (error as { message?: unknown })?.message === "string") {
    return (error as { message: string }).message;
  }
  return "transport error";
}

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}
