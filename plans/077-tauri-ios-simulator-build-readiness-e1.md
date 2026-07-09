# Plan 077: Tauri iOS simulator build readiness (E1)

## Status

BLOCKED: repo-side readiness blockers were fixed, but the selected local Xcode 27.0 beta toolchain
fails while compiling Tauri's upstream Swift package before a simulator archive can complete.

## Objective

Turn the first real Tauri iOS simulator archive attempt into durable repo contracts: generated iOS
targets must use an Xcode-supported deployment target, the generated Rust build phase must have the
package script it invokes, and iOS native key persistence must enable protected Keychain support.

## Scope

- Pin generated iOS deployment target readiness at iOS 15.0.
- Add a package-level `tauri` script because the generated Xcode build phase invokes
  `npm run -- tauri ios xcode-script ...`.
- Enable the iOS `apple-native-keyring-store` `protected` feature through a target-specific
  dependency so the existing `keyring`-backed `CarrierKeySeedStore` can compile for iOS.
- Extend `mobile:tauri-readiness` to guard those three build-readiness contracts.
- Retry the simulator archive and document the remaining blocker without claiming phone-grade
  mobile persistence or convergence.

## STOP Conditions

- If a fix moves carrier seeds into TypeScript, Vue state, app files, or replayable app storage,
  stop.
- If the simulator archive fails inside upstream Tauri/Swift/Xcode code before Township code links,
  do not paper over it with app-level claims.
- If this slice cannot prove key reuse across a simulator/device restart and BEAM convergence,
  keep phone-grade mobile persistence marked as future work.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED: `npx tauri ios build --debug --target aarch64-sim --ci --no-sign` failed because the
  generated iOS project used deployment target 14.0 while local Xcode supports 15.0 and newer.
- RED: `npm run mobile:tauri-readiness` failed until it asserted `project.yml` and `project.pbxproj`
  use iOS 15.0.
- GREEN: generated iOS project files now use `iOS: 15.0` and
  `IPHONEOS_DEPLOYMENT_TARGET = 15.0;`.
- RED: the next simulator archive failed because the generated Xcode script calls
  `npm run -- tauri ...` and `package.json` had no `tauri` script.
- RED/GREEN: `mobile:tauri-readiness` now asserts `scripts.tauri === "tauri"`, and the script
  exists.
- RED: after that, iOS compilation failed in `apple-native-keyring-store` with
  `The protected feature is required on iOS`.
- RED/GREEN: `mobile:tauri-readiness` now asserts the target-specific
  `apple-native-keyring-store` dependency enables `features = ["protected"]`, and Cargo config
  matches.
- BLOCKED: the repo-side blockers cleared, but the simulator archive still fails under
  `/Applications/Xcode-beta.app` while compiling Tauri's upstream Swift package. Direct Cargo
  reaches the same Tauri Swift package failure: Swift receives both iPhoneSimulator27.0/iOS target
  arguments and MacOSX27.0/macOS target arguments, then cannot resolve `UIKit`, `AppKit`, and
  `WebKit`.

## Second Opinion

Claude Code was asked for review of the iOS simulator blocker and whether a repo fix remained, but
the CLI prompt produced no output after roughly 60 seconds and was interrupted. This is recorded as
reviewer unavailability, not as a GO.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell && npx tauri ios build --debug --target aarch64-sim --ci --no-sign`
  - expected current result on this machine: blocked by the selected Xcode 27.0 beta Swift package
    failure after repo-side readiness blockers clear.

## Notes

- `xcode-select -p` is `/Applications/Xcode-beta.app/Contents/Developer`.
- `/Applications` contains `Xcode-beta.app` and `Xcode.appdownload`; there is no usable stable
  `/Applications/Xcode.app/Contents/Developer` to select for comparison.
- `cargo search tauri --limit 3` reports Rust `tauri = "2.11.5"`, matching the repo's Rust Tauri
  version. `npm view @tauri-apps/cli version` reports `2.11.4`, matching the repo's npm CLI line.
- This plan did not touch the BEAM toolchain. Elixir/Mix verification must continue to use
  `~/.asdf/shims/mix`.

## Remaining Work

- Re-run the simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Add the actual simulator/device mobile smoke that proves native-backed carrier key reuse across
  restarts and BEAM convergence.
- Run a physical multi-device LAN discovery smoke.
