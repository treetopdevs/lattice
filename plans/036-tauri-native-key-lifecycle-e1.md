# Plan 036: Tauri native carrier key lifecycle (E1)

## Status

DONE.

## Objective

Add a native carrier-key lifecycle seam so the Tauri shell can ask Rust to create or return a
carrier signing key by key ID, then sign through the existing native command without TypeScript
preconfiguring the public key. This moves key custody toward the Rust shell while keeping secure
platform persistence as an explicit follow-up.

## Scope

- Add a native `lattice_ensure_carrier_key` command that returns the base64 public key for a key ID.
- Generate an Ed25519 key with OS randomness when the key ID is missing from native state.
- Reuse the existing native key for subsequent calls in the same state.
- Register the new command in the Tauri builder and command-name contract.
- Add a TS async signer factory that calls `lattice_ensure_carrier_key` before creating the signer.
- Keep platform keychain/Stronghold persistence out of scope; keys still live in native process state
  after creation.

## TDD Plan

1. RED: add Rust tests for `ensure_carrier_key` creation/reuse and mock IPC command registration.
2. GREEN: add the Rust key lifecycle method, command wrapper, command name, and builder registration.
3. RED: add a TS bridge test for async native signer creation through `lattice_ensure_carrier_key`.
4. GREEN: add the TS async factory and default command name.
5. VERIFY: run native Rust tests, TS bridge/client checks, and the umbrella gates.

## TDD Evidence

1. RED: `cargo test` failed because `TownshipNativeState::ensure_carrier_key/1` did not exist.
2. GREEN: native state now generates an OS-random Ed25519 key for a missing key ID, reuses it on
   later calls, and returns the base64 public key.
3. GREEN: `lattice_ensure_carrier_key` is registered with the Tauri command handler and mock IPC can
   ensure a key, sign with it, and verify the signature.
4. RED: `npm run tauri:bridge` failed because `createTauriNativeCarrierSigner` was not exported.
5. GREEN: the TS bridge now has an async native signer factory that calls
   `lattice_ensure_carrier_key` and signs through `lattice_sign_carrier`.
6. VERIFY: native Rust tests, TS bridge/typecheck/conformance/canonical/authoring/carrier checks,
   live carrier, umbrella Mix, and Sobelow gates pass.

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

- Persist native private keys in a secure platform store instead of process memory.
- Call the registered builder from a real Tauri app bootstrap.
- Wire the Vue shell to the TypeScript client bridge and prove desktop/mobile convergence.
