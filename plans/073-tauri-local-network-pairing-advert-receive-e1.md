# Plan 073: Tauri local-network pairing advert receive (E1)

## Status

DONE.

## Objective

Add a bounded native Tauri receive path for local-network Township pairing adverts so the shell can
discover public handoff candidates from UDP packets, feed them through the existing manual discovery
ceremony, and keep save/sync/trust decisions explicit.

## Scope

- Define the local-network advert packet as JSON with `type: "township-pairing-discovery"`, an
  optional public `label`, and a public `handoff`.
- Add a Rust `lattice_discover_pairing_adverts` command that listens on a fixed UDP port for a
  bounded timeout and returns only `{label, handoff}` adverts.
- Ignore malformed, wrong-type, or empty-handoff packets inside the listener so one bad packet does
  not poison discovery.
- Add a Tauri discovery source that polls the native command and normalizes native values into the
  existing `TownshipPairingDiscoverySource` seam.
- Prefer the native source in the Tauri runtime, with the same-origin `BroadcastChannel` source as
  browser fallback.
- Preserve the existing explicit Load discovered handoff and Save pairing gates before any sync.

## STOP Conditions

- If UDP packets can transfer `keyId`, `localRealm`, seed bytes, private keys, or any other
  device-local identity selector through the discovery result, stop.
- If discovery saves pairing config, mutates `carrierPeer`, opens a WebSocket, syncs the outbox, or
  marks a peer trusted before explicit user actions, stop.
- If the native command can block indefinitely or has no timeout bound, stop.
- If malformed packets crash the discovery listener or stop later valid packets from being read,
  stop.
- If this slice claims installed-app OS deep-link delivery, phone-grade mobile convergence, W4
  receipt-freeness, or a physical multi-device LAN smoke, stop.

## TDD Evidence

- RED: `npm run discovery:contract` failed because
  `src/township_pairing_discovery_source.ts` did not exist.
- RED: `cargo test --test native_commands discovery` failed because the Rust packet decoder,
  UDP collector, advert struct, and packet type constant did not exist.
- GREEN: `discovery:contract` proves the Tauri source invokes
  `lattice_discover_pairing_adverts` with a bounded timeout, normalizes public adverts, strips
  local-only extras, and propagates native startup failure so the app can fall back.
- GREEN: `frontend:contract` proves App.vue imports the Tauri discovery source, prefers it when the
  Tauri runtime is present, keeps the same-origin browser fallback, and avoids auto-pairing or
  connection/trust claims.
- GREEN: `cargo test --test native_commands` proves command registration, mock IPC access,
  packet decoding, malformed packet handling, and loopback UDP packet receive.

## Second Opinion

Claude Code was asked for a pre-review and a post-review of this slice, but both CLI review prompts
produced no output after roughly 60 seconds and were interrupted. This is recorded as reviewer
unavailability, not as a GO. The implementation stayed inside the pairing guardrails from plans
066-072.

## Verification

- `cd clients/township-tauri-shell && npm run discovery:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run deeplink:source:contract`
- `cd clients/township-tauri-shell && npm run qr:contract`
- `cd clients/township-tauri-shell && npm run qr:camera:contract`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `cd clients/township-tauri-shell/src-tauri && cargo test --test native_commands`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Installed-app OS deep-link delivery smoke remains open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Plan 075 added the advertiser command; a physical multi-device LAN discovery smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
