# Plan 085: Release-APK carrier transport characterization (Tauri Android E1)

## Status

DONE

## Objective

Characterize the release-build-type Android APK's WebView WebSocket transport behavior on loopback
before attempting release BEAM convergence. This is not a convergence proof: the output is a
bounded on-device observation plus a release transport policy ADR. The plan must preserve
`usesCleartextTraffic=false`, avoid WebView CDP, avoid a BEAM peer, and avoid any claim about LAN
or multi-device behavior.

## Scope

- Add a build-time-gated Android startup probe controlled by
  `VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL`; ordinary builds do not open a probe socket.
- Probe only the WebView WebSocket transport surface used by the TS carrier client, and emit a
  tagged `LATTICE_PROBE` logcat line with surface, URL scheme, host class, outcome, and timing.
- Add a release transport smoke that installs the release APK, verifies the installed package is
  non-debuggable, maps device loopback with `adb reverse`, starts a minimal host WebSocket upgrade
  endpoint, launches the app, and records the observed probe line.
- Add an ADR that records the observed loopback behavior and chooses the next release transport
  policy step without authorizing release BEAM convergence.
- Keep second-device LAN discovery, TLS provisioning, remote cert policy, BEAM sync, `stateReport`,
  full onboarding, and release mobile BEAM convergence out of scope.

## STOP Conditions

- Stop if the probe requires `android:usesCleartextTraffic=true`, a permissive base network
  security config, WebView CDP, a debug-only command, a BEAM node, or a second device.
- Stop if the smoke needs `10.0.2.2`, `Sync outbox`, `stateReport`, or a convergence assertion.
- Stop if the ADR is written as a transport decision before the release probe observation exists.
- Stop if the local toolchain tries to run BEAM through Homebrew or mise shims; use the asdf rule
  from `AGENTS.md`.

## TDD Evidence

- RED: `test/township_release_transport_probe.ts` names the env-gated WebView transport probe,
  host classification, structured log line, and native log command seam before the source exists.
- RED/GREEN: `mobile:tauri-readiness` pins the package scripts, release transport smoke,
  no-CDP/no-BEAM/no-`10.0.2.2` boundary, Plan 085, and the release transport policy ADR.
- GREEN: `test/tauri_android_release_transport_probe.ts` observes the release APK transport probe
  through logcat after `adb reverse` loopback mapping without claiming carrier convergence.

## Observation

The release transport smoke observed this logcat payload on July 9, 2026:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=33 message=transport_error
```

The smoke first proved the host WebSocket endpoint with a `101 Switching Protocols` control
handshake, verified the `adb reverse` mapping was registered, then recorded zero observed
server-side WebView connection attempts. Plan 087 later reran the same release route with an
additional device-originated shell control on port 43185 and recorded `server webview stats after
controls accepts=0 upgrades=0 framesEchoed=0`. That characterizes the current release WebView
WebSocket loopback path as an error with zero observed server-side WebView accepts/upgrades/echoed
frames under unchanged release defaults. The Plan 087 control proves the reverse tunnel from
Android's shell UID, but does not prove release WebView/app-sandbox reachability, release carrier
sync, or release BEAM convergence. The browser-style `onerror` event only yields the constant
`transport_error` message on device, so this slice does not distinguish cleartext policy,
mixed-content/origin policy, app-sandbox network policy, or another connection failure.

## Second Opinion

Claude Code recommended this as the smallest honest post-084 slice:

- Do not attempt release BEAM convergence until release transport behavior is characterized.
- Treat cleartext blocks as findings, not as a reason to weaken release defaults.
- Keep the claim to "release transport does X on loopback on this device and Android version."
- Defer physical LAN discovery and iOS because they stack additional unknowns.

## Verification

- `cd clients/township-tauri-shell && npm run release:transport:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:transport:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Use the ADR decision to implement the next release transport/convergence slice.
- Completed follow-ups: Plan 086 added a debug-APK positive transport control, and Plan 087 added a
  release-route device-originated shell control for the reverse tunnel.
- The release transport smoke intentionally pins the current negative characterization
  (`outcome=error`, zero observed server-side WebView accepts/upgrades/echoed frames); update that
  characterization when release transport policy changes.
- Prove single-device release APK BEAM convergence after release transport is explicit.
- Re-run iOS simulator archive/key-reuse proof after the local Xcode/Tauri Swift-package blocker
  clears.
- Run a physical multi-device LAN discovery smoke after release transport and discovery policy are
  no longer confounded.
