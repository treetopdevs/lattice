# Plan 039: Tauri platform-secure app construction helper (E1)

## Status

DONE.

## Objective

Wrap the platform-secure Township Tauri wiring in a helper that builds a Tauri app from an
explicit builder and context. This gives the eventual desktop/mobile entrypoint a single tested
construction path while preserving the current headless/mock-runtime test surface.

Planned at commit `6b2cfe5`.

## Scope

- Add a `build_platform_secure_township_app/2` helper that calls the plan 038 platform-secure
  builder helper and then builds the app with a caller-supplied Tauri context.
- Prove the helper through Tauri's mock runtime and mock context.
- Keep `Builder::default()`, `tauri::generate_context!()`, `tauri.conf.json`, Wry runtime
  feature enablement, event-loop execution, Vue UI wiring, and mobile secure-store strategy out
  of scope.

## TDD Plan

1. RED: add a Rust integration test importing `build_platform_secure_township_app/2` and expecting
   a mock app to route an IPC command.
2. GREEN: implement the helper by delegating to `configure_platform_secure_township_builder/1` and
   `Builder::build/1`.
3. VERIFY: run native Rust tests, TS bridge/client checks, and the umbrella gates with BEAM
   commands pinned to the asdf shims.

## TDD Evidence

1. RED: `cargo test` failed because `build_platform_secure_township_app` did not exist.
2. GREEN: added `build_platform_secure_township_app/2` as a composition over the plan 038
   platform-secure builder helper and `Builder::build/1`.
3. GREEN: the mock-runtime IPC test proves the constructed app routes commands without invoking a
   key command, writing to the OS keychain, or entering the event loop.
4. VERIFY: native Rust tests, TS bridge/typecheck/conformance/canonical/authoring/carrier checks,
   live carrier, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `git diff --check`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:bridge`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run conformance`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run canonical`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run township:authoring`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix --version`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Add the real generated Tauri context/config and runtime entrypoint.
- Decide the mobile secret-store strategy before claiming phone-grade key persistence.
- Wire the Vue shell to the TypeScript client bridge and prove desktop/mobile convergence.
