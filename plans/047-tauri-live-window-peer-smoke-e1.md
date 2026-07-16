# Plan 047: Tauri live window peer smoke (E1)

## Status

DONE.

## Objective

Launch the real Township Tauri window with a configured live BEAM peer and prove the launched app
opens a carrier sync session. The smoke signal is the BEAM `LatticeNodeSpike.TownshipScenario`
peer transitioning from `base` to `diverged` after the app starts with an env-gated auto-sync path.

Planned at commit `6b2cfe5`.

## Scope

- Add a debug-only native seed hook so launch smoke can seed the desktop carrier key in memory from
  `TOWNSHIP_DEV_CARRIER_KEY_ID` and `TOWNSHIP_DEV_CARRIER_KEY_SEED` without changing production key
  persistence.
- Add a Vite env-gated auto-sync-on-mount switch for smoke tests only.
- Add a `tauri:launch:smoke` package script that:
  - starts the real BEAM Township peer in `base`,
  - starts Vite with the real peer config and auto-sync env,
  - launches the actual Tauri binary through the Rust runtime path,
  - observes the peer transition to `diverged`, proving the launched app connected and closed a
    carrier sync session,
  - terminates the app, dev server, and peer cleanly.
- Keep onboarding/cap issuance, production auto-sync policy, app-state inspection through the GUI,
  outbox compaction, and mobile secure-store strategy out of scope.

## TDD Plan

1. RED: add Rust tests requiring a debug env seed helper to prime the W1 session key.
2. RED: add a frontend contract requiring the app to support an env-gated auto-sync path.
3. RED: wire `npm run tauri:launch:smoke` before the smoke harness exists.
4. GREEN: implement the debug seed helper, auto-sync switch, and launch smoke harness.
5. VERIFY: run shell contracts, launch smoke, shell typecheck/build, Rust checks, TS carrier gates,
   umbrella Mix checks with `PATH="$HOME/.asdf/shims:$PATH"`, Sobelow, and `git diff --check`.

## TDD Evidence

1. RED: `cargo test dev_seed_env_vars_prime_the_w1_session_key` failed to compile because
   `seed_dev_carrier_key_from_vars` and the dev seed env constants did not exist.
2. RED: `npm run frontend:contract` failed because `VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT` was not
   declared and `App.vue` did not have an env-gated auto-sync path.
3. RED: `npm run tauri:launch:smoke` failed with `ERR_MODULE_NOT_FOUND` because
   `test/tauri_launch_smoke.ts` did not exist.
4. GREEN: added the debug-only native seed hook, env-gated auto-sync-on-mount, and the Tauri launch
   smoke harness.
5. DEBUG: the first launch smoke run reached the peer too early and saw `base`. A debug-only native
   command trace showed the app does reach native invoke, carrier signing, and sync persistence; the
   harness now waits for the second `lattice_kv_set` trace before probing peer status.
6. GREEN: `npm run tauri:launch:smoke` launches the real Tauri binary, observes native sync
   persistence, then confirms the BEAM peer is `diverged`, proving the launched window opened and
   closed a carrier session.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run native:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run action:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run peer:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run sync:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run frontend:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run live:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:launch:smoke`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run build`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:bridge`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run conformance`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run canonical`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run township:authoring`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Replace smoke-only seeded session setup with onboarding/cap issuance.
- Add GUI-state inspection for the post-sync status once a stable app automation route exists.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
