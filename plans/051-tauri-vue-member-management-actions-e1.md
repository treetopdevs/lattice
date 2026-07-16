# Plan 051: Tauri Vue member-management actions (E1)

## Status

DONE.

## Objective

Let a locally authorized Tauri shell submit `admit` and `remove_member` commands from the Vue
screen, using the generic cap-gated command path and action-availability model proven in plans
048-050.

Planned at commit `6b2cfe5`.

## Scope

- Add focused action-contract coverage proving member commands can be submitted from W1 local
  delegation evidence:
  - a resident key can submit `admit` with the resident delegation cap,
  - a clerk key can submit `remove_member` with the clerk delegation cap,
  - each successful command appends one semantic op and one carrier frame.
- Add Vue controls for member management.
- The controls should:
  - use one member-name input,
  - submit `admit` and `remove_member` through `submitTownshipCommand`,
  - disable `admit` when local availability denies `admit`,
  - disable `remove_member` when local availability denies `remove_member`,
  - disable both buttons while the member input is empty,
  - show signed-frame success or failure through the same command-status shape.
- Keep production onboarding/cap issuance, ack/outbox compaction, mobile secure-store strategy,
  and app convergence out of scope.

## TDD Plan

1. COVERAGE: extend `test/township_actions.ts` with resident admit and clerk remove-member submit
   checks over the already-existing generic command path.
2. RED: extend `test/frontend_shell.mjs` to require the Vue member-management controls and status
   state.
3. GREEN: wire the minimal Vue member-management panel to `submitTownshipCommand`.
4. VERIFY: run shell action/frontend contracts, shell typecheck/build, live peer/window smoke,
   Rust checks, TS carrier gates, umbrella Mix checks with `PATH="$HOME/.asdf/shims:$PATH"`,
   Sobelow, Playwright no-overlap smoke, and `git diff --check`.

## TDD Evidence

- COVERAGE: `npm run action:contract` covered resident `admit` and clerk `remove_member`
  submissions through the generic command path. This coverage was already green because the
  command authoring/submission seam from plans 048-050 was command-generic; the new assertions pin
  the expected cap ids, semantic local-op append, and carrier-frame outbox append.
- RED: `npm run frontend:contract` failed on the new member-management expectations while
  `App.vue` did not yet expose `memberDraft`, `memberStatus`, `memberSubmitting`,
  `submitMemberCommand`, `memberActionAllowed`, or the "Member management" controls.
- GREEN: `App.vue` now renders one member-name input plus cap-gated `Admit member` and
  `Remove member` buttons, both routed through `submitTownshipCommand`; `style.css` reuses the
  shell's existing mobile action-row stacking pattern for the new panel.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

All BEAM commands below were run with `PATH="$HOME/.asdf/shims:$PATH"` and explicit
`~/.asdf/shims/mix` where applicable, to avoid the local Homebrew/mise Erlang collision.

- `~/.asdf/shims/mix --version` -> Mix 1.19.5 on Erlang/OTP 28.
- `~/.asdf/shims/mix format --check-formatted`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run live:contract`
- `cd clients/township-tauri-shell && npm run tauri:launch:smoke`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/lattice-client && npm run tauri:bridge`
- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run conformance`
- `cd clients/lattice-client && npm run canonical`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/lattice-client && npm run carrier:township:live`
- Playwright visual smoke of `clients/township-tauri-shell` at desktop and 390px mobile widths;
  artifacts:
  - `output/playwright/township-member-actions-desktop.png`
  - `output/playwright/township-member-actions-mobile-scrolled.png`

## Remaining Work

- Add production onboarding/cap issuance so newly generated device keys can receive delegations.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
