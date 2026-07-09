# Plan 078: Tauri Android debug APK readiness (E1)

## Status

DONE

## Objective

Turn the first real Tauri Android debug APK build attempt into durable repo contracts: local
Android builds must invoke the rustup toolchain ahead of Homebrew Rust, the Rust app crate must
emit the native library shapes Tauri mobile expects, and the Tauri app entrypoint must export the
mobile runtime symbols required by Android packaging.

## Scope

- Add a package-level Android debug APK build command that pins rustup ahead of Homebrew Rust.
- Keep the generated Tauri Android project intact and build through Tauri/Gradle instead of a
  hand-rolled Cargo-only check.
- Extend `mobile:tauri-readiness` to guard the Android build command, library crate type, and
  mobile entrypoint marker.
- Retry the Android debug APK build and record the produced artifact path without claiming
  phone-grade persistence or convergence.

## STOP Conditions

- If a fix moves carrier seeds into TypeScript, Vue state, app files, or replayable app storage,
  stop.
- If the Android build can only pass by bypassing Tauri's generated mobile validation, stop.
- If the local toolchain selects Homebrew Rust before rustup for Android targets, stop and pin the
  command locally before treating the build as meaningful.
- If this slice cannot prove key reuse across a device/emulator restart and BEAM convergence, keep
  phone-grade mobile persistence marked as future work.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED: `npx tauri android build --debug --apk --ci` failed under the npm/Tauri environment because
  `/opt/homebrew/bin` exposed Homebrew `cargo`/`rustc` before rustup; Android target std/core could
  not be resolved even though rustup had the target installed.
- GREEN: a direct rustup-path Cargo build for `aarch64-linux-android` succeeded, proving the blocker
  was local toolchain selection rather than Township Rust source.
- RED/GREEN: `mobile:tauri-readiness` now asserts
  `tauri:android:build:debug = "PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --debug --apk --ci"`,
  and `package.json` provides that script.
- RED/GREEN: `mobile:tauri-readiness` now asserts the Rust library crate emits
  `["staticlib", "cdylib", "rlib"]`, matching Tauri mobile's need for Android shared libraries
  while preserving desktop/test library use.
- RED: after the shared library existed, Tauri Android validation failed because the library did not
  include the required mobile runtime symbols.
- RED/GREEN: `mobile:tauri-readiness` now asserts `run()` is annotated with
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, and the Rust entrypoint carries that marker.
- GREEN: `npm run tauri:android:build:debug` completed and produced
  `clients/township-tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

## Second Opinion

Claude Code was asked to review the Android readiness changes and specifically evaluate the rustup
PATH pin, library crate types, mobile entrypoint marker, and readiness-test brittleness. The CLI
prompt produced no output after roughly 60 seconds and was interrupted. This is recorded as
reviewer unavailability, not as a GO.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell/src-tauri && PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo fmt --check`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug`

## Notes

- The successful APK build is a packaging/readiness proof only. It does not prove Android
  device/emulator key reuse across restart, platform secure-store behavior, or BEAM convergence.
- The build currently emits Gradle/JDK deprecation warnings from generated Android code and Java
  source/target 8 settings, but they do not fail the debug APK build.
- The iOS simulator archive path remains separately blocked by the selected local Xcode 27 beta
  Tauri Swift-package failure from plan 077.
- This plan did not touch the BEAM toolchain. Elixir/Mix verification must continue to use
  `~/.asdf/shims/mix`.

## Remaining Work

- Completed follow-up: plan 079 adds an Android emulator smoke that proves native-backed carrier key
  reuse across app restarts, signatures over the W1 carrier transcript, and key reset after app data
  clear.
- Completed follow-up: plan 080 adds an Android debug APK smoke that reloads persisted native KV
  after restart and converges pre-signed W1 carrier frames with a BEAM Township peer.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove release mobile BEAM convergence beyond the debug APK cleartext route.
- Run a physical multi-device LAN discovery smoke.
