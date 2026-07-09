# Plan 088: Android release-shaped cleartext diagnostic (Tauri Android E1)

## Status

DONE

## Objective

Falsify or confirm the cheapest remaining release WebView transport hypothesis without weakening the
normal release APK. Build a separately identified, release-shaped diagnostic APK that changes only
the Android `usesCleartextTraffic` manifest value to `true`, keeps release minification and
non-debuggable package behavior, and bakes
`VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws://127.0.0.1:43188/carrier`.

If the diagnostic APK emits `outcome=connected message=frame_roundtrip` with server-observed WebView
accepts/upgrades/echoed frames, the approved claim is narrow: cleartext policy is sufficient to
explain the loopback WebView WebSocket failure on this emulator/WebView version. The artifact is a
release-shaped diagnostic APK, not an approved release default. It does not prove release BEAM
convergence.

## Scope

- Gate the diagnostic build with `TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC=1` read through
  Gradle's `providers.environmentVariable(...)` API.
- Give the diagnostic artifact a distinct application id suffix `.cleartextdiag` and version suffix
  `-cleartextdiag`.
- Assert the merged APK manifest from the built artifacts: standard release keeps
  `usesCleartextTraffic=false`; diagnostic release-shaped APK has `usesCleartextTraffic=true`.
- Add a diagnostic smoke that proves host and device-shell controls on port 43188, installs the
  non-debuggable diagnostic package, launches it, and requires a WebView frame roundtrip.
- Update ADR 0010, the build map, secure-store strategy, and plan index without authorizing blanket
  cleartext release defaults.

## Branches

- `connected`: cleartext policy is sufficient to explain the loopback WebView failure for this
  emulator/WebView version. The next plan should test a loopback-scoped network security config as a
  candidate release policy.
- `error`: the cleartext hypothesis is refuted or the manipulation failed. Stop, record the negative,
  and next run an in-app native networking control before touching policy again.

## STOP Conditions

- Stop if the standard release APK's merged manifest does not show `usesCleartextTraffic=false`.
- Stop if the diagnostic APK's merged manifest does not show `usesCleartextTraffic=true`.
- Stop if the diagnostic APK is debuggable, unminified, or lacks the `.cleartextdiag` package id.
- Stop if host and device-shell controls on port 43188 do not both pass before WebView launch.
- Stop if the diagnostic WebView emits `outcome=error`; do not escalate to a permissive base config,
  WebView CDP, or further policy weakening in this slice.
- Stop if the slice needs a BEAM peer, `Sync outbox`, `stateReport`, `10.0.2.2`, LAN, or a second
  device.

## TDD Evidence

- RED: `mobile:tauri-readiness` required the Plan 088 file, diagnostic build/smoke scripts,
  provider-based Gradle env input, distinct diagnostic identity, artifact manifest assertions, and
  no-convergence wording before those artifacts existed.
- RED: the diagnostic smoke caught that the first build script revision copied the diagnostic APK
  before the final normal release rebuild, allowing Gradle's cleaned output directory to delete the
  copied diagnostic artifact.
- RED: after fixing the build order, the diagnostic smoke caught that the port parser selected the
  normal release URL instead of the env-gated diagnostic URL.
- GREEN: the build script now builds the standard release first, parks that APK in a temporary
  directory outside Gradle's output, builds the diagnostic artifact, copies it to
  `app-universal-release-cleartextdiag.apk`, and restores the standard release APK.

## Second Opinion

Claude Code approved the diagnostic because Plans 085-087 left cleartext policy as the remaining
single-variable WebView-network delta between debug and release. Claude required artifact-level
manifest assertions, provider-based Gradle env reading, a distinct diagnostic package identity, and
an ADR amendment before running the diagnostic build.

Final Claude Code second opinion returned `PASS` after the green verification set. Its only
non-blocking follow-up was to consider asserting the diagnostic APK's `-cleartextdiag` version name
in the smoke as an additional artifact-identity guard.

## Observation

On July 9, 2026, the release-shaped cleartext diagnostic APK emitted:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=connected elapsed_ms=65 message=frame_roundtrip
```

The smoke asserted the diagnostic package id `dev.treetop.lattice.township.cleartextdiag`, a
non-debuggable installed package, `usesCleartextTraffic=true` in the diagnostic APK manifest, host
and device-shell controls on port 43188, and server-observed diagnostic WebView stats
`accepts=1 upgrades=1 framesEchoed=1` after controls. The standard release APK is restored beside
the diagnostic artifact and continues to assert `usesCleartextTraffic=false` through the standard
release transport smoke.

## Verification

- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:transport:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:cleartext-diagnostic:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:cleartext-diagnostic:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:debug:transport:smoke`
- `cd clients/township-tauri-shell && npm run release:transport:contract`
- `git diff --check`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- If connected, test a loopback-scoped cleartext network security config instead of blanket
  `usesCleartextTraffic=true`.
- If error, add an in-app native networking control to separate app-sandbox reachability from WebView
  policy.
- Non-blocking hardening: assert the diagnostic APK's `-cleartextdiag` version name in addition to
  package id and manifest cleartext policy.
