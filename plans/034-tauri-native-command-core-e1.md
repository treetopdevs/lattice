# Plan 034: Tauri native command core for storage and signing (E1)

## Status

DONE.

## Objective

Implement the Rust side of the Tauri bridge introduced in plan 033. The TS client can now call
`lattice_kv_get`, `lattice_kv_set`, and `lattice_sign_carrier`; this slice adds native command
implementations with deterministic tests against the W1 carrier-session vector.

## Scope

- Create `clients/township-tauri-shell/src-tauri` as the first minimal Tauri v2 Rust crate.
- Add a command state type that owns key-value storage and signing keys behind a mutex.
- Add `#[tauri::command]` functions matching the TS bridge command names:
  - `lattice_kv_get`
  - `lattice_kv_set`
  - `lattice_public_key`
  - `lattice_sign_carrier`
- Use Ed25519 signing in Rust and prove it matches the TS W1 session public key/signature.
- Keep UI/Vue app wiring out of scope; this is the native command core that a later shell will
  register with `invoke_handler`.

## TDD Evidence

1. RED: `cargo test` failed because `township_tauri_shell` had no `src/lib.rs` implementation.
2. GREEN: `TownshipNativeState` now owns key-value state and Ed25519 signing keys behind mutexes.
3. GREEN: Rust tests prove key-value roundtrip/missing read, W1 public key derivation, W1
   carrier-session signature parity with TS, missing signing-key rejection, and malformed base64
   rejection.
4. REFACTOR: Tauri command wrappers are thin around the tested core methods; they are intentionally
   dormant until a later builder-registration slice.
5. VERIFY: `cargo test` passes cleanly for the native command crate.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
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

- Register these commands in a real Tauri builder and wire a Vue frontend to the TS client.
- Replace the test/dev seeded-key helper with platform key creation/import and secure persistence.
