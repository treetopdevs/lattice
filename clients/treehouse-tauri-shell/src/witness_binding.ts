/** Public claim encoding only. This API cannot create a native signing request. */
export function canonicalBytesForWitnessBinding(_input: unknown): Uint8Array {
  return new Uint8Array();
}
