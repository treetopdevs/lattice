# Plan 127: Stable read-only carrier server boundary (toward G1)

## Status

IN PROGRESS.

## Objective

Give the Plan 126 carrier projection a supervised, configurable, non-fixture `/carrier` server to
pull from. A new `lattice_carrier_server` umbrella app loads one persisted or injected
`Lattice.Log`, authenticates trusted carrier realms, and serves only frontier advertisement and
missing-op pulls through the existing carrier session and wire formats.

This is a stable read-only server boundary, not a participant realm. It owns a transport identity
and already-signed replica data, but no participant identity, capability, command authoring,
inbound push, server-push subscription, or authority decision. It is the prerequisite for later
server-push and client-signs/server-relays slices; it does not complete G1 or Phase G itself.

Planned at commit `a971933`.

## Why this increment

- Plan 125 supplies a reusable Cowboy-free carrier client, and Plan 126 uses it to feed LiveView,
  but the only `/carrier` peer it can reach is still `LatticeNodeSpike.PeerServer`.
- The node-spike peer is intentionally a fixture: it binds `port: 0`, mutates civic state when a
  socket closes, exposes push/live/status/state/shutdown test messages, and can halt its OS process
  from the protocol. None of those are stable server semantics.
- Server-initiated subscriptions need a supervised server that owns connections. Participant write
  controls additionally need a client-signs/server-relays design and a stable relay target. The
  listener boundary therefore precedes both.
- Plans 054-120 already establish the Tauri onboarding/cap-persistence ceremony, mobile
  secure-store strategy, desktop/packaged/browser app convergence, and bounded Android evidence.
  This transport slice preserves those custody proofs; it must not redo or reclaim them.
- Receipt-free W4 remains blocked on M4 research. The iOS, physical-device, camera/LAN, and
  cross-device gaps in `TOWNSHIP_BUILD_MAP.md` section 4a remain externally blocked and parked.

## Critical trust separation

The carrier server has a realm identity only to authenticate transport sessions. That key must not
author Township operations, mint capabilities, or stand in for a resident, clerk, or shell key.
The served log contains signed operations authored elsewhere. A client still verifies those
operations through `Lattice.Sync.deliver/2`, and materialization-time authority analysis remains
the source of semantic quarantine.

The stable server must not copy the node-spike scenario lifecycle:

- socket close is ordinary connection teardown and never changes the log;
- there is no offline-divergence callback;
- there is no protocol-triggered `System.halt/1`;
- there is no inbound `push`, ephemeral `live`, fixture `status`, state-report, or shutdown
  message; and
- restart reloads the configured source or fails closed rather than silently starting an unrelated
  empty replica.

## Architecture

### Dedicated umbrella app

Add `apps/lattice_carrier_server` with:

- runtime dependencies on `lattice_core`, Cowboy, and Jason;
- a supervision tree and no Phoenix, Tauri, node-spike, or browser-demo dependency;
- `lattice_web_socket` and `township_web` only as `only: :test, runtime: false` dependencies when
  their public client/projection seams are used by cross-app proofs; and
- explicit raw-Cowboy security/refusal coverage; Sobelow is not used because this app has no
  Phoenix router, endpoint, or controller surface for it to analyze.

Do not put the listener in `lattice_web_socket`: Plan 125 deliberately made that app mod-less and
Cowboy-free. Do not put it in `lattice_server`: that app owns the browser-demo `/ws`, resume,
flagship, and federated-worker protocols. Do not promote `lattice_node_spike`: its fixture-specific
partition story must stay independently green.

### Deep server module

`LatticeCarrierServer` hides source loading, holder lifecycle, listener construction, session
authentication, read-only dispatch, supervision, and bound-port discovery behind:

- `start_link/1` (and its child spec) for application supervision and focused tests; and
- `port/1`, keyed by a configured server instance, for operators and real-process tests.

The options contain one server instance, a transport `Lattice.Identity`, a trusted-peer map, one
log source, and listener IP/port. The log source is either `{:path, path}` or `{:log, %Lattice.Log{}}`.
`port: 0` is allowed only as a test/runtime discovery convenience; deployment configuration uses a
fixed port. The identity's `realm_id` supplies the server realm, and the loaded log supplies the
replica, so callers cannot configure contradictory copies of either fact.

Internal modules may include a registry, log holder, Cowboy/Ranch listener child, and WebSocket
handler. They are not test surfaces. Do not add a holder behaviour: the real holder is an
in-process, locally substitutable dependency, and there is no second adapter to justify another
interface. Tests and callers cross the same `LatticeCarrierServer` plus real carrier seams.

### Source and restart semantics

The holder loads its source during `init/1`:

- `{:path, path}` calls `Lattice.Log.restore/1` and fails startup on a missing or malformed
  corrupt-serialization source. Before the safe restore, it loads the known `lattice_core`
  application modules so their existing structs and atoms can be decoded in a fresh VM;
- `{:log, log}` retains the immutable seed value in the child spec; and
- both paths expose only sorted op ids and causal-order missing operations.

Source restore does not attest operation signatures or authority. The server serves the restored
signed bytes; each client verifies them on arrival through `Lattice.Sync.deliver/2` and derives
semantic authority quarantine during materialization.

The server supervisor uses `:rest_for_one`: the holder starts before the embedded Ranch/Cowboy
listener. A holder failure reloads the source and restarts the listener, dropping old authenticated
connections rather than letting them retain stale process state. A listener failure restarts the
listener without replacing the holder. The listener is embedded under this app's supervisor with
`ranch.child_spec/5`; it must not be an unowned child left under global `:ranch_sup` by a bare
`:cowboy.start_clear/3` call.

Application startup always starts the internal registry and starts a server instance only when
`:server_options` are configured. No server is bound by default in umbrella tests. Invalid source,
identity, allowlist, or listener options fail that configured child visibly.

### Authenticated read-only protocol

The Cowboy WebSocket handler reuses `Lattice.Carrier.Session`, `Lattice.Carrier.Wire`, and carrier
telemetry. A signed challenge is accepted only when:

1. `local_realm` exists in the configured `%{realm => public_key}` allowlist;
2. `Session.verify_challenge/2` verifies that realm and key;
3. the requested replica exactly matches the holder log's replica; and
4. the requested wire version exactly equals `Lattice.Carrier.Wire.version/0` in addition to being
   bound into the signed transcript.

Public authentication failures return one coarse `unauthenticated` error while telemetry retains
the internal reason. Before authentication every non-challenge message is rejected. After
authentication the only requests are:

- `frontier` -> sorted `frontier_result.ids`; and
- `pull` with a bounded list of `have` ids -> causal-order wire-encoded missing operations.

Malformed frames are bounded and rejected. `push`, `live`, `status`, `state`, `shutdown`, and every
unknown authenticated request return a read-only/unsupported error and cannot mutate the holder.
Disconnect emits telemetry only.

### Dependency graph

- `lattice_carrier_server` -> `lattice_core`, Cowboy, Jason at runtime.
- `lattice_carrier_server` -> `lattice_web_socket`, `township_web` only in tests if needed.
- `township_web` remains unchanged at runtime and still connects outward through
  `lattice_web_socket`.
- `lattice_node_spike` remains a fixture app and gains no runtime dependency on the new server.
- The existing five source-level xref cycles remain the baseline; no cycle may include the new app
  or its listener/holder modules.

## Public TDD seams

These seams are fixed by the user-provided build map and are the only test surfaces for this plan:

1. `LatticeCarrierServer.start_link/1` and `port/1` plus the production
   `Lattice.Carrier.WebSocket` client: a trusted client authenticates, advertises, and pulls the
   configured log; denied or malformed requests cannot change what a later pull observes.
2. Supervised server process: killing/restarting the server reloads the same source and restores the
   same fixed-port read service; a bad path or malformed corrupt-serialization source refuses
   startup. Ranch 2.2 supplies `reuseaddr: true` as a protected listener default; the real-process
   harness waits for clean OS-process exit before the bounded readiness check on the replacement.
3. `TownshipWeb.CarrierProjection.subscribe/1` and `refresh/1` against a production server in a
   second BEAM OS process: initial pull is fresh, process loss becomes stale, process restart plus
   retry becomes fresh, and the projection authors or pushes no operation.
4. Connected `/township` in the existing root Playwright live harness: the stable-server source
   renders carrier provenance, visibly transitions fresh -> stale -> fresh across server restart,
   preserves one Vue root, emits no browser error, and exposes no write control or participant
   custody. This extends `playwright.township-live.config.mjs`; it adds no browser-test framework or
   responsive-layout scope.

Tests must not inspect holder GenServer state, call handler callbacks directly, or assert Ranch
child internals. Source identity is proven by fresh authenticated pulls and Sim/read-model output.

## Scope

- Add the dedicated supervised carrier-server app and optional configured application child.
- Add fail-closed log source loading, transport identity, trusted-peer allowlist, and replica-bound
  challenge verification.
- Add only authenticated frontier/pull server messages over the existing wire format.
- Add focused real-socket tests one vertical slice at a time.
- Add one second-BEAM projection restart/recovery proof and one browser fresh/stale/recovery proof.
- Update the plan index, build map, architecture/status docs, boundary docs, and cumulative
  readiness contracts.

## Non-goals

- No inbound carrier `push`, ephemeral `live`, `Lattice.Carrier.sync/3`, command relay, cap
  issuance, participant signing key, or participant capability storage.
- No server-initiated subscription/push protocol; periodic Plan 126 polling remains the feed.
- No participant write controls; client-signs/server-relays remains the next separate design.
- No node-spike fixture rewrite, scenario extraction, offline-divergence change, or replacement of
  its G1 tests.
- No mutable log producer, database, compaction, recursive frontier negotiation, TLS, public-Internet
  deployment, throughput, multi-replica, or production-scale claim.
- No receipt-free primitive, W4 change, G1/Phase G completion, or `receipt_free? = true` claim.
- No Tauri onboarding/cap-persistence change, mobile secure-store change, real-app convergence
  change, iOS unblock, physical-device proof, camera/LAN claim, cross-device exchange, or new
  Android release probe.

## STOP conditions

- Stop if the server accepts or authors any operation, stores a participant key/capability, or calls
  `push/2`, `live/2`, or bidirectional `Lattice.Carrier.sync/3`.
- Stop if the server transport identity is described as a resident/clerk identity or authority.
- Stop if an untrusted realm/key, wrong replica, malformed challenge, or pre-auth request can pull
  ids or operation bodies.
- Stop if socket close, authentication failure, or listener restart changes the served log.
- Stop if configured source failure silently starts an empty or different replica.
- Stop if Cowboy ownership lands in `lattice_web_socket`, the browser-demo server, or the
  node-spike fixture app.
- Stop if `township_web` gains a runtime dependency on the carrier server or any participant
  custody.
- Stop if polling is relabeled server push, listener existence is called production deployment, or
  docs claim G1/Phase G/W4 completion.
- Stop if this plan reopens a parked Tauri/mobile probe or newly claims Plans 054-120.

## TDD plan

1. SERVER RED/GREEN: require `LatticeCarrierServer` to start on `port: 0`, expose its port, and let
   a trusted production WebSocket client advertise/pull a deterministic log. Implement only the
   app, source holder, embedded listener, auth challenge, frontier, and pull path needed to pass.
2. REFUSAL RED/GREEN: add wrong key, wrong realm, wrong replica, pre-auth, malformed, oversized,
   push, live, and disconnect-no-mutation examples through the real socket. Add coarse auth errors,
   bounds, and read-only dispatch only as each example demands.
3. LIFECYCLE RED/GREEN: add path reload, configured application startup, fixed-port restart, and
   invalid-source refusal examples. Implement `:rest_for_one` ownership and fail-closed loading.
4. REAL-PROCESS RED/GREEN: start the production server app in a second BEAM OS process from a
   deterministic Township log, pull it through `CarrierProjection`, kill it, require stale state,
   restart it, and require fresh Sim/read-model convergence with no server/projection-authored op.
5. BROWSER RED/GREEN: extend the existing root Playwright live harness to drive the same process
   restart while a real `/township` LiveView is connected; require fresh/stale/fresh provenance,
   retained stale values, one Vue root, no write control, and no browser error.
6. DOCS RED/GREEN: add Plan 127 contracts and advance current markers while retaining every
   write/server-push/deployment/G1/W4/Tauri/mobile non-claim.
7. VERIFY: run focused server/projection/LiveView/real-process tests, forced warnings-as-errors
   compilation, xref cycle baseline, both existing Phoenix boundary Sobelow scans, the new raw
   Cowboy authentication/read-only refusal matrix and explicit security review, bundle
   verification, Township browser suites, mobile readiness/secure-store/app-convergence, artifact
   immutability, `mix verify`, `mix check`, formatting, and diff checks.
8. REVIEW: obtain Claude Code reviews for this written plan, each RED/GREEN seam, lifecycle and
   real-process proof, browser proof, docs contract, and the complete release diff before commit.

## TDD evidence

- SERVER RED first failed because `LatticeCarrierServer` did not exist. GREEN added the dedicated
  app, supervised holder/listener, trusted session challenge, frontier, and pull path through the
  production `Lattice.Carrier.WebSocket` client.
- REFUSAL examples then drove server-side auth-reason telemetry, the 64,000-byte frame bound,
  authenticated disconnect telemetry, pre-auth denial, the wrong-realm/key/replica/version matrix,
  and immutable `push`/`live` refusal. The focused socket matrix reached seven green tests before
  lifecycle work.
- LIFECYCLE REDs drove safe path restore in a fresh VM, optional configured application startup,
  config validation, and a supervised fixed-port source-preserving restart. The complete focused
  app suite reached eleven green tests before the cross-process proof.
- REAL-PROCESS RED first exposed that safe `Lattice.Log.restore/1` needs known application structs
  loaded in a fresh VM, then exposed the missing production process entrypoint. GREEN added the
  fail-closed loader preload and `priv/server_node.exs`; `TownshipWeb.CarrierProjection` became
  fresh, retained stale verified state after process loss, and recovered the same op ids after a
  clean replacement process started.
- BROWSER RED failed on the absent Plan 127 shell/config/spec. GREEN added the existing-root
  Playwright harness around a connected `/township` LiveView and real server/projection path.
  `npm run township:instrument:server-e2e` passes fresh -> stale -> fresh with 13 retained ops,
  one Vue root, no browser error, and no write control in every state.
- DOCS RED failed because the build map did not yet inventory `apps/lattice_carrier_server`; the
  map, boundary docs, cumulative readiness markers, and explicit non-claims were then advanced to
  Plan 127. Final completion-status RED/GREEN remains gated on the release review.

## Second opinion

- Claude ranked the stable carrier-server boundary ahead of server push and write controls because
  both depend on a real server that is not the node-spike fixture.
- Claude rejected parked Tauri/mobile probe variants and research-blocked W4 as Plan 127 work.
- Claude recommended a dedicated app rather than placing Cowboy in the client library, browser-demo
  server, or fixture app, with a read-only signed-log trust model and explicit restart proof.
- Claude's first written-plan review returned `VERDICT: REVISE`: it correctly required
  corrupt-serialization rather than server-verification language, removal of a hollow Sobelow gate,
  an explicit supported-wire-version check, and bounded fixed-port rebind behavior. It also asked to
  remove the browser proof after searching only child-app Mix files; the plan instead pins reuse of
  the already-passing root Plan 126 Playwright live harness and removes redundant responsive scope.
- Claude re-read the revised plan against the existing root Playwright harness, withdrew the
  browser objection, confirmed every requested correction, and returned `VERDICT: PROCEED`.
- Claude returned `VERDICT: PROCEED` at the server, refusal, lifecycle, and real-process
  checkpoints. Its lifecycle review identified only a wording overclaim about rebind retries; the
  plan now states the actual clean-exit plus Ranch `reuseaddr` proof.
- Claude's browser review traced the production server, production carrier client,
  `CarrierProjection`, connected LiveView, and Vue mount end to end and returned
  `VERDICT: PROCEED`. It correctly scoped the proof to deterministic manual projection refresh and
  an in-process server restart, noted that custody absence rests on Elixir code/refusal tests rather
  than DOM inspection, and suggested rechecking the no-write selector after each transition. The
  test now does so.
- Claude's documentation review checked every claim against the implementation and returned
  `VERDICT: PROCEED`. It confirmed the listener/deployment, transport/participant identity,
  request-response/server-push, browser/second-BEAM, and Plan-127/Phase-G distinctions, plus the
  unchanged Tauri/mobile/app-convergence boundary. Its only wording nit was resolved by naming
  Plan 126 as the autonomous-polling evidence below the browser boundary.
- The verification xref RED exposed one new length-two cycle caused solely by the opaque Ranch ref
  using the parent server module. Claude confirmed the edge diagnosis and returned
  `VERDICT: PROCEED` on keying the ref by `LatticeCarrierServer.Listener`; the five-cycle baseline
  and all server behaviors remain unchanged.

## Verification

- `apps/lattice_carrier_server`: 13 tests pass across trusted pull, coarse auth/refusal telemetry,
  oversized frames, disconnect immutability, pre-auth and auth matrices, read-only push/live
  refusal, injected/path sources, invalid configuration, configured application ownership,
  fixed-port supervisor restart, second-BEAM projection recovery, and the Plan 127 docs contract.
- Forced warnings-as-errors compilation passes in both test and production environments. The
  generated production `.app` runtime list contains `cowboy`, `jason`, and `lattice_core`, but not
  the test-only `lattice_web_socket` or `township_web` apps.
- `mix xref graph --format cycles` reports the unchanged five baseline cycles after the Ranch-ref
  fix, with no cycle containing the new app. Both existing HTTP-boundary Sobelow scans exit 0; the
  raw Cowboy server's ten-test auth/read-only refusal matrix supplies its applicable security gate.
- `mix lattice.township.verify_bundle --dir artifacts/township` passes and the tracked artifact
  directory remains byte-clean.
- Browser gates pass: six static Township instrument cases, the existing real-carrier live case,
  the new stable-server fresh/stale/fresh case, and the shared browser carrier E2E. The new case
  retains 13 ops and one Vue root with no browser error or write control in every state.
- Preserved app boundaries pass: mobile readiness, mobile secure-store strategy, 29 frontend shell
  contracts, and the full `app:convergence` chain through authoring, sync, onboarding ceremony,
  browser click-through, live BEAM, packaged app, and installed deep-link smokes.
- Unexcluded `mix verify` and `mix check` each pass the complete umbrella with 318 tests and 25
  properties. Strict Credo exits 0 with no Plan 127 finding after the two new test alias groups were
  ordered; formatting and diff checks are clean.
- The first externally-created feature commit accidentally included two ExUnit `tmp/` log files.
  A focused follow-up removes them, ignores the app-local `/tmp/`, restores the five-cycle xref
  baseline, and advances the cumulative mobile-readiness assertion without changing its custody
  claims.

## Completion claim

Not complete. Plan 127 is implemented only when the production carrier client and the Plan 126
projection can pull the same configured signed log from a supervised non-fixture server, recover
freshness across a real server restart, and every read-only, custody, refusal, and non-claim gate
above remains proven.
