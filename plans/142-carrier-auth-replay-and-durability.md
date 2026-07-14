# Plan 142: Carrier session replay protection and durability honesty

## Status

IN PROGRESS — local TDD, focused carrier suites, TypeScript gates, and the complete packaged
`app:convergence` chain are green; the hosted flagship gate remains open.

## Priority

**P1 — design-level gap, mitigated today only by the loopback default bind.** Must land
before the stable carrier listener is ever configured beyond `127.0.0.1`.

## Implementation status (2026-07-14)

- The operation wire remains v1. A distinct carrier session v2 now starts with a server-first
  32-byte nonce, and both challenge and hello signatures bind the client nonce, server nonce,
  operation wire version, session version, realms, replica, and signing key.
- An exact captured challenge authenticates its original connection and is rejected as
  `unauthenticated` on a new connection with a different server nonce. Stable server, node-spike,
  BEAM client, TypeScript client, and shell test doubles all use the same handshake.
- Successful same-connection re-authentication removes the prior Holder subscription and clears
  queued availability/timer state before replacing the peer identity. Failed re-authentication
  leaves the existing state untouched.
- Path-backed relay dumps are synced through an open temp-file descriptor before atomic rename;
  startup removes `path.tmp.*` orphans and fails loudly when one cannot be removed. This is
  process-crash durability only: the parent directory is not synced, macOS `F_FULLFSYNC` is not
  requested, and power-loss durability is not claimed.
- RED/GREEN evidence includes exact byte replay, atomic BEAM setup receive, TypeScript server
  nonce/version handling, re-auth cleanup, and orphan cleanup. Deliberate nonce-check and orphan-
  cleanup mutations each failed at their intended regression assertion before being restored.
- Green local evidence: core session 12 tests + 1 property; WebSocket client 15; node-spike 11;
  stable server/Holder 33; all five TypeScript `carrier:*` gates; client and shell typechecks; and
  one uninterrupted `npm run app:convergence` exit 0. Claude Opus final review found no P0–P2
  issue and returned `PROCEED`.
- Hosted flagship evidence is unrun. This plan therefore remains `IN PROGRESS` and makes no
  production-deployment, TLS, confidentiality, or power-loss-durability claim.

## Pre-implementation findings this plan fixes (evidence)

1. **Client→server authentication is replayable.** The session nonce is chosen by the
   *client* (`apps/lattice_core/lib/lattice/carrier/session.ex:12-29`); the server
   contributes no freshness and keeps no nonce cache
   (`apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:86-108`). A
   captured signed `carrier_challenge` authenticates forever — across reconnects, restarts,
   and any server sharing the same replica name and trusted-peer entry. The transport is
   plaintext (`ranch_tcp`/`cowboy_clear`, `listener.ex:41`), so capture is trivial for any
   on-path observer once the bind leaves loopback. Server→client is already replay-safe
   (the `carrier_hello` signs over the client's nonce); the asymmetry is one-directional.
   No test exercised replay before this implementation.

2. **"Persisted before acknowledgement" is process-crash durability, not power-loss
   durability.** `Log.dump` is a bare `File.write`
   (`apps/lattice_core/lib/lattice/log.ex:166-168`) and `atomic_dump` is write-temp +
   `File.rename` with no `:file.sync` (`holder.ex:161-173`). The moduledoc claim
   (`lattice_carrier_server.ex:7-8`) overstates this.

3. Minor, fix opportunistically while in the file: re-auth mid-session carries subscription
   state across an identity switch (`web_socket.ex:36-37,141-148`); crash between dump and
   rename leaks an orphan `path.tmp.<n>` never garbage-collected.

## Objective

A replayed `carrier_challenge` is rejected; the ack durability claim matches the code; a
replay regression test exists.

## Scope

### Included

- Server-contributed freshness: on connect the server sends a `carrier_nonce` frame carrying
  a 32-byte server nonce; the client's signed transcript must include it. Keep the wire
  change versioned and fail-closed for old clients (bump the session wire version — both
  sides are in this repo; there is no external-compatibility constraint). A per-connection
  nonce is sufficient; no cache needed if the server nonce is required.
- Replay test: capture a valid signed challenge, re-send it on a new connection, assert
  `unauthenticated`.
- Either add `:file.sync` on the temp file (and directory fsync where the platform allows)
  before rename in `atomic_dump`, **or** amend the moduledoc/plan prose to say
  "process-crash durable, not power-loss durable". Pick one; do not leave the claim
  overstated.
- Clear subscription state on re-authentication; delete orphan temp files for the log path
  at Holder start.

### Explicitly deferred

- TLS, per-frame session binding, rate limiting, quarantine/log growth bounds — real
  hardening, but scoped to a future "beyond loopback" plan; record them there, not here.
- Any relay/authority semantic change.

## Required gates

- New replay test red against the old handshake, green after.
- All existing carrier/session/server suites green (`lattice_core` carrier tests,
  `lattice_carrier_server` tests, TS `carrier:*` gates, packaged smokes).
- Hosted flagship green.

## STOP conditions

- If the session-version bump breaks the packaged-app gates in a way that requires shipping a
  dual-version handshake, STOP and surface the compatibility choice.

## Non-claims

- No production-deployment claim; the loopback default bind remains the default.
- No TLS or confidentiality claim.

## Likely files

- `apps/lattice_core/lib/lattice/carrier/session.ex` (+ TS mirror
  `clients/lattice-client/src/carrier.ts` session transcript)
- `apps/lattice_carrier_server/lib/lattice_carrier_server/{web_socket,holder}.ex`
- `apps/lattice_core/lib/lattice/log.ex`
- Session/server/client test suites listed above

## Completion claim

The local implementation meets the scoped completion claim: a byte-replayed challenge is rejected
and the durability claim is accurate. Plan status remains `IN PROGRESS` until the required hosted
flagship gate runs green.
