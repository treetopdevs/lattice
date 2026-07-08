# Plan 048: Tauri Vue broader author actions (E1)

## Status

DONE.

## Objective

Move the Township Tauri shell beyond a post-only authoring wrapper by adding a generic command
submission path and exposing a summary edit action from the Vue app. This is the first slice of the
remaining "broader author actions" gap while preserving the existing post workflow.

Planned at commit `6b2cfe5`.

## Scope

- Extend `src/township_actions.ts` with `submitTownshipCommand`, a shell-facing wrapper around
  `authorAndPersistTownshipCommand` that accepts any `TownshipCommand`.
- Preserve `submitTownshipPost` as a compatibility helper with the same success/failure shape.
- Add command validation for blank text commands (`set_title`, `set_summary`, `post`) and blank
  member commands (`admit`, `remove_member`).
- Add tests that:
  - prove `submitTownshipCommand({ command: "set_summary" })` produces the exact resident W1
    `set_summary` frame from the Sim-exported vector,
  - keep the existing exact post fixture proof green,
  - prove missing delegation for `close_matter` reports the command name,
  - prove validation catches blank text/member commands.
- Add a Vue summary edit control that calls the generic command path and persists the signed frame
  through native invoke when local delegation evidence exists.
- Keep onboarding/cap issuance, close/reopen UI, member-management UI, ack/outbox compaction,
  mobile secure-store strategy, and GUI-state inspection out of scope.

## TDD Plan

1. RED: extend `test/township_actions.ts` to require `submitTownshipCommand`, exact W1
   `set_summary` persistence, and broader validation.
2. RED: extend `test/frontend_shell.mjs` to require the Vue summary edit action.
3. GREEN: implement `submitTownshipCommand`, keep `submitTownshipPost` as a wrapper, and add the
   summary edit UI.
4. VERIFY: run shell action/frontend contracts, shell typecheck/build, relevant TS client gates,
   Rust checks if native surfaces are unchanged but still in the verification ladder, umbrella Mix
   checks with `PATH="$HOME/.asdf/shims:$PATH"`, Sobelow, and `git diff --check`.

## TDD Evidence

1. RED: `npm run action:contract` failed because `src/township_actions.ts` did not export
   `submitTownshipCommand`.
2. RED: `npm run frontend:contract` failed because the Vue app did not expose a summary edit
   action or call the generic command path.
3. GREEN: added `submitTownshipCommand`, command normalization/validation, and preserved
   `submitTownshipPost` as a compatibility wrapper.
4. GREEN: added a Vue summary edit form that submits `{ command: "set_summary" }` through the
   generic shell action wrapper.
5. GREEN: `npm run action:contract` proves exact W1 `set_summary` frame persistence, preserves the
   exact W1 `post` frame proof, reports missing delegation for `close_matter`, and validates blank
   text/member commands.
6. GREEN: `npm run frontend:contract` proves the summary edit action is present in the Vue source.
7. VERIFY: browser smoke screenshots confirmed the new summary UI has no horizontal overflow on
   desktop and mobile.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run action:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run frontend:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run build`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run native:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run sync:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run peer:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run live:contract`
- `cd clients/township-tauri-shell && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:launch:smoke`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 1220 }, mobile: { width: 390, height: 1300 } })) { const page = await browser.newPage({ viewport }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.waitForTimeout(500); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (overflow > 1) throw new Error(name + ' horizontal overflow ' + overflow); const hasSummary = await page.locator('button:has-text(\"Update summary\")').count(); if (hasSummary !== 1) throw new Error(name + ' missing update summary button'); await page.screenshot({ path: '/tmp/township-tauri-broader-actions-' + name + '.png', fullPage: true }); await page.close(); } await browser.close(); console.log('screenshots written');"`
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

- Add production onboarding/cap issuance so newly generated device keys can receive delegations.
- Add close/reopen and member-management UI once role/cap presentation is designed.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
