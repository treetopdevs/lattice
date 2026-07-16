# Plan 023: TS canonical op parity for carrier-frame ops (D1)

## Status

DONE.

## Objective

Prove the first Phase D runtime-boundary gate without widening the authoring surface:
TypeScript must reproduce the BEAM `Lattice.Op.canonical_encoding/1` bytes and base64url
SHA-256 ids for the Township W1 carrier-frame corpus exported from `Lattice.Sim`.

This is the D1 parity slice. Plan 024 adds local Ed25519 verification; semantic
client-side op authoring remains separate.

## Scope

- Add Sim-exported canonical op metadata to `township_carrier_w1.json`.
- Implement the TS `lattice-cbor-v1` encoder for carrier wire terms:
  nil/booleans/uint64/binaries/atoms/lists/tuples/maps/mapsets/delegations.
- Add a TS parity harness and CI script.
- Keep `UnavailableCodec` for reducer-level semantic `OpCore` authoring until the real
  body/cap construction and signer flow are implemented.

## TDD Evidence

1. RED: `Township.ExportVectorsTest` expected `canonicalOps`; focused ExUnit failed because
   the exported vector had no canonical metadata.
2. GREEN: `lattice.export_vectors` now emits `canonicalOps` from
   `Lattice.Op.canonical_encoding/1` and `Op.recompute_id/1`; focused ExUnit passed.
3. RED: `test/canonical.ts` imported missing `canonicalBytesForCarrierOp` and
   `canonicalHash`; `npx tsx test/canonical.ts` failed on the missing export.
4. GREEN: `codec.ts` implemented the dependency-free `lattice-cbor-v1` carrier-frame encoder;
   `npm run canonical` passed against every W1 carrier op.
5. RED/GREEN: the CI assertion required `npm run canonical`; it failed before workflow wiring
   and passed after adding the package script and workflow step.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `npm run typecheck`
- `npm run conformance`
- `npm run canonical`
- `npm run carrier:township`
- `npm run carrier:township:live`

## Remaining Work

- Build semantic client-side op authoring: construct the exact Lattice body/cap term from a
  user command, compute the op id, sign canonical bytes through the shell/key-custody signer,
  and produce a BEAM-accepted carrier frame.
- Build semantic client-side op authoring and signing for new carrier ops.
- Extend parity beyond the W1 carrier corpus when broader authoring scenarios land.
