# Plan 132: Authenticated carrier availability feed (toward G1)

## Status

IN PROGRESS (local verification complete; hosted CI pending)

## Objective

Replace the Township instrument's fast polling as its normal convergence trigger with an
authenticated server-initiated availability feed. After a changed path-backed carrier log is
durably persisted, the stable server sends a bounded `ops_available` hint to explicitly subscribed
transport peers. `TownshipWeb.CarrierProjection` reacts by running its existing verified
frontier/pull/`Sync.deliver`/`ReadModel` path and publishes only that result through PubSub.

The pushed frame is a liveness hint, never state transfer. It contains no operation, capability,
delegation, participant identity, authority verdict, or semantic result. `Lattice.Sim` remains the
oracle for the pulled log, read model, quarantine, and causal replay.

## Why this increment

- Plans 126-130 prove pull-based projection and a real participant action loop, but the browser
  gate converges because `township_action_handoff_live.exs` configures the projection to poll every
  250 ms (the normal projection default is one second). The build map still names a server-push
  feed as an active Phase G gap.
- Plan 131 made the packaged native foundation mandatory in CI. Feed work can now change the real
  carrier/projection lifecycle without expanding an unguarded app surface.
- A server hint followed by verified pull supplies server-initiated liveness without letting a
  server-pushed operation bypass canonical decoding, signature checks, structural quarantine,
  semantic reduction, or the Sim oracle.
- Broader participant controls should reuse a reactive projection rather than multiplying controls
  on top of a polling-only read path. Production deployment remains downstream.

## Protocol

The protocol is additive; every existing request/response frame remains unchanged.

### Client requests

After signed carrier authentication:

```json
{"type":"subscribe"}
```

The server atomically registers the connection and replies:

```json
{"type":"subscribe_result","generation":12,"frontier":["..."],"frontier_truncated":false}
```

An explicit teardown request:

```json
{"type":"unsubscribe"}
```

receives `{"type":"unsubscribe_result"}` and removes the connection from the holder.

### Server notification

Only after a changed log is persisted successfully:

```json
{"type":"ops_available","generation":13,"frontier":["..."],"frontier_truncated":false}
```

`generation` is derived from durable append-only facts:

```text
Log.size(log) + length(Log.quarantine(log))
```

It therefore survives restart from the same dump, advances for accepted or newly structurally
quarantined operations, and does not advance for duplicate, pending, rejected, read-only, or failed
persistence attempts. `frontier` is bounded public diagnostic data: it contains at most 64
lexicographically sorted operation ids, and `frontier_truncated` is true when more heads exist.
That bound keeps either hint well below the existing 64 KB carrier frame ceiling even under wide
concurrent authorship. No consumer treats the diagnostic slice as a complete reconciliation
frontier. Neither field is trusted as state: every accepted notification triggers the normal
advertise/pull verification path.

## Architecture

### Durable holder subscription

`LatticeCarrierServer.Holder` owns monitored subscriber pids. `subscribe/2` returns the current
generation/frontier from the same serialized state that registers the pid. A changed relay first
dumps and renames the path-backed log, then updates holder state and notifies subscribers. A no-op
relay or persistence failure emits nothing. Each subscriber has at most one outstanding holder
message. `acknowledge/3` clears that slot and atomically returns the latest durable availability when
newer relays landed meanwhile, so memory is O(subscribers), not O(relays). `unsubscribe/2` and
subscriber `:DOWN` remove monitors.

The Cowboy handler registers only after carrier authentication. On each holder hint it acknowledges
the delivered generation and queues the latest durable availability returned by that serialized
call. Its 50 ms timer still coalesces newly arriving acknowledged hints to one text frame, and it
deregisters on explicit unsubscribe or socket termination. Authenticated sockets use a finite
120-second idle timeout, strictly longer than the 60-second safety poll. An explicit five-second
authentication deadline closes peers that never authenticate, preserving the current tight
unauthenticated resource bound instead of granting pre-authentication sockets the larger idle window.

### Shared BEAM WebSocket demultiplexer

`Lattice.Transport.WebSocket.Client` currently performs passive blocking reads inside
`recv_envelope/2`; an unsolicited frame would be mistaken for the next request reply. Convert the
socket to `active: :once` and give the GenServer an incremental RFC 6455 server-frame buffer. It
must:

- preserve existing `send_envelope` / `recv_envelope` stream behavior;
- add one atomic request/reply API so `Lattice.Carrier.WebSocket` no longer has a send/recv race;
- route registered notification types before touching a pending request waiter;
- support split and coalesced TCP chunks plus complete text, close, ping, and pong frames within
  existing bounds;
- answer a server ping with a masked pong, ignore pong, and explicitly reject RFC 6455 continuation
  frames or messages whose FIN bit is clear; TCP chunk fragmentation is supported, WebSocket
  message fragmentation is not;
- keep at most one carrier request in flight, matching current sequential semantics;
- prefetch at most one legacy streaming envelope, leaving the active-once socket passive until the
  consumer receives it so an idle stream consumer retains TCP backpressure;
- time out and clean pending request/receive waiters; and
- notify subscription owners when the socket closes so reconnect can begin immediately.

A client process uses either the legacy streaming `send_envelope`/`recv_envelope` interface or the
atomic request/subscription interface for its lifetime, never both. The client rejects cross-mode
calls. `Lattice.Carrier.WebSocket` switches every request path to the atomic API so notifications
cannot race a split send/receive pair.

`Lattice.Carrier.WebSocket.subscribe/2` allocates a local reference for ordinary callers, while
`subscribe/3` accepts an owner-preallocated reference. Both register the local `ops_available` route
before sending the authenticated server subscribe request and return an updated connection carrying
that reference and the baseline generation. Duplicate local references fail closed. `unsubscribe/1`
tears down both sides. This is a WebSocket transport extension, not a new callback on the deliberately
minimal `Lattice.Carrier` reconciliation behaviour; `SimNet` stays unchanged.

### Push-assisted projection

`TownshipWeb.CarrierProjection` receives an opt-in `feed: :server_push` mode. Before it starts a
connecting refresh worker, the projection owner preallocates and records the subscription reference.
The worker threads that exact secret through `subscribe/3`; a matching notification with generation
greater than the last seen baseline queues an immediate refresh. A hint that races the first pull or
a reconnect pull is therefore coalesced into one trailing refresh instead of being dropped before the
worker result installs the connection. Older generations, non-reference tokens, and stale refs are
ignored. An epoch-discarded worker result explicitly closes its private connection.

The existing `feed: :poll` default remains compatible with injected carrier doubles. Server-push
mode dispatches only through a carrier module exporting owner-preallocated `subscribe/3`; a missing
callback returns a clear startup error instead of silently falling back to fast polling. The concrete
WebSocket carrier retains `subscribe/2` as a convenience, and every focused feed-mode double
implements the race-free public transport extension explicitly.

If a notification arrives while a refresh is in flight, the projection records one trailing refresh
instead of launching a parallel pull or dropping the wake-up. A socket-close notification clears
the stale subscription, marks the current projection stale/unavailable through the existing state
rules, and starts the existing reconnect/backoff path. Reconnect authenticates, re-subscribes, and
forces a pull. A slow periodic safety poll remains for missed notifications and dead-path recovery;
it is not the normal convergence mechanism.

Published projection provenance records `refresh_trigger` (`:initial`, `:manual`, `:poll`, or
`:server_push`) and the accepted `feed_generation`. The source-status DOM exposes those values as
`data-refresh-trigger` and `data-feed-generation`. The browser gate establishes its baseline before
the relay, then requires `server_push` provenance and the new generation together with exact Sim
equality within 20 seconds while the safety poll is 60 seconds. This is positive evidence that the
availability frame, not merely elapsed time, caused the converging pull.

## Critical invariants

1. No `ops_available` frame may mutate a log/read model directly; only the subsequent verified pull
   may publish state.
2. A notification must never satisfy or displace an in-flight request reply.
3. Generation cannot move backward for one persisted source across server restart.
4. Durable change is the notification boundary: persistence failure, duplicate, pending, rejected,
   and read-only relay attempts emit nothing.
5. One projection connection has at most one refresh worker and at most one coalesced trailing
   refresh.
6. Subscription is authenticated, monitored, bounded, and carries no custody or semantic authority.
7. A compromised/noisy server can cause redundant verified pulls, not state injection.
8. The authenticated idle timeout is strictly greater than the safety-poll interval; the separate
   unauthenticated deadline remains no greater than five seconds.
9. One raw WebSocket client uses streaming receive or atomic request/subscription semantics, never
   both, and fragmented WebSocket messages fail closed.

## Public TDD seams

1. `LatticeCarrierServer.Holder.subscribe/2`, `unsubscribe/2`, and durable generation/fan-out.
2. Stable server `subscribe`, `unsubscribe`, and unsolicited `ops_available` wire frames.
3. `Lattice.Transport.WebSocket.Client.request_envelope/3` plus typed local subscriptions and
   incremental active-socket frame routing.
4. `Lattice.Carrier.WebSocket.subscribe/2`, owner-preallocated `subscribe/3`, `unsubscribe/1`, and
   close notification format.
5. `TownshipWeb.CarrierProjection` feed mode, stale-event rejection, trailing refresh coalescing,
   close/reconnect handling, feed-capable carrier doubles, and slow safety poll.
6. A second-BEAM stable-server test and the real LiveView/action-handoff browser gate with a safety
   interval longer than the gate timeout plus rendered push-trigger/generation provenance.

## Scope

- `apps/lattice_carrier_server/lib/lattice_carrier_server/{holder,web_socket}.ex`
- focused stable-server holder/protocol/second-BEAM tests
- `apps/lattice_web_socket/lib/lattice/transport/web_socket/client.ex`
- `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex`
- focused real-socket demultiplexing tests in the existing Cowboy-backed boundary test app
- `apps/township_web/lib/township_web/carrier_projection.ex` and focused projection tests
- action-handoff live script/browser assertions proving notification-driven convergence
- Plan 132 contracts, build-map/status documentation, and flagship wiring already covering the
  action-handoff browser gate

## Deferred follow-up

Plan 133 must add TypeScript `CarrierWebSocketClient` notification demultiplexing and a live direct
TS subscription gate. Plan 132 deliberately does not ship ungated TS feed code: the Vue island in
this slice receives server-derived state through LiveView/PubSub, while the direct carrier
subscriber is BEAM. The wire protocol is complete and additive so Plan 133 does not renegotiate it.

## Non-goals

- No server-pushed operation/state materialization; the feed is a liveness hint only.
- No change to the core `Lattice.Carrier` advertise/pull/push/live behaviour or `SimNet`.
- No broader summary/title/member/grant/revoke/vouch participant controls.
- No participant key, capability, dependency, delegation, or authority custody in Phoenix/server.
- No mobile/device/iOS/Android/camera/LAN/cross-device probe or secure-store change.
- No TLS, public ingress, deployment, backup, database, release signing, or notarization.
- No complete G1/Phase G claim and no receipt-free W4 claim.

## STOP conditions

- Stop if a pushed frame changes rendered/materialized state without a verified pull.
- Stop if notification/request interleaving can return the wrong frame to a caller.
- Stop if generation can regress across same-path restart or advance without durable log change.
- Stop if a slow subscriber can accumulate unbounded per-operation payloads/messages.
- Stop if browser convergence can occur through the configured safety poll before the assertion
  deadline; the gate must rule polling out.
- Stop if reconnect can retain an old subscription ref or publish optimistic/unverified state.
- Stop if this work requires participant custody, direct pushed ops, a core carrier-behaviour
  redesign, ungated TypeScript feed code, parked device work, deployment, Phase G completion, or W4.

## TDD plan

1. **Plan/public-seam RED.** Add the Plan 132 contract first and observe missing holder/carrier
   subscription APIs.
2. **Holder generation/fan-out RED/GREEN.** Prove persisted change, no-op/refusal/failure behavior,
   restart-stable generation, unsubscribe, and monitored cleanup.
3. **Server protocol RED/GREEN.** Prove authentication gates subscribe, baseline result shape,
   bounded/coalesced notifications, and explicit unsubscribe on a real Cowboy socket.
4. **BEAM demux RED/GREEN.** A test server sends `ops_available` before a request response. Prove the
   request receives its response, the owner receives the notification, split/multiple frames parse,
   masked-pong handling works, pong is ignored, continuation/non-FIN frames fail closed,
   streaming/atomic mode mixing is rejected, and close/timeouts remain bounded.
5. **Projection RED/GREEN.** Prove new/stale generations, one trailing refresh, no parallel work,
   close/reconnect/resubscribe, unchanged default polling doubles, an explicit failure for a
   feed-incapable injected carrier, and unchanged verified materialization.
6. **Second-BEAM/browser RED/GREEN.** With manual or 60-second safety polling, relay one Sim op and
   prove the baseline predates the relay and server-push provenance/generation drives
   projection/LiveView/Vue to exact Sim equality within 20 seconds, before polling could run.
   Restart, recover the persisted projection through reconnect/backoff, then relay a second Sim op
   and require a new server-push generation through the replacement subscription.
7. **Docs/contracts RED/GREEN.** Mark the server-push availability feed real while retaining direct
   pushed-op, TS direct feed, broader-control, deployment, mobile, Phase G, and W4 non-claims.
   Advance every cumulative Plan 023-131 contract/test/build-map pin to Plan 132. Before status may
   become `DONE`, executable parity checks must cover `TOWNSHIP_BUILD_MAP.md`, `README.md`,
   `CLAUDE.md`, `docs/lattice_poc_status.md`, `plans/README.md`, and this plan.
8. **Full verification.** Run focused suites, TS regression gates, browser/flagship/package gates,
   warnings-as-errors/xref/Sobelow, pinned-OTP `mix verify`/`mix check`, hosted CI, and final exact
   Claude diff review.

## Second opinion

Claude Code Opus reviewed the clean Plan 131 frontier read-only and returned `PROCEED`: an
authenticated generation hint that wakes verified pull is the correct next dependency-bearing
increment and honestly closes the server-push liveness gap. It identified the passive BEAM socket
as the load-bearing risk and required request/notification demultiplexing, restart-stable generation,
trailing-refresh coalescing, and a browser deadline that rules out polling.

Claude required one scope correction incorporated here: TypeScript direct-feed demultiplexing moves
to Plan 133 because this plan's LiveView/Vue gate exercises a BEAM subscriber. Shipping TS feed code
without its own live gate would violate the build map's "not a gate, not done" rule. This plan also
keeps subscription outside the minimal core `Lattice.Carrier` reconciliation behaviour rather than
redesigning SimNet for a transport-specific liveness concern.

Claude Code Opus then reviewed this exact written plan read-only and returned `PROCEED`, with no
blocker or high-severity finding. Its medium requirements are incorporated above: cumulative plan
pins advance through Plan 132, feed dispatch preserves existing doubles, the browser gate requires
positive push provenance, and DONE requires executable documentation parity. Its lower-severity
hardening requirements are also pinned: numeric authenticated/unauthenticated timeout bounds,
masked ping/pong handling with explicit WebSocket-fragment rejection, and lifetime-exclusive raw
streaming versus atomic client APIs.

Claude reviewed each implementation boundary read-only. The holder/server slice returned `PROCEED`
after its coalescing test was made deterministic. The raw client/wrapper slice returned `PROCEED`
after notification types became lifetime-reserved and unsolicited atomic frames failed closed. The
projection/browser slice returned `PROCEED` with no blocker, high, or medium finding and confirmed
that pushed provenance plus a 60-second poll ruled polling out.

During packaged-gate diagnosis, Claude correctly separated the intentional server-kill window from
the first push proof: the failing assertion demanded `server_push` after a bare restart with no new
durable change. The corrected gate records reconnect recovery as `poll`, while real subscription
recovery is proven by a second post-restart relay and pushed generation. Claude's follow-up returned
`PROCEED`; its wording concern was fixed, and its observation that the packaged lane did not itself
re-prove push after restart led to the stronger second-relay browser proof.

The final exact-diff review found that eager active-once streaming could queue an unbounded number of
decoded envelopes. A public resource RED measured roughly 61.8 MB under a non-reading stream; GREEN
limits prefetch to one envelope and restores TCP backpressure. Claude's focused follow-up returned
`PROCEED` and confirmed bounded memory, ordering, coalesced-frame, timeout, and handshake-leftover
behavior.

A separate owner/worker ordering audit then found that an availability hint could arrive after the
first pull omitted a just-durable op but before the owner installed the worker-local subscription
reference. A manual-schedule RED proved the hint was lost. The owner-preallocated reference makes the
hint recognizable before the worker starts, queues one trailing verified pull, rejects nil/stale
tokens, and closes a private connection from any epoch-discarded result. Claude confirmed the race
fix and identified the discarded-connection cleanup, which was itself completed RED/GREEN. Its other
manual-schedule observation does not apply to a valid live subscription: every failed pull closes the
ref, manual mode deliberately resumes through explicit `refresh/1`, and the shipped schedule retains
the 60-second reconnect/poll backstop.

Claude's publication review returned `PROCEED` with no blocker, high, or medium finding, but a
literal follow-up against the slow-subscriber STOP condition drove one more RED: generations 3 and 4
could queue behind an unacknowledged generation 2 in the Cowboy mailbox even though only one frame
was eventually emitted. Holder-level one-outstanding flow control plus latest-on-ack made that test
GREEN while preserving the suspended-socket coalescing proof. Claude's focused review confirmed all
relay/ack orderings, stale acknowledgments, unsubscribe/`DOWN`, supervision, and timer behavior and
returned `PROCEED`; the bound is now independent of relay rate.

## Verification

- The public Plan 132 contract first failed on the missing holder/carrier subscription APIs.
- Holder, Cowboy protocol, active-once demultiplexing, carrier wrapper, projection, and rendered
  provenance were implemented as vertical RED/GREEN slices. Additional RED/GREEN slices cover
  bounded legacy-stream backpressure, first-subscription hint ordering, invalid local refs, and
  epoch-discarded connection cleanup. A final holder RED/GREEN bounds each slow subscriber to one
  outstanding hint while acknowledgment recovers the latest durable generation. The final focused
  aggregate passes 16 `lattice_web_socket`, 27 `township_web`, 6 node-spike socket-security, and 39
  holder/server/second-BEAM tests.
- The packaged browser gate first failed because the source could converge only through its old
  250 ms poll. With a 60-second poll and authenticated feed it then exposed the invalid bare-restart
  provenance assertion. After separating reconnect recovery from availability notification, the
  gate passed; a new RED for the absent post-restart relay helper then drove the second pushed Sim
  generation. The fixed-port restart regression also passes 20 consecutive repetitions after its
  readiness helper was corrected to retry an authenticated WebSocket connection in a monitored
  helper instead of accepting a stale TCP probe. Both cached-bundle and fresh release-app runs of
  `npm run tauri:action-handoff:smoke` pass.
- Both TypeScript workspaces and their carrier/native-shell regression matrices pass after the
  packaged-gate changes. Cumulative documentation contracts advance through plans 023-132 and cover
  every named status surface.
- Final pinned-OTP `mix verify` and `mix check` each pass 373 tests plus 25 properties; strict Credo
  exits 0. Forced test and production compiles pass with warnings as errors, xref retains the same
  five known cycles, both boundary Sobelow scans exit 0, formatting is clean, and
  `git diff --check` is clean.
- Every `clients/lattice-client` script, both TypeScript typechecks, and the complete Tauri-shell
  `app:convergence` matrix pass. Final Playwright acceptance passes 6 static instrument tests, the
  live pull, standalone server, and action-handoff tests, plus flagship playback and video
  evaluation. The final app matrix rebuilds the release app and passes launch, onboarding,
  stable-relay onboarding, post-restart pushed action handoff, and installed deep link.
- The final exact-diff Claude review returned `PROCEED` with no blocker, high, or medium finding and
  confirmed every stop condition, the literal subscriber-mailbox bound, and the fixed-port helper's
  honesty. Its LOW premature-`DONE` finding drove a focused documentation-contract RED/GREEN; the
  follow-up returned `PROCEED`. Hosted CI remains mandatory publication evidence. Its run is
  appended only after it completes; no pending gate is claimed as green.

## Completion claim

Plan 132 completes the authenticated BEAM/LiveView availability-feed increment: durable change emits
only a bounded hint, request replies and notifications are demultiplexed, every state change still
comes from verified pull, and both second-BEAM and packaged-app gates prove replacement subscription
after restart. It does not claim direct pushed-op materialization, direct TypeScript feed support,
broader participant controls, mobile custody changes, production deployment, complete G1/Phase G,
or receipt-free W4.
