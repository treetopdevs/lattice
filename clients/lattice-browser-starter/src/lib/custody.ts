import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base64ToBytes,
  verifyEd25519,
  type CarrierOpFrame,
  type CarrierOpSigner,
  type CarrierSigner,
  type CarrierVerifier,
  type Verifier,
} from "@treetopdevs/lattice-client";
import type { HeldProfile } from "@treetopdevs/lattice-shell-kit/sync";

/**
 * Demo-only browser custody (IndexedDB + in-memory fallback).
 *
 * Security / honesty boundary: keys live in browser storage for local interactive
 * demos and interop testing. This is NOT native Keychain / Android Keystore custody.
 */

export interface DemoIdentity {
  realm: string;
  seedHex: string;
  publicKey: Uint8Array;
  publicKeyBase64: string;
  fingerprint: string;
  signer: CarrierOpSigner & CarrierSigner;
}

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

export function createIdentityFromSeedHex(realm: string, seedHex: string): DemoIdentity {
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
    seedHex: bytesToHex(seed),
    publicKey,
    publicKeyBase64,
    fingerprint: pubkeyFingerprint(publicKeyBase64),
    signer,
  };
}

export function generateEphemeralIdentity(realm: string): DemoIdentity {
  const seed = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(seed);
  } else {
    throw new Error("crypto_unavailable");
  }
  return createIdentityFromSeedHex(realm, bytesToHex(seed));
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

export interface PersistedDemoSnapshot {
  version: 1;
  namespace: string;
  profiles: Record<string, HeldProfile>;
}

export interface DemoStorage {
  load(namespace: string): Promise<PersistedDemoSnapshot>;
  save(snapshot: PersistedDemoSnapshot): Promise<void>;
  clear(namespace: string): Promise<void>;
}

export function emptySnapshot(namespace: string): PersistedDemoSnapshot {
  return { version: 1, namespace, profiles: {} };
}

export function cloneProfile(profile: HeldProfile): HeldProfile {
  return {
    frames: profile.frames.map((frame) => structuredClone(frame) as CarrierOpFrame),
    outbox: [...profile.outbox],
    acked: [...profile.acked],
  };
}

export class MemoryDemoStorage implements DemoStorage {
  private readonly store = new Map<string, PersistedDemoSnapshot>();

  async load(namespace: string): Promise<PersistedDemoSnapshot> {
    const existing = this.store.get(namespace);
    if (!existing) return emptySnapshot(namespace);
    const profiles: Record<string, HeldProfile> = {};
    for (const [replica, profile] of Object.entries(existing.profiles)) {
      profiles[replica] = cloneProfile(profile);
    }
    return { version: 1, namespace, profiles };
  }

  async save(snapshot: PersistedDemoSnapshot): Promise<void> {
    const profiles: Record<string, HeldProfile> = {};
    for (const [replica, profile] of Object.entries(snapshot.profiles)) {
      profiles[replica] = cloneProfile(profile);
    }
    this.store.set(snapshot.namespace, {
      version: 1,
      namespace: snapshot.namespace,
      profiles,
    });
  }

  async clear(namespace: string): Promise<void> {
    this.store.delete(namespace);
  }
}

const DB_NAME = "lattice_browser_starter_demo_v1";
const STORE_NAME = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "namespace" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_open_failed"));
  });
}

export class IndexedDbDemoStorage implements DemoStorage {
  private readonly fallback = new MemoryDemoStorage();

  private hasIndexedDb(): boolean {
    return typeof indexedDB !== "undefined";
  }

  async load(namespace: string): Promise<PersistedDemoSnapshot> {
    if (!this.hasIndexedDb()) return this.fallback.load(namespace);
    const db = await openDb();
    try {
      return await new Promise<PersistedDemoSnapshot>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(namespace);
        req.onsuccess = () => {
          const result = req.result as PersistedDemoSnapshot | undefined;
          resolve(result && result.version === 1 ? result : emptySnapshot(namespace));
        };
        req.onerror = () => reject(req.error ?? new Error("indexeddb_read_failed"));
      });
    } finally {
      db.close();
    }
  }

  async save(snapshot: PersistedDemoSnapshot): Promise<void> {
    if (!this.hasIndexedDb()) return this.fallback.save(snapshot);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(snapshot);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexeddb_write_failed"));
      });
    } finally {
      db.close();
    }
  }

  async clear(namespace: string): Promise<void> {
    if (!this.hasIndexedDb()) return this.fallback.clear(namespace);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(namespace);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexeddb_delete_failed"));
      });
    } finally {
      db.close();
    }
  }
}
