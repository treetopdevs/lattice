import { ed25519 } from "@noble/curves/ed25519.js";
import type { CarrierOpSigner } from "@treetopdevs/lattice-client";
import type { KeyCustody } from "../ports";

// In-memory KeyCustody for Core tests. The private key lives only inside the signer closure; nothing
// here returns, logs or serializes it.

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class MemoryKeyCustody implements KeyCustody {
  private signer: CarrierOpSigner | null;
  private available: boolean;

  constructor(signer: CarrierOpSigner | null = null) {
    this.signer = signer;
    this.available = true;
  }

  /** A custody already holding `signer` (a test identity). */
  static holding(signer: CarrierOpSigner): MemoryKeyCustody {
    return new MemoryKeyCustody(signer);
  }

  /** Simulate a locked or missing keystore: status `unavailable`, every signature refused. */
  setUnavailable(unavailable: boolean): void {
    this.available = !unavailable;
  }

  async status(): Promise<"none" | "available" | "unavailable"> {
    if (!this.available) return "unavailable";
    return this.signer ? "available" : "none";
  }

  async publicKey(): Promise<string | null> {
    return this.available && this.signer ? toBase64(this.signer.publicKey) : null;
  }

  async create(): Promise<string> {
    if (!this.available) throw new Error("identity_unavailable");
    if (this.signer) throw new Error("key_exists");
    const seed = new Uint8Array(32);
    globalThis.crypto.getRandomValues(seed);
    const publicKey = ed25519.getPublicKey(seed);
    this.signer = { publicKey, sign: (bytes) => ed25519.sign(bytes, seed) };
    return toBase64(publicKey);
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.available || !this.signer) throw new Error("identity_unavailable");
    return this.signer.sign(bytes);
  }
}
