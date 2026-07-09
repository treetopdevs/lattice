# Plan 069: Tauri pairing deep-link ingress (E1)

## Status

DONE.

## Objective

Let the Tauri shell parse `township://pairing` URLs that carry the existing public carrier pairing
handoff and load them as draft pairing metadata, without claiming OS scheme registration, installed
app delivery, live camera capture, peer discovery, automatic save/sync/connect behavior, or new
trust properties.

## Scope

- Add a pure `parseTownshipPairingDeepLink` function for:
  - `township://pairing?handoff=<township-pairing:v1:...>`
  - `township://pairing/<township-pairing:v1:...>`
- Delegate all handoff validation to `importTownshipCarrierPairingHandoff`.
- Return the same draft-only handoff data and peer fingerprint as paste/QR import.
- Add an injected deep-link listener seam that can consume current and future URL batches without
  hard-importing Tauri's plugin bindings.
- Let the existing Pairing handoff field accept a `township://pairing` URL and normalize it back to
  the underlying public handoff after loading.
- Keep Save as the only persistence gate; link import does not mutate `carrierPeer`, sync, open a
  carrier session, or claim the peer is trusted.

## STOP Conditions

- If deep-link parsing bypasses `importTownshipCarrierPairingHandoff`, stop.
- If link import saves pairing config, opens a WebSocket session, syncs the outbox, or mutates
  `carrierPeer` before explicit Save, stop.
- If `keyId`, `localRealm`, raw seed bytes, private keys, or any device-local identity selector can
  transfer through a pairing URL, stop.
- If the listener hard-imports `@tauri-apps/plugin-deep-link` instead of staying injectable, stop.
- If this slice adds `tauri-plugin-deep-link`, Tauri plugin init, `tauri.conf.json` scheme config,
  or capability files and then calls OS registration/delivery proven, stop.
- If UI or docs claim installed-app delivery, scheme registration, phone-grade mobile convergence,
  live camera capture, peer discovery, or W4 receipt-freeness, stop.
- If malformed URLs throw instead of returning typed errors, stop.

## TDD Evidence

- RED: `npm run deeplink:contract` failed because `src/township_pairing_deeplink.ts` did not exist.
- GREEN: `deeplink:contract` now proves both supported URL forms produce the same draft and peer
  fingerprint as the existing handoff importer, device-local fields are stripped, malformed URLs
  return `invalid_pairing_deeplink`, handoff payload errors propagate, and the injected listener
  consumes current and future URL batches without a native runtime.
- GREEN: frontend contract now proves the Pairing handoff path recognizes the parser, normalizes a
  parsed link back to the public handoff, preserves save-before-sync copy, and avoids OS delivery,
  connection, secure-pairing, camera, or discovery claims.

## Second Opinion

Claude Code pre-reviewed the remaining shell gaps and gave GO for this split slice: pure parser plus
injected listener now, plugin/Cargo/`tauri.conf.json` OS-registration wiring deferred. It warned that
Tauri's deep-link plugin requires configured schemes and installed/platform-specific delivery to
prove real OS handling, so adding plugin/config scaffolding in this slice would create a false
signal while `bundle.active = false` and no mobile target/installed-app smoke exists.

Official Tauri docs checked for this boundary:

- https://v2.tauri.app/plugin/deep-linking/

## Verification

- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- OS deep-link scheme registration and installed-app delivery smoke remain open.
- Live camera QR capture and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
