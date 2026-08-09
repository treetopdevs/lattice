/** Encode raw bytes as standard base64, independent of DOM lib typings. */
export function bytesBase64(bytes: Uint8Array): string {
  const btoaFn = (
    globalThis as unknown as { btoa?: (decoded: string) => string }
  ).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  );
}
