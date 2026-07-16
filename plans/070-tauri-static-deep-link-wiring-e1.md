# Plan 070: Tauri static deep-link wiring (E1)

## Status

DONE.

## Objective

Wire the Township Tauri shell to Tauri's real deep-link plugin, static scheme config, and main-window
capability permissions so installed app delivery can be tested in a later slice, while preserving the
existing draft-only pairing handoff path and avoiding any claim that OS delivery has been proven.

## Scope

- Add the Tauri deep-link plugin dependencies on both sides of the shell:
  - `@tauri-apps/plugin-deep-link`
  - `tauri-plugin-deep-link`
- Initialize `tauri_plugin_deep_link::init()` in the existing Township builder path.
- Keep `bundle.active = false`, but add static `township` scheme config for desktop and mobile
  under `plugins.deep-link`.
- Add a main-window capability file that grants only the event and deep-link permissions needed to
  read current URLs and subscribe to future URL events.
- Add a lazy JS source adapter for `@tauri-apps/plugin-deep-link` that implements the existing
  `TownshipPairingDeepLinkSource` seam without importing the plugin from the pure parser module.
- Mount that source only when the Tauri runtime is present; a received link loads pairing metadata
  as a draft and still requires explicit Save before sync.

## STOP Conditions

- If `bundle.active` is flipped to true in this slice, stop.
- If this slice claims installed-app OS URL delivery is proven, stop.
- If the runtime path calls `register_all`, stop.
- If `township_pairing_deeplink.ts` imports `@tauri-apps/plugin-deep-link` directly, stop.
- If a deep link saves pairing config, opens a WebSocket, auto-syncs, or marks the peer trusted,
  stop.
- If `keyId`, `localRealm`, seed bytes, private keys, or any device-local identity selector can
  transfer through a pairing link, stop.
- If the capability grants grow beyond the main window's event/deep-link read/listen needs, stop.

## TDD Evidence

- RED: `npm run deeplink:source:contract` failed because
  `src/township_pairing_deeplink_source.ts` did not exist.
- RED: `cargo test --test runtime_bootstrap` failed during Tauri context generation with
  `Permission deep-link:default not found`, proving the capability file was present before the
  plugin dependency/init path existed.
- GREEN: `deeplink:source:contract` proves plugin import is lazy, `getCurrent` and `onOpenUrl`
  delegate through the adapter, optional unlisten is preserved, null current URLs are tolerated, and
  the existing listener still parses both current and opened URL batches through the draft-only
  pairing parser.
- GREEN: `runtime_bootstrap` proves the generated Tauri context keeps `bundle.active = false` and
  embeds the static `township` deep-link scheme config for desktop and mobile.
- GREEN: `frontend:contract` proves App.vue wires the lazy source only through a Tauri runtime
  guard, preserves the "save before sync" ceremony, and avoids OS delivery, connection,
  secure-pairing, camera, or discovery claims.

## Second Opinion

Claude Code pre-reviewed the slice and gave a conditional GO for static plugin/config/capability
wiring plus a lazy source adapter. It recommended keeping installed-app delivery out of scope,
keeping `bundle.active = false`, avoiding `register_all`, keeping the pure parser free of direct
plugin imports, and preserving explicit Save before any sync or trust effect.

Official Tauri docs checked for the API/config boundary:

- https://v2.tauri.app/plugin/deep-linking/

## Verification

- `cd clients/township-tauri-shell && npm run deeplink:source:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run qr:contract`
- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`

## Remaining Work

- Installed-app OS deep-link delivery smoke remains open.
- Live camera QR capture and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
