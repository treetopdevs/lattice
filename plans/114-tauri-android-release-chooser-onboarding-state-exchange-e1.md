# Plan 114: Android release chooser-eligible onboarding state exchange (E1)

## Status

DONE

## Objective

Prove the Android release onboarding state-exchange path can enter the app from
a chooser-eligible browser handoff rather than the existing
package/component-pinned browser intent URL.

This keeps the proof on the real release APK onboarding/cap-persistence path:
the app mints runtime pairing state, a browser-loaded page echoes that state in
a `township://pairing` handoff, the release app pulls the bootstrap cap, authors
and persists Township frames, cold-reloads the pending outbox, pushes, drains,
and verifies peer-side authority enforcement.

## Scope

- Add `tauri:android:release:chooser-onboarding-state-exchange`.
- Reuse `tauri:android:build:release:onboarding-state-probe` so the storage
  namespace, key id, runtime state exchange, cap pull, authoring, cold reload,
  push, and peer-report assertions stay aligned with Plan 111.
- Add a browser-probe mode selected by
  `TOWNSHIP_ANDROID_BROWSER_INTENT_MODE=chooser`.
- In chooser mode, generate an unpinned Android intent URL:
  `intent://...#Intent;scheme=township;end`.
- Assert the generated browser page does not include `package=` or
  `component=` in the Android intent URL.
- Assert Android can resolve an unpinned `VIEW`/`BROWSABLE`
  `township://pairing` intent to the Township app or Android resolver.
- Keep the browser page request-before-pairing-save assertion from the
  onboarding probe.

## Non-Goals

This does not prove visible chooser UI.
This does not prove cross-device pairing state exchange.
This does not prove authority origination.
This does not prove full mobile onboarding.

- No QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo
  proof, production remote TLS, production remote challenge protocol, or
  production remote state exchange.
- This is still emulator evidence over an adb-reversed loopback peer and
  probe-only loopback state-exchange endpoint.
- This plan does not rename the Plan 110-112 loopback state exchange as
  cross-device transport.

## STOP Conditions

- Stop if chooser mode emits `package=` or `component=` in the browser intent
  URL.
- Stop if docs call this visible chooser UI, cross-device exchange, authority
  origination, QR camera onboarding, LAN discovery, physical-device behavior,
  iOS, production TLS, production challenge security, or full mobile onboarding.
- Stop if the runtime state appears in `LATTICE_PROBE` logs.
- Stop if any secure-store done gate is flipped from unproven to met for
  iOS/Expo, cross-device, visible chooser UI, or full onboarding.
- Stop if readiness alone is treated as acceptance without running the heavy
  Android release chooser onboarding state-exchange smoke.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because this plan file was
  missing.
- RED: `npm run mobile:tauri-readiness` failed while this plan was still
  `IN PROGRESS`.
- RED: `npm run tauri:android:release:chooser-onboarding-state-exchange`
  proved the unpinned no-state resolver path reached the app and blocked with
  `blocked_reason=state_mismatch`, but the first state-bearing resolver delivery
  timed out before `phase=pairing outcome=saved`.
- FIX: the browser onboarding smoke now clears stale no-state logs before the
  state link and retries the state-bearing browser delivery until the pairing
  save is observed, while still requiring the browser page timestamp to precede
  the saved pairing log.
- GREEN: `npm run tauri:android:release:chooser-onboarding-state-exchange`
  passed, including resolver eligibility, no-state block, state-bearing pairing
  save, cap pull, authoring, pending-outbox cold reload, push drain, peer report,
  and final relaunch sync.

## Second Opinion

Claude Code recommended avoiding another doc-only plan after Plan 113. The
recommended next slice was a runtime proof if chooser-backed exchange was
emulator-feasible, with the cross-device frontier kept separate and every
no-claim boundary explicit.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:chooser-onboarding-state-exchange`
- `git diff --check`

## Remaining Work

- Visible chooser UI remains unproven.
- Cross-device pairing state exchange remains unproven.
- Authority origination remains unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, production challenge security, and full mobile
  onboarding remain separate bounded plans.
