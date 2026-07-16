# Plan 040: Tauri runtime config and entrypoint (E1)

## Status

DONE.

## Objective

Add the first real Tauri desktop runtime bootstrap for the Township shell: generated Tauri config,
build script, callable `run()` entrypoint, and binary target. This turns the tested platform-secure
app-construction helper into a compile-checked app entrypoint while leaving UI assets and live app
execution for later slices.

Planned at commit `6b2cfe5`.

## Scope

- Add a minimal `tauri.conf.json` with the Township product name, stable application identifier,
  generated context, and one main window.
- Add Tauri build-script wiring so generated context metadata is part of the crate build.
- Add a `run()` entrypoint that calls the platform-secure builder path with `tauri::Builder::default()`
  and `tauri::generate_context!()`.
- Add a binary `main.rs` that calls `township_tauri_shell::run()`.
- Prove the generated context and binary compile path without launching the event loop.
- Keep Vue UI assets, frontend dev/build commands, mobile secure-store strategy, and live desktop
  app smoke launch out of scope.

## TDD Plan

1. RED: add an integration test that calls `tauri::generate_context!()` and asserts the Township
   product name, identifier, and main window metadata.
2. RED: run `cargo check --bin township-tauri-shell` and observe the missing binary/runtime
   bootstrap.
3. GREEN: add `tauri.conf.json`, `build.rs`, build dependency, `run()`, and `src/main.rs`.
4. VERIFY: run native Rust checks, TS bridge/client checks, and the umbrella gates with BEAM commands
   pinned to the asdf shims.

## TDD Evidence

1. RED: `cargo test --test runtime_bootstrap` failed because `tauri.conf.json` did not exist.
2. RED: `cargo check --bin township-tauri-shell` failed because no binary target existed.
3. GREEN: added `tauri.conf.json`, Tauri build-script wiring, Wry/default Tauri dependency, `run()`,
   binary `main.rs`, and the minimal RGBA icon required by Tauri codegen.
4. GREEN: generated context now embeds the Township product name, application identifier, and main
   window metadata; `cargo check --bin township-tauri-shell` compiles without launching the app.
5. VERIFY: native Rust tests, TS bridge/typecheck/conformance/canonical/authoring/carrier checks,
   live carrier, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo test --test runtime_bootstrap`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
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

- Add the Vue shell assets and production frontend build command.
- Decide the mobile secret-store strategy before claiming phone-grade key persistence.
- Run a live desktop app smoke test once assets and runtime launch ergonomics exist.
