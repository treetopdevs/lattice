# Plan 045: Tauri Vue WebSocket carrier peer config (E1)

## Status

DONE.

## Objective

Wire the Township Vue shell's sync action to a real carrier WebSocket session configuration. The
shell should be able to parse a peer config, authenticate a carrier session with the native signer,
verify the peer hello with Ed25519, and feed the connected `CarrierWebSocketClient` into the Plan
044 sync action.

Planned at commit `6b2cfe5`.

## Scope

- Add `src/township_carrier_peer.ts` for peer config parsing, base64 peer keys, WebCrypto Ed25519
  verification, and `connectCarrierWebSocket` wiring.
- Extend `syncTownshipOutbox` so callers may pass either an injected `CarrierSyncClient` or a
  `TownshipCarrierPeerConfig`; the peer path should create one native workflow, connect the carrier
  session, sync once, persist the merged log, and close the WebSocket client afterward.
- Add TypeScript behavior tests that:
  - parse Vite-style environment variables into a peer config,
  - prove the WebCrypto verifier accepts the W1 peer signature and rejects a tampered signature,
  - sync through a scripted WebSocket that exercises the real `connectCarrierWebSocket` handshake,
    native signing command, peer hello verification, frontier/pull/push requests, and local-log
    persistence.
- Wire `App.vue` to pass `townshipCarrierPeerFromEnv()` into the sync action so browser preview
  remains honestly unconfigured unless the Vite env supplies a peer.
- Keep live Tauri app launch, spawning a BEAM peer from the UI, onboarding/cap issuance, ack-driven
  outbox pruning, mobile secure-store strategy, and broader authoring commands out of scope.

## TDD Plan

1. RED: add `test/township_carrier_peer.ts` plus a package script asserting env parsing and
   WebCrypto verifier behavior.
2. RED: extend `test/township_sync.ts` with a scripted-WebSocket peer sync path that fails until
   `syncTownshipOutbox` accepts peer config.
3. RED: extend the frontend contract to require `App.vue` to use `townshipCarrierPeerFromEnv()`.
4. GREEN: add the peer connector module, extend the sync wrapper, and wire the Vue sync button to
   the parsed peer config.
5. VERIFY: run the shell contracts, typecheck/build/browser smoke, Rust checks, TS client checks,
   and umbrella gates with BEAM commands pinned to the asdf shims.

## TDD Evidence

1. RED: `npm run peer:contract` failed with `ERR_MODULE_NOT_FOUND` because
   `src/township_carrier_peer.ts` did not exist.
2. RED: `npm run sync:contract` failed with `ERR_MODULE_NOT_FOUND` because the peer-backed sync
   contract imported the missing connector module.
3. RED: `npm run frontend:contract` failed with `ENOENT` because the frontend contract required
   `src/township_carrier_peer.ts` and `App.vue` did not yet call `townshipCarrierPeerFromEnv()`.
4. GREEN: added `township_carrier_peer.ts` with Vite env parsing, WebCrypto Ed25519 peer-hello
   verification, and `connectCarrierWebSocket` wiring.
5. GREEN: extended `syncTownshipOutbox` so a caller can provide either an injected
   `CarrierSyncClient` or a `TownshipCarrierPeerConfig`. The peer-config path creates one native
   workflow, signs the carrier challenge through native invoke, verifies the peer hello, syncs once,
   persists the merged local log, and closes the WebSocket client.
6. GREEN: `npm run sync:contract` proved the scripted-WebSocket path performs the real carrier
   handshake, sends the native signing command with the configured session key id, pulls five peer
   frames, pushes the two missing local frames, persists the eleven-op merged log, and closes the
   socket.
7. RED/GREEN: `npm run typecheck` caught DOM `BufferSource` typing, Node-only `Buffer` usage in
   browser code, and a too-narrow closeable-client type. The fixes kept the behavior contracts green
   and made Vue typecheck pass.
8. VERIFY: shell contracts/typecheck/build, browser screenshots and sync-button smoke, Rust checks,
   TS client checks, umbrella Mix, and Sobelow gates pass.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- Claude Code requested after implementation: blocked locally with `Not logged in · Please run /login`.

## Verification

- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `curl -fsS http://127.0.0.1:5173/`
- `cd clients/township-tauri-shell && node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 1050 }, mobile: { width: 390, height: 1100 } })) { const page = await browser.newPage({ viewport }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.waitForTimeout(500); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (overflow > 1) throw new Error(name + ' horizontal overflow ' + overflow); await page.screenshot({ path: '/tmp/township-tauri-peer-config-final-' + name + '.png', fullPage: true }); await page.close(); } const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } }); await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForSelector('#app main.shell', { timeout: 10000 }); await page.click('button:has-text(\"Sync outbox\")'); await page.waitForFunction(() => document.body.innerText.includes('Connect a carrier peer before syncing.'), null, { timeout: 10000 }); await page.screenshot({ path: '/tmp/township-tauri-peer-config-final-click.png', fullPage: true }); await browser.close(); console.log('screenshots written');"`
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
- `export PATH="$HOME/.asdf/shims:$PATH"; command -v mix; command -v elixir; command -v erl; ~/.asdf/shims/mix --version`
- `export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix format --check-formatted`
- `export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix check`
- `cd apps/lattice_server && export PATH="$HOME/.asdf/shims:$PATH"; ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Launch the actual Tauri app against a live BEAM peer and capture a desktop smoke artifact.
- Add onboarding/cap issuance so a newly generated device key can receive a local delegation.
- Add ack/compaction semantics before claiming the carrier-frame store is a pending-only outbox.
- Decide the mobile secret-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
