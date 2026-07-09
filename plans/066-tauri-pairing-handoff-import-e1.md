# Plan 066: Tauri pairing handoff import/export (E1)

## Status

DONE.

## Objective

Add a copy-paste/deep-link-safe carrier pairing handoff string for the Tauri shell so a receiving
device can load public carrier routing and peer-verification metadata into the runtime pairing
draft without copying device-local identity selectors, saving automatically, syncing, or claiming
OS-level deep-link registration.

## Scope

- Export `township-pairing:v1:<base64url-utf8-json>` handoff strings from the saved carrier peer.
- Carry only public carrier peer/routing fields:
  - `url`
  - `expectedPeerRealm`
  - `expectedPeerPubkey`
  - `replica`
- Omit `keyId` and `localRealm`; both are device-local identity choices for the receiving shell.
- Strip `keyId` and `localRealm` even if a hand-crafted handoff payload includes them.
- Decode handoff JSON with `TextEncoder`/`TextDecoder` over UTF-8 bytes, not direct
  `btoa(JSON.stringify(...))`.
- Return typed parse/validation errors for bad prefix, unsupported version, invalid payload, bad
  URL, missing peer realm, and invalid peer public key without throwing.
- Treat import as a validated draft patch only. The existing `saveTownshipCarrierPeerConfig` path
  remains the full config validation and persistence gate.
- Surface the peer public-key fingerprint in Vue so the operator can compare it before saving.

## STOP Conditions

- If handoff export or import carries `keyId`, stop.
- If handoff export or import carries `localRealm` as a saved receiver identity, stop.
- If importing a handoff saves pairing config, syncs the carrier, opens a carrier session, or
  mutates `carrierPeer` before the explicit Save action, stop.
- If UI copy says "paired with", "connected to carrier", "secure pairing", "phone-grade secure
  persistence", or otherwise claims OS deep-link registration/QR/discovery, stop.
- If malformed handoff strings throw instead of returning typed errors, stop.

## TDD Evidence

- RED: `npm run peer:contract` failed because
  `exportTownshipCarrierPairingHandoff` was not exported from `township_carrier_peer.ts`.
- RED: `npm run frontend:contract` failed because the Vue shell did not expose the pairing handoff
  helpers or import/export controls.
- GREEN: peer contract now proves handoff round-trip, UTF-8 realm handling, `keyId`/`localRealm`
  omission and hostile-payload stripping, peer-fingerprint derivation, no-secret string scanning,
  and typed parse/validation errors.
- GREEN: frontend contract now proves the Vue shell exposes handoff export/load controls, displays
  the peer fingerprint, preserves save-before-sync copy, and does not claim connected/paired/secure
  state.

## Second Opinion

Claude Code pre-reviewed the slice and gave conditional GO. It agreed that excluding `keyId` is
required because it selects a device-local native signer, but caught the sharper issue that
`localRealm` is also a device identity field: importing another device's `localRealm` with a
different local key would back into an identity fork. Claude required treating import as a draft
patch, actively stripping both fields, using UTF-8-safe base64url encoding, returning typed parse
errors, and rendering a peer fingerprint before save.

## Verification

- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
