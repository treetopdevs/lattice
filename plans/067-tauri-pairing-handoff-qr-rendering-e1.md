# Plan 067: Tauri pairing handoff QR rendering (E1)

## Status

DONE.

## Objective

Render the existing public Township carrier pairing handoff as a deterministic QR code in the
Tauri shell, without adding camera scanning, OS scheme registration, peer discovery, automatic
save/sync/connect behavior, or any new security claim.

## Scope

- Add a pure QR rendering helper for validated `township-pairing:v1:` handoff strings.
- Validate the input through `importTownshipCarrierPairingHandoff` before rendering.
- Render only the same public handoff string that Plan 066 already proved omits `keyId` and
  `localRealm`.
- Return a deterministic SVG and boolean module matrix so headless contract tests can decode the
  QR independently.
- Add a Vue display for the saved/exported handoff QR, with copy that keeps peer fingerprint
  verification as the trust step before save.
- Keep import as a draft-only load; loading a handoff does not save, sync, or open a carrier
  session.

## STOP Conditions

- If QR rendering encodes anything besides the existing public handoff string, stop.
- If rendered QR content includes `keyId`, `localRealm`, raw seed bytes, private keys, or any
  device-local identity selector, stop.
- If the receive path bypasses `importTownshipCarrierPairingHandoff` validation, stop.
- If the UI says "scan to pair", "camera", "secure pairing", "connected to carrier", "paired
  with", or implies OS deep-link registration or peer discovery, stop.
- If the helper needs browser canvas/native runtime to run the contract test, stop.
- If this slice claims phone-grade mobile convergence or W4 receipt-freeness, stop.

## TDD Evidence

- RED: `npm run qr:contract` failed because the test-only independent QR decoder dependency was
  absent and the QR helper did not exist.
- RED: `npm run frontend:contract` failed because `App.vue` did not render a pairing QR.
- GREEN: QR contract now proves deterministic rendering, matrix shape, SVG accessibility, `jsqr`
  decode back to the exact handoff string, re-import through the existing handoff validator, and
  absence of device-local identity/private-material strings.
- GREEN: frontend contract now proves the Vue shell imports the QR helper, renders the SVG, says
  the QR carries the same public handoff, keeps fingerprint-before-save copy, and avoids scanner,
  deeplink, discovery, secure-pairing, or connected-state claims.

## Second Opinion

Claude Code pre-reviewed the next slice and gave GO for QR rendering of the existing pairing
handoff. It gave NO-GO for a device-less "mobile convergence" smoke because that would be a fake
mobile proof without a simulator/device. Claude required the QR seam to stay pure and headless,
encode only the existing public handoff string, decode/round-trip through the handoff importer in
tests, and leave scanning, OS deep-link registration, peer discovery, phone-grade mobile convergence,
and W4 out of scope.

## Verification

- `cd clients/township-tauri-shell && npm run qr:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
