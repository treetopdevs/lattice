import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base64ToBytes,
  verifyEd25519,
  type CarrierOpSigner,
  type CarrierSigner,
  type CarrierVerifier,
  type Verifier,
} from "@treetopdevs/lattice-client";

export interface KeyStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export class MemoryKeyStore implements KeyStore {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** The part of `expo-secure-store` (SDK 58) this store uses. */
export interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
}

/**
 * Hardware-backed device keystore via `expo-secure-store` (iOS Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`,
 * Android Keystore). No fallback (closing review, both reviewers): a module that cannot load, or a read or
 * write that rejects (SDK 58 docs: getItemAsync "rejects if an error occurs while retrieving the value"; on
 * iOS a locked Keychain is errSecInteractionNotAllowed), rejects here too. `getItemAsync` resolves null only
 * when there is no entry (iOS: errSecItemNotFound). Node tests use `MemoryKeyStore` or inject the module.
 */
export class ExpoSecureStoreKeyStore implements KeyStore {
  private module: Promise<SecureStoreModule> | null = null;

  constructor(private readonly load: () => Promise<SecureStoreModule> = () => import("expo-secure-store")) {}

  private secureStore(): Promise<SecureStoreModule> {
    // A failed load is not cached, so a later launch step can try again.
    this.module ??= this.load().catch((error: unknown) => {
      this.module = null;
      throw error;
    });
    return this.module;
  }

  async getItem(key: string): Promise<string | null> {
    return (await this.secureStore()).getItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    const mod = await this.secureStore();
    await mod.setItemAsync(key, value, { keychainAccessible: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }

  async deleteItem(key: string): Promise<void> {
    await (await this.secureStore()).deleteItemAsync(key);
  }
}

export interface MobileIdentity {
  realm: string;
  publicKey: Uint8Array;
  publicKeyBase64: string;
  fingerprint: string;
  color: string;
  source: "keychain" | "demo-seed";
  signer: CarrierOpSigner & CarrierSigner;
}

const AVATAR_PALETTE = [
  "#2F855A",
  "#2B6CB0",
  "#975A16",
  "#9B2C2C",
  "#553C9A",
  "#285E61",
  "#B83280",
  "#4A5568",
] as const;

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("invalid_seed_hex: expected 64 hex characters (32 bytes)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function pubkeyFingerprint(pubkeyBase64: string): string {
  const clean = pubkeyBase64.replace(/[^A-Za-z0-9]/g, "");
  return clean.slice(0, 10);
}

export function pubkeyColor(pubkeyBase64: string): string {
  let hash = 0;
  for (let i = 0; i < pubkeyBase64.length; i++) {
    hash = (hash * 31 + pubkeyBase64.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!;
}

export function createIdentityFromSeedHex(
  realm: string,
  seedHex: string,
  source: "keychain" | "demo-seed" = "demo-seed",
): MobileIdentity {
  const seed = hexToBytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  const publicKeyBase64 = bytesToBase64(publicKey);
  const signer: CarrierOpSigner & CarrierSigner = {
    publicKey,
    sign(bytes: Uint8Array): Uint8Array {
      return ed25519.sign(bytes, seed);
    },
  };
  return {
    realm,
    publicKey,
    publicKeyBase64,
    fingerprint: pubkeyFingerprint(publicKeyBase64),
    color: pubkeyColor(publicKeyBase64),
    source,
    signer,
  };
}

const DEVICE_SEED_KEY = "treehouse_mobile_device_ed25519_seed_v1";

/** The device key, or custody "unavailable" (03 KeyCustody; never "none" when the Keychain did not answer). */
export type DeviceIdentityOutcome = { ok: true; identity: MobileIdentity; created: boolean } | { ok: false; reason: "key_unavailable" };

const SEED_HEX = /^[0-9a-f]{64}$/i;
const UNAVAILABLE = { ok: false, reason: "key_unavailable" } as const;

/**
 * Load this phone's key, or create one only when the Keychain positively answers that none exists (07 STOP 5:
 * a key is never regenerated to recover from an error). A read that fails, a stored value that is not a seed
 * (left as it is, never overwritten), a write that fails and a write that does not read back are all
 * `key_unavailable`; no key that exists only in memory is ever returned.
 */
export async function loadOrCreateDeviceIdentity(keyStore: KeyStore, realm = "mobile-device"): Promise<DeviceIdentityOutcome> {
  let stored: string | null;
  try {
    stored = await keyStore.getItem(DEVICE_SEED_KEY);
  } catch {
    return UNAVAILABLE;
  }
  if (stored !== null) return SEED_HEX.test(stored) ? { ok: true, identity: createIdentityFromSeedHex(realm, stored, "keychain"), created: false } : UNAVAILABLE;
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("crypto_getRandomValues_unavailable");
  }
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  const seedHex = bytesToHex(seed);
  try {
    await keyStore.setItem(DEVICE_SEED_KEY, seedHex);
    // Use the key only once it reads back from the Keychain.
    if ((await keyStore.getItem(DEVICE_SEED_KEY)) !== seedHex) return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
  return { ok: true, identity: createIdentityFromSeedHex(realm, seedHex, "keychain"), created: true };
}

export const strictCarrierVerifier: CarrierVerifier = {
  verify(pubkey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): boolean {
    return verifyEd25519(signature, bytes, pubkey);
  },
};

export const strictOpVerifier: Verifier = {
  async verify(author: string, canonicalBytes: Uint8Array, sig: Uint8Array): Promise<boolean> {
    try {
      const pubkey = base64ToBytes(author);
      return verifyEd25519(sig, canonicalBytes, pubkey);
    } catch {
      return false;
    }
  },
};
