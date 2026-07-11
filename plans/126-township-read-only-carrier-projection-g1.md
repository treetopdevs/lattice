# Plan 126: Township read-only carrier projection (G1)

## Status

DONE.

## Objective

Feed the connected `/township` instrument from an authenticated, real WebSocket peer without
giving Phoenix any participant capability or write path. A supervised pull-only projection owns
the carrier connection, validates received operations through the existing log/reducer path, and
broadcasts fresh or stale read-model snapshots through `TownshipWeb.PubSub`.

This is a periodic request/response feed, not server push. It does not complete G1, add write
controls, promote the spike listener to a production server, or make W4 receipt-free.

Planned at commit `065f459`.

## Why this increment

- Plans 121-124 provide an outsider-verifiable bundle, shared read model, connected LiveView, and
  Vue causal replay consumer, but the instrument still renders one static snapshot.
- Plan 125 moved the authenticated WebSocket carrier client into a dependency-light reusable app
  specifically so a later instrument feed would not depend on the node spike or full server app.
- `TownshipWeb.PubSub` already runs under the web supervisor and has no producer.
- The Tauri/TS client already proves onboarding, capability persistence, native key custody,
  mobile secure-store strategy, and real app convergence. This read-only Phoenix projection must
  preserve those custody boundaries and must not re-claim those gates.
- Phase F remains blocked on the receipt-free research verdict, and write controls remain blocked
  on a client-signs/server-relays design. A read-only feed can advance honestly now.

## Critical source separation

The tracked audit bundle and the node-spike Township peer are different replicas:

- bundle: `replica:matter:zoning-variance-24#root:...`, 13 operations;
- peer fixture: `replica:matter:township-g1#root:...`, 11 operations after convergence.

The projection must never seed a carrier log from the bundle or invoke `Lattice.Carrier.sync/3`,
because that driver is bidirectional and may push local operations. The bundle remains the
offline/default source. The configured carrier source starts from `Lattice.Log.new(replica)` and
uses only `advertise/2` plus `pull/2`; received operations pass through `Lattice.Sync.deliver/2`.

## Architecture

### Deep projection module

Add `TownshipWeb.CarrierProjection`, a supervised GenServer that hides connection lifecycle,
pull-only reconciliation, validation, projection, PubSub, freshness, and retry policy behind:

- `start_link/1` for supervision and focused tests;
- `subscribe/1`, which subscribes the caller and returns the current projection state; and
- `refresh/1`, a deterministic manual trigger used by tests and available to operators.

`subscribe/1` executes in the caller: it asks the GenServer for its PubSub server/topic, calls
`Phoenix.PubSub.subscribe/2` from the caller process, and then asks the GenServer for the latest
state. This ordering closes the snapshot/subscription race: an update either appears in the second
state read or arrives as a PubSub event, and a duplicate application is harmless. The GenServer
must never call `Phoenix.PubSub.subscribe/2` on the LiveView's behalf.

The normal child schedules an immediate refresh, polls at a configured interval after success,
and retries with `Lattice.Carrier.Backoff` after failure. Tests use manual scheduling. The module
accepts a carrier adapter internally; production uses `Lattice.Carrier.WebSocket`, while focused
tests use a deterministic in-memory adapter with the same `connect/1`, `advertise/2`, `pull/2`, and
`close/1` functions. There is no `push/2` call in the implementation.

### Verify on arrival

Each refresh:

1. connects and authenticates if no connection is open;
2. calls `advertise/2` to read the peer's current op-id set (the current WebSocket adapter does not
   transmit the local log in this callback);
3. rejects peer regression if the peer no longer advertises a previously received id;
4. calls `pull/2`, which sends only the local `have` ids and receives missing peer operation
   bodies;
5. delivers them through `Lattice.Sync.deliver/2`;
6. refuses to publish a new snapshot when any operation is wrong-replica or dependency-pending;
7. retains signature-invalid operations in structural quarantine so they remain visible and
   auditable; and
8. derives `Township.ReadModel.observe/2` and `replay/1` from the resulting peer log, including
   materialization-time authority quarantine such as `:not_holder` independently of the
   accept-time structural report.

Carrier provenance is labeled separately from audit-bundle verification:

```elixir
%{
  source: :carrier,
  freshness: :fresh | :stale,
  verification: :arrival,
  peer_realm: String.t(),
  replica: String.t(),
  frontier: [String.t()],
  pulled_at: DateTime.t(),
  last_error: nil | term()
}
```

No bundle path or bundle digest is attached to a carrier projection.

### Fresh, stale, and unavailable

- Before the first successful pull, a configured carrier projection is `:connecting`. Connected
  LiveViews withhold the unrelated bundle values while waiting for that peer.
- A successful pull publishes `{:fresh, payload}` on one private PubSub topic.
- A transport, authentication, regression, or validation failure before any successful pull
  publishes `{:unavailable, reason}` and the LiveView renders no authoritative values.
- A failure after a successful pull retains the last peer-derived model, marks its provenance
  `freshness: :stale`, records the error, and publishes `{:stale, payload}`.
- A later successful pull clears the error and returns the same projection to `:fresh`.

The static bundle remains the default when no carrier projection is configured. It is not used as
a fallback for a configured but unavailable peer because it describes a different matter.

### LiveView integration

`TownshipWeb.InstrumentLive` continues to load the bundle for dead rendering. On connected mount it
subscribes only when a projection server is configured, then applies the projection's current
state and later PubSub events. The existing model and replay render path remains shared.

The source strip distinguishes:

- `bundle / verified snapshot`;
- `carrier / arrival-verified / fresh`;
- `carrier / arrival-verified / stale`; and
- `carrier connecting` or `source unavailable`, with no panel or replay payload.

Vue continues to receive server-derived replay data only. It does not connect to the carrier or
derive state, authority, order, quarantine, or freshness.

### Ownership and dependency graph

- `township_web` adds a direct runtime dependency on `lattice_web_socket`.
- `township_web` does not depend on `lattice_node_spike`, Cowboy, or `lattice_server`.
- The second-process peer remains a test/producer fixture owned by `lattice_node_spike`; place the
  cross-app integration proof in `lattice_node_spike`, which adds `township_web` only as a
  `only: :test, runtime: false` umbrella dependency. This gives that test access to the real
  endpoint/LiveView without adding a production web-to-spike or spike-to-web runtime edge.
- Application startup includes `CarrierProjection` only when carrier projection options are
  configured. It is ordered after PubSub and before the Endpoint. `init/1` performs no network I/O:
  it schedules the first refresh asynchronously so an absent peer cannot block application boot.
  Failed connections are closed before retry to avoid leaking WebSocket client processes. The
  default static instrument remains runnable without a peer.

## Public TDD seams

These seams are fixed by the user-provided build map and are the only test surfaces for this plan:

1. `TownshipWeb.CarrierProjection.subscribe/1` and `refresh/1`: observable fresh, stale, and
   unavailable results plus PubSub delivery; tests do not inspect GenServer state.
2. Connected `/township`: rendered carrier provenance and values update from projection events;
   unavailable states expose no authoritative panel or replay values.
3. Real second-process peer: an authenticated pull updates the connected LiveView to a
   Sim-matching state and authority quarantine while the peer receives no projection-authored op.

Existing `Township.ReadModel.observe/2`, `replay/1`, `Lattice.Sync.deliver/2`, and
`Lattice.Carrier.WebSocket` remain independently covered and are reused rather than retested
through private helpers.

## Scope

- Add the supervised pull-only projection and direct web-to-carrier dependency.
- Add configured startup, PubSub subscription, freshness/error state, and connected LiveView
  rendering.
- Add focused adapter-driven projection tests one vertical slice at a time.
- Add one real second-process WebSocket-to-PubSub-to-LiveView integration proof.
- Extend browser coverage only where source labels or LiveView patching need a real browser.
- Update the plan index, build map, current status docs, and cumulative readiness contracts.

## Non-goals

- No carrier `push/2`, `live/2`, command relay, write control, cap issuance, or participant key.
- No stable carrier listener/server extraction, TLS, deployment topology, recursive frontier diff,
  production throughput, or server-push protocol.
- No replacement of the tracked bundle or change to its seven verified artifacts.
- No Vue reducer, direct Vue carrier connection, or browser-side authority decision.
- No Tauri onboarding/cap-persistence change, mobile secure-store change, shell custody change,
  iOS unblock, physical-device, QR/LAN, or full-mobile-onboarding claim.
- No receipt-free primitive, W4 change, G1/Phase G completion, or `receipt_free? = true` claim.

## STOP conditions

- Stop if the projection calls `push/2`, `live/2`, or bidirectional `Lattice.Carrier.sync/3`.
- Stop if the audit bundle log is merged with or sent to the carrier peer.
- Stop if previously received peer ids disappear without making the projection stale/unavailable.
- Stop if wrong-replica, dependency-pending, malformed, or unauthenticated input produces a fresh
  authoritative snapshot.
- Stop if `township_web` gains a runtime dependency on `lattice_node_spike`, Cowboy,
  `lattice_server`, a shell app, or participant key/cap storage.
- Stop if polling is described as server push, continuous liveness, or production scalability.
- Stop if stale data is displayed without an explicit stale marker and last successful pull time.
- Stop if an unavailable configured peer silently renders the unrelated bundle as its state.
- Stop if any current doc claims write capability, stable server ownership, G1 completion, real W4,
  or newly proves a Tauri/mobile gate untouched by this plan.

## TDD plan

1. PULL-ONLY RED/GREEN: through `CarrierProjection.refresh/1`, require an empty replica log to pull
   deterministic peer ops, derive a fresh model/replay, publish to a subscriber, and never call
   `push/2`. Implement only the minimum connection/pull/deliver/project path.
2. FRESHNESS RED/GREEN: add failure-before-success, stale-after-success, peer-regression, and
   recovery examples through the same interface; then add connection close, backoff, and scheduler
   behavior needed to pass them.
3. LIVEVIEW RED/GREEN: start a configured projection adapter, connect `/township`, and require
   connecting/unavailable refusal plus fresh/stale provenance and model patches before changing the
   LiveView/template.
4. REAL-PEER RED/GREEN: spawn the existing Township peer in a second BEAM OS process, pull its base
   log, trigger its existing offline divergence with a separate authenticated socket, refresh the
   projection, and require the connected LiveView to match the Sim-derived peer state and authority
   reasons. Add the explicit test-only node-spike-to-township-web dependency, prove the observer
   authored and pushed no operation, and require a wrong peer key to withhold state.
5. DOCS RED/GREEN: add the Plan 126 contract and advance current plan/build-map/readiness markers
   while retaining every write/server-push/stable-server/G1/W4/Tauri/mobile non-claim.
6. VERIFY: run focused projection/LiveView/real-peer tests, forced warnings-as-errors compilation,
   the five-cycle xref baseline, `mix verify`, `mix check`, both Sobelow scans, bundle verification,
   Township browser E2E, mobile readiness, artifact immutability, formatting, and diff checks.
7. REVIEW: obtain Claude Code reviews for this written plan, each red/green seam, the real-peer
   proof, and the complete release diff before commit.

## TDD evidence

- PULL-ONLY RED began with the public `CarrierProjection` module absent. GREEN established an
  empty peer-replica log, authenticated advertise/pull, `Lattice.Sync.deliver/2`, read-model/replay
  derivation, PubSub delivery, and no adapter push callback.
- FRESHNESS RED/GREEN added pre-first-pull unavailability, stale retention and recovery, explicit
  peer-regression details, one in-flight refresh, deterministic backoff, tokenized single-timer
  replacement, and best-effort close of an already-dead carrier process. The public suite now has
  eight passing examples without inspecting GenServer state.
- LIVEVIEW RED/GREEN added connecting-to-fresh patches, refusal when a configured projection is
  absent, bounded stale error rendering, configured application supervision, and options-only
  wiring to the named projection. The bundle remains the dead/default source only when no carrier
  projection is configured.
- REAL-PEER RED/GREEN uses the existing peer in a second BEAM OS process, proves authenticated base
  pull and offline divergence, matches Sim-derived counts and `:not_holder` authority quarantine,
  proves a wrong peer key withholds state, and checks the observer authored/pushed no operation.
- BROWSER RED first exposed that the server LiveView patched while the Vue island retained its
  original mount. GREEN added `updated`/`destroyed` hook handling with exact one-app teardown and
  remount. A follow-up RED/GREEN suppressed identical fresh-to-fresh PubSub broadcasts so periodic
  no-op pulls do not remount the island. Final line review added a public-seam RED proving those
  no-op pulls still advance the stored last-successful-pull timestamp; GREEN updates internal
  freshness without broadcasting an unchanged model.
- DOCS RED advanced every current marker to `plans 023-126` and required the Plan 126 index/map
  claim plus the Tauri onboarding/cap-persistence, mobile secure-store, real-app convergence,
  stable-server, G1, and W4 non-claims. The completion markers stayed RED until the complete gate
  set and final second opinion passed; changing only the plan and index status then made the
  contract GREEN. Its semantic build-map assertions tolerate Markdown line wrapping. The
  mobile-readiness gate also exposed stale assertions against the build map's deleted per-plan
  ledger; GREEN now checks concise map boundaries while trusting plans 054-120 and the secure-store
  strategy for their detailed claims.

## Second opinion

- Claude ranked this read-only carrier projection first, ahead of stable listener extraction,
  remaining environment-bound mobile work, write controls, and research-blocked receipt-free work.
- Claude confirmed that request/response polling plus PubSub is an honest B2 slice when it is
  described as periodic pull rather than server push.
- Claude found the bundle/peer replica mismatch and required peer-sourced pull-only state rather
  than bidirectional sync from the verified bundle.
- Claude required a real second-process proof, explicit stale/error semantics, no runtime
  node-spike edge, and preservation of Tauri/mobile custody and non-claims.
- Claude's written-plan review returned `VERDICT: PROCEED` after identifying two details to pin
  before implementation: PubSub subscription must run in the LiveView caller process, and the
  real-peer LiveView proof needs an explicit test-only node-spike-to-township-web edge. The plan
  now also records the adapter's actual advertise/pull wire behavior, separates structural from
  authority quarantine, and requires non-blocking startup plus close-before-retry cleanup.
- Claude returned `PROCEED` on the pull, failure, regression, scheduler, timer, close, LiveView,
  application, real-peer, browser-remount, and no-op-polling checkpoints after requested revisions
  were implemented. In particular, Claude caught an invalid ephemeral PubSub test subscriber, a
  duplicate-timer race, the missing test-only app dependency, and unnecessary Vue remounts.
- The docs-RED and complete release-diff review was retried after Claude access recovered. Claude
  inspected the implementation, supervision, LiveView/Vue path, real-peer and browser proofs,
  dependency ownership, build map, cumulative contracts, and preserved Tauri/mobile boundaries.
  It found no correctness issue and returned `VERDICT: PROCEED`. Its three non-blocking
  observations were that real-carrier timing remains deterministic/manual in end-to-end tests,
  LiveView subscription catches `:noproc` rather than every possible call exit, and stale payloads
  retain `verified: true` while carrying explicit stale provenance, pull time, and last error.

## Verification

- Focused projection/application/LiveView/source suite: 17 tests, 0 failures.
- Real second-process projection suite: 2 tests, 0 failures, including wrong-key refusal.
- Static Township browser suite: 6 Playwright cases passing; live carrier projection: 1 case passing
  with desktop/mobile framing, no browser errors, and one Vue root after the peer update.
- Tauri boundaries: mobile readiness, secure-store strategy, 29 frontend/onboarding ceremony
  checks, and the full `app:convergence` gate passed, including browser click-through, live BEAM,
  packaged app, onboarding, and installed deep-link smokes.
- `mix lattice.township.verify_bundle` passed and `git diff --exit-code -- artifacts/township` is
  clean. The shared `npm run browser:e2e` carrier path also passed.
- Forced warnings-as-errors compilation passed in `township_web` and `lattice_node_spike`.
  `mix xref graph --format cycles` reports the unchanged five baseline cycles, with none containing
  the projection or its dependency edge. Both HTTP boundary Sobelow scans exited 0.
- Strict Credo exits 0 with no new finding in Plan 126 files. Formatting and `git diff --check` are
  clean. The completed docs contract passes 3 tests. Unexcluded `mix verify` and `mix check` each
  pass the full umbrella: 305 tests and 25 properties, with strict Credo included by `mix check`.
- The full gate exposed a pre-existing load-sensitive teardown race in the mediated WebSocket
  story. A pinned umbrella seed reproduced it after all four story assertions: linked reader tasks
  were still calling the clients when the test closed those client processes. Claude independently
  returned `VERDICT: PROCEED` on the diagnosis. Ending the readers before closing their clients made
  the focused story, pinned original repro, `mix verify`, and `mix check` GREEN without changing
  production behavior.

## Completion claim

Complete for this scoped increment. A connected LiveView receives a peer-sourced,
arrival-verified read model over the real WebSocket carrier and PubSub while every pull-only,
freshness, refusal, custody, and non-claim gate above remains proven. This does not complete G1 or
Phase G, add participant writes or server push, make W4 receipt-free, or newly prove any Tauri or
mobile gate.
