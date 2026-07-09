# Plan 079: Tauri Android emulator native key reuse (E1)

## Status

DONE

## Objective

Turn Android mobile key persistence from a packaging claim into an emulator proof: the installed
Tauri app must invoke the native carrier signer, sign a W1-shaped carrier transcript, reuse the
same public key after force-stop/relaunch, and change keys after app data clear.

## Scope

- Add an Android emulator smoke command that installs the generated debug APK and drives the Tauri
  WebView over CDP.
- Configure mobile keyring stores explicitly through `keyring-core` so Android and iOS do not rely
  on the desktop/default `keyring` store selection.
- Initialize Android `ndk_context` from the generated activity before the Rust keyring store is
  opened.
- Disable Android application backup so carrier identity is not restored implicitly across installs.
- Add a concurrency regression for `ensure_carrier_key` so simultaneous callers cannot mint two
  different keys for the same id.
- Keep full mobile BEAM convergence, iOS archive proof, and physical multi-device LAN discovery out
  of scope.

## STOP Conditions

- If a fix moves carrier seeds into TypeScript, Vue state, app files, or replayable app storage,
  stop.
- If Android key reuse can only be proven by deterministic key derivation instead of platform
  persistence, stop and add a negative `pm clear` guard.
- If the app claims phone-grade mobile persistence before an Android/iOS mobile BEAM convergence
  smoke exists, stop.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED/GREEN: `mobile:tauri-readiness` now asserts the Android emulator smoke command, Android
  keyring dependencies, Android backup disablement, Android NDK context shim, and mobile keyring
  default-store setup.
- RED: Claude review flagged that key reuse after force-stop alone could be deterministic
  derivation, not persistence. GREEN: the emulator smoke now force-stops/relaunches and then runs
  `pm clear`; the first restart must keep the public key and the data-clear launch must change it.
- RED: `concurrent_ensure_carrier_key_returns_one_public_key_per_id` produced two keys for the same
  id under coordinated concurrent misses. GREEN: `ensure_carrier_key` now holds the signing-key
  mutex across load/generate/save for a given state.
- RED: Android startup crashed with `android context was not initialized` when the keyring store was
  configured before the Android context existed. GREEN: store setup is lazy at keyring-entry use,
  after the activity initializes the NDK context.
- RED: Android startup crashed with `No implementation found ... initializeNdkContext` when the
  Kotlin shim used `@JvmStatic`. GREEN: the shim declares the companion-object external method shape
  exported by `android-native-keyring-store`.
- GREEN: `npm run tauri:android:emulator:smoke` starts a fresh AVD when needed, installs the APK,
  verifies native Ed25519 signatures over the W1 transcript, proves public-key reuse after
  force-stop/relaunch, and proves key reset after `pm clear`.

## Second Opinion

Claude Code reviewed the mobile keyring diagnosis and agreed that explicit Android default-store
setup was required. It also caught the iOS default-store gap, the force-stop-vs-derivation ambiguity,
the `ensure_carrier_key` concurrency race, Android backup risk, and Android `ndk_context`
initialization timing. Those critiques are incorporated in this plan. A final post-change Claude
review prompt was attempted after local verification, but it produced no output before being
interrupted; this is recorded as reviewer unavailability, not as an additional GO.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell/src-tauri && PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo fmt --check`
- `PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test --manifest-path clients/township-tauri-shell/src-tauri/Cargo.toml --test native_commands`
- `PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo check --manifest-path clients/township-tauri-shell/src-tauri/Cargo.toml --target aarch64-linux-android --lib`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug`
- `cd clients/township-tauri-shell && npm run tauri:android:emulator:smoke`

## Notes

- The Android smoke proves native carrier key reuse and signing, not full mobile BEAM convergence.
- Completed follow-up: plan 080 proves Android debug APK pre-signed-frame BEAM convergence after
  restart, using persisted native KV and a real BEAM Township peer.
- The iOS source path now configures the protected Keychain default store, but the simulator archive
  remains locally blocked by the selected Xcode 27 beta Tauri Swift-package failure.
- This plan did not touch the BEAM toolchain. Elixir/Mix verification must continue to use
  `~/.asdf/shims/mix`.

## Remaining Work

- Release mobile BEAM convergence remains unproven beyond the debug APK cleartext route.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Run a physical multi-device LAN discovery smoke.
