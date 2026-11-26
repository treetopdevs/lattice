import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Closing review (both reviewers, blocker): ExpoSecureStoreKeyStore turned every expo-secure-store error into an
// in-memory lookup, so a locked Keychain at launch read as "no key" and loadOrCreateDeviceIdentity made a
// replacement key, could overwrite the real one, and labelled it Keychain-backed. 07 STOP 5: a key is never
// regenerated to recover from an error. A key is created only when the Keychain positively answers that none
// exists (iOS: getItemAsync resolves null only on errSecItemNotFound, node_modules/expo-secure-store/ios); a read
// failure, or a stored value that is not a seed, is custody "unavailable"; an existing key is never overwritten.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_KEY = "treehouse_mobile_device_ed25519_seed_v1";

type Calls = { get: number; set: number; del: number };

/** A secure-store module stand-in: `get` decides what a read does; every write is counted. */
function fakeSecureStore(get: (key: string) => Promise<string | null>, set?: (key: string, value: string) => Promise<void>) {
  const calls: Calls = { get: 0, set: 0, del: 0 };
  const written = new Map<string, string>();
  const mod = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
    async getItemAsync(key: string) {
      calls.get++;
      return written.has(key) ? written.get(key)! : get(key);
    },
    async setItemAsync(key: string, value: string) {
      calls.set++;
      if (set) await set(key, value);
      written.set(key, value);
    },
    async deleteItemAsync(key: string) {
      calls.del++;
      written.delete(key);
    },
  };
  return { mod, calls, written };
}

const locked = () => Promise.reject(new Error("User interaction is not allowed. (errSecInteractionNotAllowed)"));

test("a Keychain read that fails is custody unavailable: no key is created or written", async () => {
  const { ExpoSecureStoreKeyStore, loadOrCreateDeviceIdentity } = await import("../../src/native/custody");
  const { mod, calls } = fakeSecureStore(locked);
  const store = new ExpoSecureStoreKeyStore(async () => mod);
  await assert.rejects(store.getItem(SEED_KEY), /errSecInteractionNotAllowed/, "the read failure is not turned into null");
  const outcome = await loadOrCreateDeviceIdentity(store, "mobile-device");
  assert.deepEqual(outcome, { ok: false, reason: "key_unavailable" });
  assert.equal(calls.set, 0, "nothing was written over the Keychain entry");
  assert.equal(calls.del, 0);
});

test("a secure store that cannot load is unavailable, never an in-memory store", async () => {
  const { ExpoSecureStoreKeyStore, loadOrCreateDeviceIdentity } = await import("../../src/native/custody");
  const store = new ExpoSecureStoreKeyStore(async () => {
    throw new Error("Cannot find native module 'ExpoSecureStore'");
  });
  await assert.rejects(store.getItem(SEED_KEY));
  await assert.rejects(store.setItem(SEED_KEY, "00".repeat(32)));
  assert.deepEqual(await loadOrCreateDeviceIdentity(store, "mobile-device"), { ok: false, reason: "key_unavailable" });
  const source = readFileSync(join(ROOT, "src/native/custody.ts"), "utf8");
  const cls = source.slice(source.indexOf("export class ExpoSecureStoreKeyStore"), source.indexOf("\n}\n", source.indexOf("export class ExpoSecureStoreKeyStore")));
  assert.ok(!/MemoryKeyStore|fallback/.test(cls), "the app's key store has no memory fallback");
});

test("a stored value that is not a seed is unavailable and is never overwritten", async () => {
  const { loadOrCreateDeviceIdentity, MemoryKeyStore } = await import("../../src/native/custody");
  const store = new MemoryKeyStore();
  await store.setItem(SEED_KEY, "not-a-seed");
  assert.deepEqual(await loadOrCreateDeviceIdentity(store, "mobile-device"), { ok: false, reason: "key_unavailable" });
  assert.equal(await store.getItem(SEED_KEY), "not-a-seed", "the existing entry is left as it was");
});

test("a key is created only when the Keychain answers none, then loaded, never replaced", async () => {
  const { ExpoSecureStoreKeyStore, loadOrCreateDeviceIdentity } = await import("../../src/native/custody");
  const { mod, calls, written } = fakeSecureStore(async () => null);
  const store = new ExpoSecureStoreKeyStore(async () => mod);
  const first = await loadOrCreateDeviceIdentity(store, "mobile-device");
  assert.ok(first.ok);
  assert.equal(first.created, true);
  assert.equal(first.identity.source, "keychain");
  assert.equal(calls.set, 1);
  assert.match(written.get(SEED_KEY)!, /^[0-9a-f]{64}$/);
  const second = await loadOrCreateDeviceIdentity(store, "mobile-device");
  assert.ok(second.ok);
  assert.equal(second.created, false);
  assert.equal(second.identity.publicKeyBase64, first.identity.publicKeyBase64);
  assert.equal(calls.set, 1, "the existing key is not written again");
});

test("a key that cannot be saved, or does not read back, is unavailable, not a RAM-only key", async () => {
  const { ExpoSecureStoreKeyStore, loadOrCreateDeviceIdentity } = await import("../../src/native/custody");
  const failingWrite = fakeSecureStore(async () => null, () => Promise.reject(new Error("errSecNotAvailable")));
  assert.deepEqual(await loadOrCreateDeviceIdentity(new ExpoSecureStoreKeyStore(async () => failingWrite.mod), "mobile-device"), {
    ok: false,
    reason: "key_unavailable",
  });
  // A write that "succeeds" but reads back as something else (another writer, or a store that drops it).
  let reads = 0;
  const lossy = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
    getItemAsync: async () => (reads++ === 0 ? null : null),
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
  };
  assert.deepEqual(await loadOrCreateDeviceIdentity(new ExpoSecureStoreKeyStore(async () => lossy), "mobile-device"), {
    ok: false,
    reason: "key_unavailable",
  });
});

test("the release path shows the key_unavailable line, not a native error", () => {
  const source = readFileSync(join(ROOT, "src/composition.tsx"), "utf8");
  assert.match(source, /identityMismatchCopy\.key_unavailable/, "composition maps unavailable custody to 04's line");
});
