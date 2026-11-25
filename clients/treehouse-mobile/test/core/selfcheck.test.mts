import assert from "node:assert/strict";
import { test } from "node:test";
import { ExpoSqliteStorage } from "../../src/native/storage";
import { runSelfCheck, type SelfCheckDeps } from "../../src/native/selfcheck";

function memorySecure(): SelfCheckDeps["secureStore"] {
  const m = new Map<string, string>();
  return {
    async setItemAsync(k, v) {
      m.set(k, v);
    },
    async getItemAsync(k) {
      return m.get(k) ?? null;
    },
    async deleteItemAsync(k) {
      m.delete(k);
    },
  };
}

function memoryStorage(backend: "sqlite" | "memory"): SelfCheckDeps["storage"] {
  const m = new Map<string, unknown>();
  return {
    async load(ns) {
      return (m.get(ns) as never) ?? { version: 1, namespace: ns, profiles: {} };
    },
    async save(s) {
      m.set(s.namespace, structuredClone(s));
    },
    async clear(ns) {
      m.delete(ns);
    },
    backend: () => backend,
  };
}

test("self-check passes custody, storage and crypto when sqlite answers", async () => {
  const r = await runSelfCheck({ secureStore: memorySecure(), storage: memoryStorage("sqlite") });
  assert.equal(r.custody.ok, true);
  assert.equal(r.storage.ok, true);
  assert.equal(r.storage.backend, "sqlite");
  assert.equal(r.crypto.ok, true);
  assert.equal(r.ok, true);
});

test("self-check fails storage when the memory fallback answered", async () => {
  const r = await runSelfCheck({ secureStore: memorySecure(), storage: memoryStorage("memory") });
  assert.equal(r.storage.backend, "memory");
  assert.equal(r.storage.ok, false);
  assert.equal(r.ok, false);
});

test("self-check fails custody when the read-back is wrong, and leaks no key material", async () => {
  const bad = memorySecure();
  bad.getItemAsync = async () => "00";
  const r = await runSelfCheck({ secureStore: bad, storage: memoryStorage("sqlite") });
  assert.equal(r.custody.ok, false);
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /[0-9a-f]{64}/);
});

test("ExpoSqliteStorage reports memory and a reason when expo-sqlite cannot open (Node)", async () => {
  const s = new ExpoSqliteStorage();
  assert.equal(s.backend(), "memory");
  assert.equal(await s.ready(), "memory");
  assert.equal(typeof s.lastError(), "string");
});

test("self-check removes the throwaway key when custody throws after the write", async () => {
  const sec = memorySecure();
  const deleted: string[] = [];
  const del = sec.deleteItemAsync;
  sec.deleteItemAsync = async (k) => {
    deleted.push(k);
    return del(k);
  };
  sec.getItemAsync = async () => {
    throw new Error("keychain locked");
  };
  const r = await runSelfCheck({ secureStore: sec, storage: memoryStorage("sqlite") });
  assert.equal(r.custody.ok, false);
  assert.equal(deleted.length, 1);
});

test("self-check crypto fails when crypto.subtle.digest is missing (Hermes has no WebCrypto)", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle");
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  try {
    const r = await runSelfCheck({ secureStore: memorySecure(), storage: memoryStorage("sqlite") });
    assert.equal(r.crypto.ok, false);
    assert.match(r.crypto.detail, /subtle/);
  } finally {
    delete (globalThis.crypto as { subtle?: unknown }).subtle;
    if (desc && !("subtle" in globalThis.crypto)) Object.defineProperty(globalThis.crypto, "subtle", desc);
  }
});

test("polyfilled crypto.subtle.digest returns the SHA-256 known answer and refuses other algorithms", async () => {
  const realSubtle = globalThis.crypto.subtle;
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  try {
    await import("../../src/polyfills_crypto");
    const subtle = globalThis.crypto.subtle;
    assert.notEqual(subtle, realSubtle);
    const out = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode("abc")));
    assert.equal(
      Buffer.from(out).toString("hex"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await assert.rejects(subtle.digest("SHA-1", new Uint8Array(0)), /unsupported/);
  } finally {
    delete (globalThis.crypto as { subtle?: unknown }).subtle;
    if (globalThis.crypto.subtle !== realSubtle) {
      Object.defineProperty(globalThis.crypto, "subtle", { value: realSubtle, configurable: true });
    }
  }
});
