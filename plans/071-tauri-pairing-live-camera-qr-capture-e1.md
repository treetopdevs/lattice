# Plan 071: Tauri pairing live camera QR capture (E1)

## Status

DONE.

## Objective

Let the Tauri shell capture a Township pairing QR from a live camera frame and load it as draft
pairing metadata through the same public handoff path as QR image import, without saving, syncing,
connecting, discovering peers, or adding any new trust claim.

## Scope

- Add a camera scanner seam that consumes an injected frame source and reuses
  `decodeTownshipPairingQrImageData`.
- Ignore blank/no-QR frames so camera preview noise does not overwrite pairing state.
- Stop the camera source after the first meaningful QR result, whether valid or invalid.
- Add browser `getUserMedia` wiring in `App.vue` with Start/Stop controls under Carrier pairing.
- Apply a valid camera result to `pairingDraft`, `pairingHandoffDraft`, and peer fingerprint only;
  Save remains the persistence gate before sync.
- Preserve the existing QR image import path and the static/deep-link handoff paths.

## STOP Conditions

- If camera capture bypasses `decodeTownshipPairingQrImageData` or
  `importTownshipCarrierPairingHandoff`, stop.
- If camera capture saves pairing config, opens a WebSocket session, syncs the outbox, mutates
  `carrierPeer`, or marks a peer trusted before explicit Save, stop.
- If `keyId`, `localRealm`, raw seed bytes, private keys, or any device-local identity selector can
  transfer through a camera QR, stop.
- If this slice adds peer discovery, installed-app OS deep-link delivery, phone-grade mobile
  convergence, or W4 receipt-freeness claims, stop.
- If blank camera frames produce persistent errors or overwrite existing draft state, stop.
- If stopping the scanner leaves the media stream tracks alive, stop.

## TDD Evidence

- RED: `npm run qr:camera:contract` failed because
  `src/township_pairing_qr_camera.ts` did not exist.
- RED: `npm run frontend:contract` failed because the frontend contract could not find the camera
  source module or App.vue camera controls.
- GREEN: `qr:camera:contract` proves the scanner subscribes to an injected frame source, ignores
  blank frames, decodes a valid camera QR into the same draft-only public handoff result, strips
  device-local identity fields, stops after the first meaningful result, ignores later frames, and
  surfaces non-empty invalid pairing QR payloads without continuing the camera loop.
- GREEN: `frontend:contract` proves App.vue exposes camera start/stop controls, uses
  `navigator.mediaDevices.getUserMedia` with an environment-facing camera preference, applies camera
  capture as "save before sync" draft metadata, and avoids auto-connect, connected-state,
  secure-pairing, or discovery claims.

## Second Opinion

Claude Code was asked for a pre-review on this slice, but the CLI review prompt hung and had to be
interrupted. This is recorded as reviewer unavailability, not as a GO. The implementation stayed
inside the previously reviewed pairing boundaries from plans 068-070: reuse the pure QR/handoff
decoder, keep imports draft-only, do not transfer local identity, and leave Save as the only
persistence gate.

## Verification

- `cd clients/township-tauri-shell && npm run qr:camera:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run qr:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- Installed-app OS deep-link delivery smoke remains open.
- Peer discovery remains open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
