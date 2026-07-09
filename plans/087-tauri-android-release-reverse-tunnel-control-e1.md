# Plan 087: Android release-route reverse-tunnel control (Tauri Android E1)

## Status

DONE

## Objective

Remove one confound from the Android release transport characterization before any release BEAM
convergence attempt. The release transport smoke must prove that the `adb reverse` mapping on the
release probe port (`ws://127.0.0.1:43185/carrier`) can carry a device-originated non-WebView
WebSocket control handshake to the host, then preserve the existing release WebView observation:
`outcome=error` with zero WebView accepts, upgrades, or echoed frames.

This proves only the release-route reverse tunnel from Android's shell UID. It does not prove release
WebView transport, app-sandbox network access, cleartext-policy root cause, mixed-content/origin
policy, release carrier sync, or release BEAM convergence. It does not prove release BEAM
convergence.

## Scope

- Hoist the Android device-originated WebSocket control into shared smoke support.
- Rebaseline the release transport smoke after both host and device-shell controls, then keep the
  WebView delta pinned to zero accepts, zero upgrades, and zero echoed frames.
- Make the probe server accept HTTP upgrade headers split across TCP chunks.
- Capture a bounded diagnostic slice from recent unfiltered logcat after the release probe and record
  it as evidence, without asserting a root cause.
- Update the release transport ADR, build map, secure-store strategy, and plan index with the shell
  UID caveat.

## STOP Conditions

- Stop if the release-route device-originated control on port 43185 fails; the release observation is
  then confounded by the tunnel/server mapping and the ADR must be weakened before further release
  work.
- Stop if the release WebView emits `outcome=connected`; Plans 085/086 and ADR 0010 must be corrected
  before any convergence work.
- Stop if the slice needs `android:usesCleartextTraffic=true`, a permissive network security config,
  release minification changes, WebView CDP, a BEAM peer, `Sync outbox`, `stateReport`, `10.0.2.2`,
  LAN discovery, or a second device.

## TDD Evidence

- RED: `mobile:tauri-readiness` required Plan 087, a shared Android WebSocket control helper, release
  smoke device-control wording, and ADR/build-map strategy updates before those artifacts existed.
- RED: the release transport smoke observed `accepts=2` but `upgrades=1` for the control phase,
  exposing that the probe server assumed the full HTTP upgrade arrived in one TCP chunk.
- GREEN: the probe server now accumulates handshake bytes until the header terminator before parsing;
  the release smoke then passed with the device-shell control and zero WebView delta.

## Second Opinion

Claude Code approved this as a valid next diagnostic because Plan 086 proved the debug-port tunnel,
not the release-port tunnel. Claude required the shell UID caveat, explicit STOP conditions for
device-control failure and unexpected release `connected`, and no claim that the release failure cause
is isolated.

## Observation

The release transport smoke observed this logcat payload on July 9, 2026 after both host and
device-originated shell controls passed on port 43185:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=46 message=transport_error
```

The smoke recorded `server webview stats after controls accepts=0 upgrades=0 framesEchoed=0`. The
device-originated control used `adb shell` and therefore ran as Android's shell UID outside the app
sandbox; it proves the release-route reverse tunnel and host probe server can carry device-originated
bytes, not that the release WebView/app process can.

The bounded diagnostic excerpt from the recent unfiltered logcat capture contained WebView startup
and the probe line, but no asserted root cause:

```text
07-09 03:39:20.341 13704 13704 I WebViewFactory: Loading com.google.android.webview version 113.0.5672.136 (code 567263634)
07-09 03:39:20.525 13704 13745 W chromium: [WARNING:dns_config_service_android.cc(115)] Failed to read DnsConfig.
07-09 03:39:21.692 13704 13801 I LATTICE_PROBE: township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=46 message=transport_error
```

## Verification

- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:release:transport:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:debug:transport:smoke`
- `cd clients/township-tauri-shell && npm run release:transport:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `git diff --check`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Diagnose release WebView/app-process transport policy directly. This plan eliminates the
  release-route tunnel/server mapping as the cause, but leaves cleartext policy, WebView
  mixed-content/origin policy, and app-sandbox network access unresolved.
- Keep release mobile BEAM convergence blocked until the release WebView transport path is reachable
  without debug-only affordances.
