import {
  connectCarrierWebSocket,
  type CarrierVerifier,
  type CarrierWebSocketClient,
  type ConnectCarrierWebSocketOptions,
} from "@treetopdevs/lattice-client";
import type { TownshipNativeWorkflow } from "./native_workflow";
import { TOWNSHIP_REPLICA } from "./township_actions";

export interface TownshipCarrierPeerConfig {
  url: string;
  localRealm: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
  replica: string;
  keyId?: string;
}

export interface TownshipCarrierPeerEnv {
  VITE_TOWNSHIP_CARRIER_URL?: string;
  VITE_TOWNSHIP_LOCAL_REALM?: string;
  VITE_TOWNSHIP_PEER_REALM?: string;
  VITE_TOWNSHIP_PEER_PUBKEY?: string;
  VITE_TOWNSHIP_REPLICA?: string;
  VITE_TOWNSHIP_CARRIER_KEY_ID?: string;
}

export type TownshipCarrierWebSocket = NonNullable<ConnectCarrierWebSocketOptions["webSocket"]>;

export interface ConnectTownshipCarrierPeerOptions {
  workflow: TownshipNativeWorkflow;
  peer: TownshipCarrierPeerConfig;
  verifier?: CarrierVerifier;
  webSocket?: TownshipCarrierWebSocket;
}

export function townshipCarrierPeerFromEnv(
  env: TownshipCarrierPeerEnv = ((import.meta as ImportMeta & { env?: TownshipCarrierPeerEnv }).env ?? {}),
): TownshipCarrierPeerConfig | null {
  const url = present(env.VITE_TOWNSHIP_CARRIER_URL);
  const localRealm = present(env.VITE_TOWNSHIP_LOCAL_REALM);
  const expectedPeerRealm = present(env.VITE_TOWNSHIP_PEER_REALM);
  const expectedPeerPubkey = present(env.VITE_TOWNSHIP_PEER_PUBKEY);
  if (!url || !localRealm || !expectedPeerRealm || !expectedPeerPubkey) return null;

  const config: TownshipCarrierPeerConfig = {
    url,
    localRealm,
    expectedPeerRealm,
    expectedPeerPubkey,
    replica: present(env.VITE_TOWNSHIP_REPLICA) ?? TOWNSHIP_REPLICA,
  };
  const keyId = present(env.VITE_TOWNSHIP_CARRIER_KEY_ID);
  if (keyId) config.keyId = keyId;
  return config;
}

export async function connectTownshipCarrierPeer(
  options: ConnectTownshipCarrierPeerOptions,
): Promise<CarrierWebSocketClient> {
  const connectOptions: ConnectCarrierWebSocketOptions = {
    url: options.peer.url,
    localRealm: options.peer.localRealm,
    replica: options.peer.replica,
    signer: options.workflow.signer,
    expectedPeerRealm: options.peer.expectedPeerRealm,
    expectedPeerPubkey: base64ToBytes(options.peer.expectedPeerPubkey),
    verifier: options.verifier ?? createWebCryptoCarrierVerifier(),
  };
  if (options.webSocket !== undefined) connectOptions.webSocket = options.webSocket;
  return connectCarrierWebSocket(connectOptions);
}

export function createWebCryptoCarrierVerifier(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): CarrierVerifier {
  return {
    async verify(pubkey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (!subtle) throw new Error("crypto.subtle unavailable");
      const algorithm = "Ed25519" as AlgorithmIdentifier;
      const key = await subtle.importKey("raw", arrayBufferBytes(pubkey), algorithm, false, ["verify"]);
      return subtle.verify(algorithm, key, arrayBufferBytes(signature), arrayBufferBytes(bytes));
    },
  };
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function base64ToBytes(value: string): Uint8Array {
  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
