import type { TownshipPairingDeepLinkSource } from "./township_pairing_deeplink";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { TauriInvoke } from "@treetopdevs/lattice-client";
import { TOWNSHIP_LOG_PROBE_COMMAND } from "./native_workflow";

export const TOWNSHIP_ANDROID_CURRENT_PAIRING_HANDOFF_B64_COMMAND = "lattice_android_current_pairing_handoff_b64";
export const TOWNSHIP_ANDROID_INTENT_SOURCE_LOG_PREFIX = "township-android-intent-source";

export interface TauriPairingDeepLinkPlugin {
  getCurrent(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface TauriPairingDeepLinkSourceOptions {
  importPlugin?: () => Promise<TauriPairingDeepLinkPlugin>;
  invoke?: TauriInvoke;
  currentTimeoutMs?: number;
  subscribeTimeoutMs?: number;
  includeAndroidPairingIntent?: boolean;
}

const DEFAULT_CURRENT_TIMEOUT_MS = 1_000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 1_000;

export function createTauriPairingDeepLinkSource(
  options: TauriPairingDeepLinkSourceOptions = {},
): TownshipPairingDeepLinkSource {
  const importPlugin = options.importPlugin ?? importTauriDeepLinkPlugin;
  const invoke = options.invoke ?? tauriInvoke;
  const currentTimeoutMs = options.currentTimeoutMs ?? DEFAULT_CURRENT_TIMEOUT_MS;
  const subscribeTimeoutMs = options.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
  const includeAndroidPairingIntent = options.includeAndroidPairingIntent ?? true;

  return {
    async current(): Promise<readonly string[] | null> {
      const plugin = await importPlugin();
      const rawIntentUrl = includeAndroidPairingIntent ? await currentAndroidPairingUrl(invoke) : null;
      const pluginCurrent = await withTimeout(plugin.getCurrent(), currentTimeoutMs, null);
      return mergeRawIntentUrl(rawIntentUrl, pluginCurrent);
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void> {
      const plugin = await importPlugin();
      return withTimeoutReject(
        plugin.onOpenUrl((urls) => {
          void (async () => {
            const rawIntentUrl = includeAndroidPairingIntent ? await currentAndroidPairingUrl(invoke) : null;
            callback(mergeRawIntentUrl(rawIntentUrl, urls) ?? urls);
          })();
        }),
        subscribeTimeoutMs,
        "deep-link subscription timed out",
      );
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withTimeoutReject<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function importTauriDeepLinkPlugin(): Promise<TauriPairingDeepLinkPlugin> {
  return import("@tauri-apps/plugin-deep-link");
}

async function currentAndroidPairingUrl(invoke: TauriInvoke): Promise<string | null> {
  try {
    const value = await invoke(TOWNSHIP_ANDROID_CURRENT_PAIRING_HANDOFF_B64_COMMAND);
    if (typeof value === "string" && value.trim().length > 0) {
      const handoff = decodeBase64Url(value);
      const pairingUrl = `township://pairing?handoff=${encodeURIComponent(handoff)}`;
      await logRawIntentOutcome(invoke, "found");
      return pairingUrl;
    }
    await logRawIntentOutcome(invoke, "missing");
    return null;
  } catch (error) {
    await logRawIntentOutcome(invoke, "error", errorMessage(error));
    return null;
  }
}

async function logRawIntentOutcome(invoke: TauriInvoke, outcome: "found" | "missing" | "error", message?: string): Promise<void> {
  try {
    const fields = [TOWNSHIP_ANDROID_INTENT_SOURCE_LOG_PREFIX, `outcome=${outcome}`];
    if (message) fields.push(`message=${probeToken(message)}`);
    await invoke(TOWNSHIP_LOG_PROBE_COMMAND, { event: fields.join(" ") });
  } catch {
    // Best-effort diagnostic only. Deep-link fallback must keep working off-Tauri and on non-Android.
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${"=".repeat(paddingLength)}`;
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function mergeRawIntentUrl(rawUrl: string | null, urls: readonly string[] | null): readonly string[] | null {
  const merged = rawUrl ? [rawUrl, ...(urls ?? [])] : [...(urls ?? [])];
  const unique = [...new Set(merged)];
  return unique.length > 0 ? unique : null;
}

function probeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
