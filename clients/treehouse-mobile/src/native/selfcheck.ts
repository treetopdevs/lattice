import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./custody";

/** Dev-only probe of the three native facilities M0 never executed. Reports; never repairs. */

export interface SelfCheckDeps {
  secureStore: {
    /** Options mirror ExpoSecureStoreKeyStore.setItem so the probe exercises the real accessibility class. */
    setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
    WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number;
    getItemAsync(key: string): Promise<string | null>;
    deleteItemAsync(key: string): Promise<void>;
  };
  /** Opens a SQLite database by name (expo-sqlite on the phone). There is no memory fallback. */
  storage: { openDb(name: string): Promise<ProbeDb> };
}

type SqlParam = string | number | null;

/** The part of expo-sqlite's SQLiteDatabase the probe uses. */
export interface ProbeDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: SqlParam[]): Promise<unknown>;
  getAllAsync<T>(source: string, ...params: SqlParam[]): Promise<T[]>;
}

export interface SelfCheck {
  ok: boolean;
  custody: { ok: boolean; detail: string };
  storage: { ok: boolean; backend: "sqlite" | "none"; detail: string };
  crypto: { ok: boolean; detail: string };
}

const THROWAWAY_KEY = "treehouse_selfcheck_throwaway_v1";
/** Its own throwaway file: never an identity replica store, the local store or the M0 snapshot file. */
const PROBE_DB = "treehouse_selfcheck_v1.db";

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
  let db: ProbeDb;
  try {
    db = await s.openDb(PROBE_DB);
  } catch (e) {
    return { ok: false, backend: "none", detail: msg(e) };
  }
  try {
    await db.execAsync("CREATE TABLE IF NOT EXISTS probe (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);");
    const value = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
    await db.runAsync("INSERT INTO probe (key, value) VALUES ('probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", value);
    const back = await db.getAllAsync<{ value: string }>("SELECT value FROM probe WHERE key = 'probe'");
    await db.runAsync("DELETE FROM probe WHERE key = 'probe'");
    if (back.length !== 1 || back[0]!.value !== value) return { ok: false, backend: "sqlite", detail: "read-back differs from written row" };
    return { ok: true, backend: "sqlite", detail: "row round-trip on sqlite" };
  } catch (e) {
    return { ok: false, backend: "sqlite", detail: msg(e) };
  }
}

async function checkCrypto(): Promise<SelfCheck["crypto"]> {
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
    // lattice-client hashes op ids through WebCrypto, so the probe must exercise that path too.
    const subtle = globalThis.crypto.subtle as SubtleCrypto | undefined;
    if (typeof subtle?.digest !== "function") return { ok: false, detail: "crypto.subtle.digest unavailable" };
    const viaSubtle = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode("abc")));
    if (bytesToHex(viaSubtle) !== SHA256_ABC) return { ok: false, detail: "crypto.subtle sha-256 known answer mismatch" };
    const sk = hexToBytes(RFC8032_SEED);
    if (bytesToHex(ed25519.getPublicKey(sk)) !== RFC8032_PUB) {
      return { ok: false, detail: "ed25519 public key mismatch" };
    }
    const sig = ed25519.sign(new Uint8Array(0), sk);
    if (bytesToHex(sig) !== RFC8032_SIG) return { ok: false, detail: "ed25519 signature mismatch" };
    return { ok: true, detail: "getRandomValues, sha-256, subtle sha-256, ed25519 known answers" };
  } catch (e) {
    return { ok: false, detail: msg(e) };
  }
}

// One shared probe handle for the app's lifetime, so repeated runs do not leak SQLite connections.
let sharedProbe: Promise<ProbeDb> | null = null;
let inFlight: Promise<SelfCheck> | null = null;

const expoStorage: SelfCheckDeps["storage"] = {
  openDb(name) {
    sharedProbe ??= (async () => {
      const { openDatabaseAsync } = await import("expo-sqlite");
      const handle: ProbeDb = await openDatabaseAsync(name);
      return handle;
    })().catch((e: unknown) => {
      sharedProbe = null;
      throw e;
    });
    return sharedProbe;
  },
};

export async function runSelfCheck(deps?: SelfCheckDeps): Promise<SelfCheck> {
  if (deps) return runWith(deps);
  // A second call while one is running returns the same run (no shared-key races).
  inFlight ??= runDefault().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runDefault(): Promise<SelfCheck> {
  const storage = expoStorage;
  let custody: SelfCheck["custody"];
  try {
    const secureStore = await import("expo-secure-store");
    return runWith({ secureStore, storage });
  } catch (e) {
    custody = { ok: false, detail: `expo-secure-store unavailable: ${msg(e)}` };
  }
  const st = await checkStorage(storage);
  const crypto = await checkCrypto();
  return { ok: false, custody, storage: st, crypto };
}

async function runWith(d: SelfCheckDeps): Promise<SelfCheck> {
  const custody = await checkCustody(d.secureStore);
  const storage = await checkStorage(d.storage);
  const crypto = await checkCrypto();
  return { ok: custody.ok && storage.ok && crypto.ok, custody, storage, crypto };
}
