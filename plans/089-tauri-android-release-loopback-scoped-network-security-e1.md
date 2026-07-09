# Plan 089: Android release loopback-scoped network security (Tauri Android E1)

## Status

DONE

## Objective

Replace the non-shippable blanket-cleartext diagnostic finding with a normal-app-id release APK
policy candidate that allows only the emulator loopback WebView probe route. The standard release APK
must keep `usesCleartextTraffic=false`, keep the package id `dev.treetop.lattice.township`, attach a
compiled Android network-security config whose base policy denies cleartext, and permit cleartext
only for `127.0.0.1` and `localhost`.

The approved claim is narrow: on an Android API 26+ emulator/WebView, a normal-app-id release APK can
complete a `ws://127.0.0.1:43185/carrier` WebView frame roundtrip through a loopback-scoped network
security config while a non-loopback cleartext control (`ws://10.0.2.2:43185/carrier`) remains
blocked with zero additional server accepts. This is not release BEAM convergence, Sync,
`stateReport`, LAN discovery, physical-device proof, or a production remote cleartext policy.

## Scope

- Add release and debug Android network-security config resources.
- Attach the release config to the normal release APK while keeping `usesCleartextTraffic=false`.
- Keep debug and the historical `.cleartextdiag` diagnostic on a permissive config so existing
  controls still mean what their plans say.
- Build the normal release transport-probe APK with two URLs:
  `ws://127.0.0.1:43185/carrier` and `ws://10.0.2.2:43185/carrier`.
- Assert the normal release APK's merged manifest and compiled network-security config with
  `apkanalyzer` and `aapt2 dump xmltree`.
- Assert the smoke device is Android API 26+ because WebView honors app network-security config only
  on that API range.
- Update ADR 0010, the mobile secure-store strategy, the build map, and the plan index without
  claiming release BEAM convergence.

## STOP Conditions

- Stop if the normal release APK package id changes from `dev.treetop.lattice.township`.
- Stop if the normal release APK merged manifest does not keep `usesCleartextTraffic=false`.
- Stop if the compiled release network-security config does not deny base cleartext and permit only
  the loopback domains `127.0.0.1` and `localhost`.
- Stop if the smoke device reports Android API < 26.
- Stop if the loopback WebView probe fails to emit `outcome=connected message=frame_roundtrip`.
- Stop if the `10.0.2.2` non-loopback cleartext control produces an extra server accept, upgrade, or
  echoed frame.
- Stop if the slice needs BEAM, Sync, `stateReport`, LAN discovery, a second device, or WebView CDP.

## TDD Evidence

- RED: `release:transport:contract` required the new multi-URL probe API before it existed.
- RED: `mobile:tauri-readiness` required the Plan 089 file and Android network-security resources
  before they existed.
- RED: the release transport smoke now expects loopback `connected`, non-loopback `error`, API 26+
  proof, and compiled network-security config assertions before the release APK implements that
  policy.

## Second Opinion

Claude Code passed the Plan 089 scope with corrections: keep the normal app id and every other
release-build variable fixed, inspect the compiled resource with `aapt2` rather than relying only on
the manifest, add a non-loopback cleartext negative control in the same release smoke, and record the
Android API 26+ WebView caveat in the plan and docs.

## Observation

On July 9, 2026, the normal release transport-probe APK built at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` with the
normal package id `dev.treetop.lattice.township`, `usesCleartextTraffic=false`, and a compiled
`xml/township_release_network_security_config` resource whose base policy denies cleartext while its
domain policy permits only `127.0.0.1` and `localhost`.

The release smoke ran on an Android API 34 emulator and first proved the `10.0.2.2` host alias was
reachable from Android's shell UID before app launch. The loopback WebView probe emitted
`outcome=connected message=frame_roundtrip`; the non-loopback `10.0.2.2` WebView probe emitted
`outcome=error message=transport_error`; and server stats after the host, loopback shell, and
`10.0.2.2` shell controls were exactly `accepts=1 upgrades=1 framesEchoed=1`. That proves only the
scoped loopback release WebView path, not release BEAM convergence.

## Verification

- `cd clients/township-tauri-shell && npm run release:transport:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:transport:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:debug:transport:smoke`
- `git diff --check`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Use this scoped release transport path for the next release mobile BEAM convergence attempt.
- Keep remote TLS, LAN transport, physical-device proof, and production remote cleartext policy as
  separate follow-ups.
