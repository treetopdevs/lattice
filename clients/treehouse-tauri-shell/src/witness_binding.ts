import { canonicalBase64Bytes, canonicalBytesForCarrierTerm, type CarrierTerm } from "@treetopdevs/lattice-client";

const binaryFields = ["enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey",
  "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest"] as const;
const encoder = new TextEncoder();

/** Public claim encoding only. This API cannot create a native signing request.
 * All input fields are proposed public facts; encoding them is not native review.
 */
export function canonicalBytesForWitnessBinding(input: unknown): Uint8Array {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid_binding_claim");
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 9 || !keys.every(k => k === "replica" || (binaryFields as readonly string[]).includes(k)))
    throw new TypeError("invalid_binding_claim");
  if (typeof value.replica !== "string" || value.replica.length > 512) throw new TypeError("invalid_binding_replica");
  const replica = encoder.encode(value.replica);
  if (replica.length === 0 || replica.length > 512 ||
    new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(replica) !== value.replica)
    throw new TypeError("invalid_binding_replica");
  const bin = (bytes: Uint8Array): CarrierTerm => ["bin", toBase64(bytes)];
  const fixed = (value: string) => bin(encoder.encode(value));
  return canonicalBytesForCarrierTerm(["list", [
    fixed("lattice-witness-binding-challenge-v1"), ["int", 1],
    fixed("treehouse"), fixed("dev.treetop.lattice.treehouse"), bin(replica),
    ...binaryFields.map(field => {
      if (typeof value[field] !== "string" || value[field].length !== 44)
        throw new TypeError("invalid_binding_field");
      const bytes = canonicalBase64Bytes(value[field], 32);
      if (bytes === null) throw new TypeError("invalid_binding_field");
      return bin(bytes);
    }),
  ]]);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}
