# Plan 072: Tauri pairing discovery candidate channel (E1)

## Status

DONE.

## Objective

Add a manual peer-discovery candidate channel to the Township Tauri pairing flow so the shell can
receive public pairing handoff adverts and present them for explicit user loading, without
auto-pairing, saving, syncing, connecting, or adding any new trust claim.

## Scope

- Add a `TownshipPairingDiscoverySource` seam that emits public pairing handoff adverts.
- Validate every discovered handoff through `importTownshipCarrierPairingHandoff`.
- Deduplicate valid candidates by peer fingerprint and carrier URL.
- Strip device-local identity fields by reusing the existing public handoff importer.
- Add a browser `BroadcastChannel("township-pairing-discovery")` source in `App.vue`.
- Add manual Start/Stop discovery controls and a Load discovered handoff action.
- Loading a discovered candidate only fills draft pairing metadata and still requires explicit Save
  before sync.

## STOP Conditions

- If discovered candidates bypass `importTownshipCarrierPairingHandoff`, stop.
- If discovery saves pairing config, opens a WebSocket session, syncs the outbox, mutates
  `carrierPeer`, or marks a peer trusted before explicit Save, stop.
- If `keyId`, `localRealm`, raw seed bytes, private keys, or any device-local identity selector can
  transfer through discovery, stop.
- If this slice claims LAN/mDNS/Bluetooth/local-network discovery, installed-app OS deep-link
  delivery, phone-grade mobile convergence, or W4 receipt-freeness, stop.
- If malformed adverts throw or poison the discovery loop instead of surfacing typed errors, stop.

## TDD Evidence

- RED: `npm run discovery:contract` failed because
  `src/township_pairing_discovery.ts` did not exist.
- RED: `npm run frontend:contract` failed because the Vue shell had no discovery source module or
  manual discovery controls.
- GREEN: `discovery:contract` proves the discovery seam subscribes to an injected source, validates
  candidates through the handoff importer, emits draft-only public metadata, strips local identity,
  deduplicates repeated candidates, surfaces malformed adverts as typed errors, ignores adverts after
  stop, and stops idempotently.
- GREEN: `frontend:contract` proves App.vue exposes manual Start/Stop discovery controls, listens on
  `BroadcastChannel("township-pairing-discovery")`, shows candidate fingerprint state, loads a
  discovered candidate only as save-before-sync draft metadata, and avoids auto-pair, auto-connect,
  connected-state, trusted-peer, or secure-pairing claims.

## Second Opinion

Claude Code was asked for a pre-review on this slice, but the CLI review prompt hung and had to be
interrupted. This is recorded as reviewer unavailability, not as a GO. The implementation stayed
inside the previously reviewed pairing boundaries from plans 066-071: public handoff metadata only,
explicit Load and Save gates, no local identity transfer, and no connection or trust side effects.

## Verification

- `cd clients/township-tauri-shell && npm run discovery:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run qr:camera:contract`
- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run deeplink:source:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run app:convergence`

## Remaining Work

- Installed-app OS deep-link delivery smoke remains open.
- Local-network peer discovery remains open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
