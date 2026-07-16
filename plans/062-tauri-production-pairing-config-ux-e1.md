# Plan 062: Tauri production pairing config UX (E1)

## Status

DONE.

## Objective

Replace the Tauri shell's env-only carrier peer setup with a runtime pairing panel that persists
non-secret carrier peer config through native storage, validates it before saving, and lets sync use
the saved config while retaining env config as a dev/smoke fallback.

## Scope

- Add normalized carrier peer config validation for URL, realms, replica, key id, and peer public
  key.
- Require carrier URLs to use `ws://` or `wss://`.
- Require the peer public key to decode as a 32-byte Ed25519 public key.
- Persist only public pairing metadata under `carrier_peer_config`.
- Prefer valid persisted config over env config; fall back to env when storage is missing, empty,
  invalid, or unavailable.
- Add a Vue `Carrier pairing` panel with runtime fields for carrier URL, local realm, peer realm,
  peer public key, and key id.
- Make sync consume the current reactive pairing config rather than a module-level env-only
  constant.
- Keep saving distinct from connecting; sync remains the only action that opens a carrier session.
- Do not add QR/deeplink pairing, peer discovery, connection-health UI, phone-grade mobile
  convergence, or W4 receipt-freeness in this slice.

## STOP Conditions

- If persisted pairing JSON stores seed/private/secret material, stop.
- If the UI says saving means "connected" or "paired with" a carrier, stop; save only records
  config for future sync.
- If invalid peer public keys can be saved and then crash connect later, stop.
- If env smoke config no longer works when no valid persisted config exists, stop.
- If verifier anchoring on the peer public key is weakened or made optional, stop.
- If the slice expands into discovery, QR/deeplink handoff, or connection-health UX, stop.

## TDD Evidence

- RED: `npm run peer:contract` failed because the pairing config exports were missing.
- RED: `npm run native:contract` failed because `createTownshipNativeStorage` was missing.
- RED: `npm run frontend:contract` failed because Vue still used an env-only carrier peer constant
  and exposed no runtime pairing panel.
- GREEN: peer config tests now cover trimming/defaulting, invalid URL/public-key rejection,
  persisted-over-env precedence, env fallback for empty/invalid storage, no-secret storage, and
  no-save on invalid config.
- GREEN: native workflow tests now prove a storage-only helper can persist namespaced pairing
  config without signer work.
- GREEN: frontend source tests now prove the Vue shell exposes the runtime pairing fields, saves
  through native storage, syncs through `carrierPeer.value`, keeps env autosync fallback, and avoids
  secret/connected overclaim copy.

## Second Opinion

Claude Code gave conditional GO before implementation. It agreed this is the right first production
pairing slice because runtime, persisted peer config is the essence of moving beyond `VITE_*`
build-time setup. Guardrails were: store only public metadata, validate the 32-byte peer pubkey
before saving, keep peer pubkey verification unconditional, prefer valid persisted config over env
while preserving env fallback for smoke, and do not claim saving equals a live connection.

Post-review Claude Code gave GO after inspecting the implementation, diffs, tests, and secret
scanning contract. It confirmed the persisted config serializes only normalized public metadata,
env fallback still supports the smoke path, verifier anchoring is unchanged, and save copy does not
overclaim a live connection. Optional follow-ups are documenting standard base64 for env peer
pubkeys and adding a defense-in-depth test that malicious extra secret fields are dropped.

## Verification

- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell && npm run build`
- `~/.asdf/shims/mix format --check-formatted`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Connection-health UI remains open.
- Standard-base64 peer pubkey expectations can be documented near the env config.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Authority-confirmed effective-revocation UI remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
