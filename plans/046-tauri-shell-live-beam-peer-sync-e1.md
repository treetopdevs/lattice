# Plan 046: Tauri shell live BEAM peer sync (E1)

## Status

DONE.

## Objective

Prove the Township Tauri shell's configured peer sync path against the real BEAM Township
WebSocket peer, using Tauri-style native invoke storage and carrier-session signing. This closes
the gap between Plan 045's scripted WebSocket proof and a live `LatticeNodeSpike.TownshipScenario`
carrier peer, while keeping full GUI Tauri app launch as the next slice.

Planned at commit `6b2cfe5`.

## Scope

- Add a `live:contract` package script for `clients/township-tauri-shell`.
- Add a live shell contract that:
  - starts the BEAM `LatticeNodeSpike.TownshipScenario` peer with the asdf Elixir shim,
  - warms the peer from `base` to `diverged`,
  - seeds shell key-value storage with the W1 client-diverged local log and carrier outbox,
  - drives `syncTownshipOutbox({ peer })` through native-invoke signing and storage commands,
  - asserts five peer frames are pulled, two local frames are pushed, the merged local log matches
    the Sim-exported W1 oracle, and the BEAM peer reports the expected post-sync state,
  - shuts the peer down cleanly.
- Record the remaining honesty boundary in `TOWNSHIP_BUILD_MAP.md`: this proves live BEAM peer sync
  through the shell workflow, not a launched Tauri window.
- Keep onboarding/cap issuance, outbox ack compaction, broader author actions, mobile secure-store
  strategy, and GUI Tauri launch/screenshot out of scope.

## TDD Plan

1. RED: wire `npm run live:contract` to the expected test file before that file exists.
2. GREEN: add the live shell contract, reusing the W1 Sim-exported vector and live BEAM peer
   harness shape from `clients/lattice-client/test/live_carrier.ts`.
3. VERIFY: run the shell contracts, shell typecheck/build, Rust checks, TS client carrier gates,
   umbrella Mix checks with `PATH="$HOME/.asdf/shims:$PATH"`, Sobelow, and `git diff --check`.

## TDD Evidence

1. RED: `npm run live:contract` failed with `ERR_MODULE_NOT_FOUND` because
   `test/township_live_peer.ts` did not exist.
2. GREEN: added `test/township_live_peer.ts`, which starts the BEAM
   `LatticeNodeSpike.TownshipScenario` peer with the asdf Elixir shim, warms the peer from `base`
   to `diverged`, seeds Tauri-style key-value storage with the W1 client-diverged local log and
   carrier outbox, and calls `syncTownshipOutbox({ peer })`.
3. GREEN: `npm run live:contract` proved the shell workflow signs the carrier session through the
   native invoke seam, pulls five peer frames, pushes two local frames, persists the eleven-op
   merged local log, verifies the BEAM peer state report against the Sim-exported W1 oracle, and
   shuts the peer down cleanly.

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

- Launch the actual Tauri app against a live BEAM peer and capture a desktop smoke artifact.
- Add onboarding/cap issuance so a newly generated device key can receive a local delegation.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
