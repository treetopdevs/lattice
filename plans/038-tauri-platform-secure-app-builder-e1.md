# Plan 038: Tauri platform-secure app builder helper (E1)

## Status

DONE.

## Objective

Expose a production-default Tauri builder helper that wires Township native commands to
desktop keyring-backed carrier key custody. This turns plan 037's keyring persistence seam into
the app-bootstrap API the real Tauri shell can call, while keeping full desktop runtime and UI
wiring for a later slice.

Planned at commit `6b2cfe5`.

## Scope

- Export a stable desktop keyring service name for Township carrier keys.
- Add a platform-secure builder helper that calls `TownshipNativeState::platform_secure/1` and
  delegates command registration to the existing `configure_township_builder/2`.
- Prove the helper through Tauri's mock runtime using a non-key command, so the test verifies
  builder state/IPC wiring without writing to the developer's OS keychain.
- Keep `tauri.conf.json`, `Builder::default().run(...)`, Wry runtime enablement, Vue UI wiring,
  mobile secure-store strategy, and migration of existing keys out of scope.

## TDD Plan

1. RED: add a Rust integration test importing the platform-secure builder helper and stable
   service constant, expecting command registration through mock IPC.
2. GREEN: add the constant and helper in `src/lib.rs`.
3. VERIFY: run native Rust tests, TS bridge/client checks, and the umbrella gates with BEAM
   commands pinned to the asdf shims.

## TDD Evidence

1. RED: `cargo test` failed because `configure_platform_secure_township_builder` and
   `TOWNSHIP_KEYRING_SERVICE` did not exist.
2. GREEN: added the stable desktop keyring service constant and the platform-secure builder helper.
3. GREEN: the mock-runtime IPC test proves the helper registers commands with platform-secure state
   without invoking a key command or writing to the OS keychain.
4. VERIFY: native Rust tests, TS bridge/typecheck/conformance/canonical/authoring/carrier checks,
   live carrier, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:bridge`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run conformance`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run canonical`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run township:authoring`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix --version`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `git diff --check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Call the helper from a real Tauri app bootstrap (`Builder::default()`, generated context, runtime
  config).
- Decide the mobile secret-store strategy before claiming phone-grade key persistence.
- Wire the Vue shell to the TypeScript client bridge and prove desktop/mobile convergence.
