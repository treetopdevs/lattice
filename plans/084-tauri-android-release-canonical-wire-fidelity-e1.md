# Plan 084: Tauri Android release APK canonical/wire fidelity (E1)

## Status

DONE

## Objective

Prove the release-build-type (debug-keystore signed), R8-enabled Android APK preserves the
Township canonical/wire encoding that BEAM exported for the W1 carrier vector before attempting
release-mode carrier networking. The proof must use an on-device observation path that is
available in both debug and release variants and must not rely on WebView CDP, cleartext
networking, or a BEAM peer. The release delta exercises the release Rust profile and R8'd Android
host shell around the unchanged WebView bundle.

## Scope

- Add a permanent, non-secret Android startup probe that computes canonical bytes from the bundled
  TS codec and logs only a tagged digest; keep
  `township://probe/canonical?vector=township_carrier_w1` as a diagnostic ingress, but do not make
  the release proof depend on Android deep-link delivery timing.
- Add a release-available native log command so the probe can be observed through Android logcat
  without enabling debug WebView tooling.
- Compare debug and release APK probe digests against the BEAM-exported canonical vector fixture.
- Keep `usesCleartextTraffic=false`, release minification/R8 enabled, and the Plan 083 release
  build/install boundary intact.
- Keep release mobile BEAM convergence, release-mode network policy, iOS key reuse, full
  onboarding beyond Plan 082's pull-based cap acquisition, and physical multi-device LAN discovery
  out of scope.

## STOP Conditions

- If the probe requires `android:debuggable=true`, WebView CDP, `usesCleartextTraffic=true`,
  disabling minification/R8, or a debug-only code path, stop.
- If the probe needs a socket, a BEAM node, or a second device, stop and split the transport work
  into a later plan.
- If release canonical bytes diverge from the BEAM fixture and the cause is not a release
  packaging/R8 host-shell configuration issue, leave the failing evidence and open a correctness-fix plan instead of
  hiding it inside the harness.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED: `test/township_canonical_probe.ts` names the deep-link parser, canonical digest result,
  and release-available native probe log command before those seams exist.
- RED/GREEN: `mobile:tauri-readiness` will pin the package scripts, non-CDP release probe smoke,
  release-available native log command, and docs claim boundary.
- GREEN: `test/tauri_android_release_canonical_probe.ts` installs both debug and release APKs,
  launches the shell with an explicit canonical probe intent, reads the startup `LATTICE_PROBE`
  logcat output by probe prefix instead of expected digest, confirms the installed release package
  is not debuggable, and compares both captured digests to the BEAM-exported fixture digest.

## Second Opinion

Claude Code recommended this as the smallest honest post-083 slice:

- Do not attempt release BEAM convergence yet because release observation and release transport
  policy are independent blockers.
- First prove release-build-type canonical/wire fidelity through a variant-invariant on-device
  surface before attempting release transport.
- Do not weaken Android release cleartext defaults, disable R8, or use debug-only CDP to make a
  release convergence claim.
- During implementation, Tauri Android deep-link delivery proved too timing-dependent for the proof
  harness: diagnostics could see the URL later, but the app listener did not receive it reliably.
  The diagnostic route remains, while the proof moved to an Android startup logcat probe.
- Follow-up review found and fixed two claim-boundary defects before DONE: the objective now says
  debug-keystore-signed release build type instead of implying a production release signing identity,
  and the smoke captures probe lines by structural log markers before asserting the actual digest.
  The release leg also verifies a positive `dumpsys package` section anchor before asserting
  `DEBUGGABLE` is absent.

## Verification

- `cd clients/township-tauri-shell && npm run canonical:probe:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release`
- `cd clients/township-tauri-shell && npm run tauri:android:release:canonical:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Decide release carrier transport policy without weakening release defaults by accident.
- Prove single-device release APK BEAM convergence after release transport is explicit.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Run a physical multi-device LAN discovery smoke.
