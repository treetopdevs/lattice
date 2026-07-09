import assert from "node:assert/strict";
import {
  createTownshipPairingDeepLinkListener,
  parseTownshipPairingDeepLink,
  type TownshipPairingDeepLinkSource,
} from "../src/township_pairing_deeplink";
import { createTauriPairingDeepLinkSource } from "../src/township_pairing_deeplink_source";

console.log("\n▸ Township Tauri deep-link source");

const currentUrls = ["township://pairing?handoff=township-pairing:v1:not-json"];
const openedUrls = ["township://pairing/garbage"];
let importerCalls = 0;
let subscribed: ((urls: readonly string[]) => void) | null = null;
let unlistenCount = 0;
const source = createTauriPairingDeepLinkSource({
  async importPlugin() {
    importerCalls++;
    return {
      async getCurrent(): Promise<readonly string[] | null> {
        return currentUrls;
      },
      async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<() => void> {
        subscribed = callback;
        return () => {
          unlistenCount++;
        };
      },
    };
  },
});
assert.equal(importerCalls, 0, "plugin import should be lazy");
assert.deepEqual(await source.current(), currentUrls);
assert.equal(importerCalls, 1);

const seen: readonly string[][] = [];
const stop = await source.onOpenUrl((urls) => {
  seen.push([...urls]);
});
assert.equal(importerCalls, 2);
assert.ok(subscribed, "source should subscribe to deep-link open events");
subscribed(openedUrls);
await nextTick();
assert.deepEqual(seen, [openedUrls]);
stop?.();
assert.equal(unlistenCount, 1);

const missingCurrent = createTauriPairingDeepLinkSource({
  async importPlugin() {
    return {
      async getCurrent(): Promise<null> {
        return null;
      },
      async onOpenUrl(): Promise<void> {},
    };
  },
});
assert.equal(await missingCurrent.current(), null);
assert.equal(await missingCurrent.onOpenUrl(() => {}), undefined);

const rawIntentUrl = "township://pairing?handoff=township-pairing:v1:not-json";
const routeOnlyUrl = "township://nohost/_pairing";
const invokedCommands: string[] = [];
const rawIntentSource = createTauriPairingDeepLinkSource({
  async importPlugin() {
    return {
      async getCurrent(): Promise<readonly string[]> {
        return [routeOnlyUrl];
      },
      async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<void> {
        callback([routeOnlyUrl]);
      },
    };
  },
  async invoke(command) {
    invokedCommands.push(command);
    return rawIntentUrl;
  },
});
assert.deepEqual(await rawIntentSource.current(), [rawIntentUrl, routeOnlyUrl]);
const rawSeen: readonly string[][] = [];
await rawIntentSource.onOpenUrl((urls) => rawSeen.push([...urls]));
await nextTick();
assert.deepEqual(rawSeen, [[rawIntentUrl, routeOnlyUrl]]);
assert.deepEqual(invokedCommands, ["lattice_android_current_intent_url", "lattice_android_current_intent_url"]);

const failedRawIntentSource = createTauriPairingDeepLinkSource({
  async importPlugin() {
    return {
      async getCurrent(): Promise<readonly string[]> {
        return [routeOnlyUrl];
      },
      async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<void> {
        callback([routeOnlyUrl]);
      },
    };
  },
  async invoke() {
    throw new Error("unsupported platform");
  },
});
assert.deepEqual(await failedRawIntentSource.current(), [routeOnlyUrl]);
const fallbackSeen: readonly string[][] = [];
await failedRawIntentSource.onOpenUrl((urls) => fallbackSeen.push([...urls]));
await nextTick();
assert.deepEqual(fallbackSeen, [[routeOnlyUrl]]);

const parsed: ReturnType<typeof parseTownshipPairingDeepLink>[] = [];
const scriptedSource: TownshipPairingDeepLinkSource = {
  async current() {
    return currentUrls;
  },
  async onOpenUrl(callback) {
    callback(openedUrls);
  },
};
await createTownshipPairingDeepLinkListener({
  source: scriptedSource,
  apply(parse) {
    parsed.push(parse);
  },
});
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.ok, false);
assert.equal(parsed[0]?.reason, "invalid_pairing_format");
assert.equal(parsed[1]?.ok, false);
assert.equal(parsed[1]?.reason, "invalid_pairing_payload");

console.log("\x1b[32m✓ Township Tauri deep-link source checks passed\x1b[0m");

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
