# Plan 117: Tauri Android release visible chooser onboarding (E1)

## Status

DONE

## Objective

Prove Android release visible chooser onboarding selection.

Plan 114 proved the browser-backed onboarding state-exchange link was
chooser-eligible by using an unpinned Android intent URL. This plan strengthens
that slice by installing a second `township://` `VIEW`/`BROWSABLE` handler, using
the Android resolver UI as the public seam, selecting the primary Township app
from the dumped OS hierarchy, and then driving the same runtime-state onboarding
flow to convergence.

## Scope

- Add `tauri:android:release:chooser-visible-onboarding`.
- Build a distinct diagnostic release APK package as the competing handler for
  the `township://` scheme.
- Label the normal release app `Township` and the competing diagnostic package
  `Township Diagnostic` so the resolver hierarchy is falsifiable.
- Extend the existing browser onboarding smoke with `chooser-visible` mode.
- Prove the smoke observes both `Township` and `Township Diagnostic` in
  `uiautomator` output before tapping the primary `Township` row.
- Reuse the existing onboarding-state probe after selection:
  pairing save, pull, author, cold reload, push, drained outbox, and BEAM peer
  report with `post_materialized=true` and
  `bad_authority_reason=operation_not_granted`.

## Non-Goals

This does not prove cross-device pairing state exchange.
This does not prove QR camera onboarding, LAN discovery, physical-device
behavior, production remote TLS, iOS/Expo parity, authority origination, or full
mobile onboarding.
This does not prove full mobile onboarding.
This does not prove arbitrary third-party handler behavior; the competing
handler is a distinct Township diagnostic package with a different package id
and visible label.
This does not change the production release build or make the diagnostic
cleartext package a production artifact.

## STOP Conditions

- Stop if `chooser_visible` is inferred from app logcat rather than Android
  `uiautomator` hierarchy.
- Stop if only one `township://` handler is installed.
- Stop if the smoke auto-launches the app by package/component instead of
  tapping the visible primary `Township` resolver row.
- Stop if the diagnostic competitor uses the production package id.
- Stop if docs imply cross-device exchange, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo, production TLS, authority origination, or
  full mobile onboarding completion from this slice.

## TDD Evidence

- RED: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  failed because `plans/117-tauri-android-release-visible-chooser-onboarding-e1.md`
  did not exist.
- GREEN: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  passed after adding the plan, scripts, diagnostic competitor label guards, and
  static smoke expectations.
- GREEN: `npm --prefix clients/township-tauri-shell run typecheck`
  passed after adding the chooser-visible mode and competitor install path.
- GREEN: `npm --prefix clients/township-tauri-shell run tauri:android:build:release:chooser-competitor`
  produced the distinct diagnostic competitor APK.
- GREEN: `npm --prefix clients/township-tauri-shell run tauri:android:build:release:onboarding-state-probe`
  rebuilt the primary release onboarding-state APK.
- GREEN: `npm --prefix clients/township-tauri-shell run tauri:android:release:chooser-visible-onboarding:smoke`
  observed the visible Android resolver with both handlers, selected Township,
  and completed the onboarding state-exchange convergence flow.

## Second Opinion

Claude Code recommended this as the next bounded slice after Plan 116 because it
closes the repeated "visible chooser UI" gap with real OS behavior, while QR
camera onboarding, LAN discovery, cross-device exchange, and physical-device
proofs would be fake or blocked on this machine.

## Verification

- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
- `npm --prefix clients/township-tauri-shell run typecheck`
- `npm --prefix clients/township-tauri-shell run tauri:android:build:release:chooser-competitor`
- `npm --prefix clients/township-tauri-shell run tauri:android:build:release:onboarding-state-probe`
- `npm --prefix clients/township-tauri-shell run tauri:android:release:chooser-visible-onboarding:smoke`
- pinned OTP 28 `mix verify`

## Remaining Work

- Cross-device pairing state exchange remains separate.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, authority origination composition, and full mobile
  onboarding remain separate bounded plans.
