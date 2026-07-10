# Plan 113: Android release browser/onboarding regression gate (E1)

## Status

DONE

## Objective

Add one named Android release browser/onboarding regression gate that rebuilds
and runs the existing browser-backed release proof slices back-to-back.

This is a regression aggregation over already-proven slices, not a new runtime
capability. Its value is proving the six browser/onboarding release smokes can
run sequentially on one Android test session without stale APK assumptions,
browser setup drift, port conflicts, or probe script sequencing mistakes.

## Scope

- Add `tauri:android:release:browser-onboarding-regression`.
- Compose only existing build-then-smoke commands:
  - `tauri:android:release:browser-pairing`
  - `tauri:android:release:browser-state-exchange`
  - `tauri:android:release:browser-onboarding`
  - `tauri:android:release:browser-onboarding-state-exchange`
  - `tauri:android:release:browser-onboarding-grant`
  - `tauri:android:release:browser-onboarding-grant-state-exchange`
- Keep each underlying proof responsible for rebuilding its own release probe
  APK before its smoke runs.
- Update the build map, mobile secure-store strategy, and readiness contract to
  name this as a regression gate over Plans 107-112.

## Non-Goals

No new runtime behavior.
This does not prove chooser UI.
This does not prove cross-device pairing state exchange.
This does not prove authority origination.
This does not prove full mobile onboarding.

- No QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo
  proof, production remote TLS, production remote challenge protocol, or
  production remote state exchange.
- This gate does not replace the individual smoke assertions; it only composes
  them.
- This gate must not be used to claim phone-grade equivalence.

## STOP Conditions

- Stop if any smoke runs against a shared or stale APK instead of its own
  freshly rebuilt probe APK.
- Stop if the gate drops any of the six browser/onboarding release smokes from
  Plans 107-112.
- Stop if docs call this chooser coverage, cross-device exchange, authority
  origination, QR camera onboarding, LAN discovery, physical-device behavior,
  iOS, production TLS, production challenge security, or full mobile onboarding.
- Stop if readiness alone is treated as acceptance without running the heavy
  Android release browser/onboarding regression gate.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because this plan file was
  missing.
- RED: `npm run mobile:tauri-readiness` then failed because this plan was not
  yet marked `DONE`.
- RED: `npm run tauri:android:release:browser-onboarding-regression` exposed
  browser setup drift: Chrome crash UI/stale state in the first pairing smoke,
  then a first-run page-request timeout after clearing Chrome state.
- FIX: the browser pairing and browser onboarding harnesses now clear emulator
  browser state like the grant harness, settle Chrome first-run prompts after
  opening pages, and retry page-request observation before tapping the handoff.
- FIX: the fixed-state browser onboarding release probe now uses the same
  120000 ms timeout budget as the runtime-state and grant onboarding probes.
- GREEN: `npm run tauri:android:release:browser-onboarding-regression` passed,
  rebuilding and running all six Plan 107-112 browser-backed release proofs
  back-to-back.
- GREEN: `npm run mobile:tauri-readiness`, `npm run mobile:strategy`,
  `npm run typecheck`, `git diff --check`, and pinned-OTP-28 `mix verify`
  passed after the plan was marked done.

## Second Opinion

Claude Code cautioned that this is not the next frontier capability gap and
should not be named as another broad convergence proof. Claude approved the
slice only as a cheap regression capstone before pivoting to harder design work,
with the rationale narrowed to back-to-back rebuild/install/browser/port hygiene
over Plans 107-112 and with every chooser, cross-device, authority-origination,
QR/LAN, physical-device, iOS, production challenge, and full-onboarding caveat
kept explicit.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-onboarding-regression`
- `git diff --check`

## Remaining Work

- Chooser UI remains unproven.
- Cross-device pairing state exchange remains unproven.
- Authority origination remains unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, production challenge security, and full mobile
  onboarding remain separate bounded plans.
- The next high-value step should be a browser-realm/cross-device transport
  design decision rather than another single-device browser proof aggregation.
