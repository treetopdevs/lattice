// The neutral op representation used by the reducer (Tier A: semantics).
//
// This is deliberately encoding-independent. Byte-identical canonical encoding
// and hashing live in codec.ts (Tier B), which is gated on the CBOR migration
// (ADR-P08). The reducer here can be conformance-tested against `Lattice.Sim`
// today, using op ids as opaque handles, without CBOR existing yet.
/** One semantic effect for old input, complete ordered effects for new commands. */
export function effectsFor(op) {
    return op.effects ?? [{ field: op.field, mutation: op.mutation, value: op.value }];
}
/** Internal reduction views retain their original signed ID and DAG edges. */
export function effectViews(op) {
    return effectsFor(op).map((effect, effectIndex) => ({ ...op, ...effect, effectIndex }));
}
export function effectElementId(op, counts) {
    return counts.get(op.id) === 1 ? op.id : `${op.id}#effect:${String(op.effectIndex ?? 0).padStart(10, "0")}`;
}
/** Compare two opaque ordering keys. Returns >0 if a>b. */
export function cmpHash(a, b) {
    return a > b ? 1 : a < b ? -1 : 0;
}
/** BEAM binary order for product values; opaque legacy ordering stays unchanged. */
export function compareUtf8(a, b) {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index])
            return left[index] - right[index];
    }
    return left.length - right.length;
}
