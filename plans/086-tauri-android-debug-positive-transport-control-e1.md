# Plan 086: Android debug-APK positive transport control (Tauri Android E1)

## Status

DONE

## Objective

Prove the Android transport probe instrument can produce a positive on-device WebView result before
any release BEAM convergence attempt. A debug-build-type APK with
`VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws://127.0.0.1:43186/carrier` must emit
`outcome=connected` only after a post-handshake WebSocket frame roundtrip, while the host endpoint
observes at least one WebSocket upgrade and echoed frame from the app.

This is not a release transport fix and does not isolate cleartext policy. Debug and release differ
in cleartext policy, debuggability, JNI debuggability, and minification, so the plan only proves the
probe/harness can move bytes in the debug surface. It does not prove release BEAM convergence,
carrier authentication, Sync, materialized `stateReport`, LAN behavior, or physical-device behavior.

## Scope

- Add a debug transport-probe build script on a distinct loopback port from the release probe.
- Extend the transport probe so `connected` means a WebSocket frame roundtrip, not merely `onopen`.
- Add a debug transport smoke that installs the debug APK, verifies the package is debuggable,
  registers `adb reverse`, runs a device-originated non-WebView control handshake, launches the app,
  and observes `outcome=connected` with server-side upgrades and echoed frames.
- Keep the release smoke as a negative characterization under unchanged release defaults; do not
  weaken `usesCleartextTraffic=false`, change release minification, use WebView CDP, start a BEAM
  peer, click `Sync outbox`, or assert `stateReport`.

## STOP Conditions

- Stop if the debug APK emits `outcome=error` or `timeout`; the Plan 085 release observation is then
  confounded by the harness and ADR 0010 must be weakened before further release work.
- Stop if debug emits `outcome=connected` but the host endpoint observes no completed WebSocket
  upgrade or no echoed frame from the WebView.
- Stop if the device-originated non-WebView reverse control fails; the reverse tunnel is not proven
  to carry device-originated bytes.
- Stop if the slice needs WebView CDP, a BEAM node, `Sync outbox`, `stateReport`, `10.0.2.2`, a
  release cleartext override, a permissive network security config, or a release minification change.

## TDD Evidence

- RED: `test/township_release_transport_probe.ts` required a `message=frame_roundtrip` connected
  result before `src/township_release_transport_probe.ts` sent or awaited any WebSocket frame.
- RED: `mobile:tauri-readiness` required the debug transport script, smoke, plan, and no-CDP/no-BEAM
  claim boundary before those artifacts existed.

## Second Opinion

Claude Code approved this as the right post-085 control with one scope correction: call it a
debug-APK positive transport control, not transport-policy isolation. The approved claim is that the
instrument works in the debug surface; the cause of the release `outcome=error` remains unresolved.
Claude's completion review passed the implementation and required recording the post-frame-roundtrip
release re-observation before marking the plan done.

## Observation

The debug transport smoke observed this logcat payload on July 9, 2026:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=connected elapsed_ms=58 message=frame_roundtrip
```

The host endpoint also recorded `server webview stats after controls accepts=1 upgrades=1
framesEchoed=1` after a host WebSocket control and a device-originated non-WebView reverse control.
This proves the env-gated WebView probe can reach the host through `adb reverse` and complete a
post-handshake frame roundtrip in the debug surface. It does not prove release transport, does not
isolate cleartext policy as the release failure cause, and does not prove release BEAM convergence.

The release transport smoke was rerun after the probe started requiring a frame roundtrip before
`connected`. It still observed the release WebView negative on July 9, 2026:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=85 message=transport_error
```

The release smoke recorded `server webview stats after host control accepts=0 upgrades=0
framesEchoed=0`, so the release result remains a transport characterization and not a BEAM
convergence claim.

## Verification

- `cd clients/township-tauri-shell && npm run release:transport:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:debug:transport:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:transport-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:transport:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Use the positive debug control to design the next release transport diagnostic without claiming
  release convergence.
- Keep release mobile BEAM convergence blocked until a reachable release transport policy is proven
  and the app sync path runs against a BEAM peer without debug-only affordances.
