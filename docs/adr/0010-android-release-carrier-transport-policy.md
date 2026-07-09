# ADR 0010: Android Release Carrier Transport Policy

## Status

Accepted for Plan 085-089 characterization; release BEAM convergence remains unproven.

## Context

Plan 084 proved Android release APK canonical/wire fidelity inside the installed app without opening
a socket. The next unknown is the release WebView WebSocket transport surface used by the TS carrier
client. The Android release build keeps `usesCleartextTraffic=false`, uses the release build type
with local debug-keystore signing for emulator installability, and must not use WebView CDP for
release evidence.

## Observed Release Transport Behavior

Plan 085 observed a release-build-type APK launched with
`VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws://127.0.0.1:43185/carrier`. The smoke first proves the
host endpoint can complete a WebSocket `101 Switching Protocols` control handshake, checks the
device `adb reverse --list` registration, launches the app, and reads a tagged
`township-release-transport-probe` line from Android logcat.

Plan 087 reran the release smoke after the probe started requiring a post-handshake frame roundtrip
before `connected` and after adding a release-route device-originated shell control on port 43185.
The release APK still observed this negative result on July 9, 2026:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=46 message=transport_error
```

The host control path succeeded, the reverse mapping was registered, and the smoke recorded `server
webview stats after controls accepts=0 upgrades=0 framesEchoed=0`. Plan 087 proves the release-route
reverse tunnel can carry a device-originated non-WebView handshake from Android's shell UID to the
host probe server. That eliminates release-port tunnel/server-instance failure as the cause of the
WebView result, but it does not prove app-sandbox or WebView reachability because the control ran
outside the app process. The observation is
intentionally narrow: it describes WebView WebSocket behavior on loopback for one emulator/device
and Android version. The browser-style `onerror` event only gives the constant on-device
`transport_error` message, so this probe does not distinguish Android network security cleartext
policy, WebView mixed-content/origin policy, reverse-forwarding behavior, or other connection
failure. It does not prove LAN behavior, remote TLS behavior, BEAM protocol compatibility, carrier
authentication, Sync, or materialized `stateReport` convergence.

The bounded diagnostic excerpt from the recent unfiltered logcat capture contained WebView startup
and the probe line, but no root cause is asserted from it:

```text
07-09 03:39:20.341 13704 13704 I WebViewFactory: Loading com.google.android.webview version 113.0.5672.136 (code 567263634)
07-09 03:39:20.525 13704 13745 W chromium: [WARNING:dns_config_service_android.cc(115)] Failed to read DnsConfig.
07-09 03:39:21.692 13704 13801 I LATTICE_PROBE: township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=error elapsed_ms=46 message=transport_error
```

## Decision

Keep Android release defaults unchanged while treating Plan 085 as a policy characterization gate.
Because the observed loopback WebView WebSocket outcome is `error` and no server-side WebView
accept, upgrade, or echoed frame was observed at the host endpoint, the next implementation slice
must diagnose transport policy before attempting release BEAM convergence. Until then, the only
approved release transport claim is the observed loopback WebView WebSocket error outcome, the zero
observed server-side WebView accepts/upgrades/echoed frames, and the unresolved cause.

Plan 086 adds the first positive control for this instrument. A debug-build-type APK launched with
`VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws://127.0.0.1:43186/carrier` emitted:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=connected elapsed_ms=58 message=frame_roundtrip
```

The same smoke proved a host control WebSocket upgrade, a device-originated non-WebView reverse
control upgrade, and then recorded `server webview stats after controls accepts=1 upgrades=1
framesEchoed=1`. This proves the probe/harness can produce a positive on-device WebView result and
can carry a post-handshake frame roundtrip in the debug surface. It does not isolate the release
cause: debug and release still differ in cleartext policy, debuggability, JNI debuggability, and
minification.

Plan 087 adds the release-route reverse-tunnel control for port 43185. It proves the reverse mapping
and host probe server can carry a device-originated non-WebView handshake in the release smoke, but
only from Android's shell UID. It does not authorize a release WebView transport claim.

Plan 088 amends this ADR to authorize one separately identified, non-shippable, release-shaped
cleartext diagnostic APK. That artifact uses the release build type, remains non-debuggable and
minified, carries the `.cleartextdiag` application id suffix, and sets `usesCleartextTraffic=true`
only when `TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC=1` is present. This diagnostic is allowed
only to test whether cleartext policy is sufficient to explain the loopback WebView WebSocket
failure. It does not authorize blanket cleartext release defaults, a permissive production network
security config, release BEAM convergence, Sync, `stateReport`, or LAN claims.

The Plan 088 diagnostic APK observed this positive result on July 9, 2026:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=connected elapsed_ms=65 message=frame_roundtrip
```

The diagnostic smoke asserted the `.cleartextdiag` package identity, non-debuggable installed
package behavior, `usesCleartextTraffic=true` in the diagnostic APK manifest, host and device-shell
controls on port 43188, and server-observed diagnostic WebView stats
`accepts=1 upgrades=1 framesEchoed=1` after controls. The standard release artifact remains
separate and continues to assert `usesCleartextTraffic=false`. This confirms the narrow claim that
cleartext policy is sufficient to explain the loopback WebView WebSocket failure on this
emulator/WebView version. The next policy slice must test a loopback-scoped Android network
security configuration or another explicitly bounded release path instead of making
`usesCleartextTraffic=true` the release default.

Plan 089 adds a loopback-scoped Android network security config to the normal release app id. The
normal release APK keeps package id `dev.treetop.lattice.township`, keeps
`usesCleartextTraffic=false`, and points `android:networkSecurityConfig` at a release resource whose
compiled base policy denies cleartext while permitting cleartext only for `127.0.0.1` and
`localhost`. On an Android API 34 emulator/WebView, the release smoke first proved the `10.0.2.2`
host alias was reachable from Android's shell UID before app launch, then observed:

```text
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=loopback outcome=connected elapsed_ms=99 message=frame_roundtrip
township-release-transport-probe surface=webview-websocket url_scheme=ws host_class=android_host outcome=error elapsed_ms=32 message=transport_error
```

The smoke also asserted server stats after the host, loopback shell, and `10.0.2.2` shell controls
as `accepts=1 upgrades=1 framesEchoed=1`, proving the non-loopback cleartext WebView probe
(`ws://10.0.2.2:43185/carrier`) did not produce an additional accept, upgrade, or echoed frame. This
proof is scoped to Android API 26+ WebView behavior, because WebView honors app network-security
config only on that API range. It does not authorize remote cleartext, LAN transport,
physical-device claims, release BEAM convergence, Sync, or `stateReport`.

This ADR does not authorize a release BEAM convergence claim. It also does not authorize weakening
`usesCleartextTraffic=false`, adding a permissive network security base config, using debug WebView
CDP, or claiming physical LAN discovery.

## Consequences

- Plan 089's connected scoped-loopback observation can justify a single-device release convergence
  plan on the same Android API 26+ WebView boundary while still avoiding LAN and physical-device
  claims.
- This error observation is now attributed to cleartext policy for this emulator/WebView loopback
  route, but only through a non-shippable diagnostic APK. Normal release defaults remain unchanged.
- Plan 087 supplies the release-route reverse-tunnel control, Plan 088 supplies the cleartext
  sufficiency diagnostic, and Plan 089 supplies the normal-app-id scoped-loopback release policy
  candidate while requiring non-loopback cleartext to remain blocked.
- Physical multi-device LAN discovery and iOS key-reuse proof remain separate follow-ups.
