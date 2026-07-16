# Plan 022: TS live WebSocket carrier W1 (C3)

> **Executor instructions**: This plan records the completed live C3 slice from
> `TOWNSHIP_BUILD_MAP.md`. Keep future carrier work bounded: preserve Sim as the oracle,
> use injected key custody/signers, and do not enable client-side op authoring before ADR-P08.
>
> **Toolchain**: run BEAM commands locally as `PATH="$HOME/.asdf/shims:$PATH"
> ~/.asdf/shims/mix ...`; the Homebrew/mise Erlang path is not reliable here.

## Status

- **Priority**: P1
- **Effort**: M
- **Category**: client library / carrier sync
- **Build-map phase**: C3
- **Depends on**: plan 021
- **Status**: DONE

## Goal

Complete the Tier-A C3 gate by proving a real TypeScript client process can talk to the
BEAM Township peer over WebSocket, authenticate the carrier session, pull and push carrier
frames, materialize the converged W1 state, and match the same Sim oracle that the BEAM
carrier test uses.

## TDD Trace

- Added a red live TS carrier script that imported a missing `connectCarrierWebSocket`.
- Implemented a shell-neutral WebSocket carrier client with injected signer/verifier:
  signed challenge, verified BEAM `carrier_hello`, `status`, `frontier`, `pull`, `push`,
  `state`, and `shutdown` request helpers.
- Added a red `syncCarrierOnce` expectation so the library, not just the test, owns the
  advertise/pull/push/integrate loop.
- Implemented `syncCarrierOnce` over the existing carrier frame adapter and `sync.ts`
  integration helper.
- Added a red workflow assertion for `npm run carrier:township:live`, then wired the package
  script and CI step.

## Completed Scope

- Added `clients/lattice-client/test/live_carrier.ts`.
- Extended `clients/lattice-client/src/carrier.ts` with:
  - `connectCarrierWebSocket`;
  - `CarrierWebSocketClient`;
  - `verifyCarrierHello`;
  - `carrierChallenge`;
  - `syncCarrierOnce`.
- Added `npm run carrier:township:live`.
- Wired `.github/workflows/flagship.yml` to run the live carrier check after the vector check.
- Updated Township build-map and client-plan docs to mark C3 done for Tier-A W1.

## Verification

- `npm run typecheck` from `clients/lattice-client`
- `npm run conformance` from `clients/lattice-client`
- `npm run carrier:township` from `clients/lattice-client`
- `npm run carrier:township:live` from `clients/lattice-client`

## Remaining Work

- Tier B remains blocked on ADR-P08 / canonical CBOR: client-side op authoring and local op
  verification still must not be enabled.
- Expand beyond W1 when app-shell work needs broader live scenarios; keep those scenarios
  Sim-generated and CI-gated.
