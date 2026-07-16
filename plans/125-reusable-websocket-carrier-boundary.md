# Plan 125: Reusable WebSocket carrier boundary

## Status

DONE.

## Objective

Promote the real WebSocket carrier client out of `lattice_node_spike` into a dependency-light,
reusable umbrella boundary without changing carrier, wire, session, sync, or Township semantics.
This is producer-boundary extraction only: it enables a later real-peer instrument feed, but does
not add PubSub, live snapshots, write controls, or any liveness claim itself.

Planned at commit `f8390d8`.

## Why this increment

- Plan 017 already proves Township W0-W3 against a second BEAM OS process over a real WebSocket,
  but its reusable client is still owned by the app named `lattice_node_spike`.
- Plan 124 deliberately refused a static-bundle PubSub layer because it would have no real
  producer. A stable real-carrier client is the prerequisite for an honest live source.
- `lattice_node_spike` currently depends on and starts the complete `lattice_server` application
  solely to obtain `Lattice.Transport.WebSocket.Client`; this boots unrelated server supervision.
- The Tauri/TS clients already hold participant keys and capabilities. This extraction is read/write
  transport plumbing only and must not move participant custody into Phoenix or BEAM.
- Phase F remains blocked on the R-02/R-03 receipt-free research verdict. Carrier ownership can be
  improved now without touching `Lattice.Attestation.M4Placeholder`.

## Architecture

### New library app

Create `apps/lattice_web_socket`, a `mod:`-less umbrella library app with only:

- `lattice_core` as an umbrella dependency;
- `jason` for JSON envelopes; and
- `:logger` / `:crypto` as extra applications.

It must not depend on Cowboy, Phoenix, `lattice_server`, `lattice_node_spike`, `township_web`, or
any shell/client app, and it starts no supervision tree. Callers explicitly start WebSocket client
processes.

### Module ownership

Move these public modules without changing their names or APIs:

- `Lattice.Transport.WebSocket.Client`
- `Lattice.Transport.WebSocket.Envelope`

Promote `LatticeNodeSpike.WsCarrier` to:

- `Lattice.Carrier.WebSocket`

`Lattice.Carrier.WebSocket` intentionally joins the `Lattice.Carrier.*` discovery namespace while
being physically owned by `:lattice_web_socket`; the core behaviour and transport implementation
therefore span two apps. Document that split explicitly. The module uses
`Lattice.Carrier.Wire.encode_op/1` and `decode_ops/1` directly.

Delete the `LatticeNodeSpike.Wire` rename shim. Update `LatticeNodeSpike.WsHandler`, which also uses
that shim, to call the shared wire API directly with its real function names.

### Boundaries that stay put

- `Lattice.Transport.WebSocket`, the browser-tab Cowboy handler, remains in `lattice_server`.
- `LatticeNodeSpike.Peer`, `PeerServer`, `WsHandler`, scenarios, and peer scripts remain in
  `lattice_node_spike` as real-producer fixtures and spike/server ownership.
- `Lattice.Carrier`, `Batch`, `Session`, `Wire`, `Telemetry`, and `SimNet` remain in `lattice_core`.
- `township_web` remains unchanged and static-bundle-backed in this plan.

`Envelope.encode/1` is generic transport JSON, while `Envelope.parse/1` owns the browser-boundary
allowlist used by `lattice_server`. Keeping them together avoids a reverse dependency from the new
library to the server; record that vocabulary ownership and leave an encode/parse split as a future
cleanup only if another inbound protocol needs it.

### Dependency graph

- `lattice_server` adds a direct `lattice_web_socket` dependency for `Envelope`.
- `lattice_node_spike` replaces its `lattice_server` dependency with `lattice_web_socket`.
- `lattice_demo` and `lattice_stress` add direct `lattice_web_socket` dependencies because they
  call `Client`, while retaining `lattice_server` for their actual server/demo APIs.

The resulting app graph must remain acyclic. Source-level `mix xref` has five pre-existing cycles;
Plan 125 must add no cycle containing the new app, carrier, client, or envelope modules.

## Public seams

- Existing callers of `Lattice.Transport.WebSocket.Client` and `.Envelope` require no code change.
- Carrier callers switch from `LatticeNodeSpike.WsCarrier` to `Lattice.Carrier.WebSocket` with the
  same `connect/1`, `close/1`, status/report helpers, and `Lattice.Carrier` callbacks.
- `Application.get_application/1` reports `:lattice_web_socket` for all three promoted modules.
- `Application.spec(:lattice_node_spike, :applications)` includes `:lattice_web_socket` and excludes
  `:lattice_server`. This checks the child app's declared runtime graph rather than global
  `Application.started_applications/0`, whose contents depend on umbrella test ordering.

## Scope

- Add the new umbrella app and ownership contract tests.
- Move the client/envelope source files and carrier implementation.
- Remove the two spike-owned adapter modules.
- Update direct umbrella dependencies and all active code/test module references.
- Update current architecture docs and code references, including the `Lattice.Carrier` moduledoc,
  app layout, plan index, build map, and cumulative readiness contracts. Preserve historical plan
  narratives that accurately describe their original paths.

## Non-goals

- No carrier protocol, wire schema, batching, authentication, telemetry, or retry change.
- No carrier server extraction, reconnect supervisor, deployment configuration, TLS, or recursive
  frontier negotiation.
- No `township_web` source, PubSub, LiveView, Vue, or browser change.
- No write controls, relay endpoint, participant signing keys/caps in BEAM, or mutable UI session.
- No receipt-free primitive, W4 change, live-feed claim, Phase G/G1 completion, or production-scale
  claim.

## STOP conditions

- Stop if extraction requires changing `Lattice.Carrier`, `Sync`, `Wire`, `Session`, `Authority`,
  `Township.Matter`, or attestation semantics.
- Stop if `lattice_web_socket` depends on or starts Cowboy, Phoenix, `lattice_server`,
  `lattice_node_spike`, or `township_web`.
- Stop if `:lattice_server` remains in `Application.spec(:lattice_node_spike, :applications)` after
  the move. Do not use global started-app state for this gate.
- Stop if the public `Client`/`Envelope` API or real carrier behavior changes rather than moves.
- Stop if a new xref cycle contains `lattice_web_socket`, `carrier/web_socket`, `client`, or
  `envelope`; the five baseline cycles may remain unchanged.
- Stop if the work is described as a live producer integration, PubSub feed, write relay, stable
  carrier server, scalable transport, or G1 completion.
- Stop if `M4Placeholder` changes or anything claims `receipt_free? = true`.

## TDD plan

1. OWNERSHIP RED: add one file-scoped boundary contract that requires the three modules to belong
   to `:lattice_web_socket`, requires the node-spike application spec to include that app and
   exclude `:lattice_server`, and requires the old spike source files to be gone. Run only this new
   file for the initial RED so unchanged carrier suites still compile against the old module.
2. APP/CARRIER GREEN: create the library app, move `Client`/`Envelope`, promote the carrier, remove
   the shim, update `WsHandler`, adjust direct dependencies, and update every active code/test
   reference to `Lattice.Carrier.WebSocket` in the same implementation step. Then make the ownership
   file and the existing node/Township real-socket, security, and telemetry suites green together,
   proving convergence, quarantine, auth rejection, batch bounds, idempotency, and ephemeral
   non-persistence remain unchanged.
3. TRANSPORT GREEN: run the server integration/resume/envelope suites plus demo/stress focused
   coverage to prove the moved client and envelope remain compatible.
4. DOCS RED/GREEN: add a Plan 125 contract, advance current ownership and cumulative markers, and
   retain every feed/write/W4 non-claim.
5. VERIFY: compile with warnings as errors, compare xref cycles to the five-cycle baseline, run
   `mix verify`, `mix check`, both Sobelow scans, carrier/browser gates relevant to moved modules,
   formatting, artifact immutability, and diff checks.
6. REVIEW: obtain Claude Code reviews for architecture, corrected baseline, ownership RED,
   implementation, and final diff before commit.

## TDD evidence

- OWNERSHIP RED initially produced 3 failures from 3 tests: the stable carrier module had no owning
  application, node-spike declared `:lattice_server` instead of `:lattice_web_socket`, and both
  spike-owned adapter source files still existed. The first run also exposed and corrected an
  incorrect repo-root hop in the test itself before accepting the decisive RED.
- APP/CARRIER GREEN moved the modules and dependencies atomically. The ownership contract passed
  3/3, then the generic/Township real-socket, security/batching, telemetry, and boundary set passed
  23/23 with `Lattice.Carrier.WebSocket` in every carrier call.
- TRANSPORT GREEN passed 12 `lattice_server` integration/envelope/resume/live-ops/federation tests
  and 12 stress WebSocket/adversarial tests against the unchanged public client/envelope APIs.
- STRUCTURE GREEN forced warnings-as-errors compilation in both `lattice_web_socket` and
  `lattice_node_spike`. `mix xref graph --format cycles` still reports exactly the same five
  baseline cycles and none contains a moved or new WebSocket-library module.
- DOCS RED failed while Plan 125 remained `IN PROGRESS` and current architecture docs still named
  spike/server ownership, before the app layout, ADR, status, build map, plan index, and cumulative
  `023-125` contracts advanced.

## Second opinion

- Claude ranked receipt-free Phase F as research-blocked, write relay as dependent on a live target,
  and PubSub-before-carrier as a fake-liveness trap.
- Claude recommended decomposing the real-carrier path into B1 ownership extraction followed by a
  separate B2 read-only real-peer instrument feed with verify-on-arrival.
- The first architecture review returned `VERDICT: PROCEED` for a dependency-light new app, while
  requiring explicit Envelope vocabulary ownership, direct dependency edits, shim call-site edits,
  and startup/xref gates.
- Live verification corrected Claude's proposed empty-xref-cycle gate: the baseline already has five
  source cycles. Claude rechecked that fact and returned `VERDICT: PROCEED` for the revised no-new-
  cycle and node-spike-without-server runtime contracts.
- Claude's written-plan review returned `VERDICT: REVISE` because global started-app state would be
  umbrella-order-dependent and the original green steps left a temporary test compile gap. The plan
  now uses `Application.spec/2` and updates all active references atomically; rereview returned
  `VERDICT: PROCEED`.
- Claude reviewed the implementation diff, independently confirmed semantic equivalence, module
  ownership, dependency decoupling, direct wire calls, and the unchanged five-cycle baseline, and
  returned `VERDICT: PROCEED` with no blockers.

## Verification

- Ownership boundary: 3 tests passed.
- Real carrier/convergence/security/telemetry set: 23 tests passed.
- Server and stress transport compatibility set: 24 tests passed.
- Forced `mix compile --warnings-as-errors` passed in `apps/lattice_web_socket` and
  `apps/lattice_node_spike`; only upstream Erlang deprecation notices remained outside Elixir's
  warnings-as-errors gate.
- `mix xref graph --format cycles` retained exactly the five source-level baseline cycles, with no
  new app/client/envelope/carrier cycle.
- `~/.asdf/shims/mix verify`: 290 tests and 25 properties passed across the umbrella.
- `~/.asdf/shims/mix check`: full verification plus strict Credo exited 0. Two new alias-order
  advisories in moved-callsite tests were corrected; the remaining advisory set matches the
  baseline outside this diff.
- `~/.asdf/shims/mix sobelow --exit --skip` exited 0 in both HTTP boundary apps; the raw Cowboy app
  retained its expected no-Phoenix-router notice.
- `~/.asdf/shims/mix lattice.township.verify_bundle --dir artifacts/township` and
  `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` passed;
  `git diff --exit-code -- artifacts/township` is clean.
- `npm run browser:e2e` passed against a real ephemeral HTTP/WebSocket server, and
  `npm run township:instrument:e2e` passed all 6 desktop/mobile/resilience cases.
- `~/.asdf/shims/mix format --check-formatted` and `git diff --check` are clean before commit.

## Completion claim

DONE. Plan 125 provides a reusable real WebSocket carrier client boundary with unchanged
spike-proven behavior and removes node-spike's runtime dependency on `lattice_server`. It does not
add a stable carrier server, PubSub, write controls, receipt-freeness, or Phase G completion; no
live instrument producer is wired.
