# Plan 043: Tauri Vue author-and-persist post action (E1)

## Status

DONE.

## Objective

Add the first cap-gated Township authoring action to the Vue shell. A user-facing post action should
call the real shell workflow (`createTownshipNativeWorkflow` + `authorAndPersistTownshipCommand`),
append the semantic op to native-backed local storage, append the signed carrier frame to the native
outbox, and return an honest missing-delegation status when the device key has no local cap.

Planned at commit `6b2cfe5`.

## Scope

- Add `src/township_actions.ts`, a UI-facing wrapper around the existing client
  `authorAndPersistTownshipCommand` workflow.
- Reuse `src/native_workflow.ts` for namespaced native key-value storage, local op-log store, carrier
  frame outbox, and native signer discovery.
- Add a TypeScript behavior test that seeds local storage with the W1 carrier vector minus the
  resident post, then proves the action writes the exact expected signed frame and semantic op.
- Add a missing-delegation test for an empty local outbox.
- Add a small post composer to `App.vue` that calls the action and shows success, missing-delegation,
  validation, or native-unavailable status.
- Keep live peer push/sync, live Tauri app launch, mobile secure-store strategy, and onboarding/cap
  issuance out of scope.

## TDD Plan

1. RED: add `test/township_actions.ts` and a package script asserting the wished-for
   `submitTownshipPost` success and missing-delegation behavior.
2. RED: extend the frontend contract to require `App.vue` to call `submitTownshipPost` from a post
   composer.
3. GREEN: add the action wrapper and Vue composer/status surface.
4. VERIFY: run the action/native/frontend tests, typecheck/build/browser smoke, Rust checks, TS
   client checks, and umbrella gates with BEAM commands pinned to the asdf shims.

## TDD Evidence

1. RED: `npm run action:contract` failed with `ERR_MODULE_NOT_FOUND` because
   `src/township_actions.ts` did not exist.
2. RED: `npm run frontend:contract` failed because `src/township_actions.ts` did not exist and
   `App.vue` did not expose the wished-for composer/action path.
3. GREEN: added `submitTownshipPost`, the W1 replica/realm constants, and a Vue post composer that
   calls the action.
4. GREEN: `npm run action:contract` proved the wrapper creates a native workflow, loads local
   storage, selects the resident delegation, signs the exact W1 post frame, appends the semantic op,
   appends the carrier frame outbox, rejects empty posts, and reports missing delegation for an empty
   outbox.
5. RED/GREEN: added a failing assertion that native-unavailable errors should be user-facing rather
   than raw Tauri internals, then changed the message to `Open in the Tauri shell to sign and save
   local posts.`
6. VERIFY: action/native/frontend contracts, typecheck, Vite build, browser screenshots and fallback
   submit, Rust checks, TS client checks, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `curl -fsS http://127.0.0.1:5173/`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 1000 }, mobile: { width: 390, height: 1000 } })) { const page = await browser.newPage({ viewport }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.waitForTimeout(500); await page.screenshot({ path: '/tmp/township-tauri-post-action-final-' + name + '.png', fullPage: true }); await page.close(); } await browser.close();"`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.fill('textarea[aria-label=\"Township post update\"]', 'browser smoke post'); await page.click('button[type=\"submit\"]'); await page.waitForFunction(() => document.body.innerText.includes('Open in the Tauri shell to sign and save local posts.'), null, { timeout: 10000 }); await browser.close();"`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
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

- Push the persisted carrier-frame outbox to a live peer from the UI.
- Add onboarding/cap issuance so a newly generated device key can receive a local delegation.
- Add a live desktop app smoke test once launch ergonomics exist.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
