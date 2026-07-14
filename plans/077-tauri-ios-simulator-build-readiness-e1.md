# Plan 077: Tauri iOS simulator build readiness (E1)

## Status

IN PROGRESS

Stable Xcode 26.6 (Build 17F113) now completes the Tauri iOS simulator archive. A local iOS 18.6
simulator smoke creates two independently named protected Keychain keys, verifies that they differ,
and proves both keys survive process relaunch while returning 64 signature bytes per slot. The smoke
does not independently verify the returned signature bytes. It does not prove simulator or device
reboot, does not prove physical-device behavior, does not prove iOS BEAM convergence, and is not
enforced in CI.

## Objective

Turn the first real Tauri iOS simulator archive and protected-key runtime attempt into durable repo
contracts without overstating the local proof as phone-grade convergence.

## Scope

- Pin generated iOS deployment target readiness at iOS 15.0.
- Add a package-level `tauri` script because the generated Xcode build phase invokes
  `npm run -- tauri ios xcode-script ...`.
- Enable the iOS `apple-native-keyring-store` `protected` feature through a target-specific
  dependency so the existing `keyring`-backed `CarrierKeySeedStore` can compile for iOS.
- Build the simulator archive with signing identity supplied only through
  `APPLE_DEVELOPMENT_TEAM`, and restore the generated Xcode signing files after Tauri's build
  mutation.
- Add an exact-build-flag runtime probe that logs public proof only: key id, public key, signature
  byte count, result, store, and probe slot. It must never log seed or private-key material.
- Use independent primary and control key ids, require their 32-byte public keys to differ, and
  require both to remain stable across a process terminate/relaunch cycle.
- Extend `mobile:tauri-readiness` to guard the build, probe, signing, source-restoration, and claim
  boundaries.

## Out of Scope

- Simulator shutdown/boot or erase/restore behavior.
- Physical-device install, reboot, Keychain policy, or hardware-backed custody claims.
- iOS pairing, cap acquisition, op authoring, carrier sync, or BEAM convergence.
- Hosted CI enforcement and any phone-grade persistence claim.

## STOP Conditions

- If a fix moves carrier seeds into TypeScript, Vue state, app files, or replayable app storage,
  stop.
- If the simulator archive fails inside upstream Tauri/Swift/Xcode code before Township code links,
  keep the failure scoped to the toolchain rather than making an app-level claim.
- If signing requires a checked-in Apple team id or leaves generated project mutations behind,
  stop and keep the build local-only.
- If either probe key is constant, the two independently named keys collapse to the same public key,
  or either signature is not 64 bytes, fail the smoke.
- Until reboot, physical-device, persisted-cap, and BEAM convergence gates exist, keep phone-grade
  mobile persistence marked as future work.
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
- SYSTEM RED: a no-sign simulator archive installed and launched, but the first native Keychain
  operation failed with `NSOSStatusErrorDomain Code=-34018` because the process had neither an
  application identifier nor Keychain access-group entitlements.
- RED/GREEN: `ios:key-reuse:contract` failed until the exact-flag TypeScript probe existed and
  exposed only tokenized public evidence through the existing native log command.
- GREEN: under stable Xcode 26.6 (Build 17F113), the entitlement-enabled simulator archive builds
  and reaches the protected Keychain operation without `-34018`.
- REVISE: Claude's first adversarial review found that Tauri's generated Xcode project retained a
  local development team and that a single stable key could not rule out a constant fixture.
- RED/GREEN: `mobile:tauri-readiness` failed until the build moved behind a wrapper that reads
  `APPLE_DEVELOPMENT_TEAM`, rejects missing or malformed input, and restores the generated Xcode
  signing files in `finally`. No Apple team id remains in tracked source.
- RED/GREEN: the probe contract and readiness gate failed until an independent control key and
  `slot=primary|control` evidence were present.
- RUNTIME GREEN: the local iOS 18.6 simulator reports two distinct 32-byte public keys, two 64-byte
  signature results, and the same key for each slot after process terminate/relaunch. The smoke also
  checks for the executable's embedded simulator entitlement section before launch.
- REVIEW HARDENING: Claude's full final review returned `PROCEED` with one low-severity false-positive
  concern: a swallowed between-launch terminate failure could reuse the first process and its logs.
- RED/GREEN: `mobile:tauri-readiness` failed until the smoke made that terminate strict and required
  the second `simctl launch` process id to differ from the first. The hardened runtime smoke is green.

## Second Opinion

Claude Code's first read-only adversarial review returned `REVISE`. It required environment-only
team selection, generated-file restoration, and a second independently named key as a negative
control. A later full final review returned `PROCEED` with the low-severity process-identity concern
recorded above. After the strict-terminate and changed-process-id hardening, Claude's final focused
re-review returned `PROCEED` with no findings.

## Verification

- `xcodebuild -version` -> `Xcode 26.6`, `Build version 17F113`
- `cd clients/township-tauri-shell && npm run ios:key-reuse:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && APPLE_DEVELOPMENT_TEAM=<team-id> npm run tauri:ios:build:key-reuse-probe`
- `cd clients/township-tauri-shell && TOWNSHIP_IOS_SIMULATOR_UDID=<udid> npm run tauri:ios:key-reuse:smoke`

## Notes

- `xcode-select -p` is `/Applications/Xcode.app/Contents/Developer`.
- Tauri mutates generated Apple signing files during a build. The build wrapper snapshots and
  restores `project.pbxproj`, `Info.plist`, and the generated entitlement file while retaining the
  archive output.
- Simulator entitlements are carried in the executable's Mach-O entitlement section; the runtime
  Keychain call is the functional entitlement proof.
- The runtime smoke is local-only and opt-in. It is not enforced in CI.
- This plan did not touch the BEAM toolchain. Elixir/Mix verification must continue to use
  `~/.asdf/shims/mix`.

## Remaining Work

- Prove protected-key reuse across a simulator shutdown/boot cycle, then define the destructive
  reset control separately.
- Repeat the key-custody proof on a physical iOS device, including device reboot behavior.
- Add iOS persisted-cap onboarding and real BEAM carrier convergence through the app path.
- Decide whether the expensive signed simulator and physical-device gates belong in hosted CI.
- Run a physical multi-device LAN discovery smoke.
