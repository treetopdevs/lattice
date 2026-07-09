# Plan 083: Tauri Android release APK build readiness (E1)

## Status

DONE

## Objective

Turn Android release packaging from an untested roadmap gap into a bounded build/install proof: the
repo must provide a `tauri:android:build:release` command that assembles an Android release APK
through the real Tauri/Gradle path, signs it locally for emulator installability without committing
signing secrets, and proves that APK installs and launches on an emulator without relying on
debug-only WebView CDP.

## Scope

- Add a package-level `tauri:android:build:release` command.
- Add a package-level `tauri:android:release:smoke` command.
- Configure the generated Android release build to use the existing local Android debug keystore
  for installability only. This is not production app-store signing.
- Keep release minification enabled so the build exercises the real release/R8 path.
- Install the release APK on an emulator, clear app data, launch it, and assert a stable app process
  with `adb pidof`.
- Keep release mobile BEAM convergence, release-mode network policy, iOS key reuse, Expo, and
  physical multi-device LAN discovery out of scope.

## STOP Conditions

- If a release keystore, private signing key, password, or signing properties file with secrets must
  be committed to the repo, stop.
- If the release build can only pass by disabling release minification/R8, stop and record the
  blocker.
- If the release smoke installs a debug APK or uses debug-only WebView CDP, stop.
- If docs claim release mobile BEAM convergence, release-mode carrier networking, iOS proof, or
  phone-grade equivalence from this build/install smoke, stop.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED/GREEN: `mobile:tauri-readiness` asserts the release build package script, release smoke
  package script, generated Gradle release signing/minification configuration, release smoke file,
  and build-map wording that separates release build/install readiness from release BEAM
  convergence.
- GREEN: `test/tauri_android_release_smoke.ts` installs the generated
  `app-universal-release.apk`, clears app data, launches the installed app, checks `pidof`, and
  waits briefly to prove the release process stays alive without touching WebView devtools, carrier
  sync, or BEAM.

## Second Opinion

Claude Code reviewed the remaining build-map gaps and recommended splitting Android release work:

- Plan 083 should prove release APK build/readiness only.
- Release BEAM convergence should be a later plan because release signing, R8/minification, and
  release network-security behavior are independent unknowns.
- The plan must not commit signing secrets, must not disable minification to get a hollow release
  claim, and must not claim release carrier convergence from install/launch evidence.
- Final review returned PASS on the Plan 083 claim boundary. The review asked that readiness
  assertions inspect the actual Gradle release block, so the contract now brace-matches that block
  before checking local debug signing and minification.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npx esbuild test/tauri_android_release_smoke.ts --bundle --platform=node --format=esm --external:@tauri-apps/api --external:@treetopdevs/lattice-client --outfile=/tmp/tauri_android_release_smoke.mjs`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release`
- `cd clients/township-tauri-shell && npm run tauri:android:release:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Notes

- This plan proves a release APK builds, is locally signed for emulator installability, installs,
  launches, and stays alive.
- It does not prove release mobile BEAM convergence. The generated release manifest still keeps
  cleartext traffic disabled by default; release-mode carrier networking needs a separate plan and
  explicit network-security decision.
- Local debug-keystore signing is acceptable for this readiness smoke because it avoids committing
  production signing secrets. It is not a distribution signing ceremony.
- The Android Gradle file is generated; if a future `tauri android init` overwrites the local
  release-signing line, `mobile:tauri-readiness` should fail before any release-readiness claim is
  repeated.

## Remaining Work

- Prove release mobile BEAM convergence without weakening release network-security defaults by
  accident.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Run a physical multi-device LAN discovery smoke.
