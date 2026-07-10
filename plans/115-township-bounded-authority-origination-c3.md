# Plan 115: Township bounded authority origination (C3)

## Status

DONE

## Objective

Prove the shared TypeScript Township authoring layer can originate a root-bound
authority genesis that matches the BEAM substrate, and prove the live BEAM peer
enforces the root boundary when a different key forges a self-issued genesis
under the honest bound replica id.

This closes the substrate-level authority-origination gap left by the delegated
mobile onboarding proofs: `authorTownshipGenesis` can create the same root
genesis frame that BEAM accepts for W1, while an impostor root is structurally
accepted by the carrier but authority-quarantined by BEAM as
`impostor_genesis`.

## Scope

- Add TypeScript replica root-binding helpers matching `Lattice.Authority`:
  `bindTownshipReplica`, `townshipReplicaCommitment`, and
  `townshipReplicaRootTag`.
- Add `townshipGenesisBody` and `authorTownshipGenesis` for self-issued root
  authority frames with succession-policy encoding.
- Extend `clients/lattice-client/test/township_authoring.ts` to prove:
  - the TS-bound replica id matches the BEAM W1 root-bound fixture;
  - TS-authored genesis is byte-for-byte equal to the BEAM W1 genesis frame;
  - a forged self-issued genesis under the honest bound replica is
    representable and uses a different root key.
- Extend `clients/lattice-client/test/live_carrier.ts` to push that forged
  genesis through the live BEAM Township carrier and assert:
  - the frame is structurally accepted;
  - materialized state bytes remain unchanged;
  - peer authority quarantine contains `[forged_id, "impostor_genesis"]`.
- Update the Township build map and mobile secure-store strategy to mark this
  shared TS/live-BEAM authority-origination proof as done without promoting it
  into an Android release root-originating onboarding ceremony.

## Non-Goals

This does not prove Android release root/authority origination.
This does not prove a user-facing Tauri onboarding ceremony that creates a new
replica root from mobile secure storage.
This does not prove cross-device pairing state exchange.
This does not prove visible chooser UI.
This does not prove QR camera onboarding, LAN discovery, physical-device
behavior, iOS/Expo parity, production remote TLS, or full mobile onboarding.

## STOP Conditions

- Stop if the TS genesis frame does not match the BEAM W1 fixture byte-for-byte.
- Stop if a forged self-issued genesis under the honest bound replica changes
  BEAM peer state.
- Stop if the forged genesis is not reported as `impostor_genesis` in live BEAM
  authority quarantine.
- Stop if docs imply Android release root/authority origination, phone-grade
  onboarding, cross-device exchange, visible chooser UI, QR camera onboarding,
  LAN discovery, or iOS/Expo parity from this proof.

## TDD Evidence

- RED: `npm --prefix clients/lattice-client run township:authoring` failed
  because `authorTownshipGenesis` was not exported.
- GREEN: `npm --prefix clients/lattice-client run township:authoring` passed
  after adding root-binding, genesis-body, and genesis-frame authoring helpers.
- GREEN: `npm --prefix clients/lattice-client run carrier:township:live` passed
  after adding the forged-genesis live BEAM quarantine assertion.
- RED: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  failed because this plan file was missing.
- GREEN: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  passed after adding this plan and narrowing the remaining Android release
  root/authority-origination gap.

## Second Opinion

Claude Code rejected an authoring-only claim as insufficient for "bounded
authority origination." The recommended minimum was an oracle-backed quarantine
assertion for forged genesis; the final slice follows the stronger path by
pushing the TS-authored forged genesis through the live BEAM peer and checking
`impostor_genesis`.

## Verification

- `npm --prefix clients/lattice-client run township:authoring`
- `npm --prefix clients/lattice-client run carrier:township:live`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `npm --prefix clients/lattice-client run typecheck`
- `git diff --check`
- pinned OTP 28 `mix verify`

## Remaining Work

- Android release root/authority origination remains unproven.
- A real Tauri onboarding ceremony that creates a new replica root from
  platform secure storage remains unproven.
- Cross-device pairing state exchange, visible chooser UI, QR camera onboarding,
  LAN discovery, physical-device behavior, iOS/Expo proof, production remote TLS,
  production challenge security, and full mobile onboarding remain separate
  bounded plans.
