# Plan 076: Tauri mobile target readiness (E1)

## Status

DONE.

## Objective

Generate and pin the Township Tauri iOS and Android target scaffolds so the repo has real mobile
project entrypoints before attempting a device or simulator convergence smoke.

## Scope

- Add `tauri:ios:init` and `tauri:android:init` package scripts that run Tauri mobile init in CI
  mode while skipping Rust target installation.
- Add `mobile:tauri-readiness`, a source contract that proves:
  - the Tauri config still declares the `township` mobile deep-link scheme,
  - generated iOS and Android target projects exist,
  - the generated projects use the Township app identifier, and
  - the mobile secure-store strategy still refuses phone-grade claims.
- Run Tauri iOS and Android init to generate `src-tauri/gen/apple` and `src-tauri/gen/android`.
- Update the mobile strategy document to distinguish generated build targets from phone-grade
  persistence or convergence evidence.

## STOP Conditions

- If generated mobile project files require moving carrier seeds into TypeScript, app storage,
  AsyncStorage, or Vue state, stop.
- If this slice claims a device/simulator build, key reuse across mobile app restarts, or BEAM sync
  from a phone, stop.
- If the mobile strategy stops saying phone-grade persistence needs a native-backed signer and a
  mobile convergence smoke, stop.
- If the generated target changes the desktop app convergence path or the existing Tauri command
  contract, stop.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because `src-tauri/gen/apple` was missing.
- GREEN: `npm run tauri:ios:init` generated the Xcode project under `src-tauri/gen/apple`.
- GREEN: `npm run tauri:android:init` generated the Android Studio project under
  `src-tauri/gen/android`.
- GREEN: `npm run mobile:tauri-readiness` now proves the generated target scaffolds and keeps the
  no-phone-grade-claim boundary intact.

## Second Opinion

Claude Code was asked for pre-review and post-review of this slice, but both CLI review prompts
produced no output after roughly 60 seconds and were interrupted. This is recorded as reviewer
unavailability, not as a GO.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Notes

`tauri ios init --ci --skip-targets-install` still installed/reinstalled Tauri's iOS helper tooling
through Homebrew (`xcodegen` and `libimobiledevice`). It did not touch the local BEAM toolchain; Mix
verification must continue to use `~/.asdf/shims/mix`.

## Remaining Work

- A simulator/device mobile smoke must still prove native-backed carrier key reuse and BEAM
  convergence before the repo can claim phone-grade mobile persistence.
- A physical multi-device LAN discovery smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
