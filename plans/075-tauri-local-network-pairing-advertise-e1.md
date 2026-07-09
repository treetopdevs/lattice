# Plan 075: Tauri local-network pairing advertise (E1)

## Status

DONE.

## Objective

Make the Township Tauri shell able to advertise a public pairing handoff over the same LAN
discovery packet format that Plan 073 can receive, without saving, syncing, connecting, or
transferring device-local identity.

## Scope

- Add a native `lattice_advertise_pairing_handoff` command.
- Encode only `type`, optional `label`, and `handoff` into `township-pairing-discovery` packets.
- Default native sends to the LAN broadcast address and keep a target-address override for local
  loopback smoke tests.
- Add a TypeScript invoke adapter for the advertise command.
- Add an explicit Vue "Advertise handoff" control that reuses the public handoff exporter and does
  not save pairing config, sync the outbox, connect to a carrier, or mark trust.
- Keep browser-preview behavior as same-origin `BroadcastChannel` handoff advertisement only.

## STOP Conditions

- If the advertised packet includes `localRealm`, `keyId`, private key material, seed bytes, or any
  other device-local identity, stop.
- If the UI claims the peer is paired, trusted, connected, or securely paired after advertising,
  stop.
- If advertising silently saves pairing config or starts sync/connect behavior, stop.
- If this slice claims a physical multi-device LAN smoke without another device participating, stop.
- If this slice claims phone-grade mobile convergence or W4 receipt-freeness, stop.

## TDD Evidence

- RED: `cargo test --test native_commands` failed because
  `advertise_township_pairing_handoff` and `encode_township_pairing_discovery_packet` did not
  exist.
- RED: `npm run discovery:contract` failed because `TOWNSHIP_PAIRING_ADVERTISE_COMMAND` and
  `advertiseTauriPairingHandoff` were missing.
- RED: `npm run frontend:contract` failed because the source did not expose the advertise command,
  advertise UI state, or a public-packet browser fallback.
- GREEN: native tests prove command registration, mock IPC dispatch, public packet encoding, and
  OS UDP loopback delivery through the same decoder used by discovery.
- GREEN: TypeScript tests prove the invoke adapter trims handoff/label/target address, rejects
  blank handoffs before invoking native code, and does not pass local identity fields.
- GREEN: frontend contract proves the Vue shell exposes an explicit "Advertise handoff" ceremony and
  same-origin preview fallback without auto-pair/connect/trust copy.

## Second Opinion

Claude Code was asked for pre-review and post-review of this slice, but both CLI review prompts
produced no output after roughly 60 seconds and were interrupted. This is recorded as reviewer
unavailability, not as a GO.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo test --test native_commands`
- `cd clients/township-tauri-shell && npm run discovery:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- A physical multi-device LAN discovery smoke remains open because this slice only proves the real
  advertiser command and OS loopback delivery locally.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
