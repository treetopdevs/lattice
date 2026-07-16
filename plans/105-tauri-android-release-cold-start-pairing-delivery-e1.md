# Plan 105: Tauri Android release cold-start pairing delivery (E1)

## Status

DONE

## Objective

Extend the Android release pairing proof so a non-debuggable APK receives
state-bound `township://pairing` delivery when the app process is not already
running.

## Scope

- Extend `tauri:android:release:pairing:smoke`, which is already part of the
  named release convergence gate from Plan 104.
- Add an Android force-stop/assert-not-running guard based on `adb shell
  pidof` before the cold-start intents are delivered.
- Prove a no-state cold-start `VIEW`/`BROWSABLE` pairing intent starts the app
  but is blocked with `blocked_reason=state_mismatch` and does not save a peer
  config.
- Prove a state-bearing cold-start `VIEW`/`BROWSABLE` pairing intent starts the
  app, saves the paired config, survives force-stop/relaunch as `paired=true`,
  and syncs against the BEAM peer.
- Keep using the release pairing probe namespace
  `township:release-pairing-probe` and the fixed probe-only state from Plan
  103.

## Non-Goals

This does not prove browser/chooser-backed state exchange.

- No browser/chooser-backed state exchange.
- No cross-device authenticated state exchange or unforgeable production
  challenge.
- No authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, or full
  mobile onboarding.

## STOP Conditions

- Stop if the proof delivers the pairing URL while the app process is already
  running.
- Stop if a no-state cold-start link can save pairing config before the
  state-bearing delivery.
- Stop if docs call this browser/chooser coverage, production challenge
  exchange, authority origination, phone-grade equivalence, or full onboarding.
- Stop if the proof relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because Plan 105 and the
  cold-start process assertions were missing.
- GREEN: the Android release pairing smoke now asserts `pidof` is empty before
  adb-delivered cold-start pairing intents, blocks no-state delivery with
  `blocked_reason=state_mismatch`, saves state-bearing delivery, relaunches
  with `paired=true`, and syncs from the persisted peer config.
- GREEN: `npm run tauri:android:release:convergence` passed after rebuilding
  the sync, author, and pairing probe APKs and running their smokes in
  sequence.

## Second Opinion

Claude Code agreed this is the right bounded next slice when it explicitly
asserts the app is not running before delivery. It warned not to conflate this
with the existing persisted cold-reload proof and not to widen the claim to
browser/chooser-backed state exchange, iOS, or full onboarding.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:pairing-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:pairing:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:release:convergence`

## Remaining Work

- Browser/chooser-backed state exchange remains unproven.
- full mobile onboarding remains unproven.
- Authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, and full
  mobile onboarding remain separate bounded plans.
