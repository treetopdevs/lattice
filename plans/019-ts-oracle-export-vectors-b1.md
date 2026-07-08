# Plan 019: Generate TS client conformance vectors from Sim (Phase B1)

> **Executor instructions**: This plan records the completed Phase B1 slice from
> `TOWNSHIP_BUILD_MAP.md`. Future workers should keep using TDD: change the
> exporter test first, regenerate vectors, then run both Elixir and TS gates.
>
> **Toolchain**: run BEAM commands locally as `PATH="$HOME/.asdf/shims:$PATH"
> ~/.asdf/shims/mix ...`; the Homebrew/mise Erlang path is not reliable here.

## Status

- **Priority**: P1
- **Effort**: M
- **Category**: client library / oracle conformance
- **Build-map phase**: B1
- **Status**: DONE

## Goal

Make the TypeScript client realm consume conformance vectors generated from the
live `Lattice.Sim` oracle instead of a hand-authored JSON fixture.

## Completed Scope

- Imported the user-provided `clients/lattice-client` Tier-A scaffold.
- Added `Mix.Tasks.Lattice.ExportVectors` under the repo's real task location:
  `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`.
- Added a red-first regression test:
  `apps/lattice_core/test/township/export_vectors_test.exs`.
- Exported three Sim-generated vectors:
  `township_join_w0.json`, `township_zoning_variance_24.json`, and
  `township_succession_w3.json`.
- Included mid-partition clerk/resident perspectives in the zoning vector.
- Adjusted the TS reducer to treat ordering keys as opaque Sim-provided strings
  and to honor schema defaults for partial-frontier materialization.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `npm run typecheck` from `clients/lattice-client`
- `npm run conformance` from `clients/lattice-client`

## Remaining Work

- Phase B2 is complete in plan 020: randomized Sim-generated scenarios and CI wiring for the
  TS conformance harness.
- Plan 011 Deliverable 3: real-carrier TS sync.
- Tier B remains blocked on ADR-P08 / canonical CBOR.
