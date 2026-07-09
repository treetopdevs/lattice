# Plan 101: Tauri dev-trace release hydration and control links (E1)

## Status

DONE

## Objective

Repair the packaged macOS armed pairing smoke so it proves the real Tauri app is
hydrated before OS pairing delivery and can exercise the app-local armed
state-binding ceremony without relying on inaccessible macOS window automation.

## Scope

- Allow `township-dev-trace` release-mode bundles to honor
  `TOWNSHIP_DEV_CARRIER_KEY_ID` / `TOWNSHIP_DEV_CARRIER_KEY_SEED`, keeping the
  packaged smoke off the platform keyring path while production release builds
  still ignore those env vars.
- Add a dev-trace `township-native-hydration-settled` trace after native status
  and action-availability hydration both complete.
- Make the installed-app armed deep-link smoke wait for hydration completion
  rather than the entry trace for `lattice_ensure_carrier_key`.
- Replace the smoke's AppleScript shortcut dependency with dev-trace-only
  `township://dev/pairing-import/arm` and
  `township://dev/carrier-health/check` control links.
- Remove the failed current-URL polling fallback from the pairing deep-link
  listener.

## Non-Goals

- No production arm-by-deep-link behavior; the control links are only honored
  when `VITE_TOWNSHIP_DEV_TRACE` is enabled.
- No browser/chooser automation, Android release armed OS delivery, remote
  challenge protocol, app-originated grants, authority origination, QR camera
  onboarding, LAN discovery, physical-device proof, or full onboarding claim.
- No change to the production platform keyring/secure-store boundary.

## STOP Conditions

- Stop if production builds honor the dev carrier-key seed env vars.
- Stop if `township://dev/*` links are handled when the dev-trace runtime flag is
  not enabled.
- Stop if the installed-app smoke waits only for command entry rather than a
  settled hydration trace.
- Stop if the smoke depends on AppleScript seeing a Tauri webview window.

## TDD Evidence

- RED: `cargo test --release --features township-dev-trace
  dev_seed_env_vars_prime_the_w1_session_key` failed because
  `seed_dev_carrier_key_from_vars` was compiled out of release builds.
- GREEN: the same release-profile test passes after allowing the helper under
  `any(debug_assertions, feature = "township-dev-trace")`.
- RED: the packaged `tauri:deep-link:smoke` previously timed out after the first
  unarmed delivery, then hung in `osascript` while waiting for a System Events
  window.
- GREEN: the packaged `tauri:deep-link:smoke` now passes with hydration-settled
  readiness and dev-trace control links.

## Second Opinion

Claude Code was requested for second-opinion review during this sequence,
including a final non-interactive findings-first review prompt after the smoke
passed, but the CLI did not return a verdict before hanging or being
interrupted. No Claude approval is claimed for this plan; verification is from
the focused red/green tests and packaged app smoke.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo test --release --features township-dev-trace dev_seed_env_vars_prime_the_w1_session_key`
- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:deep-link:smoke`

## Remaining Work

- Run the cold-start deep-link smoke and mobile strategy/readiness gates after
  this plan lands to keep the broader Tauri/mobile status synchronized.
- Add Android release armed OS delivery, browser/chooser behavior,
  browser/chooser-backed or cross-device pairing state exchange, authority
  origination, QR camera onboarding, LAN discovery,
  physical-device behavior, and full onboarding as separate bounded plans.
