# Plan 020: Randomized TS client conformance and CI wiring (Phase B2)

> **Executor instructions**: This plan records the completed Phase B2 slice from
> `TOWNSHIP_BUILD_MAP.md`. Keep future changes red-first: pin the desired vector or CI
> behavior in `Township.ExportVectorsTest`, regenerate vectors from Sim, then run the TS
> conformance harness.
>
> **Toolchain**: run BEAM commands locally as `PATH="$HOME/.asdf/shims:$PATH"
> ~/.asdf/shims/mix ...`; the Homebrew/mise Erlang path is not reliable here.

## Status

- **Priority**: P1
- **Effort**: M
- **Category**: client library / oracle conformance
- **Build-map phase**: B2
- **Depends on**: plan 019
- **Status**: DONE

## Goal

Make the TypeScript reducer prove itself against more than hand-picked Township stories by
exporting a deterministic randomized Sim corpus and running the Elixir exporter plus TS
typecheck/conformance gates in CI.

## TDD Trace

- Added red assertions that `lattice.export_vectors` writes at least five
  `township_random_*.json` vectors with `scenarioKind: "randomized"` and integer `seed`.
- Added a red workflow assertion that CI regenerates vectors and runs
  `npm run typecheck` + `npm run conformance` in `clients/lattice-client`.
- Implemented five deterministic seeded Sim scenarios across clerk/resident/neighbor with
  randomized partitions, heals, syncs, posts, LWW writes, admits, and observed removes.
- The fresh randomized corpus exposed a real TS drift bug: OR-set removal was deleting an
  element globally instead of retiring only causally observed add-tags. Fixed
  `clients/lattice-client/src/crdt/reducers.ts` to mirror `Lattice.Crdt.OrSet`.

## Completed Scope

- Extended `Mix.Tasks.Lattice.ExportVectors` to emit:
  - `township_join_w0.json`
  - `township_zoning_variance_24.json`
  - `township_succession_w3.json`
  - `township_random_101.json`
  - `township_random_202.json`
  - `township_random_303.json`
  - `township_random_404.json`
  - `township_random_505.json`
- Added randomized-vector metadata: `scenarioKind` and `seed`.
- Regenerated `clients/lattice-client/test/vectors/*.json` from the live Sim oracle.
- Fixed TS OR-set observed-remove semantics and stable sorted display order.
- Wired `.github/workflows/flagship.yml` to regenerate vectors, install the TS client, typecheck,
  and run conformance in CI.

## Verification

- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix compile`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `npm run typecheck` from `clients/lattice-client`
- `npm run conformance` from `clients/lattice-client`

## Remaining Work

- Plan 011 Deliverable 3: real-carrier TS sync.
- Tier B remains blocked on ADR-P08 / canonical CBOR.
- The randomized corpus can be expanded later; preserve deterministic seeds so checked-in
  vectors do not churn.
