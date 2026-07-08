# Plan 042: Tauri Vue native invoke workflow (E1)

## Status

DONE.

## Objective

Wire the Township Vue shell to the real Tauri `invoke` API through the existing
`@treetopdevs/lattice-client` bridge. The Vue app should exercise native key-value storage and
native carrier signing from UI code without claiming a live Tauri app launch or mobile secure-store
strategy.

Planned at commit `6b2cfe5`.

## Scope

- Add the frontend Tauri API dependency and TypeScript test runner to the Township shell package.
- Add `src/native_workflow.ts`, a small UI-facing module that imports `invoke` from
  `@tauri-apps/api/core`, builds the namespaced Tauri key-value store, local op-log store, carrier
  frame outbox, and native carrier signer through `@treetopdevs/lattice-client`.
- Add a probe that writes/reads a native storage value and signs a fixed challenge byte string,
  returning a compact status object for Vue.
- Update `App.vue` to run the probe on mount and show whether native invoke is ready or unavailable.
- Add a behavior test that uses a complete fake native command surface to prove the UI module calls
  the real command names and namespaces storage correctly.
- Keep live desktop app launch, mobile secure-store strategy, and full author-and-persist UI actions
  out of scope.

## TDD Plan

1. RED: add `test/native_workflow.ts` and a package script asserting the wished-for
   `probeTownshipNativeWorkflow` behavior.
2. GREEN: add the Tauri API dependency, TypeScript test runner, `native_workflow.ts`, and Vue status
   integration.
3. VERIFY: run the native workflow test, frontend contract/typecheck/build, Vite browser smoke, Rust
   native checks, TS client checks, and umbrella gates with BEAM commands pinned to the asdf shims.

## TDD Evidence

1. RED: `npm run native:contract` failed with `ERR_MODULE_NOT_FOUND` because
   `src/native_workflow.ts` did not exist.
2. GREEN: added `@tauri-apps/api`, the `tsx` test runner, `native_workflow.ts`, and a complete fake
   native command surface proving the module calls `lattice_ensure_carrier_key`, namespaced
   `lattice_kv_set`/`lattice_kv_get`, and `lattice_sign_carrier`.
3. RED: after temporarily removing the App integration, `npm run frontend:contract` failed because
   `App.vue` did not call `loadTownshipNativeStatus()`.
4. GREEN: re-added the Vue `onMounted` native-status load and device-key status surface.
5. VERIFY: native workflow contract, frontend contract, typecheck, Vite build, waited Playwright
   desktop/mobile screenshots, Rust checks, TS client checks, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && npm install`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run dev`
- `curl -fsS http://127.0.0.1:5173/`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } })) { const page = await browser.newPage({ viewport }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.waitForTimeout(500); await page.screenshot({ path: '/tmp/township-tauri-native-shell-final-' + name + '.png', fullPage: true }); await page.close(); } await browser.close();"`
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

- Replace the probe-only UI with real author-and-persist Township actions.
- Add a live desktop app smoke test once launch ergonomics exist.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
