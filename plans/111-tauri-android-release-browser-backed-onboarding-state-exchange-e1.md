# Plan 111: Android release browser-backed onboarding state exchange (E1)

## Status

DONE

## Objective

Prove Android release browser-backed onboarding convergence can use an
app-minted runtime state token instead of a build-time shared `ARM_STATE`
constant.

The non-debuggable release APK starts the existing release onboarding probe in a
fresh namespace, arms the existing crypto-backed one-shot pairing gate, publishes
the generated 32-hex state to a probe-only loopback exchange endpoint, and
accepts only the browser-loaded pairing page that echoes that runtime state. A
no-state browser link is blocked with `blocked_reason=state_mismatch`, then the
runtime state-bearing browser link saves pairing and drives the same onboarding
pull-author-reload-push-report flow as Plan 108:
`post_materialized=true`, `bad_authority_reason=operation_not_granted`, and a
drained outbox after relaunch.

## Scope

- Add `tauri:android:build:release:onboarding-state-probe`,
  `tauri:android:release:browser-onboarding-state-exchange:smoke`, and
  `tauri:android:release:browser-onboarding-state-exchange`.
- Use a dedicated `township:release-onboarding-state-probe` namespace and
  `township-release-onboarding-state-resident` key id.
- Add `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL` as a
  probe-only callback URL for runtime state exchange.
- Keep peer URL, peer realm, peer pubkey, and replica out of build-time env; the
  peer config still comes only from the browser-delivered `township://pairing`
  handoff.
- Require exactly one onboarding state source: either legacy fixed `ARM_STATE`
  or runtime state-exchange URL, never both.
- No build-time `ARM_STATE` is allowed in the onboarding state-exchange probe
  build.
- Assert the no-state browser link is blocked before pairing is saved.
- Assert the accepted browser link uses the app-minted runtime state and then
  completes the onboarding pull-author-reload-push-report flow.
- Assert the runtime onboarding state is absent from `LATTICE_PROBE` logcat
  output.
- The runtime onboarding state must not be emitted to probe logs.

## Non-Goals

This does not prove chooser UI.
This does not prove cross-device pairing state exchange.
This does not prove authority origination.
This does not prove full mobile onboarding.

- No QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo
  proof, production remote TLS, production remote challenge protocol, or
  production remote state exchange.
- The loopback state-exchange callback is a bounded probe seam, not a
  cross-device confidentiality story.
- No root or issuer authority is minted by the app device.
- This plan does not move the browser-backed child-grant composition probe off
  its fixed build-time state; that remains a separate bounded slice.

## STOP Conditions

- Stop if the accepted browser page state still comes from a build-time
  `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE` constant.
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
- Stop if the smoke does not run the full onboarding pull-author-reload-push-
  report flow.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim chooser UI, cross-device pairing exchange, authority
  origination, QR camera, LAN, physical-device behavior, iOS, production TLS,
  production challenge security, browser-backed child-grant runtime state
  exchange, or full mobile onboarding.

## TDD Evidence

- RED: `npm run release:onboarding:contract` failed because
  `townshipReleaseOnboardingProbeConfigFromEnv/1` required fixed
  `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE` and ignored
  `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL`.
- GREEN: `npm run release:onboarding:contract` passes after the release
  onboarding probe parses a valid loopback exchange URL, rejects fixed-state plus
  exchange configuration, rejects non-loopback cleartext exchange URLs, and
  forwards runtime state exchange into the release pairing probe config without
  a fixed arm state.
- RED: `TOWNSHIP_RELEASE_ONBOARDING_BUILD_SCRIPT=tauri:android:build:release:onboarding-state-probe npx tsx test/tauri_android_release_browser_onboarding_probe.ts`
  failed because the state-exchange build script did not exist.
- GREEN: `npm run tauri:android:release:browser-onboarding-state-exchange`
  passes after the release APK publishes a runtime state to the probe-only
  loopback callback, blocks the browser-delivered no-state link, accepts the
  browser-delivered state-bearing link, completes the onboarding pull-author-
  reload-push-report flow, reports `post_materialized=true` and
  `bad_authority_reason=operation_not_granted`, drains the outbox, and verifies
  logcat does not contain the runtime state.
- RED: `npm run mobile:tauri-readiness` failed because this plan file was
  missing.
- GREEN: `npm run mobile:tauri-readiness` passes after docs and readiness
  wiring.

## Second Opinion

Claude Code approved this as the best next bounded slice after Plan 110 because
the browser-backed onboarding convergence probes still relied on a build-time
state constant. Claude specifically called out the invariants that the build
script must remove `ARM_STATE`, the runtime state-bearing browser link must
drive the full onboarding pull-author-reload-push-report flow, the no-state
negative control and log secrecy must remain, and the docs must avoid chooser,
cross-device, authority-origination, QR, LAN, physical-device, iOS, production
TLS, browser-backed child-grant runtime state, or full-mobile-onboarding claims.

## Verification

- `cd clients/township-tauri-shell && npm run release:onboarding:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-onboarding-state-exchange`
- `git diff --check`

## Remaining Work

- Browser-backed child-grant runtime state exchange remains unproven.
- Chooser UI remains unproven.
- Cross-device pairing state exchange remains unproven.
- Authority origination remains unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, production challenge security, and full mobile
  onboarding remain separate bounded plans.
