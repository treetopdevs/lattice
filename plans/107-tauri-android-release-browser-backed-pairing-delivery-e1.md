# Plan 107: Android release browser-backed pairing delivery (E1)

## Status

DONE

## Objective

Prove Android release browser-backed pairing delivery: a non-debuggable Android
release APK can receive a state-bearing `township://pairing` handoff that was
loaded from a browser-served HTML page and activated by a tap through an Android
package/component-pinned intent URL, then persist the paired carrier config and
sync from that persisted config after relaunch.

## Scope

- Add `tauri:android:release:browser-pairing:smoke` and
  `tauri:android:release:browser-pairing`.
- Reuse the Plan 103/105 release pairing probe APK, namespace, and fixed
  probe-only state token.
- Serve a local browser-loaded HTML page whose full-screen link carries the
  canonical `township://pairing` handoff and targets Android through a
  package/component-pinned intent URL.
- Open that page with an installed Android browser package resolved through
  `cmd package resolve-activity`.
- Tap the page link with Android input, rather than directly starting the app
  with a `township://pairing` adb intent.
- First tap a no-state link and assert it is blocked with
  `blocked_reason=state_mismatch`.
- Then tap a state-bearing `township://pairing` handoff through that Android
  intent URL and assert the release app saves the paired carrier config,
  relaunches with `paired=true`, and syncs from the persisted pairing.

## Non-Goals

This does not prove chooser UI.
This does not prove cross-device cryptographic state exchange.

- No browser-version guarantee beyond the installed browser package used by the
  smoke.
- No QR camera onboarding, authority origination, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, or full
  mobile onboarding.
- No claim that the fixed Plan 103 probe-only state is an unforgeable production
  challenge.

## STOP Conditions

- Stop if the positive path uses a direct adb `township://pairing` app intent
  instead of browser page delivery plus tap.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim chooser UI, cross-device state exchange, production
  challenge security, authority origination, QR camera onboarding, physical
  device coverage, or full mobile onboarding.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because the Plan 107 smoke and
  plan file were missing.
- GREEN: the Plan 107 smoke serves a browser-loaded HTML page, resolves an
  Android browser package, taps no-state and state-bearing Android intent URLs
  carrying `township://pairing` handoffs, asserts the no-state handoff is blocked with
  `blocked_reason=state_mismatch`, and asserts the state-bearing handoff saves the
  pairing and syncs after relaunch.

## Second Opinion

Claude Code agreed this is the best next bounded slice after Plan 106 as long
as it is framed as browser-originated handoff delivery into the release app, not
as a proof of chooser UI, browser semantics in general, cross-device
cryptographic exchange, or full onboarding.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-pairing`
- `git diff --check`

## Remaining Work

- Chooser UI behavior remains unproven.
- Cross-device cryptographic state exchange remains unproven.
- QR camera onboarding, authority origination, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, and full
  mobile onboarding remain separate bounded plans.
- full mobile onboarding remains unproven.
