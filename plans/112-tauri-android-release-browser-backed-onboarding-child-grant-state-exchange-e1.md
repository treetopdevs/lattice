# Plan 112: Android release browser-backed onboarding child-grant state exchange (E1)

## Status

DONE

## Objective

Prove Android release browser-backed onboarding child-grant composition can use
an app-minted runtime state token instead of a build-time shared `ARM_STATE`
constant.

The non-debuggable release APK starts the existing release onboarding probe in a
fresh child-grant state namespace, arms the existing crypto-backed one-shot
pairing gate, publishes the generated 32-hex state to a probe-only loopback
exchange endpoint, and accepts only the browser-loaded pairing page that echoes
that runtime state. A no-state browser link and a well-formed wrong-state
browser link are blocked with `blocked_reason=state_mismatch`, then the runtime
state-bearing browser link saves pairing and drives the same child-grant
pull-grant-author-reload-push-
report flow as Plan 109: `grant_ops=post`, `outbox_frame_count=3`,
`accepted_count=3`, `grant_authority_accepted=true`,
`post_materialized=true`, `bad_authority_reason=operation_not_granted`, and a
drained outbox after relaunch.

## Scope

- Add `tauri:android:build:release:onboarding-grant-state-probe`,
  `tauri:android:release:browser-onboarding-grant-state-exchange:smoke`, and
  `tauri:android:release:browser-onboarding-grant-state-exchange`.
- Use a dedicated `township:release-onboarding-grant-state-probe` namespace and
  `township-release-onboarding-grant-state-resident` key id.
- Add `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL` as a
  probe-only callback URL for runtime state exchange.
- Keep `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY` so the
  same app-originated child-grant composition path runs after pairing.
- Keep peer URL, peer realm, peer pubkey, and replica out of build-time env; the
  peer config still comes only from the browser-delivered `township://pairing`
  handoff.
- Require exactly one onboarding state source: either legacy fixed `ARM_STATE`
  or runtime state-exchange URL, never both.
- No build-time `ARM_STATE` is allowed in the child-grant state-exchange probe
  build.
- Assert the no-state browser link is blocked before pairing is saved.
- Assert a well-formed wrong-state browser link is blocked before pairing is
  saved.
- Assert the accepted browser link uses the app-minted runtime state and then
  completes the child-grant pull-grant-author-reload-push-report flow.
- Assert the runtime onboarding child-grant state is absent from `LATTICE_PROBE`
  logcat output.

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
- The grant audience remains the bounded probe dummy audience, not a real
  second-device recipient or issuer authority.
- No root or issuer authority is minted by the app device.
- This plan closes the `{child grant, runtime state}` Android release browser
  probe cell; it is not new evidence for chooser, cross-device, QR/LAN,
  physical-device, or iOS behavior.

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
- Stop if the no-state or well-formed wrong-state browser link saves pairing
  before the runtime state is exchanged.
- Stop if the runtime state appears in probe logs.
- Stop if the smoke does not run the full child-grant pull-grant-author-reload-
  push-report flow.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim chooser UI, cross-device pairing exchange, authority
  origination, QR camera, LAN, physical-device behavior, iOS, production TLS,
  production challenge security, or full mobile onboarding.

## TDD Evidence

- RED: `TOWNSHIP_RELEASE_ONBOARDING_GRANT_BUILD_SCRIPT=tauri:android:build:release:onboarding-grant-state-probe npx tsx test/tauri_android_release_browser_onboarding_grant_probe.ts`
  failed because the grant-state build script did not exist.
- GREEN: `npm run tauri:android:release:browser-onboarding-grant-state-exchange`
  passes after the release APK publishes a runtime state to the probe-only
  loopback callback, blocks the browser-delivered no-state and well-formed
  wrong-state links with `blocked_reason=state_mismatch`, accepts the
  browser-delivered state-bearing link, completes the child-grant
  pull-grant-author-reload-push-report flow, reports `grant_ops=post`,
  `outbox_frame_count=3`, `accepted_count=3`, `grant_authority_accepted=true`,
  `post_materialized=true`, and `bad_authority_reason=operation_not_granted`,
  drains the outbox after relaunch, and verifies logcat does not contain the
  runtime state.
- RED: `npm run mobile:tauri-readiness` failed because this plan file was
  missing.
- GREEN: `npm run mobile:tauri-readiness` and `npm run mobile:strategy` pass
  after docs and readiness wiring.
- GREEN: `npm run release:onboarding:contract`, `npm run typecheck`, and
  `git diff --check` pass after the grant-state script and smoke wiring.

## Second Opinion

Claude Code approved this as the correct next bounded empty cell after Plans 109
and 111 because the fixed-state child-grant browser probe and the runtime-state
onboarding probe had not yet been composed. Claude specifically recommended
making the no-state block the load-bearing behavioral red, parameterizing the
existing child-grant smoke instead of forking another harness, asserting no
`ARM_STATE` in the new build, preserving the Plan 109 child-grant terminal
assertions, checking runtime-state log secrecy, and keeping docs clear that this
is combinatorial closure rather than chooser, cross-device, authority-
origination, QR/LAN, physical-device, iOS, production challenge, or full-mobile-
onboarding proof.

After the wrong-state negative control was added, Claude Code re-reviewed the
grant-state smoke and confirmed the well-formed one-character-wrong state closes
the earlier "presence versus value equality" coverage concern. Claude noted no
remaining blocker; the only follow-up is to later collapse the Plan 111 inline
state-exchange helpers into the shared support module.

## Verification

- `cd clients/township-tauri-shell && npm run release:onboarding:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-onboarding-grant-state-exchange`
- `git diff --check`

## Remaining Work

- Chooser UI remains unproven.
- Cross-device pairing state exchange remains unproven.
- Authority origination remains unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, production challenge security, and full mobile
  onboarding remain separate bounded plans.
