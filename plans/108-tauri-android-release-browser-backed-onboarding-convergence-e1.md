# Plan 108: Android release browser-backed onboarding convergence (E1)

## Status

DONE

## Objective

Prove Android release browser-backed onboarding convergence: a non-debuggable
Android release APK can receive a state-bearing `township://pairing` handoff
from a browser-loaded HTML page plus tap, persist the paired carrier config in
the `township:release-onboarding-probe` namespace, pull the bootstrap post-only
cap, author and push a valid post plus unauthorized summary, and relaunch with
paired config, local evidence, peer-side authority enforcement, and a drained
outbox.

The browser page request is observed before the onboarding namespace saves
pairing, which distinguishes this from the direct-adb Plan 106 handoff.
The same release session pulls the bootstrap post-only cap before authoring and
pushing the convergence proof frames.

## Scope

- Add `tauri:android:release:browser-onboarding:smoke` and
  `tauri:android:release:browser-onboarding`.
- Reuse the Plan 106 release onboarding probe APK, namespace, and fixed
  probe-only state token.
- Serve a local browser-loaded HTML page whose full-screen link carries the
  canonical `township://pairing` handoff and targets Android through a
  package/component-pinned intent URL.
- Open that page with an installed Android browser package resolved through
  `cmd package resolve-activity`.
- Tap the page link with Android input, rather than directly starting the app
  with a `township://pairing` adb intent.
- Assert the browser page request is observed before the onboarding namespace
  emits `phase=pairing outcome=saved`.
- Reuse the Plan 106 convergence assertions after pairing: pairing-derived
  sync, bootstrap cap pull, post authoring, pending-outbox cold reload,
  push/outbox drain, peer report with `post_materialized=true` and
  `bad_authority_reason=operation_not_granted`, and final relaunch sync.

## Non-Goals

This does not prove chooser UI.
This does not prove browser/chooser-backed or cross-device pairing state exchange.

- No browser-version guarantee beyond the installed browser package used by the
  smoke.
- No QR camera onboarding, authority origination, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, or full
  mobile onboarding.
- No claim that the fixed Plan 106 probe-only state is an unforgeable production
  challenge.

## STOP Conditions

- Stop if the positive path uses a direct adb `township://pairing` app intent
  instead of browser page delivery plus tap.
- Stop if the browser page request cannot be observed before the onboarding
  namespace saves pairing.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim chooser UI, browser/chooser-backed or cross-device state
  exchange, production challenge security, authority origination, QR camera
  onboarding, physical-device coverage, or full mobile onboarding.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because the Plan 108 smoke and
  plan file were missing.
- GREEN: the Plan 108 smoke serves a browser-loaded HTML page, resolves an
  Android browser package, taps a state-bearing Android intent URL carrying the
  `township://pairing` handoff, asserts the browser page request is observed
  before the onboarding namespace saves pairing, and then proves the same
  pull/author/pending-reload/push/peer-report/final-reload convergence chain as
  Plan 106.

## Second Opinion

Claude Code agreed this is the right next bounded slice after Plan 107 only if
the new proof distinguishes itself from Plan 106 by tying the onboarding
pairing save to a browser-served page request and tap. Claude recommended
keeping this as a standalone probe smoke, not a convergence-gate edit, and
leaving chooser UI, cross-device state exchange, and production challenge
security as explicit non-goals.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-onboarding`
- `git diff --check`

## Remaining Work

- Chooser UI behavior remains unproven.
- Browser/chooser-backed or cross-device cryptographic state exchange remains
  unproven.
- QR camera onboarding, authority origination, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, and full
  mobile onboarding remain separate bounded plans.
- full mobile onboarding remains unproven.
