# Plan 063: Tauri carrier connection-health UI (E1)

## Status

DONE.

## Objective

Add a one-shot carrier health check to the Tauri shell so a resident can verify that the
current runtime pairing config opens an authenticated carrier session and returns peer status,
without syncing data or claiming a durable connection state.

## Scope

- Add `checkTownshipCarrierPeerHealth/1` to the Tauri carrier-peer module.
- Reuse the existing verified `connectTownshipCarrierPeer/1` handshake and WebCrypto peer-hello
  verification path.
- Create a native workflow only when one is not injected; pass the pairing key id through to
  native signing.
- Call carrier `status()` and return a typed success result with the peer status phase.
- Return typed failures for unconfigured pairing, native-unavailable runtime, and probe failures.
- Close the carrier client in `finally` after a client has been obtained.
- Add a Vue `Check carrier` action with status text near the carrier sync control.
- Keep the probe side-effect-free for Township state: no local log reads/writes, no carrier outbox
  reads/writes, no delegation evidence reads/writes, no pairing persistence writes, and no sync.
- Do not add QR/deeplink pairing, peer discovery, mobile convergence smoke, or authority-confirmed
  effective-revocation UI in this slice.

## STOP Conditions

- If the health helper calls `probeTownshipNativeWorkflow`, stop; that probe writes a native
  readiness key and is not a health check.
- If the health helper calls `syncCarrierOnce`, `advertise`, `pull`, `push`, or any local
  log/frame store load/save/append method, stop.
- If a returned carrier client is not closed in `finally`, stop.
- If the UI copy claims the shell is durably connected, paired with a carrier, or online, stop.
- If verifier anchoring on the expected peer public key is weakened or made optional, stop.
- If the slice expands into QR/deeplink/discovery pairing UX, stop.

## TDD Evidence

- RED: `npm run peer:contract` failed because `checkTownshipCarrierPeerHealth` was not exported.
- RED: `npm run frontend:contract` failed because the Vue shell exposed no health helper/state,
  no `Check carrier` control, and no guarded health copy.
- GREEN: peer tests now prove a scripted carrier health session performs only
  `carrier_challenge` and `status`, closes on success and status-error, returns typed failures for
  status error, wrong peer, missing pairing, and native-unavailable runtime, and never touches the
  injected Township storage/log/frame stores.
- GREEN: frontend source tests now prove the shell exposes health state and a `Check carrier`
  action while forbidding durable connection/paired/online copy.

## Second Opinion

Claude Code gave conditional GO before implementation. It agreed the slice is a strict subset of
the existing carrier sync connection path and belongs in `township_carrier_peer.ts`, provided it
does not call sync or store APIs, keeps peer verification anchored to the expected public key,
closes returned clients in `finally`, and avoids durable connection claims. It also called out one
pre-existing limitation: when handshake verification fails before a client is returned, this helper
cannot close that socket, so tests should only assert close on success and post-handshake status
failure.

Post-review Claude Code gave GO after inspecting the implementation, tests, docs, and verification
evidence. It found no blockers: the helper avoids `probeTownshipNativeWorkflow`, sync, and store
I/O; tests prove only `carrier_challenge` and `status` are sent; returned clients close on success
and status-error; wrong-peer hello fails before status; verifier anchoring remains required; and UI
copy avoids durable connection/paired/online claims. The only follow-up it noted is the pre-existing
carrier-client socket leak when handshake verification fails before `connectCarrierWebSocket`
returns a client.

## Verification

- `cd clients/township-tauri-shell && npm run peer:contract`
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
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Authority-confirmed effective-revocation UI remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
