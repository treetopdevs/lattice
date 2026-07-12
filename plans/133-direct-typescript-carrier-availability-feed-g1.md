# Plan 133: Direct TypeScript carrier availability feed (toward G1)

## Status

IN PROGRESS

## Objective

Add authenticated availability subscriptions to the shared TypeScript
`CarrierWebSocketClient` and prove them against the real stable
`LatticeCarrierServer` over a real WebSocket. An unsolicited `ops_available` frame must be
demultiplexed from atomic request replies, retained with a literal O(1) client-side bound, and
exposed through a typed subscription. The notification remains only a liveness hint: pulled
carrier frames must still pass canonical hash/signature verification before any Sim-oracle claim is
accepted.

This is the direct TypeScript follow-up explicitly deferred by Plan 132. It completes the shared
client library and real-socket gate. It does not yet turn the Tauri/Vue application into a reactive
feed consumer.

## Why this increment

- Plan 132 completed the additive `subscribe` / `unsubscribe` / `ops_available` wire protocol and
  proved a BEAM subscriber through the LiveView projection. It deliberately withheld TypeScript
  feed code because no direct TypeScript live gate existed.
- `CarrierWebSocketClient` currently routes every inbound frame through a FIFO waiter/queue. An
  unsolicited notification can therefore resolve an unrelated `advertise` or `pull`, or poison the
  next request when no waiter exists.
- `@treetopdevs/lattice-client` is the shared transport/client realm consumed by desktop and mobile
  shells. Correct notification routing here is a prerequisite for any later reactive app loop.
- The stable-relay test support already provides the production holder/Cowboy boundary, durable
  same-path restart, client-signed relay, and Sim-derived oracle operations needed for a real gate.

## Scope

### Included

1. A deterministic fake-socket contract for request/notification interleaving and lifecycle.
2. Explicit one-atomic-request-in-flight enforcement in `CarrierWebSocketClient`.
3. Typed `CarrierAvailability` decoding for `subscribe_result` and `ops_available`.
4. A pre-registered `subscribeAvailability/0` route that cannot lose a hint racing the
   `subscribe_result` reply.
5. A subscription mailbox retaining at most one latest availability plus at most one waiting
   consumer.
6. Idempotent unsubscribe and fail-closed socket/subscription teardown.
7. A live direct-TypeScript gate against `LatticeCarrierServer` proving first push, verified pull,
   no-op silence, restart replacement, and a second pushed generation.
8. Hard-failing hosted CI wiring and cumulative Plan 133 documentation contracts.

### Explicitly deferred

- A persistent Tauri/Vue feed controller or automatic app sync loop. Plan 132 already proves the
  packaged app through the BEAM/LiveView subscriber; a direct TS-driven app loop needs its own
  lifecycle and packaged gate after this reusable substrate exists.
- Any participant key, capability, outbox, pairing, onboarding, or native-storage custody change.
- No mobile secure-store implementation change or new Android/iOS/device probe.
- Broader participant controls, pushed operation/state materialization, a carrier-core behavior
  redesign, production ingress/TLS/deployment/notarization, complete G1/Phase G, or receipt-free W4.

## Public interface

`clients/lattice-client/src/carrier.ts` adds:

```ts
export interface CarrierAvailability {
  generation: number;
  frontier: string[];
  frontierTruncated: boolean;
}

export interface CarrierAvailabilitySubscription {
  readonly baseline: CarrierAvailability;
  next(): Promise<CarrierAvailability>;
  unsubscribe(): Promise<void>;
}

export class CarrierWebSocketClient {
  subscribeAvailability(): Promise<CarrierAvailabilitySubscription>;
}
```

The subscription is an async latest-value mailbox rather than a callback. That gives the library a
literal retained-state bound, isolates socket dispatch from consumer exceptions, and gives a
reconnect owner an ordinary rejected `next()` promise when the socket closes. Concurrent `next()`
calls fail closed; a consumer may have only one outstanding receive.

At most one availability subscription may be active per client. A second
`subscribeAvailability()` call rejects without disturbing the existing subscription.

The transport-specific API stays off `CarrierSyncClient` and `CarrierRelayClient`. SimNet and the
minimal reconciliation behavior do not gain a subscription concern.

## Availability decoding

Both `subscribe_result` and `ops_available` must contain:

- a non-negative safe-integer `generation`;
- at most 64 string frontier ids; and
- a boolean `frontier_truncated`.

The public shape uses `frontierTruncated`. The frontier is diagnostic only. It is never passed to
`pull`, treated as complete when truncated, or used to materialize state.

After baseline establishment, an equal hint generation is a duplicate wake and may be coalesced. A
hint lower than the established baseline or highest prior hint is a protocol violation and closes
the client. The `subscribe_result` baseline remains exactly the server's baseline and is not itself
compared as a later hint against a newer pre-baseline notification; both remain separately visible.

A structurally invalid `ops_available` frame is also a protocol violation. A bad generation,
over-64 or non-string frontier, or non-boolean `frontier_truncated` closes the client and rejects the
pending request and `next()` exactly like an undecodable envelope. It is never silently dropped,
partially retained, or delivered to an atomic request.

## Client state and lifecycle

`CarrierWebSocketClient` owns:

- zero or one pending atomic request;
- zero or one active availability subscription;
- zero or one pending `next()` waiter; and
- zero or one retained latest availability.

The receive order is fixed:

1. Decode the envelope. Decode failure closes the client and rejects pending work.
2. If the type is the reserved `ops_available`, route it to the active subscription and return.
3. If no subscription exists, an `ops_available` frame is a protocol violation; it never enters a
   reply queue.
4. Any other frame resolves the one pending atomic request. Without a pending request it is an
   unsolicited protocol violation and closes the client.

`subscribeAvailability()` installs its private route before sending `{"type":"subscribe"}`. A
hint that races the reply is retained. Once the typed baseline arrives, an early hint newer than the
baseline remains available through `next()`; a covered/equal early hint is coalesced away.

`unsubscribe()` keeps the route active until `unsubscribe_result` arrives, then deactivates it and
rejects any pending `next()`. If another atomic request is in flight, unsubscribe fails locally and
the subscription remains active. Repeated unsubscribe after success is a no-op.

Client `close`, peer close, malformed input, and transport error reject the pending request and
pending `next()`, discard retained availability, and make the old subscription unusable. A failed
carrier handshake also closes its socket. A new `next()` call after successful unsubscribe, local
or peer close, transport failure, or protocol failure rejects immediately rather than hanging.

## Boundedness claim

The TypeScript client promises only O(1) retained application state: latest generation wins and no
per-notification payload queue exists in `CarrierWebSocketClient`.

It does not claim wire-level browser/Node WebSocket backpressure. The WebSocket API exposes no
per-message receive credit or Plan 132 client acknowledgment. Underlying implementation buffering
therefore remains outside the TypeScript client's control. Server-side holder one-outstanding flow
control and Cowboy coalescing remain the transport bound; a later reactive app consumer must also
retain at most one trailing refresh.

## Live direct-TypeScript gate

Add a dedicated Tauri-shell test script that imports the built shared client directly but does not
mount Vue or launch an app. It reuses:

- `clients/township-tauri-shell/test/support/stable_relay_fixture.exs` for Sim oracle operations;
- `spawnStableCarrierServer` for the real supervised server; and
- separate observer and relay identities/connections.

The gate must prove:

1. Observer subscription returns a typed baseline and performs no hidden frontier/pull request.
2. Relaying `expectedPost` emits a newer hint before any test-initiated pull.
3. The hint alone changes no local operation set.
4. A subsequent pull verifies every carrier frame's canonical hash and Ed25519 signature, then its
   sorted ids equal the Sim-derived `afterPost.opIds` oracle.
5. A duplicate relay changes no generation and produces no retained notification during a bounded
   observation window. The window must exceed the server's availability-coalesce interval by a
   deterministic margin; use at least 250 ms for the current 50 ms interval.
6. Fake-socket and live coverage together prove notifications never satisfy an atomic request.
7. Killing the server rejects the old subscription and no old route survives.
8. Restarting from the same path preserves the subscription baseline generation.
9. A new subscription plus `expectedRestartPost` emits a strictly newer second hint; verified pull
   then equals `afterRestartPost.opIds` from Sim.

The gate has no safety poll. Its positive ordering is stronger: no test-controlled `pull` is invoked
between subscription establishment and each awaited hint. The restart proof may keep an
`advertise` request in flight while awaiting the second hint to prove real-socket notification
demultiplexing; the hint must not resolve that request. The unchanged local op set proves the
no-materialization claim at the live seam; the fake socket additionally inspects outbound frames and
proves first-hint establishment sends only `subscribe` before the hint.

## Files

- `clients/lattice-client/src/carrier.ts`
- `clients/lattice-client/test/carrier_feed.ts`
- `clients/lattice-client/package.json`
- `clients/township-tauri-shell/test/township_carrier_feed.ts`
- `clients/township-tauri-shell/package.json`
- `.github/workflows/flagship.yml`
- Plan 133 cumulative contract tests and status documentation

The fake-socket script runs as a hard step in the existing lattice-client block of the hosted
`Unit + property suite` job. The live shell-located gate runs in that same Ubuntu job, after the
full BEAM suite has compiled `_build/test`: CI builds `clients/lattice-client`, installs
`clients/township-tauri-shell` dependencies explicitly, and runs its new `feed:contract` script.
The shell script's pre-hook rebuilds the file-linked client before execution. The headless gate is
not moved into the expensive packaged macOS job.

The existing stable server protocol and Plan 132 BEAM implementation should not require runtime
changes. A server change is allowed only if the live gate exposes a real cross-runtime protocol bug
that cannot be corrected in the TypeScript client.

## Stop conditions

Stop and redesign if any is true:

- A notification can resolve, displace, reorder, or queue ahead of an atomic request reply.
- The subscription route is installed after the subscribe request is sent.
- An availability frame can mutate/materialize state without canonical verification and pull.
- A diagnostic/truncated frontier becomes reconciliation input.
- More than one latest availability or one `next()` waiter is retained per client.
- The plan claims the TypeScript layer bounds underlying WebSocket implementation buffering.
- Duplicate/non-changing relay advances the observed generation.
- Reconnect can retain an old subscription or route a new hint to an old consumer.
- Direct TypeScript feed code ships without the real stable-server gate in hosted CI.
- The implementation begins to require app feed wiring, custody changes, parked mobile/device work,
  broader controls, deployment, complete Phase G/G1, or W4.

## TDD plan

1. **Plan/public seam RED.** Add the Plan 133 contract and index row first. Assert the typed exports,
   direct live script, hard CI step, and unchanged non-claims; observe missing implementation.
2. **Demultiplexing RED.** With a fake socket, deliver `ops_available` before an in-flight frontier
   reply and with no request pending. Prove current FIFO routing corrupts the current/next request.
   Keep the scenario permanently as the GREEN assertion that a notification never satisfies an
   atomic request.
3. **Atomic request GREEN.** Replace the FIFO response queue with one pending atomic request;
   unsolicited non-notification frames and concurrent requests fail closed while all existing
   request/response tests remain green.
4. **Subscription establishment RED/GREEN.** Add typed decoding and pre-register the route before
   sending subscribe. Deliver a hint before `subscribe_result` and prove `next()` receives it.
5. **Mailbox bound RED/GREEN.** Deliver many increasing hints to a slow consumer and prove only the
   latest is retained. Cover duplicate generation, regression, malformed payload, concurrent
   `next()`, peer close, local close, duplicate subscribe, and idempotent unsubscribe.
6. **Live gate RED/GREEN.** Run the direct TS client against the real path-backed stable relay and
   prove first hint, verified pull/Sim equality, duplicate silence, restart replacement, and the
   second hint/verified pull.
7. **CI/docs RED/GREEN.** Add the fake script to the existing lattice-client steps in `Unit +
   property suite`; then build the client, install shell dependencies, and run the live
   `feed:contract` in the same job after BEAM compilation. Advance cumulative pins through 133 and
   update build-map/status surfaces without claiming app feed consumption.
8. **Regression.** Run all TypeScript scripts/typechecks, Tauri shell contracts and app convergence,
   full pinned-OTP verification/check, warnings compiles, xref, Sobelow, and affected browser/package
   gates.
9. **Independent review.** Claude reviews each RED diagnosis, public API, live proof, final exact
   diff, stop conditions, and documentation claims before commit and publication.

## Independent design review

Claude's read-only scope review returned `PROCEED TO PLAN`. It identified the current FIFO
`request/receive` path as a blocker to any subscription API, the first-hint registration order as a
high-risk race, and the lack of client-side receive credits as a required claim boundary. It
confirmed that the smallest complete Plan 133 is the shared library API plus a real stable-server
live gate; packaged app feed consumption belongs in a separately gated follow-up.

## Implementation evidence

- The implementation followed vertical RED/GREEN slices for unsolicited-notification poisoning,
  unsolicited replies, one-request enforcement and send-throw cleanup, pre-baseline hints,
  peer-close propagation, malformed envelopes/baselines/hints, latest-only retention, generation
  regression, duplicate subscribe/concurrent receive, unsubscribe lifecycle, handshake cleanup,
  real stable-server first/restart hints, CI/docs contracts, and malformed unsubscribe teardown.
- `npm run carrier:feed` passes the deterministic fake-socket matrix. `npm run feed:contract`
  passes against the real stable server with canonical hash/signature verification, Sim-equal ids,
  duplicate silence, old-route rejection, restart-stable baseline, concurrent request demultiplexing,
  and the second pushed generation. Both TypeScript typechecks and every shared-client script pass.
- The complete shell `app:convergence` matrix passes, including browser click-through, live peer,
  packaged onboarding, stable-relay onboarding, post-restart action handoff, and installed deep
  link. The direct feed gate itself remains headless and does not claim reactive app consumption.
- Full local regression passed on 2026-07-12: pinned-OTP `mix verify` and `mix check` each pass 374
  tests and 25 properties; strict Credo exits 0; forced test and production compiles pass with
  warnings as errors; xref retains the same five known cycles; both boundary Sobelow scans exit 0;
  workflow actionlint and `git diff --check` are clean.
- Claude's documentation review returned `PROCEED`; its CI-tense, row-placement, and live-ordering
  findings were resolved with a focused documentation-contract RED/GREEN. Its focused unsubscribe
  diagnosis returned `VERDICT FIX`; the malformed-reply test failed with an open socket, and the
  minimal GREEN now closes the client and rejects pending/future receives.
- Final exact-worktree Claude review returned `PROCEED` with no blocker, high, or medium finding.
  It rechecked all ten stop conditions, prior findings, source/generated-output parity, live oracle,
  lifecycle races, CI executability, and non-claims. Hosted publication evidence remains the final
  closure gate.

## Completion claim

Not yet complete. Completion requires the deterministic demultiplexing/mailbox contracts, the live
stable-server direct TypeScript proof, hard hosted CI, final independent review, and all cumulative
status surfaces to be green. Even then, this plan will not claim a reactive Tauri/Vue app loop,
custody/mobile changes, broader participant controls, deployment, complete G1/Phase G, or W4.
