# Plan 024: TS received-op verification for W1 carrier frames (D2)

## Status

DONE.

## Objective

Advance Phase D2 without overclaiming semantic client authoring: TypeScript must verify a
received carrier op locally by checking both:

- the `lattice-cbor-v1` canonical bytes hash to the declared op id; and
- the declared author's Ed25519 signature verifies over those same canonical bytes.

## Scope

- Reuse the carrier-frame canonical encoder from plan 023.
- Add `verifyCarrierOp(frame, verifier)` so shells can plug in their key-custody/WebCrypto/
  native verifier while the framework-neutral library owns the canonical bytes and result shape.
- Extend `npm run canonical` to verify every W1 carrier op and reject tampered signatures and
  tampered bodies.

## TDD Evidence

1. RED: `test/canonical.ts` imported missing `verifyCarrierOp`; `npm run canonical` failed on
   the missing export.
2. GREEN: `codec.ts` added `verifyCarrierOp` returning `{hash, signature, valid}`.
3. DEBUG: the first tampered-signature case mutated Base64 padding and decoded to the same
   signature bytes; the test was corrected to mutate decoded bytes before re-encoding.
4. GREEN: `npm run canonical` passed, including valid W1 signatures plus tampered signature/body
   rejection.

## Verification

- `npm run typecheck`
- `npm run conformance`
- `npm run canonical`
- `npm run carrier:township`
- `npm run carrier:township:live`

## Remaining Work

- Build semantic client-side op authoring: construct the exact Lattice body/cap term from a
  user command, compute the op id, sign canonical bytes through shell/key custody, and produce
  a carrier frame accepted by the BEAM `Lattice.Log.accept/2` path.
- Extend beyond the W1 corpus when broader authoring scenarios land.
