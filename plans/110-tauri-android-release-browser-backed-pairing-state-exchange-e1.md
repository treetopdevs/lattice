# Plan 110: Android release browser-backed pairing state exchange (E1)

## Status

DONE

## Objective

Prove Android release browser-backed pairing can use an app-minted runtime
state token instead of a build-time shared `ARM_STATE` constant.

The non-debuggable release APK arms its existing one-shot pairing gate, mints a
fresh crypto-generated 32-hex state in the app session, publishes that state to
a probe-only loopback exchange endpoint, and accepts only the browser-loaded
pairing page that echoes that runtime state. A no-state browser link is blocked
with `blocked_reason=state_mismatch`, and the runtime pairing state must not be
emitted to probe logs.

## Scope

- Add `tauri:android:build:release:pairing-state-probe`,
  `tauri:android:release:browser-state-exchange:smoke`, and
  `tauri:android:release:browser-state-exchange`.
- Use a dedicated `township:release-pairing-state-probe` namespace and
  `township-release-pairing-state-resident` key id.
- Add `VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL` as a probe-only
  callback URL for runtime state exchange.
- Keep peer URL, peer realm, peer pubkey, and replica out of build-time env; the
  peer config still comes only from the browser-delivered `township://pairing`
  handoff.
- Require exactly one state source per release pairing probe build: either a
  legacy fixed `ARM_STATE` or a runtime state-exchange URL, never both.
- No build-time `ARM_STATE` is allowed in the state-exchange probe build.
- Preserve Plan 107's browser-pairing smoke while adding a state-exchange mode
  that starts a loopback HTTP exchange server before app launch.
- Assert the no-state browser link is blocked before pairing is saved.
- Assert the accepted browser link uses the app-minted runtime state and pairing
  persists/syncs through relaunch.
- Assert the runtime state is absent from `LATTICE_PROBE` logcat output.
- The runtime pairing state must not be emitted to probe logs.

## Non-Goals

This does not prove chooser UI.
This does not prove cross-device pairing state exchange.
This does not prove authority origination.
This does not prove full mobile onboarding.

- No QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo
  proof, production remote TLS, or production remote challenge protocol.
- The loopback state-exchange callback is a bounded probe seam, not a
  cross-device confidentiality story.
- No root or issuer authority is minted by the app device.

## STOP Conditions

- Stop if the accepted browser page state still comes from a build-time
  `VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE` constant.
- Stop if the state-exchange build includes both `ARM_STATE` and
  `STATE_EXCHANGE_URL`.
- Stop if non-loopback cleartext callback URLs are accepted; loopback HTTP is
  allowed only for the emulator probe, and non-loopback exchange URLs must be
  HTTPS.
- Stop if the state is generated outside the existing crypto-backed one-shot
  gate.
- Stop if the no-state browser link saves pairing before the runtime state is
  exchanged.
- Stop if the runtime state appears in probe logs.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim chooser UI, cross-device pairing exchange, authority
  origination, QR camera, LAN, physical-device behavior, iOS, production TLS,
  production challenge security, or full mobile onboarding.

## TDD Evidence

- RED: `npm run release:pairing:contract` failed because
  `townshipReleasePairingProbeConfigFromEnv/1` ignored
  `VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL`.
- GREEN: `npm run release:pairing:contract` passes after the release pairing
  probe parses a valid loopback exchange URL, rejects fixed-state plus exchange
  configuration, rejects non-loopback cleartext exchange URLs, mints runtime
  state through the one-shot gate, publishes it through an injected callback,
  and keeps the raw state out of emitted probe logs.
- RED: `npm run mobile:tauri-readiness` failed because this plan file was
  missing.
- GREEN: `npm run mobile:tauri-readiness` passes after docs and readiness
  wiring.
- GREEN: `npm run tauri:android:release:browser-state-exchange` passes after
  the release APK publishes a runtime state to the probe-only loopback callback,
  blocks the browser-delivered no-state link, accepts the browser-delivered
  state-bearing link, persists pairing through relaunch, syncs, and verifies
  logcat does not contain the runtime state.

## Second Opinion

Claude Code recommended this as the best next bounded slice after Plan 109
because the repeated caveat across Plans 100-109 was the fixed probe-only
state constant. Claude approved the callback seam over logging the raw state,
and specifically called out the need to reject non-loopback cleartext exchange
URLs, keep the state crypto-generated, and avoid any chooser, cross-device,
authority-origination, QR, LAN, physical-device, iOS, production TLS, or full
mobile-onboarding claim.

## Verification

- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-state-exchange`
- `git diff --check`

## Remaining Work

- Chooser UI remains unproven.
- Cross-device pairing state exchange remains unproven.
- Authority origination remains unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, and full mobile onboarding remain separate bounded
  plans.
