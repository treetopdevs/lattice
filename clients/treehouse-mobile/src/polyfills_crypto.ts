import { sha256 } from "@noble/hashes/sha2.js";

// Hermes has no WebCrypto. lattice-client's canonicalHash (op ids, codec.ts) only needs SHA-256 digest,
// so supply exactly that from @noble/hashes when crypto.subtle is missing; other algorithms still fail.
const webCrypto = globalThis.crypto as { subtle?: unknown } | undefined;
if (webCrypto && !webCrypto.subtle) {
  const digest = async (
    algorithm: string | { name: string },
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<ArrayBuffer> => {
    const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
    if (String(name).toUpperCase() !== "SHA-256") {
      throw new Error(`crypto.subtle.digest: unsupported algorithm ${String(name)}`);
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = sha256(bytes);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  Object.defineProperty(webCrypto, "subtle", { value: { digest }, configurable: true, enumerable: true });
}

export {};
