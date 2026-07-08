# Plan 021: TS carrier W1 vector adapter (C3 progress)

> **Executor instructions**: This plan records the completed C3 adapter slice from
> `TOWNSHIP_BUILD_MAP.md`. Continue to use TDD: write the carrier/vector expectation first,
> regenerate from Sim, then prove the TS carrier path against the generated frames.
>
> **Toolchain**: run BEAM commands locally as `PATH="$HOME/.asdf/shims:$PATH"
> ~/.asdf/shims/mix ...`; the Homebrew/mise Erlang path is not reliable here.

## Status

- **Priority**: P1
- **Effort**: M
- **Category**: client library / carrier sync
- **Build-map phase**: C3
- **Depends on**: plan 020
- **Status**: DONE for the adapter/vector slice; live TS WebSocket process completed in plan 022

## Goal

Move C3 from pure semantic reducer conformance toward the real carrier by exporting a Township
W1 carrier vector with full BEAM carrier op frames, then proving the TS client can authenticate
session bytes, decode those frames into semantic ops, and converge the W1 pull/push merge to
the Sim oracle.

## TDD Trace

- Added red exporter assertions for `township_carrier_w1.json` with client/peer metadata,
  base/diverged carrier frames, oracle frames, and a non-empty authority quarantine.
- Added a red TS carrier script that expected carrier-session transcript/signature helpers and
  carrier-frame decoding exports.
- The carrier vector exposed a real TS drift bug: the quarantine predicate covered concurrent
  stale-holder moves but not serial `not_holder` commands after the author observed a transfer
  away. Fixed `src/quarantine.ts` to check the causal holder before applying gated commands,
  while preserving the concurrent stale-holder rule.
- Added a red CI assertion for `npm run carrier:township`, then wired the package script and
  workflow step.

## Completed Scope

- Extended `Mix.Tasks.Lattice.ExportVectors` to emit `township_carrier_w1.json` from the live
  `Township.Matter` Sim scenario.
- Included both standard semantic oracle fields (`ops`, `expectAtFullFrontier`) and carrier
  fields (`clientBaseCarrierOps`, `clientDivergedCarrierOps`, `peerDivergedCarrierOps`,
  `oracleCarrierOps`, endpoint session metadata).
- Added `clients/lattice-client/src/carrier.ts`:
  - BEAM-compatible carrier-session transcript bytes;
  - signer-injected carrier challenge signing;
  - full carrier frame to semantic `Op` decoding for Township commands and authority ops.
- Added `clients/lattice-client/test/carrier.ts` and `npm run carrier:township`.
- Wired `.github/workflows/flagship.yml` to run the carrier check in CI after conformance.

## Verification

- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `npm run carrier:township` from `clients/lattice-client`
- `npm run conformance` from `clients/lattice-client`
- `npm run typecheck` from `clients/lattice-client`

## Remaining Work

- Live TS process round trip against `LatticeNodeSpike.WsHandler` is complete in plan 022.
- Keep client-side op authoring and local op verification blocked until ADR-P08 / canonical CBOR
  fully lands; plan 021 only signs carrier-session transcripts through an injected signer.
