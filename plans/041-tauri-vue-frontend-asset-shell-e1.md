# Plan 041: Tauri Vue frontend asset shell (E1)

## Status

DONE.

## Objective

Add the first Vue 3.5 frontend asset shell for the Township Tauri app and configure Tauri to serve
the built assets. The shell should consume `@treetopdevs/lattice-client` and materialize a real
Township matter preview, moving E1 from runtime-only bootstrap to an actual UI asset path.

Planned at commit `6b2cfe5`.

## Scope

- Add a Vite/Vue frontend package at `clients/township-tauri-shell`.
- Configure `src-tauri/tauri.conf.json` with `beforeBuildCommand`, `beforeDevCommand`, `devUrl`,
  and `frontendDist`.
- Add a reducer-backed Township preview module that uses `materialize` from
  `@treetopdevs/lattice-client`.
- Add a first Vue screen for the zoning-variance matter with compact civic-tool UI.
- Add a Node contract test for the frontend package/config/source contract.
- Keep live desktop launch, native invoke wiring from the Vue screen, mobile secure-store strategy,
  and production visual polish out of scope.

## TDD Plan

1. RED: add `test/frontend_shell.mjs` asserting Tauri frontend asset config, Vue package scripts,
   app root, reducer-backed preview module, and App usage.
2. GREEN: add package metadata, Vite/Vue source files, Tauri frontend build config, and generated
   package lock.
3. VERIFY: run frontend contract/build checks, native Rust checks, TS client checks, and umbrella
   gates with BEAM commands pinned to the asdf shims.

## TDD Evidence

1. RED: `node --test test/frontend_shell.mjs` failed because `tauri.conf.json` had no frontend
   build config, no frontend `package.json` existed, and no Vue source files existed.
2. GREEN: added the Vite/Vue shell package, Tauri frontend build config, reducer-backed
   `township_preview.ts`, first `App.vue` screen, CSS, and package lock.
3. GREEN: `vue-tsc` and Vite initially caught that `@treetopdevs/lattice-client` exported
   `dist/index.js` while its build emits `dist/src/index.js`; fixed the package export so shells can
   consume the local package normally.
4. VERIFY: frontend contract, typecheck, Vite build, Vite HTTP smoke, Playwright desktop/mobile
   screenshots, native Rust tests, TS client checks, live carrier, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && node --test test/frontend_shell.mjs`
- `cd clients/township-tauri-shell && npm install`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run dev`
- `curl -fsS http://127.0.0.1:5173/`
- `curl -fsS http://127.0.0.1:5173/src/main.ts`
- `cd clients/township-tauri-shell && npx playwright screenshot --viewport-size=1280,900 http://127.0.0.1:5173/ /tmp/township-tauri-shell.png`
- `cd clients/township-tauri-shell && npx playwright screenshot --viewport-size=390,844 http://127.0.0.1:5173/ /tmp/township-tauri-shell-mobile.png`
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

- Wire the Vue screen to real Tauri `invoke` storage/signing commands.
- Add a live desktop app smoke test once runtime launch is ergonomic.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
