# Plan 050: Tauri Vue close/reopen actions (E1)

## Status

DONE.

## Objective

Let a clerk-authorized Tauri shell submit `close_matter` and `reopen_matter` commands from the
Vue screen, using the generic cap-gated command path proven in plans 048 and 049.

Planned at commit `6b2cfe5`.

## Scope

- Add focused action-contract coverage proving a clerk key can submit `close_matter` and
  `reopen_matter` against the W1 carrier-frame delegation evidence.
- The close/reopen checks should prove:
  - the command succeeds through `submitTownshipCommand`,
  - the chosen cap id is the clerk delegation `ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8`,
  - the local semantic log and carrier-frame outbox each append exactly one authored command.
- Add Vue controls for close/reopen matter status actions.
- The controls should:
  - use `submitTownshipCommand`,
  - disable the close button when local availability denies `close_matter`,
  - disable the reopen button when local availability denies `reopen_matter`,
  - show a signed-frame success or failure message through the same command-status shape.
- Keep member add/remove submit controls, production onboarding/cap issuance, ack/outbox
  compaction, mobile secure-store strategy, and app convergence out of scope.

## TDD Plan

1. COVERAGE: extend `test/township_actions.ts` with clerk close/reopen submit checks over the
   already-existing generic command path.
2. RED: extend `test/frontend_shell.mjs` to require the Vue close/reopen controls and status state.
3. GREEN: wire the minimal Vue status-control panel to `submitTownshipCommand`.
4. VERIFY: run shell action/frontend contracts, shell typecheck/build, live peer/window smoke,
   Rust checks, TS carrier gates, umbrella Mix checks with `PATH="$HOME/.asdf/shims:$PATH"`,
   Sobelow, Playwright no-overlap smoke, and `git diff --check`.

## TDD Evidence

- `PATH="$HOME/.asdf/shims:$PATH" npm run action:contract` passed immediately after adding
  clerk close/reopen coverage because `submitTownshipCommand` already supported generic
  zero-argument Township commands.
- RED: `PATH="$HOME/.asdf/shims:$PATH" npm run frontend:contract` failed in
  `Vue source exposes close and reopen matter status actions` because App.vue did not expose
  `statusStatus`, `statusSubmitting`, `submitMatterStatus`, or close/reopen controls.
- GREEN: added a Vue "Matter status" panel with `Close matter` and `Reopen matter` buttons.
- GREEN: buttons submit through `submitTownshipCommand({ command: { command } })`, disable from
  `actionAvailability.commands.close_matter/reopen_matter`, and show the command-status message.

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

- Add member-management submit controls on top of the existing availability model.
- Add production onboarding/cap issuance so newly generated device keys can receive delegations.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
