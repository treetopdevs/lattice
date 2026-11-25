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

/**
 * Hardware-backed device keystore via `expo-secure-store`
 * (iOS Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, Android Keystore).
 * Falls back to `MemoryKeyStore` when running outside React Native (e.g. Node tests).
 */
export class ExpoSecureStoreKeyStore implements KeyStore {
  private readonly fallback = new MemoryKeyStore();
  private secureStorePromise: Promise<typeof import("expo-secure-store") | null> | null = null;

  private async loadModule(): Promise<typeof import("expo-secure-store") | null> {
    if (this.secureStorePromise) return this.secureStorePromise;
    this.secureStorePromise = (async () => {
      try {
        const mod = await import("expo-secure-store");
        if (typeof mod.getItemAsync === "function" && typeof mod.setItemAsync === "function") {
          return mod;
        }
        return null;
      } catch {
        return null;
      }
    })();
    return this.secureStorePromise;
  }

  async getItem(key: string): Promise<string | null> {
    const mod = await this.loadModule();
    if (!mod) return this.fallback.getItem(key);
    try {
      return await mod.getItemAsync(key);
    } catch {
      return this.fallback.getItem(key);
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const mod = await this.loadModule();
    if (!mod) {
      await this.fallback.setItem(key, value);
      return;
    }
    try {
      await mod.setItemAsync(key, value, {
        keychainAccessible: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      await this.fallback.setItem(key, value);
    }
  }

  async deleteItem(key: string): Promise<void> {
    const mod = await this.loadModule();
    if (!mod) {
      await this.fallback.deleteItem(key);
      return;
    }
    try {
      await mod.deleteItemAsync(key);
    } catch {
      await this.fallback.deleteItem(key);
    }
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

export async function loadOrCreateDeviceIdentity(
  keyStore: KeyStore,
  realm = "mobile-device",
): Promise<MobileIdentity> {
  let seedHex = await keyStore.getItem(DEVICE_SEED_KEY);
  if (!seedHex || !/^[0-9a-f]{64}$/i.test(seedHex)) {
    const seed = new Uint8Array(32);
    if (
      typeof globalThis.crypto === "undefined" ||
      typeof globalThis.crypto.getRandomValues !== "function"
    ) {
      throw new Error("crypto_getRandomValues_unavailable");
    }
    globalThis.crypto.getRandomValues(seed);
    seedHex = bytesToHex(seed);
    await keyStore.setItem(DEVICE_SEED_KEY, seedHex);
  }
  return createIdentityFromSeedHex(realm, seedHex, "keychain");
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
