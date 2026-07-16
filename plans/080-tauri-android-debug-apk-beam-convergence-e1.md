# Plan 080: Tauri Android debug APK BEAM convergence (E1)

## Status

DONE

## Objective

Turn Android mobile BEAM convergence from a roadmap gap into a bounded debug-APK proof: the
installed Android app must reload persisted replayable Township state after restart, click the real
`Sync outbox` UI, sync host-authored, pre-signed W1 carrier frames with a real BEAM Township peer,
and prove both local KV convergence and peer `stateReport` convergence.

## Scope

- Add a package-level `tauri:android:beam:smoke` command.
- Extract Android CDP helpers for installed WebView command invocation and UI button clicks.
- Extract a BEAM peer spawn helper that starts `peer_node.exs` through `~/.asdf/shims/elixir`.
- Persist Tauri native key-value state to an app-local JSON file so replayable state survives app
  relaunch.
- Drive the installed debug APK, not a desktop shell or Vite-only browser harness.
- Keep release mobile BEAM convergence, iOS key reuse, Expo, and physical multi-device LAN
  discovery out of scope.

## STOP Conditions

- If the smoke trusts the W1 vector key for the carrier session instead of the Android device public
  key returned by `lattice_ensure_carrier_key`, stop.
- If the proof only calls TypeScript sync helpers and does not click the real `Sync outbox` button
  in the installed app, stop.
- If the smoke is described as on-device command authoring or persisted-cap onboarding evidence,
  stop.
- If the test claims release or phone-grade mobile BEAM convergence from the debug APK cleartext
  `ws://10.0.2.2` route, stop.
- If replayable state can only survive by moving carrier seeds into app KV, stop.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED/GREEN: `mobile:tauri-readiness` now asserts the `tauri:android:beam:smoke` package script,
  `test/tauri_android_beam_smoke.ts`, shared Android CDP support, shared BEAM peer support, and the
  debug-only build-map claim.
- RED: `key_value_store_reloads_from_persistent_file_across_state_instances` failed because
  `TownshipNativeState` kept KV only in memory. GREEN: `TownshipNativeState` can load/save a JSON KV
  file, and `kv_set` persists the full replayable map.
- RED/GREEN:
  `platform_secure_builder_persists_native_kv_across_app_restarts_when_file_is_configured` proves
  the platform-secure Tauri builder can use a configured KV file across app construction restarts.
- GREEN: `test/tauri_android_beam_smoke.ts` launches the debug APK, obtains the Android device
  public key through `lattice_ensure_carrier_key`, starts a BEAM Township peer that trusts that
  public key, seeds pre-signed W1 carrier frames and `carrier_peer_config` into native KV, restarts
  the app, clicks `Sync outbox`, asserts the synced KV state, checks the peer `stateReport`, restarts
  again, and proves the second sync is idempotent.

## Second Opinion

Claude Code reviewed the proposed Plan080 seam and required these corrections:

- The BEAM peer must trust the Android device public key, not the W1 vector key.
- A second relaunch without another sync proves restart persistence only; the smoke must click sync
  again or explicitly enable autosync.
- The claim must be pre-signed-frame convergence, not mobile authoring.
- Cleartext `ws://10.0.2.2` is debug-APK-only evidence and must not be described as release or
  phone-grade mobile convergence.
- DOM text is only liveness; KV state and BEAM `stateReport` are the convergence proof.
- Gate 3 of the secure-store strategy remains open because the smoke does not exercise on-device
  cap selection, command authoring, or persisted-cap onboarding.

Those constraints are reflected in the implementation and docs.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cargo test --manifest-path clients/township-tauri-shell/src-tauri/Cargo.toml --test native_commands`
- `cd clients/township-tauri-shell && npm run tauri:android:beam:smoke`
- `cd clients/township-tauri-shell/src-tauri && PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo fmt --check`
- `~/.asdf/shims/mix check`

## Notes

- This is an Android debug APK proof over the emulator host route `ws://10.0.2.2`; release mobile
  BEAM convergence remains unproven.
- The W1 frames are host-authored, pre-signed fixture frames. Mobile authoring remains covered by
  desktop/mock seams and still needs a mobile-authoring smoke before broader phone-grade claims.
- The replayable KV file stores signed ops and carrier/delegation frames only. Carrier seeds remain
  behind the platform keyring-backed native signer.

## Remaining Work

- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Prove release mobile BEAM convergence beyond the debug APK cleartext route.
- Run a physical multi-device LAN discovery smoke.
