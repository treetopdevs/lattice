# Plan 037: Tauri secure carrier key persistence seam (E1)

## Status

DONE.

## Objective

Persist native carrier signing keys through an explicit key-store seam so a Tauri shell can keep a
carrier identity across native state restarts without exposing private key material to TypeScript.
This is the next key-custody step after plan 036's in-process key lifecycle.

## Scope

- Add a `CarrierKeySeedStore` abstraction for loading/saving 32-byte Ed25519 seeds by key ID.
- Add a cloneable in-memory store for deterministic tests.
- Add a platform keyring-backed store that persists base64-encoded seeds through the OS credential
  store (`keyring` crate) for desktop shell use.
- Add constructors for ephemeral/default state, custom store state, and platform-secure state.
- Make `ensure_carrier_key` load an existing seed from the store before generating a new key, and
  save newly generated seeds before returning the public key.
- Keep app bootstrap, UI wiring, mobile Stronghold/secure-store integration, and key migration out
  of scope.

## TDD Plan

1. RED: add a Rust integration test that creates a key with one `TownshipNativeState`, recreates
   state with the same store, and proves the second state returns the same public key/signs with the
   same private key.
2. GREEN: implement `CarrierKeySeedStore`, `InMemoryCarrierKeySeedStore`, state constructors, and
   store-backed `ensure_carrier_key`.
3. RED: add a compile-level test for the platform-secure constructor/keyring store API.
4. GREEN: add the keyring-backed store implementation.
5. VERIFY: run native Rust tests, TS bridge/client checks, and the umbrella gates.

## TDD Evidence

1. RED: `cargo test` failed because `InMemoryCarrierKeySeedStore` and
   `TownshipNativeState::with_key_store/1` did not exist.
2. GREEN: added `CarrierKeySeedStore`, a cloneable in-memory store, state constructors, and
   store-backed `ensure_carrier_key`.
3. GREEN: a native key now reloads from a shared seed store across two state instances and signs
   with the same private key.
4. RED: `cargo test` failed because `KeyringCarrierKeySeedStore` and
   `TownshipNativeState::platform_secure/1` did not exist.
5. GREEN: added the keyring-backed store and platform-secure state constructor.
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

- Call the platform-secure state constructor from a real Tauri app bootstrap.
- Decide the mobile secret-store strategy (Tauri Stronghold or mobile secure store) before claiming
  phone-grade persistence.
- Wire the Vue shell to the TypeScript client bridge and prove desktop/mobile convergence.
