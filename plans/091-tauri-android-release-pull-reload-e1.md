# Plan 091: Android release pull-and-reload persistence (Tauri Android E1)

## Status

DONE

## Objective

Use the Plan 089 loopback-scoped release transport policy and the Plan 090 trusted BEAM handshake
shape to prove one narrow release persistence path: a non-debuggable, normal-app-id Android release
APK can pull existing Township carrier frames from a trusted BEAM peer, persist the resulting local
ops and delegation frames in shipped app storage, and reload those same ids after
force-stop/relaunch with the BEAM peer offline.

This is a release pull + KV reload proof in a dedicated probe namespace. It does not prove release device authoring, push, outbox drain, pairing ceremony, or full mobile onboarding.

## Scope

- Add an env-gated release startup probe that creates the real native workflow, announces
  `public_key_b64url`, reloads app storage, then runs the existing `syncTownshipOutbox` pull path.
- Use the dedicated probe namespace `township:release-sync-probe` and key id
  `township-release-sync-resident` so the proof cannot be confused with the normal app namespace.
- Bake only a loopback release peer URL, realm names, expected peer pubkey, replica id, namespace,
  and bounded retry timing into the dedicated release sync-probe build.
- Keep the smoke non-CDP: install the release APK, assert the normal package id, assert
  non-debuggable package metadata, assert `usesCleartextTraffic=false`, assert the compiled
  loopback-only network-security config, observe only logcat, spawn BEAM peers from the host, and
  use `adb reverse` to map the release loopback port.
- Prove a same-realm wrong-peer negative before the success path.
- Compare logcat `pulled_op_ids`, `local_op_ids`, and `delegation_frame_ids` to host-derived ids
  from the BEAM carrier vector rather than accepting counts alone.
- Force-stop the app, remove the BEAM peer/reverse mapping, relaunch offline, and prove the reload
  phase reports the same persisted local op and delegation frame ids.
- Update the build map, mobile secure-store strategy, and plan index without claiming full
  release Sync/outbox/KV convergence.

## Non-Goals

- No WebView CDP connection, debug APK fallback, UI command automation, `run-as`, native KV
  inspection, host-side frame injection into release private storage, or release command channel.
- No on-device authoring, post submission, grant/revoke authoring, push path, outbox-drain proof,
  pairing ceremony, QR/deep-link onboarding, discovery, LAN, TLS, iOS, Expo, or physical-device
  proof.
- No production transport policy beyond the emulator loopback-scoped release policy already
  documented by Plans 089-090.

## STOP Conditions

- Stop if the smoke needs WebView CDP, a debuggable package, debug APK, `run-as`, a host KV read,
  or direct host injection into release app storage.
- Stop if the probe uses the normal `TOWNSHIP_STORAGE_NAMESPACE` instead of the dedicated probe
  namespace `township:release-sync-probe`.
- Stop if any logcat line includes frame bodies, caps, signatures, seeds, private key material, or
  secrets.
- Stop if the success proof compares only counts rather than exact host-derived op/delegation ids.
- Stop if the wrong-peer path can produce `outcome=synced`.
- Stop if docs imply release device authoring, push, outbox drain, pairing ceremony, full mobile
  onboarding, iOS/Expo parity, physical-device behavior, or unqualified release Sync/outbox/KV
  convergence.

## TDD Evidence

- RED: `release:sync:contract` initially failed because `src/township_release_sync_probe.ts` did
  not exist.
- RED: `mobile:tauri-readiness` required this Plan 091 file, package scripts, app startup wiring,
  Android smoke assertions, and no-overclaim docs before the plan/docs were present.

## Second Opinion

Claude Code reviewed the next-slice plan before implementation and rejected a broad "release
Sync/outbox/KV convergence" claim as too large for one step. The recommended slice was release pull
plus persisted reload only: prove the release app acquires frames over the wire from a trusted BEAM
peer, prove the shipped JSON stores retain the resulting ids across cold restart, keep the namespace
probe-only, and leave release authoring/push/onboarding for later plans.

## Observation

On July 9, 2026, the release sync-probe APK built at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` with the
normal package id `dev.treetop.lattice.township`, non-debuggable release package metadata,
`usesCleartextTraffic=false`, and the compiled loopback-scoped network-security config from
Plan 089.

The release smoke ran on an Android API 34 emulator, which is inside the Android API 26+ WebView
network-security config support boundary. The same-realm wrong-key BEAM peer produced no successful
sync and logged:

- `township-release-sync-probe phase=sync outcome=timeout elapsed_ms=8308 message=carrier_hello_pubkey_mismatch`

The success path launched the release app with an empty probe namespace, observed the native key:

- `township-release-sync-probe phase=native_key local_realm=resident storage_namespace=township:release-sync-probe public_key_b64url=mvwT2IfeFd3Jix239oUBD0GH1cz0GLYlWnPlyhtHeI0`

After the host spawned the trusted `LatticeNodeSpike.TownshipScenario` peer, asserted that the
peer's announced public key matched the release-baked
`VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY`, and mapped `adb reverse tcp:43191` to that peer,
the release app pulled the four host-derived W1 carrier ids and logged:

- `township-release-sync-probe phase=sync outcome=synced elapsed_ms=1184 pulled_op_ids=54k0ylcLeVyalnNtBaXdTN1Um356AFxOb-R9foEBOo0,C-SorKNoOhygkiAYGooEeCbGVj-_ThX__meOl2RXKt4,Spi9_nVdmF9h0E9z-eGIRoZccgHFxCLJzQfOhHvPW8c,tysTDHsBwKwkX50bCzSsaQlYOp1Qe6bRI-sY7zkgvHo local_op_ids=54k0ylcLeVyalnNtBaXdTN1Um356AFxOb-R9foEBOo0,C-SorKNoOhygkiAYGooEeCbGVj-_ThX__meOl2RXKt4,Spi9_nVdmF9h0E9z-eGIRoZccgHFxCLJzQfOhHvPW8c,tysTDHsBwKwkX50bCzSsaQlYOp1Qe6bRI-sY7zkgvHo delegation_frame_ids=54k0ylcLeVyalnNtBaXdTN1Um356AFxOb-R9foEBOo0,C-SorKNoOhygkiAYGooEeCbGVj-_ThX__meOl2RXKt4,Spi9_nVdmF9h0E9z-eGIRoZccgHFxCLJzQfOhHvPW8c,tysTDHsBwKwkX50bCzSsaQlYOp1Qe6bRI-sY7zkgvHo carrier_frame_count=0 pushed_frame_count=0 accepted_count=0`

The host then killed the BEAM peer, removed the reverse mapping, force-stopped the app, cleared
logcat, relaunched the release app offline, and observed the same persisted ids from app storage:

- `township-release-sync-probe phase=reload outcome=loaded local_op_ids=54k0ylcLeVyalnNtBaXdTN1Um356AFxOb-R9foEBOo0,C-SorKNoOhygkiAYGooEeCbGVj-_ThX__meOl2RXKt4,Spi9_nVdmF9h0E9z-eGIRoZccgHFxCLJzQfOhHvPW8c,tysTDHsBwKwkX50bCzSsaQlYOp1Qe6bRI-sY7zkgvHo delegation_frame_ids=54k0ylcLeVyalnNtBaXdTN1Um356AFxOb-R9foEBOo0,C-SorKNoOhygkiAYGooEeCbGVj-_ThX__meOl2RXKt4,Spi9_nVdmF9h0E9z-eGIRoZccgHFxCLJzQfOhHvPW8c,tysTDHsBwKwkX50bCzSsaQlYOp1Qe6bRI-sY7zkgvHo carrier_frame_count=0`

This proves release pull plus replayable local op/delegation-frame reload in the dedicated probe
namespace only. It does not prove release device authoring, push, outbox drain, pairing ceremony,
full mobile onboarding, iOS/Expo parity, physical-device behavior, LAN discovery, or production
remote TLS.

## Verification

- `cd clients/township-tauri-shell && npm run release:sync:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:sync-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:sync:smoke`

## Remaining Work

- Add a later release device-authoring/push/outbox-drain proof.
- Add a later full mobile onboarding proof that starts from pairing ceremony rather than baked
  probe env.
- Keep iOS, Expo, physical-device LAN discovery, and production TLS transport proofs separate.
