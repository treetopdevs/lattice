import type { CarrierSigner } from "./carrier";
import { canonicalBase64Bytes } from "./codec";
import type { LocalKeyValueStore } from "./local_log";

export type TauriInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface TauriKeyValueStoreOptions {
  namespace?: string;
  getCommand?: string;
  setCommand?: string;
}

export interface TauriCarrierSignerOptions {
  keyId: string;
  publicKey: string | Uint8Array;
  signCommand?: string;
}

export interface TauriNativeCarrierSignerOptions {
  keyId: string;
  publicKeyCommand?: string;
  signCommand?: string;
}

export function createTauriKeyValueStore(
  invoke: TauriInvoke,
  opts: TauriKeyValueStoreOptions = {},
): LocalKeyValueStore {
  const getCommand = opts.getCommand ?? "lattice_kv_get";
  const setCommand = opts.setCommand ?? "lattice_kv_set";

  return {
    getItem(key: string): Promise<string | null> {
      return invoke<string | null>(getCommand, { key: storageKey(opts.namespace, key) });
    },

    async setItem(key: string, value: string): Promise<void> {
      await invoke(setCommand, { key: storageKey(opts.namespace, key), value });
    },
  };
}

export function createTauriCarrierSigner(
  invoke: TauriInvoke,
  opts: TauriCarrierSignerOptions,
): CarrierSigner {
  const signCommand = opts.signCommand ?? "lattice_sign_carrier";
  const publicKey = typeof opts.publicKey === "string"
    ? canonicalBase64Bytes(opts.publicKey, 32)
    : opts.publicKey;
  if (publicKey === null || publicKey.length !== 32) {
    throw new Error("invalid canonical Ed25519 public key");
  }

  return {
    publicKey,

    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const signature = await invoke<string>(signCommand, {
        keyId: opts.keyId,
        bytes: bytesToBase64(bytes),
      });
      if (typeof signature !== "string") throw new Error(`${signCommand} returned a non-string signature`);
      const decoded = canonicalBase64Bytes(signature, 64);
      if (decoded === null) throw new Error("invalid canonical Ed25519 signature");
      return decoded;
    },
  };
}

export async function createTauriNativeCarrierSigner(
  invoke: TauriInvoke,
  opts: TauriNativeCarrierSignerOptions,
): Promise<CarrierSigner> {
  const publicKeyCommand = opts.publicKeyCommand ?? "lattice_ensure_carrier_key";
  const publicKey = await invoke<string>(publicKeyCommand, { keyId: opts.keyId });
  if (typeof publicKey !== "string") throw new Error(`${publicKeyCommand} returned a non-string public key`);

  const signerOpts: TauriCarrierSignerOptions = {
    keyId: opts.keyId,
    publicKey,
  };
  if (opts.signCommand !== undefined) signerOpts.signCommand = opts.signCommand;

  return createTauriCarrierSigner(invoke, signerOpts);
}

function storageKey(namespace: string | undefined, key: string): string {
  return namespace === undefined || namespace === "" ? key : `${namespace}:${key}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...bytes));
}
