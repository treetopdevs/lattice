import type { TownshipPairingDeepLinkSource } from "./township_pairing_deeplink";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { TauriInvoke } from "@treetopdevs/lattice-client";
import { TOWNSHIP_LOG_PROBE_COMMAND } from "./native_workflow";

export const TOWNSHIP_ANDROID_CURRENT_INTENT_URL_COMMAND = "lattice_android_current_intent_url";
export const TOWNSHIP_ANDROID_INTENT_SOURCE_LOG_PREFIX = "township-android-intent-source";

export interface TauriPairingDeepLinkPlugin {
  getCurrent(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface TauriPairingDeepLinkSourceOptions {
  importPlugin?: () => Promise<TauriPairingDeepLinkPlugin>;
  invoke?: TauriInvoke;
}

export function createTauriPairingDeepLinkSource(
  options: TauriPairingDeepLinkSourceOptions = {},
): TownshipPairingDeepLinkSource {
  const importPlugin = options.importPlugin ?? importTauriDeepLinkPlugin;
  const invoke = options.invoke ?? tauriInvoke;

  return {
    async current(): Promise<readonly string[] | null> {
      const plugin = await importPlugin();
      return mergeRawIntentUrl(await currentAndroidIntentUrl(invoke), await plugin.getCurrent());
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void> {
      const plugin = await importPlugin();
      return plugin.onOpenUrl((urls) => {
        void (async () => callback(mergeRawIntentUrl(await currentAndroidIntentUrl(invoke), urls) ?? urls))();
      });
    },
  };
}

async function importTauriDeepLinkPlugin(): Promise<TauriPairingDeepLinkPlugin> {
  return import("@tauri-apps/plugin-deep-link");
}

async function currentAndroidIntentUrl(invoke: TauriInvoke): Promise<string | null> {
  try {
    const value = await invoke(TOWNSHIP_ANDROID_CURRENT_INTENT_URL_COMMAND);
    if (typeof value === "string" && value.trim().length > 0) return value;
    await logRawIntentOutcome(invoke, "missing");
    return null;
  } catch (error) {
    await logRawIntentOutcome(invoke, "error", errorMessage(error));
    return null;
  }
}

async function logRawIntentOutcome(invoke: TauriInvoke, outcome: "missing" | "error", message?: string): Promise<void> {
  try {
    const fields = [TOWNSHIP_ANDROID_INTENT_SOURCE_LOG_PREFIX, `outcome=${outcome}`];
    if (message) fields.push(`message=${probeToken(message)}`);
    await invoke(TOWNSHIP_LOG_PROBE_COMMAND, { event: fields.join(" ") });
  } catch {
    // Best-effort diagnostic only. Deep-link fallback must keep working off-Tauri and on non-Android.
  }
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
