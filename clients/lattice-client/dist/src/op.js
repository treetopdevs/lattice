// The neutral op representation used by the reducer (Tier A: semantics).
//
// This is deliberately encoding-independent. Byte-identical canonical encoding
// and hashing live in codec.ts (Tier B), which is gated on the CBOR migration
// (ADR-P08). The reducer here can be conformance-tested against `Lattice.Sim`
// today, using op ids as opaque handles, without CBOR existing yet.
/** Compare two opaque ordering keys. Returns >0 if a>b. */
export function cmpHash(a, b) {
    return a > b ? 1 : a < b ? -1 : 0;
}
