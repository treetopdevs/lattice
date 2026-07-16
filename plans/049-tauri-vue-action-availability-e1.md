# Plan 049: Tauri Vue action availability (E1)

## Status

DONE.

## Objective

Show which Township commands the current device key can actually author from local delegation
evidence. This gives the shell a cap-aware action model before adding close/reopen and
member-management submit controls.

Planned at commit `6b2cfe5`.

## Scope

- Add `loadTownshipActionAvailability` in `src/township_actions.ts`.
- The availability loader should:
  - create or use a `TownshipNativeWorkflow`,
  - read the current signer public key,
  - load persisted carrier frames,
  - extract carrier delegations,
  - use `selectTownshipCapId` to report command-level availability for all declared
    `TownshipCommand` names.
- Add tests that:
  - prove resident W1 availability permits `set_title`, `set_summary`, `post`, and `admit`,
  - prove resident W1 availability denies `remove_member`, `close_matter`, and `reopen_matter`,
  - prove clerk W1 availability permits privileged commands,
  - preserve native-unavailable handling.
- Add a Vue "Available actions" panel that renders the current device's command availability.
- Keep actual close/reopen/member-management submit controls, onboarding/cap issuance,
  ack/outbox compaction, mobile secure-store strategy, and app convergence out of scope.

## TDD Plan

1. RED: extend `test/township_actions.ts` to require `loadTownshipActionAvailability` and exact W1
   resident/clerk availability.
2. RED: extend `test/frontend_shell.mjs` to require the Vue action availability panel.
3. GREEN: implement the availability loader and Vue panel.
4. VERIFY: run shell action/frontend contracts, shell typecheck/build, visual no-overflow smoke,
   live peer/window smoke, Rust checks, TS carrier gates, umbrella Mix checks with
   `PATH="$HOME/.asdf/shims:$PATH"`, Sobelow, and `git diff --check`.

## TDD Evidence

- RED: `PATH="$HOME/.asdf/shims:$PATH" npm run action:contract` failed because
  `../src/township_actions` did not export `loadTownshipActionAvailability`.
- RED: `PATH="$HOME/.asdf/shims:$PATH" npm run frontend:contract` failed in
  `Vue source shows cap-aware action availability` because the source did not expose the
  availability loader or panel.
- GREEN: added `loadTownshipActionAvailability`, backed by persisted carrier-frame
  delegation extraction plus `selectTownshipCapId`, and proved exact resident/clerk W1
  command availability.
- GREEN: added the Vue "Available actions" panel with browser-preview/native-unavailable
  fallback.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `PATH="$HOME/.asdf/shims:$PATH" npm run action:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run frontend:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run native:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run peer:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run sync:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run live:contract`
- `PATH="$HOME/.asdf/shims:$PATH" npm run tauri:launch:smoke`
- `PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `PATH="$HOME/.asdf/shims:$PATH" npm run build`
- `cargo fmt --check`
- `cargo test`
- `cargo check`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run typecheck`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run build`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run tauri:bridge`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run conformance`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run canonical`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run township:authoring`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run carrier:township`
- `PATH="$HOME/.asdf/shims:$PATH" npm --prefix clients/lattice-client run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix --version` reported Erlang/OTP 28 and
  Mix 1.19.5.
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`
- Playwright browser-preview desktop/mobile screenshots captured with no visible overlap.
- `git diff --check`

## Remaining Work

- Add close/reopen and member-management submit controls on top of the availability model.
- Add production onboarding/cap issuance so newly generated device keys can receive delegations.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
