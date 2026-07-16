# Plan 044: Tauri Vue carrier sync outbox (E1)

## Status

DONE.

## Objective

Add a shell-facing Township sync action that pushes the persisted carrier-frame outbox through the
existing TypeScript carrier sync contract, pulls peer frames, persists the merged local semantic log,
and reports honest push/pull counts to the Vue shell.

Planned at commit `6b2cfe5`.

## Scope

- Add a small `src/township_sync.ts` wrapper around `createTownshipNativeWorkflow` and
  `syncCarrierOnce`.
- Load the native-backed local op log and carrier frame outbox, call the injected carrier client,
  save the merged semantic op log, and leave carrier-frame retention unchanged until an ack/compaction
  policy exists.
- Add a TypeScript behavior test that seeds the W1 vector, syncs against a deterministic carrier
  client double, and proves pushed frame IDs, pulled frames, accepted counts, persisted merged op IDs,
  and native-unavailable/unconfigured statuses.
- Add a compact Vue "Sync outbox" control that calls the action and displays the last push/pull
  outcome.
- Keep live WebSocket URL/session configuration, onboarding/cap issuance, ack-driven outbox pruning,
  mobile secure-store strategy, and live Tauri app launch out of scope.

## TDD Plan

1. RED: add `test/township_sync.ts` and a package script asserting the wished-for
   `syncTownshipOutbox` success, carrier-unconfigured, and native-unavailable behavior.
2. RED: extend the frontend contract to require `App.vue` to call `syncTownshipOutbox` from a sync
   control.
3. GREEN: add the sync wrapper, adjust the carrier sync type seam if needed, and wire the Vue sync
   control/status.
4. VERIFY: run the sync/action/native/frontend tests, typecheck/build/browser smoke, Rust checks, TS
   client checks, and umbrella gates with BEAM commands pinned to the asdf shims.

## TDD Evidence

1. RED: `npm run sync:contract` failed with `ERR_MODULE_NOT_FOUND` because
   `src/township_sync.ts` did not exist.
2. RED: `npm run frontend:contract` failed with `ENOENT` because the frontend contract required
   `src/township_sync.ts` and the Vue sync control before either existed.
3. GREEN: added `syncTownshipOutbox`, an exported `CarrierSyncClient` seam for `syncCarrierOnce`,
   and a Vue "Sync outbox" control.
4. GREEN: `npm run sync:contract` proved the wrapper loads the native-backed local log/outbox,
   pushes the two W1 frames missing from the peer, pulls five peer frames, persists the merged
   eleven-op local log, leaves carrier frames retained, and reports carrier-unconfigured and
   native-unavailable states honestly.
5. RED/GREEN: `npm run typecheck` first caught stale package declarations for the new carrier sync
   seam; rebuilding `@treetopdevs/lattice-client` regenerated the declarations and made the shell
   typecheck pass.
6. VERIFY: shell contracts/typecheck/build, browser screenshots and sync-button smoke, Rust checks,
   TS client checks, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `curl -fsS http://127.0.0.1:5173/`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 1050 }, mobile: { width: 390, height: 1100 } })) { const page = await browser.newPage({ viewport }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.waitForTimeout(500); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (overflow > 1) throw new Error(name + ' horizontal overflow ' + overflow); await page.screenshot({ path: '/tmp/township-tauri-sync-final-' + name + '.png', fullPage: true }); await page.close(); } const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.click('button:has-text(\"Sync outbox\")'); await page.waitForFunction(() => document.body.innerText.includes('Connect a carrier peer before syncing.'), null, { timeout: 10000 }); await page.screenshot({ path: '/tmp/township-tauri-sync-final-click.png', fullPage: true }); await browser.close(); console.log('screenshots written');"`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `cd clients/lattice-client && npm run build`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run typecheck`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run tauri:bridge`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run conformance`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run canonical`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run township:authoring`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township`
- `cd clients/lattice-client && PATH="$HOME/.asdf/shims:$PATH" npm run carrier:township:live`
- `export PATH="$HOME/.asdf/shims:$PATH"; command -v mix; command -v elixir; command -v erl; ~/.asdf/shims/mix --version`
- `export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix format --check-formatted`
- `export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix check`
- `cd apps/lattice_server && export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Connect the Vue action to a real WebSocket carrier session and peer configuration.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Add onboarding/cap issuance so a newly generated device key can receive a local delegation.
- Add a live desktop app smoke test once launch ergonomics exist.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
