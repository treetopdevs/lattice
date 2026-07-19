# Plan 150: Device-hosted carrier boundary (toward CD1)

## Status

TODO (proposed draft — not yet reviewed or resumed by the operator).

## The CD1 gate this track discharges

Plans 150-152 form the **centerless demo track**. Its exit gate is:

> **CD1** — two packaged Township apps on two separate machines (or two isolated OS user
> accounts) on one LAN converge a Township matter through W0-W3 beats with `Lattice.Sim`
> as the oracle, with **no Phoenix process and no operator-hosted carrier server** anywhere
> in the loop. One participant's device hosts the rendezvous; every custody, authority,
> and verification claim already proven on the stable-server path holds unchanged.

CD1 is a demo gate, not a production gate. It makes no TLS/public-ingress, NAT-traversal,
mobile-hosting, compaction, E2EE, availability, or receipt-free claim.

Plan 150 owns the first slice: the packaged desktop app can **be** the carrier server.

## Objective

Add an explicit opt-in **host mode** to the packaged desktop Township app: the app supervises
one local `lattice_carrier_server` OS process (a BEAM sidecar) whose path-backed signed log
lives in the app's data directory, bound to loopback plus one explicitly configured LAN
interface. The hosting user's own resident identity participates as an ordinary client of that
local server over the real socket. Everything the stable server already proves — session v2
authentication, read-only pull, opt-in one-op relay with persist-before-acknowledge, the
bounded `ops_available` availability feed, and restart recovery from the same path — is reused
byte-for-byte, not reimplemented.

This changes **who runs the server**, not what the server is. No server semantics, wire
format, or trust rule changes.

Planned at commit `ba4d4eff` on `codex/township-build-map`.

## Why this increment

- Every packaged proof since Plan 127 routes through `apps/lattice_carrier_server` started as
  an operator-owned OS process. Plans 128 (relay), 129 (packaged convergence), 132/133/134
  (availability feed), 142 (session replay protection + durability honesty), and 147/148
  (client-side authority) deliberately demoted that server to a dumb durable relay: it holds
  no participant key, authors nothing, and decides no semantic authority. That demotion is
  exactly what makes it movable onto a participant's device — and nothing has moved it yet.
- The packaged app today is client-only. Nothing in the shell can listen. CD1 is unreachable
  until one device can serve.
- Plan 129 already established production-server subprocess support in the packaged test
  harness, and Plan 141/143 established the serialized shell persistence and consolidated
  smoke harness this plan's gates reuse. The remaining work is supervision, packaging, and
  configuration — not new protocol.
- The alternative — reimplementing the server boundary in Rust or TypeScript inside the shell
  — would duplicate the session v2 handshake, holder generations, relay durability ordering,
  and availability coalescing that Plans 127/128/132/142 hardened, and would create a second
  implementation of a security boundary with no second-oracle benefit. Question that
  requirement before accepting it: the BEAM sidecar reuses the proven code.

## Critical trust separation

- The host device runs **two identities with different jobs**: a transport identity (server
  realm key) that only authenticates carrier sessions, and the user's resident identity that
  only authors operations. They must be distinct keys in distinct storage. The transport key
  must never author a Township operation, mint a capability, or appear in any op's author
  field; the resident key must never sign a session challenge for the server side.
- The hosting resident is **not privileged**. Their app reaches their own server through the
  same loopback WebSocket, session authentication, relay opt-in, and availability
  subscription as any remote peer. No in-process shortcut, no direct log append, no
  holder-state read. One code path keeps the trust model honest: if the host could write
  around the relay, the demo would silently reintroduce a center.
- The served log contains signed operations authored elsewhere; every client (including the
  host's own client) still verifies frames via canonical hash + Ed25519 and derives semantic
  authority locally per Plans 147/148. Hosting confers durability custody of public signed
  bytes, nothing more — and the plan must say so: matter content is plaintext to the hosting
  device (M3/E2EE remains out of scope, as `docs/path_to_real.md` records).
- Socket close, auth failure, guest misbehavior, and app-UI actions never mutate the served
  log except through the existing relay persist path. All Plan 127 non-lifecycle rules
  (no protocol halt, no offline-divergence callback, fail-closed source restore) apply
  unchanged because the same code runs.

## Architecture

### BEAM sidecar, not a rewrite

- Build a minimal `mix release` of `lattice_carrier_server` (plus its `lattice_core`
  dependency closure) and bundle it as a Tauri sidecar binary of the desktop app. The dev and
  CI path may launch the same server via the existing subprocess helpers from the Plan 129
  harness; the packaged smoke must exercise the bundled release.
- The shell gains a `township_host.ts` module (name indicative) that owns sidecar lifecycle:
  spawn with validated options, health/port discovery, restart-with-backoff on crash, clean
  shutdown on app quit. It is a process supervisor, not a protocol participant.
- Host-mode options are constructed only from: a dedicated transport identity generated and
  stored through the existing native custody commands under a **new alias distinct from the
  resident carrier key** (generic resident key APIs must reject the host alias, mirroring the
  Plan 146 Seam 6 governance-alias precedent); a path inside the app data directory for the
  log source; loopback plus at most one explicitly user-selected LAN bind address; a fixed
  port; and trusted-peer / relay allowlists managed by the host UI.

### Guest admission without a second custody store

- The server's trusted-peer and relay allowlists remain configuration owned by the host app
  and passed to the sidecar; they hold public keys and realm ids only. Admitting a guest's
  transport key to the allowlist is a host-UI action that restarts or reconfigures the
  sidecar's peer table; it is not a capability grant. Semantic authority still arrives only
  through in-log delegation ops (v5 ceremony), exactly as today.
- How a guest's key reaches the host is Plan 152's problem (pairing exchange). Plan 150 may
  test with keys transferred out-of-band by the harness.

### Host self-participation

- When host mode is active, the app's existing pairing state points at
  `ws://127.0.0.1:<port>` with the same explicit relay transport mode from Plan 129. Pull,
  author, review, sign, outbox, relay, drain, and the reactive availability feed all run
  through the existing client seams (`clients/lattice-client/src/carrier.ts`,
  `township_sync.ts`, `township_feed.ts`) with zero special-casing.

### Lifecycle and durability

- Sidecar crash: supervised restart from the same path; the availability feed's
  replacement-subscription behavior (Plans 132/133/134) covers reconnect for host and guests
  alike.
- App quit: clean sidecar shutdown; the path-backed log is the durable artifact. Relaunch
  restores the same source or fails closed exactly as Plan 127 requires; a missing or corrupt
  source must surface in the host UI as a hard error, never as a silent fresh community.
- The process-crash-not-power-loss durability honesty from Plan 142 carries over verbatim and
  must be restated in the host UI copy.

## Public TDD seams

1. `township_host` lifecycle seam: host mode with valid options spawns the sidecar, discovers
   the bound port, and a production `CarrierWebSocketClient` authenticates and pulls; invalid
   options (missing identity, resident-key alias, absent path parent, bad bind) refuse
   without spawning; crash triggers supervised restart from the same path.
2. Identity separation seam: the host transport key and resident key are distinct native
   aliases; generic resident key APIs reject the host alias; after a full authored-post
   round trip, no operation in the served log is authored by the transport key.
3. Self-participation seam: with host mode active, the host app authors one post through
   review/sign/Sync against its own loopback server; the persisted source, the host app's
   reactive feed, and a distinct guest client all converge to the `Lattice.Sim` oracle.
4. Guest + restart seam (packaged): the bundled-release host app serves a guest packaged
   app (or headless production client) through pull, relay, and availability hint; killing
   and relaunching the host app preserves the log, restores service on the same port, and a
   second pushed generation converges the guest after reconnect — the Plan 129/132 restart
   proofs re-run with the app as the server operator.

Tests must not read holder internals or bypass the socket; source identity is proven by
authenticated pulls and Sim/read-model equality, as in Plan 127.

## Scope

- The `lattice_carrier_server` release target and Tauri sidecar bundling for the desktop app.
- The shell host-mode module, host transport-key alias custody, host UI surface (enable,
  bind/port, peer admission list, health, hard source-error state), and its focused
  contracts.
- Loopback + single-LAN-interface binding.
- The four seams above, wired into the existing consolidated packaged-smoke harness and the
  hosted CI jobs.
- Plan index, build map (new CD1 track section), and cumulative status/non-claim updates.

## Non-goals

- No TLS, public-Internet ingress, NAT traversal, DNS/rendezvous service, or deployment
  claim; LAN and loopback only.
- No server reimplementation in Rust/TypeScript; no protocol, wire, session, or relay change.
- No mobile hosting, iOS work, physical-device claim, or new Android probe (§4a stays parked
  except as Plan 152 explicitly records).
- No multi-host replication, host migration/failover, compaction, E2EE, or key rotation.
- No change to Phoenix instrument gates, the stable operator-run server tests, or any v1-v6
  ceremony; no succession/v7 surface; no receipt-free W4 or G1/Phase G completion claim.

## STOP conditions

- Stop if the host transport key authors any operation or the resident key authenticates a
  server session.
- Stop if the host app gains any log access that does not traverse the loopback socket and
  the existing relay persist path.
- Stop if server code is forked, patched, or partially reimplemented in the shell instead of
  run as the sidecar.
- Stop if a missing/corrupt source silently starts an empty community.
- Stop if the bind surface exceeds loopback plus the one configured LAN interface, or any
  doc claims public deployment, production hosting, or availability guarantees.
- Stop if peer admission is described as, or implemented as, capability granting.
- Stop if any existing hosted gate (stable-relay onboarding, v1-v6 handoffs, reactive feed,
  Plan 146 seams) is weakened or bypassed to make host mode pass.

## TDD plan

1. RELEASE RED/GREEN: require a runnable `lattice_carrier_server` release artifact that
   serves an authenticated pull in a fresh environment with no Mix; implement the release
   config and preload only as the failure demands.
2. HOST-MODULE RED/GREEN: the `township_host` lifecycle seam — spawn/port/refuse/restart —
   against the release binary, plus the host-alias custody refusal matrix.
3. SELF-PARTICIPATION RED/GREEN: one authored post through the host's own loopback server;
   Sim-oracle equality across source, host feed, and a distinct guest client.
4. PACKAGED RED/GREEN: bundle the sidecar, add the host-mode packaged smoke (guest pull,
   relay, availability hint, host kill/relaunch, second generation), reusing the Plan 143
   harness; wire it as a hard step in the packaged macOS CI job.
5. DOCS RED/GREEN: CD1 track section, plan index row, build-map and status updates retaining
   every TLS/mobile/availability/W4 non-claim above.
6. VERIFY: focused suites, full `npm run app:convergence`,
   `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix verify`,
   the corresponding `~/.asdf/shims/mix check`,
   both Sobelow boundaries, xref baseline, formatting/diff checks, and hosted three-job green
   at the exact implementation tip.
7. REVIEW: written-plan, per-seam RED/GREEN, packaged, docs, and release-diff reviews with
   no unresolved P0-P2 finding, per the standing council loop.
