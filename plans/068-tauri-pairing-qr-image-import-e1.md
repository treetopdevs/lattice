# Plan 068: Tauri pairing QR image import (E1)

## Status

DONE.

## Objective

Let the Tauri shell consume a supplied image of a Township pairing QR and load its public carrier
handoff as draft pairing metadata, without adding live camera capture, OS deep-link registration,
peer discovery, automatic save/sync/connect behavior, or new trust claims.

## Scope

- Add a pure QR image-data decoder that accepts RGBA bytes and dimensions.
- Decode QR text with `jsqr`, then delegate to `importTownshipCarrierPairingHandoff`.
- Return the same draft-only handoff data and peer fingerprint as paste/import.
- Return typed errors for missing QR content and malformed/unsupported handoff payloads.
- Add a Vue file-input path for a QR image that fills the pairing draft, handoff text, and peer
  fingerprint.
- Keep Save as the only persistence gate; QR image import does not mutate `carrierPeer`, sync,
  open a carrier session, or claim the peer is trusted.

## STOP Conditions

- If QR image import bypasses `importTownshipCarrierPairingHandoff`, stop.
- If image import saves pairing config, opens a WebSocket session, syncs the outbox, or mutates
  `carrierPeer` before explicit Save, stop.
- If the UI claims camera capture, "scan to pair", "secure pairing", "connected to carrier",
  "paired with", OS deep-link registration, peer discovery, phone-grade mobile convergence, or W4
  receipt-freeness, stop.
- If decoded handoff data can transfer `keyId`, `localRealm`, raw seed bytes, private keys, or
  any device-local identity selector, stop.
- If `jsqr` remains a dev-only dependency while production Vue imports it, stop.

## TDD Evidence

- RED: `npm run qr:contract` failed because `decodeTownshipPairingQrImageData` was not exported
  from `township_pairing_qr.ts`.
- RED: `npm run frontend:contract` failed because the Vue shell did not expose QR image import
  state or controls.
- GREEN: QR contract now renders a known public handoff QR, converts the matrix to RGBA image
  data, decodes it with the production helper, reuses the existing handoff importer, preserves the
  draft/fingerprint, returns `invalid_pairing_qr` for blank image data, and propagates malformed
  handoff payload errors.
- GREEN: frontend contract now proves the Vue shell imports the decoder, exposes a QR image file
  input, fills the existing draft with decoded public metadata, keeps save-before-sync copy, and
  avoids camera/scanner/discovery/secure-pairing/connected-state claims.

## Second Opinion

Claude Code pre-reviewed the remaining gap and recommended doing QR image decode before OS
deep-link registration. It gave NO-GO for claiming OS deep-link registration because the shell has
`bundle.active = false`, no mobile target exists, and desktop/mobile OS delivery cannot be proven
from the current repo. It gave GO for the pure QR image-data decode seam because it reuses the
already-present QR round-trip harness, adds no native/device dependency, and completes the
rendered-QR consume path while keeping live camera capture out of scope.

## Verification

- `cd clients/township-tauri-shell && npm run qr:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
