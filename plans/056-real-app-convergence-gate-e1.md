# Plan 056: Real app convergence gate (E1)

## Status

DONE.

## Objective

Expose one named shell command that proves the current real Tauri app path converges: the grant
ceremony/action contract, sync/outbox contract, live BEAM peer sync, and real Tauri window smoke all
run in sequence.

Planned at commit `ee6f56c`.

## Scope

- Add an `app:convergence` package script to `clients/township-tauri-shell`.
- Keep the gate honest by composing existing executable proofs instead of weakening them into a doc
  claim.
- Treat this as the current Tauri desktop convergence gate. It does not claim phone-grade Tauri
  mobile or Expo convergence; that still needs a real mobile smoke.

## STOP Conditions

- If the gate drops the live BEAM peer sync or the Tauri window smoke, stop; that would be a shell
  contract, not real app convergence.
- If the gate claims mobile convergence without a mobile build/smoke, stop and keep the claim
  desktop-only.
- If the gate bypasses the plan 054 grant/action contract, stop; convergence must include the new
  onboarding cap persistence ceremony.

## TDD Plan

1. RED: extend the frontend package contract to require an `app:convergence` script before it
   exists.
2. GREEN: add the package script that runs `action:contract`, `sync:contract`, `live:contract`, and
   `tauri:launch:smoke`.
3. VERIFY: run the frontend contract and then run `npm run app:convergence`.

## Second Opinion

Claude Code agreed that real app convergence should remain the next slice after the mobile
secure-store strategy, with no mobile convergence claim until a real mobile smoke exists.

## Verification

- RED: `npm run frontend:contract` failed because `package.json` had no `app:convergence` script.
- GREEN: `app:convergence` now runs `action:contract`, `sync:contract`, `live:contract`, and
  `tauri:launch:smoke`.
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run app:convergence`

## Remaining Work

- Completed follow-up: plan 080 creates an actual Android debug APK convergence smoke for persisted
  pre-signed W1 frames against a BEAM Township peer.
- A future release mobile convergence plan must flip the phone-grade persistence gate from strategy
  to release/device evidence.
- That mobile smoke should also add a behavioral no-secrets-in-KV assertion for serialized app
  stores and a grant-specific authority/quarantine check.
