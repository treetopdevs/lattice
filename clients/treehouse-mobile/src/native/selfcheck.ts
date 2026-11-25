import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./custody";
import { emptySnapshot, ExpoSqliteStorage, type MobileStorage } from "./storage";

/** Dev-only probe of the three native facilities M0 never executed. Reports; never repairs. */

export interface SelfCheckDeps {
  secureStore: {
    /** Options mirror ExpoSecureStoreKeyStore.setItem so the probe exercises the real accessibility class. */
    setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
    WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number;
    getItemAsync(key: string): Promise<string | null>;
    deleteItemAsync(key: string): Promise<void>;
  };
  storage: MobileStorage & {
    backend(): "sqlite" | "memory";
    ready?(): Promise<unknown>;
    lastError?(): string | undefined;
  };
}

export interface SelfCheck {
  ok: boolean;
  custody: { ok: boolean; detail: string };
  storage: { ok: boolean; backend: "sqlite" | "memory"; detail: string };
  crypto: { ok: boolean; detail: string };
}

const THROWAWAY_KEY = "treehouse_selfcheck_throwaway_v1";
const NAMESPACE = "treehouse_selfcheck";

// Public known answers: SHA-256("abc") (FIPS 180-2) and RFC 8032 section 7.1 test 1 (empty message).
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const RFC8032_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC8032_SIG =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function checkCustody(d: SelfCheckDeps["secureStore"]): Promise<SelfCheck["custody"]> {
  try {
    const seed = new Uint8Array(32);
    globalThis.crypto.getRandomValues(seed);
    const hex = bytesToHex(seed);
    await d.setItemAsync(
      THROWAWAY_KEY,
      hex,
      d.WHEN_UNLOCKED_THIS_DEVICE_ONLY === undefined
        ? undefined
        : { keychainAccessible: d.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    const back = await d.getItemAsync(THROWAWAY_KEY);
    if (back !== hex) {
      await d.deleteItemAsync(THROWAWAY_KEY).catch(() => undefined);
      return { ok: false, detail: "read-back differs from written value" };
    }
    const sk = hexToBytes(back);
    const probe = new TextEncoder().encode("selfcheck");
    const ok = ed25519.verify(ed25519.sign(probe, sk), probe, ed25519.getPublicKey(sk));
    await d.deleteItemAsync(THROWAWAY_KEY);
    const gone = (await d.getItemAsync(THROWAWAY_KEY)) === null;
    if (!ok) return { ok: false, detail: "sign/verify failed" };
    if (!gone) return { ok: false, detail: "delete did not remove the key" };
    return { ok: true, detail: "create, read back, sign, verify, delete" };
  } catch (e) {
    // Never leave the throwaway seed behind on a failure path.
    await d.deleteItemAsync(THROWAWAY_KEY).catch(() => undefined);
    return { ok: false, detail: msg(e) };
  }
}

async function checkStorage(s: SelfCheckDeps["storage"]): Promise<SelfCheck["storage"]> {
  try {
    await s.ready?.();
    const snap = emptySnapshot(NAMESPACE);
    snap.profiles["selfcheck"] = { frames: [], outbox: [], acked: ["a"] };
    await s.save(snap);
    const back = await s.load(NAMESPACE);
    await s.clear(NAMESPACE);
    const backend = s.backend();
    const same = JSON.stringify(back) === JSON.stringify(snap);
    if (!same) return { ok: false, backend, detail: "read-back differs from written snapshot" };
    if (backend !== "sqlite") return { ok: false, backend, detail: `memory fallback answered${s.lastError?.() ? `: ${s.lastError?.()}` : ""}` };
    return { ok: true, backend, detail: "snapshot round-trip on sqlite" };
  } catch (e) {
    return { ok: false, backend: s.backend(), detail: msg(e) };
  }
}

function checkCrypto(): SelfCheck["crypto"] {
  try {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      return { ok: false, detail: "crypto.getRandomValues unavailable" };
    }
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(a);
    globalThis.crypto.getRandomValues(b);
    if (bytesToHex(a) === bytesToHex(b)) return { ok: false, detail: "getRandomValues repeated" };
    if (bytesToHex(sha256(new TextEncoder().encode("abc"))) !== SHA256_ABC) {
      return { ok: false, detail: "sha-256 known answer mismatch" };
    }
    const sk = hexToBytes(RFC8032_SEED);
    if (bytesToHex(ed25519.getPublicKey(sk)) !== RFC8032_PUB) {
      return { ok: false, detail: "ed25519 public key mismatch" };
    }
    const sig = ed25519.sign(new Uint8Array(0), sk);
    if (bytesToHex(sig) !== RFC8032_SIG) return { ok: false, detail: "ed25519 signature mismatch" };
    return { ok: true, detail: "getRandomValues, sha-256, ed25519 known answers" };
  } catch (e) {
    return { ok: false, detail: msg(e) };
  }
}

// One shared storage handle for the app's lifetime, so repeated runs do not leak SQLite connections.
let sharedStorage: ExpoSqliteStorage | null = null;
let inFlight: Promise<SelfCheck> | null = null;

export async function runSelfCheck(deps?: SelfCheckDeps): Promise<SelfCheck> {
  if (deps) return runWith(deps);
  // A second call while one is running returns the same run (no shared-key races).
  inFlight ??= runDefault().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runDefault(): Promise<SelfCheck> {
  sharedStorage ??= new ExpoSqliteStorage();
  const storage = sharedStorage;
  let custody: SelfCheck["custody"];
  try {
    const secureStore = await import("expo-secure-store");
    return runWith({ secureStore, storage });
  } catch (e) {
    custody = { ok: false, detail: `expo-secure-store unavailable: ${msg(e)}` };
  }
  const st = await checkStorage(storage);
  const crypto = checkCrypto();
  return { ok: false, custody, storage: st, crypto };
}

async function runWith(d: SelfCheckDeps): Promise<SelfCheck> {
  const custody = await checkCustody(d.secureStore);
  const storage = await checkStorage(d.storage);
  const crypto = checkCrypto();
  return { ok: custody.ok && storage.ok && crypto.ok, custody, storage, crypto };
}
