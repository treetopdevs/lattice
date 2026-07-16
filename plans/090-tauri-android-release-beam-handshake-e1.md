# Plan 090: Android release BEAM carrier handshake (Tauri Android E1)

## Status

DONE

## Objective

Use the Plan 089 loopback-scoped release transport policy to prove one narrow release-mode BEAM
carrier capability: a non-debuggable, normal-app-id Android release APK can announce its native
carrier public key, connect to a real `lattice_node_spike` Township BEAM peer over loopback, complete
the authenticated carrier handshake, read carrier `status`, and request a carrier state report.

This is a release BEAM carrier handshake/status/state-report proof. It does not prove release
Sync/outbox/KV convergence, full app convergence, full mobile onboarding, LAN discovery, physical
device behavior, production remote cleartext, or a release command channel.

## Scope

- Add an env-gated release startup probe that uses the native Tauri signer and real
  `connectCarrierWebSocket` path.
- Emit a first `LATTICE_PROBE` logcat line with `phase=native_key` and `public_key_b64url` so the
  host can start a BEAM peer that trusts the Android release app's native public key.
- Retry a bounded carrier connection to `ws://127.0.0.1:43190/carrier` until the peer and
  `adb reverse` mapping are ready.
- On connection, emit `phase=carrier outcome=connected status=base op_count=...` and
  `authority_quarantine_count=...`.
- Keep the smoke non-CDP: install the release APK, assert normal package id, assert non-debuggable,
  assert `usesCleartextTraffic=false`, assert the compiled loopback-only network-security config,
  observe only logcat, spawn the BEAM peer from the host, and use `adb reverse` to map the release
  loopback port to the peer.
- Update the build map, mobile secure-store strategy, and plan index without claiming release
  Sync/outbox/KV convergence.

## Non-Goals

- No `Sync outbox` click, WebView CDP connection, debug APK fallback, UI command automation, or
  native KV inspection.
- This slice does not add a release command channel.
- No proof that release replayable state reloads after restart.
- No proof that a release app can author, persist, push, pull, or materialize Township commands.
- No production remote transport policy, TLS policy, LAN discovery, iOS proof, Expo proof, or
  physical-device proof.

## STOP Conditions

- Stop if the release smoke needs WebView CDP, a debuggable package, or a debug APK.
- Stop if the slice needs a release command channel, UI automation seam, or native KV inspection.
- Stop if the probe cannot announce `public_key_b64url` before the host starts the trusted BEAM peer.
- Stop if the BEAM peer is not configured to trust the Android native public key.
- Stop if the probe cannot use the same loopback-scoped release network-security policy from
  Plan 089.
- Stop if the carrier result cannot be observed through logcat without claiming Sync/outbox/KV
  behavior.
- Stop if docs imply full release app convergence, release Sync/outbox/KV convergence, LAN transport,
  or phone-grade mobile onboarding.

## TDD Evidence

- RED: `release:beam:contract` required release probe env parsing, native-key log shape, bounded
  retry, carrier status/state-report logging, and no CDP/Sync wording before the probe module
  existed.
- RED: `mobile:tauri-readiness` required this Plan 090 file, package scripts, probe wiring, Android
  smoke assertions, and no-overclaim docs before the plan/docs were present.

## Second Opinion

Claude Code reviewed the next-slice plan before implementation and recommended keeping this below a
full release convergence claim: prove only the release app's real BEAM carrier handshake and
status/report read, avoid a release command channel, avoid Sync/outbox/KV inspection, and keep the
trusted-peer setup explicit because the BEAM peer needs the Android native public key before
accepting the session.

## Observation

On July 9, 2026, the release beam-probe APK built at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` with the
normal package id `dev.treetop.lattice.township`, non-debuggable release package flags,
`usesCleartextTraffic=false`, and the compiled loopback-scoped network-security config from
Plan 089.

The release smoke ran on an Android API 34 emulator, which is inside the Android API 26+ WebView
network-security config support boundary. After launch, the app emitted:

- `township-release-beam-probe phase=native_key local_realm=resident public_key_b64url=rFY1tuwnYRNzIvkH527fDzbRGF_51hFMsYJ1zsa5Fug`
- `township-release-beam-probe phase=carrier url_scheme=ws host_class=loopback outcome=connected elapsed_ms=3846 status=base op_count=4 authority_quarantine_count=0`

The host spawned a same-realm wrong-key BEAM peer first, mapped `adb reverse tcp:43190` to that
peer, and observed no connected release carrier log. It then removed that mapping, spawned the
`LatticeNodeSpike.TownshipScenario` peer, asserted the peer's announced session pubkey matched the
release-baked `VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY`, configured that BEAM peer to trust the
Android key, and mapped `adb reverse tcp:43190` to the trusted peer's host port. This proves release
BEAM carrier handshake/status/state-report behavior over scoped loopback only. It does not prove
release Sync/outbox/KV convergence, release replayed-state reload, full app convergence, or full
mobile onboarding.

## Verification

- `cd clients/township-tauri-shell && npm run release:beam:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:beam-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:beam:smoke`

## Remaining Work

- Use this release carrier handshake proof as the entry point for a later release Sync/outbox/KV
  convergence smoke.
- Keep full mobile onboarding, physical-device LAN discovery, remote TLS, iOS, and Expo proofs as
  separate plans.
