# Plan 128: Durable client-signed carrier relay (toward G1)

## Status

DONE.

## Objective

Give the Plan 127 stable carrier server one opt-in write seam: an authenticated, explicitly
relay-authorized transport realm can submit one already-signed operation, the server structurally
verifies and durably records it, and a different read-only observer can pull and materialize it
through the existing verified projection.

The client signs and the server relays. The server never holds a participant private key, authors
an operation, mints a capability, or decides semantic authority. This plan creates the real source
change producer needed before server-push notifications can be honest. It does not add write
controls to `/township`, server push, production deployment, or G1/Phase G completion.

Planned at commit `150869e3`.

## Why this increment

- Plan 127 supplies a stable supervised listener, but its holder is immutable for the life of the
  process. There is currently nothing real for a server-push feed to announce.
- The shared WebSocket client is blocking request/response with no unsolicited-frame demultiplexer.
  Rewriting it for server push before a source can change would be speculative and would not create
  observable application progress.
- TLS/release packaging would deploy the read-only half before the functional write boundary is
  stable. Participant writes are the dependency-changing frontier.
- Existing TS/Tauri code already proves native key custody, local command/cap composition,
  persistence, outbox behavior, and app convergence through Plans 054-120. This server slice must
  preserve those proofs rather than moving custody into BEAM or claiming the real app uses the new
  relay yet.
- Receipt-free W4 remains blocked on M4 research. The iOS, physical-device, camera/LAN, and
  cross-device areas in `TOWNSHIP_BUILD_MAP.md` section 4a remain parked.

## Critical trust separation

Three identities must remain distinct:

1. The server transport identity authenticates the `/carrier` endpoint and never authors a
   Township operation.
2. The relay transport realm is allowlisted to submit frames. It is transport authorization, not
   civic authority.
3. The operation author is the public key inside the signed operation. The operation signature,
   hash, replica, dependency closure, in-log capability, and materialization-time authority decide
   what the operation can mean.

An authenticated relayer may forward an operation signed by another author. Binding relayer and
author would break ordinary signed-op forwarding and add no authority: the author signature is
self-certifying, replay is idempotent, and semantic capability/role checks remain downstream.

The server may persist the operation's signed public capability reference as part of the log. It
must not gain a separate participant cap store, private key, signing callback, command builder, or
authority policy.

## Architecture

### Opt-in relay configuration

Extend `LatticeCarrierServer.start_link/1` with `relay_realms: [realm]`, defaulting to `[]`.

- Every relay realm must be a non-empty string already present in `trusted_peers`.
- A non-empty relay set requires `source: {:path, path}` so acknowledged writes survive process and
  OS-process restart.
- `source: {:log, log}` remains a read-only injected/test source and cannot enable relay.
- Invalid realm/source combinations fail configured startup visibly.
- A trusted peer not in `relay_realms` retains Plan 127 frontier/pull access but receives the same
  `read_only` refusal for relay as for push/live.

The relay list is an access boundary, not an authority list. It controls who may spend server
resources delivering signed bytes; it does not decide whether a Township command is honored.

### One-op relay protocol

Add `Lattice.Carrier.WebSocket.relay/2` outside the generic `Lattice.Carrier` behaviour. Relay is an
asymmetric application operation, not bidirectional `sync/3` and not bulk carrier push.

After the existing signed session challenge, the client sends:

```text
{"type":"relay","op":<Lattice.Carrier.Wire op>}
```

The stable server:

1. requires an authenticated relay realm;
2. decodes exactly one op through `Lattice.Carrier.Wire.decode_op/1`;
3. applies it through `Lattice.Sync.deliver/2` / `Lattice.Log.accept/2`;
4. persists the resulting log before exposing the new in-memory state or acknowledging it; and
5. returns one existing wire-format acceptance report as `relay_result`.

The report distinguishes accepted, structurally quarantined, wrong-replica rejected, pending
missing-dependency, and duplicate/idempotent delivery. A validly signed but authority-invalid
Township command is structurally accepted here and remains semantically quarantined by
materialization. The server must not call `Township.Matter`, `Lattice.Authority`, or `Lattice.Reduce`
to pre-adjudicate it.

Malformed relay frames return a bounded coarse error. Persistence failure returns an unavailable
error while telemetry retains the internal reason; filesystem paths and operation bodies are not
sent to the peer. Existing `push`, `live`, status/state/shutdown, and unknown messages remain
refused.

### Process-restart durability

The holder serializes relay calls. For any delivery that changes the log (accepted or structural
quarantine), it writes a uniquely named temporary dump in the source directory and renames it over
the configured source. Only a successful rename advances holder state and returns the report.
Temporary files are removed on failure.

The holder retains the normalized source tuple in its state so persistence always targets the
source loaded at startup. Persistence is keyed on `new_log != old_log`, not on report labels: a
re-relayed bad-signature frame reports `already_quarantined` but does not rewrite an unchanged log.
An already-present valid op returns the existing all-empty `Sync.report()` and likewise performs no
write; that all-empty report is the explicit duplicate/idempotent acknowledgement.

This is process/OS-process restart durability, not a claim of database-grade transactions,
directory fsync, power-loss durability, replication, compaction, or backup. A failed write leaves
the old in-memory log observable and returns no success acknowledgement. A duplicate, rejected, or
pending op does not rewrite the source.

The Plan 127 `:rest_for_one` ordering remains: holder restart reloads the persisted source before a
replacement listener accepts traffic. Restart therefore cannot fall back to the original seed and
lose an acknowledged relay.

### Projection and oracle

`TownshipWeb.CarrierProjection` remains pull-only and unchanged at runtime. A second observer pulls
after the relay acknowledgement, verifies the operation again through `Lattice.Sync.deliver/2`, and
publishes a fresh read model through PubSub.

The cross-process acceptance scenario is generated through `Lattice.Sim`:

- persist a pre-command Township log;
- relay a participant-signed command created by the Sim scenario;
- pull it through a distinct observer/projection;
- compare materialized state, op ids, and semantic quarantine with Sim; and
- restart the server OS process and prove the acknowledged operation remains.

The relay client and observer use distinct authenticated transport realms. The server identity is
never an op author.

### Dependency graph

- `lattice_carrier_server` retains runtime dependencies only on `lattice_core`, Cowboy, and Jason.
- `lattice_web_socket` gains the reusable `relay/2` client request but no listener, application mod,
  or Township dependency.
- `township_web` gains no runtime dependency or write path; it observes via its existing test-only
  relation from the server app.
- The five source-level xref cycles remain the baseline.

## Public TDD seams

Only public boundaries are test surfaces:

1. `Lattice.Carrier.WebSocket.relay/2` plus `LatticeCarrierServer.start_link/1`: default and
   observer-only servers refuse relay; an explicitly authorized realm relays one signed op and a
   second connection pulls it.
2. Public relay reports and fresh pulls: malformed, bad-signature, wrong-replica,
   missing-dependency, duplicate, oversized, observer-realm, `push`, and `live` cases cannot create
   a new served op. Structurally quarantined bytes are reported honestly; semantic authority is not
   decided by the server.
3. Process/OS-process restart: an acknowledged path-backed relay survives supervised holder/server
   restart and replacement BEAM process startup. A forced persistence failure returns an error,
   leaves the old pull result intact, and is not resurrected after restart.
4. `TownshipWeb.CarrierProjection.subscribe/1` and `refresh/1`: a distinct observer pulls the
   relayed command and matches the Sim oracle, including one authority-invalid but signed command
   remaining a materialization quarantine rather than a server refusal.

Tests do not call holder callbacks, inspect GenServer state, match Ranch children, or use an
in-process fake transport. Source identity and durability are proven by production client pulls,
fresh-process restore, and Sim/read-model output.

## Scope

- Add opt-in relay-realm configuration and fail-closed path-source validation.
- Add one-op request/response relay to the production WebSocket client and stable server.
- Add structurally checked, atomic-rename path persistence and rollback-on-failure semantics.
- Add focused real-socket refusal, idempotency, persistence, and restart tests.
- Add one second-BEAM projection/Sim convergence and restart proof.
- Update the plan index, build map, architecture/status docs, and cumulative readiness contracts.

## Non-goals

- No server-initiated notification/subscription, unsolicited frame, transport demultiplexer, or
  server-push claim. Periodic/manual pull remains the feed.
- No generic inbound `push`, bulk sync, ephemeral `live`, or server-authored operation.
- No `/township` write control, Tauri UI integration, TS relay adapter, outbox drain change, or claim
  that a packaged/mobile app uses this relay.
- No participant private-key/capability custody, cap issuance, command construction, semantic
  authority decision, or server-side role policy.
- No mutable injected `{:log, log}` source, database, multi-writer transaction, fsync/power-loss
  claim, compaction, backup, multi-replica routing, throughput, rate limiting, TLS, public ingress,
  release packaging, or production deployment.
- No receipt-free primitive, W4 change, G1/Phase G completion, or `receipt_free? = true` claim.
- No change or new claim for Tauri onboarding/cap persistence, mobile secure-store strategy, real
  app convergence, iOS, physical devices, QR camera, LAN discovery, or cross-device exchange.

## STOP conditions

- Stop if the server signs/authors an op, stores a participant private key or out-of-log cap
  inventory, or invokes a Township command builder.
- Stop if transport relay authorization is described as civic/semantic authority.
- Stop if a non-relay trusted observer can relay, or if relay enables generic `push`/`live`.
- Stop if malformed/wrong-replica/missing-dependency delivery appears in the served op frontier.
- Stop if authority-invalid but structurally valid ops are rejected as an authority decision at the
  server rather than preserved for deterministic materialization quarantine.
- Stop if success is acknowledged before persistence, a failed persistence mutates observable
  in-memory state, or an acknowledged op disappears after process restart.
- Stop if relay is enabled for `{:log, log}` and restart silently loses acknowledged state.
- Stop if `township_web` gains participant custody, a runtime server dependency, or a write path.
- Stop if request/response relay is labeled server push, or this plan claims deployment, G1/Phase G,
  W4, Tauri/mobile, or parked-device completion.

## TDD plan

1. DEFAULT RED/GREEN: call the absent production `relay/2`; keep default and observer sessions
   read-only, then add only the one-op request and explicit relay-realm configuration needed for one
   authorized accepted op to appear in a second pull.
2. REFUSAL RED/GREEN: add malformed, bad-signature, wrong-replica, missing-dependency, duplicate,
   oversized, observer, push, and live cases through real sockets. Implement bounded report/error
   mapping without semantic authority logic.
3. DURABILITY RED/GREEN: require acknowledgement to update a path source atomically, survive
   supervised restart, and leave state unchanged when the public filesystem source path is
   temporarily replaced by a directory so rename fails. Restore the old source bytes before restart
   and prove the unacknowledged op is absent. Keep injected logs read-only.
4. REAL-PROCESS RED/GREEN: generate a Township command from Sim, relay it to a second BEAM server,
   pull/project it from a distinct observer, kill/restart the server, and require the same Sim state
   and op ids after recovery.
5. AUTHORITY RED/GREEN: relay one validly signed but authority-invalid Sim command; require a relay
   acceptance report and identical downstream semantic quarantine, proving the server did not
   adjudicate it.
6. DOCS RED/GREEN: add Plan 128 contracts and advance current markers while retaining every
   server-push, write-control/UI, custody, deployment, G1/W4, Tauri/mobile, and parked-area non-claim.
7. VERIFY: run focused server/client/projection/real-process tests, forced test/prod compilation,
   five-cycle xref baseline, both Phoenix-boundary Sobelow scans, bundle verification, Township
   browser suites, mobile readiness/strategy/frontend/app convergence, artifact immutability,
   `mix verify`, `mix check`, formatting, and diff checks.
8. REVIEW: obtain Claude Code reviews for this written plan, each RED/GREEN seam, persistence and
   real-process proof, authority separation, docs contract, and the exact release diff.

## TDD evidence

- DEFAULT: the first client/server contract failed with `UndefinedFunctionError` for the absent
  `Lattice.Carrier.WebSocket.relay/2`. The smallest GREEN added the explicit request and retained
  `read_only` for default, observer, generic `push`, and `live` sessions.
- AUTHORIZED RELAY: the first path-backed authorized scenario still returned `read_only`. The GREEN
  added validated `relay_realms`, serialized structural delivery, and persisted-before-ack holder
  state; a second authenticated connection then pulled the relayed operation.
- REFUSAL/IDEMPOTENCY: real-socket tests cover malformed, bad-signature, wrong-replica,
  missing-dependency, duplicate accepted, duplicate quarantined, oversized, observer, `push`, and
  `live` cases. Only changed logs rewrite the path; duplicate accepted returns the all-empty report.
- DURABILITY: a public filesystem rename failure returns `unavailable`, emits bounded internal
  telemetry, leaves the old pull result and source bytes intact, leaks no temporary file, and does
  not resurrect the unacknowledged operation after restart. An acknowledged operation survives a
  supervised server restart.
- REAL PROCESS/AUTHORITY: Sim supplies the participant-signed operation relayed to a second BEAM OS
  process. A distinct observer pulls the exact Sim op ids/read model before and after kill/restart;
  the server key is not an op author. A signed authority-invalid operation is structurally accepted
  and appears only in the downstream `:no_capability` materialization quarantine.
- DOCS: the Plan 128 contract first failed on the absent build-map claim. The GREEN advances the
  cumulative marker to plans 023-128 while preserving every UI write, server-push, custody,
  deployment, G1/Phase G, W4, and Tauri/mobile/real-app non-claim.

## Second opinion

- Claude ranked client-signs/server-relays ahead of server push and deployment after Plan 127.
- Claude found that server push is currently premature because the holder cannot change and the
  blocking request/response client has no unsolicited-frame demultiplexer.
- Claude found deployment orthogonal to functional dependency progress and kept W4 plus all
  section-4a Tauri/mobile/device areas blocked or parked.
- Claude recommended an opt-in one-op relay, second-observer/Sim convergence, and an explicit
  restart durability contract while keeping polling and all custody/non-claims intact.
- Claude's written-plan review returned `VERDICT: PROCEED`. It required four implementation details
  to be explicit: retain the source path in holder state, persist on actual log inequality rather
  than report tags, define duplicate relay as an all-empty report, and force persistence failure
  through the public filesystem rather than a holder test hook. The plan now pins all four.
- Claude's DEFAULT, authorized-relay, refusal/durability, and real-process/authority checkpoint
  reviews each returned `VERDICT: PROCEED`; the direct observer-pull author check it suggested was
  added before the real-process checkpoint closed.
- Claude's documentation review returned `VERDICT: PROCEED` after tracing all six public claims to
  implementation and behavioral tests. Its only non-blocking finding was this stale TDD ledger,
  now reconciled before the full release gates.
- Claude's exact-release-diff review returned `VERDICT: PROCEED` with no correctness, security,
  race, durability-overclaim, lifecycle, test-proof, documentation, or accidental-scope finding.
  Its three informational notes match explicit non-goals: no power-loss/fsync claim, internal
  holder construction is not a public seam, and trusted-relay rate limiting remains future work.

## Verification

- The complete `lattice_carrier_server` suite passes with 25 tests. Forced warnings-as-errors
  compilation passes in test and production environments; the generated production `.app` runtime
  list is standard OTP plus `cowboy`, `jason`, and `lattice_core`, with no test-only WebSocket or
  Township app dependency.
- Documentation/current-marker contracts pass: carrier server 2 tests, WebSocket 1 test, Township
  web 3 tests, core read-model/audit-bundle 4 tests, and mobile readiness 1 test.
- `mix xref graph --format cycles` reports the unchanged five-cycle baseline with no carrier-server
  cycle. Both Phoenix-boundary Sobelow scans exit 0.
- `mix lattice.township.verify_bundle --dir artifacts/township` passes and `artifacts/township`
  remains byte-clean.
- Browser gates pass: six static Township instrument cases, the existing real-carrier live case,
  the stable-server fresh/stale/fresh case, and the shared browser carrier E2E.
- Preserved app boundaries pass: mobile readiness, mobile secure-store strategy, 29 frontend shell
  contracts, and the full `app:convergence` chain through authoring, sync, onboarding ceremony,
  browser click-through, live BEAM, launched/packaged app, and installed deep-link smokes.
- Unexcluded `mix verify` and `mix check` each pass the complete umbrella with 330 tests and 25
  properties. Strict Credo exits 0 with no Plan 128 finding.
- `mix format --check-formatted` and `git diff --check` pass. Claude's exact-release-diff review
  returns `VERDICT: PROCEED`.

## Completion claim

Complete for this scoped increment. One explicitly authorized client-signed operation is
structurally delivered and persisted before acknowledgement, survives supervised and real
OS-process restart, and converges through a distinct pull-only observer to the Sim oracle. Refusal,
idempotency, failure rollback, authority separation, custody, dependency, browser, Tauri/mobile,
and public non-claim gates remain proven. Server push, `/township` write controls, production
deployment, receipt-free W4, and complete G1/Phase G remain subsequent build-map work.
