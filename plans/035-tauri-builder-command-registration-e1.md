# Plan 035: Tauri builder command registration (E1)

## Status

DONE.

## Objective

Register the native Township storage/signing commands from plan 034 with a Tauri v2 builder so
the Rust command core is no longer just a tested library seam. This is the smallest E1 shell slice
between command implementation and a full Vue app.

## Scope

- Export the command-name contract expected by the TypeScript Tauri bridge.
- Add a builder configuration function that manages `TownshipNativeState` and installs the
  `lattice_kv_get`, `lattice_kv_set`, `lattice_public_key`, and `lattice_sign_carrier` handlers.
- Prove the hook compiles against Tauri's mock runtime without launching a real desktop app.
- Keep secure platform key persistence, actual app bootstrap, and Vue UI wiring out of scope.

## TDD Plan

1. RED: add a Rust integration test that expects exported command names and a builder registration
   helper.
2. GREEN: implement the exported command list and Tauri builder configuration hook.
3. REFACTOR: remove the command-wrapper dead-code allowances because `generate_handler!` now
   references the wrappers.
4. VERIFY: run the native crate tests, then the existing TS bridge/client and umbrella gates.

## TDD Evidence

1. RED: `cargo test` failed because `configure_township_builder` and
   `township_command_names` were not exported by `township_tauri_shell`.
2. GREEN: exported the command-name contract and a Tauri builder helper that manages
   `TownshipNativeState` and installs all four native handlers.
3. GREEN: the Rust integration test now sends mock IPC through `lattice_kv_get` and
   `lattice_kv_set`, proving the registered handler path reaches the native state.
4. REFACTOR: removed the command-wrapper `dead_code` allowances because `generate_handler!`
   now references the wrappers.
5. VERIFY: native Rust, TS client, umbrella Mix, and Sobelow gates pass.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/lattice-client && npm run tauri:bridge`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run conformance`
- `cd clients/lattice-client && npm run canonical`
- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/lattice-client && npm run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `git diff --check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Create the actual Tauri app bootstrap that calls the builder helper.
- Replace the deterministic dev seeded-key helper with platform key creation/import and secure
  persistence.
- Wire the Vue shell to the TypeScript client bridge and prove desktop/mobile convergence.
