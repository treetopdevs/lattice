import type { TownshipPairingDeepLinkSource } from "./township_pairing_deeplink";

export interface TauriPairingDeepLinkPlugin {
  getCurrent(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface TauriPairingDeepLinkSourceOptions {
  importPlugin?: () => Promise<TauriPairingDeepLinkPlugin>;
}

export function createTauriPairingDeepLinkSource(
  options: TauriPairingDeepLinkSourceOptions = {},
): TownshipPairingDeepLinkSource {
  const importPlugin = options.importPlugin ?? importTauriDeepLinkPlugin;

  return {
    async current(): Promise<readonly string[] | null> {
      const plugin = await importPlugin();
      return plugin.getCurrent();
    },
    async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void> {
      const plugin = await importPlugin();
      return plugin.onOpenUrl(callback);
    },
  };
}

async function importTauriDeepLinkPlugin(): Promise<TauriPairingDeepLinkPlugin> {
  return import("@tauri-apps/plugin-deep-link");
}
