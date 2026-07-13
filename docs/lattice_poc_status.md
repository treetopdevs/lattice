# Lattice POC Status

## Checkpoint: Project Scaffold

- Files changed: root Mix umbrella, `apps/lattice_core`, `apps/lattice_server`, `apps/lattice_demo`.
- Command run: `mix new . --umbrella && mix new apps/lattice_core --sup && mix new apps/lattice_server --sup && mix new apps/lattice_demo --sup`, then `git init`.
- Result: scaffold created and `/Users/nicholas/develop/lattice` initialized as its own git repository.
- Blocker or remaining limitation: none.

## Checkpoint: Core Capability Plane

- Files changed: `apps/lattice_core/lib/lattice/**/*.ex`, `apps/lattice_core/lib/lattice.ex`.
- Command run: implementation edit pass.
- Result: core data structures, cap store, gateway, topology, audit, and movable process implemented.
- Blocker or remaining limitation: in-memory state only.

## Checkpoint: Demo Processes

- Files changed: `apps/lattice_demo/lib/lattice/demo/*.ex`, `apps/lattice_demo/lib/mix/tasks/*.ex`.
- Command run: implementation edit pass.
- Result: echo, secret, tab worker, deterministic WebSocket demo task, and browser server task implemented.
- Blocker or remaining limitation: demo processes are intentionally narrow.

## Checkpoint: WebSocket Boundary

- Files changed: `apps/lattice_server/lib/lattice/transport/web_socket*.ex`, `apps/lattice_server/lib/lattice_server*.ex`.
- Command run: implementation edit pass.
- Result: Cowboy JSON WebSocket boundary, static demo serving, and minimal real WebSocket client implemented.
- Blocker or remaining limitation: browser demo is a POC boundary, not production auth.

## Checkpoint: Browser Demo

- Files changed: `examples/browser_demo/*`.
- Command run: implementation edit pass.
- Result: browser client/page added.
- Blocker or remaining limitation: none for the browser POC.

## Checkpoint: Initial Validation

- Files changed: all implementation, docs, tests, scripts, and browser demo files.
- Command run: `mix deps.get`
- Result: succeeded. Resolved `cowboy 2.14.2`, `jason 1.4.5`, `cowlib 2.16.0`, and `ranch 2.2.0`.
- Blocker or remaining limitation: none.

## Checkpoint: Post-Review Completion Pass

- Files changed: `apps/lattice_core/test/lattice_core_poc_test.exs`, `apps/lattice_core/test_support/test_tab_client.exs`, `apps/lattice_server/test/web_socket_envelope_test.exs`, `apps/lattice_server/test/web_socket_integration_test.exs`, `apps/lattice_server/lib/lattice/transport/web_socket/client.ex`, `apps/lattice_demo/lib/mix/tasks/lattice.demo.ex`, `apps/lattice_demo/test_support/test_tab_client.exs`, `docs/acceptance_checklist.md`, `README.md`, `docs/lattice_poc_status.md`.
- Command run: implementation edit pass.
- Result: added explicit bridge-expiry coverage, asserted denied tab-to-tab traffic does not reach the target tab, added JSON boolean/null encoder coverage, added a real WebSocket integration test/client, converted the deterministic demo to WebSocket, removed the in-process runtime tab transport, removed non-runnable carrier files, and documented acceptance status.
- Blocker or remaining limitation: none; validation checkpoints below passed.

## Checkpoint: Final Formatting And Tests

- Files changed: formatted Elixir files.
- Command run: `mix format && mix test`
- Result: succeeded. `lattice_core`: 21 tests, 0 failures. `lattice_server`: 6 tests, 0 failures. `lattice_demo`: 3 tests, 0 failures.
- Blocker or remaining limitation: none.

## Checkpoint: Final WebSocket Demo

- Files changed: `scripts/lattice_poc_demo.sh`, `apps/lattice_demo/lib/mix/tasks/lattice.demo.ex`.
- Command run: `scripts/lattice_poc_demo.sh`
- Result: succeeded. Demonstrated tab A echo success, tab B stolen-cap denial, secret denial, mediated bridge success, tab disconnect, worker cleanup, and audit output over the real WebSocket boundary.
- Blocker or remaining limitation: none.

## Checkpoint: Final Browser Demo Smoke Test

- Files changed: `scripts/lattice_browser_demo.sh`, `examples/browser_demo/*`.
- Command run: `scripts/lattice_browser_demo.sh 4054`, `curl -fsS http://localhost:4054/ | head -n 5`, and in-app browser button flow.
- Result: succeeded. Static page served, browser connected over WebSocket, grant response arrived, allowed call returned `ok: true`, denied call returned `ok: false`.
- Blocker or remaining limitation: none for the POC browser path.

## Checkpoint: Port Argument Fix

- Files changed: `scripts/lattice_poc_demo.sh`, `apps/lattice_demo/lib/mix/tasks/lattice.demo.ex`, `README.md`, `docs/lattice_poc_status.md`.
- Command run: `mix format && mix test`, `scripts/lattice_poc_demo.sh`, `scripts/lattice_poc_demo.sh 4055`, `curl -fsS http://localhost:4055/ | head -n 5`, in-app browser button flow, `scripts/lattice_poc_demo.sh 4040`, and `curl -fsS http://localhost:4040/ | head -n 5`.
- Result: `scripts/lattice_poc_demo.sh 4040` now forwards the port and starts a long-running browser demo server at `http://localhost:4040/`.
- Blocker or remaining limitation: none.

## Checkpoint: Visual Two-Tab Story

- Files changed: `apps/lattice_server/lib/lattice_server/demo_hub.ex`, `apps/lattice_server/lib/lattice/transport/web_socket.ex`, `apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex`, `apps/lattice_server/lib/lattice_server/static_handler.ex`, `examples/browser_demo/index.html`, `examples/browser_demo/client.js`, `examples/browser_demo/styles.css`, `apps/lattice_server/test/web_socket_integration_test.exs`, `README.md`, `docs/unified_beam_plane_poc.md`, `docs/acceptance_checklist.md`, `docs/lattice_poc_status.md`.
- Command run: `mix format && mix test`, `scripts/lattice_poc_demo.sh`, `scripts/lattice_poc_demo.sh 4056`, `curl -fsS http://localhost:4056/ | head -n 8`, and in-app browser visual inspection.
- Result: browser demo now shows tab realms, central server plane, live server ledger, capability grant/call/deny events, audit counts, and an automatic two-tab bridge story over real WebSocket clients. Tests verify A->B and B->A mediated bridge events.
- Blocker or remaining limitation: the Codex in-app browser did not keep two visual tabs connected simultaneously during inspection, so the two-tab choreography was validated through real WebSocket integration tests; the page itself was visually inspected in the one-tab waiting state.

## Checkpoint: Browser Story Clarity Pass

- Files changed: `examples/browser_demo/index.html`, `examples/browser_demo/client.js`, `examples/browser_demo/styles.css`, `docs/lattice_poc_status.md`.
- Command run: `mix format`, `mix test`, `scripts/lattice_poc_demo.sh`, `scripts/lattice_poc_demo.sh 4057`, `curl -fsS http://localhost:4057/ | head -n 8`, in-app browser grant/call/deny flow, and a second real WebSocket client connected to the browser demo server for the mediated two-realm story.
- Result: succeeded. Manual calls are no longer auto-triggered after grant; each tab's controls name the local actor, the actor-aware route animation distinguishes self, peer, grant, deny, and bridge traffic, and the server audit stream now states owner, target, cap, gateway allow/refuse, and bridge intent in plain language.
- Blocker or remaining limitation: none for the browser POC; the automated visual smoke used the repository's real WebSocket client as the second realm while the page remains usable with two normal browser tabs.

## Checkpoint: Adversarial Stress Lab

- Files changed: `apps/lattice_stress/**/*`, `apps/lattice_core/lib/lattice.ex`, `apps/lattice_core/lib/lattice/cap.ex`, `apps/lattice_core/lib/lattice/cap_store.ex`, `apps/lattice_core/lib/lattice/gateway.ex`, `apps/lattice_core/lib/lattice/topology.ex`, `apps/lattice_server/lib/lattice/transport/web_socket.ex`, `apps/lattice_server/lib/lattice/transport/web_socket/client.ex`, `apps/lattice_demo/lib/lattice/demo/secret_server.ex`, `docs/stress_lab.md`, `README.md`, `package.json`, `package-lock.json`, `scripts/lattice_browser_e2e.mjs`, `.gitignore`, `docs/lattice_poc_status.md`.
- Command run: `mix deps.get`, `mix format`, `mix test`, `mix test apps/lattice_stress/test/browser_e2e_test.exs --only browser_e2e`, `npm install`, `npm run browser:e2e`, and `mix lattice.stress --tabs 8 --caps 16 --calls 120 --bridges 8 --concurrency 8` through the load-smoke test.
- Result: succeeded. Added adversarial authority tests, deterministic race tests, StreamData property tests, WebSocket abuse tests, failure semantics tests, lifecycle/load smoke, `mix lattice.stress`, and a real two-browser Playwright E2E check. The stress pass found and fixed Topology/CapStore lock inversion, slow tab delivery blocking Topology, malformed cap crashes, cap-id collision overwrite, and dead-pid cast false positives.
- Blocker or remaining limitation: the harness is local-node pressure and in-memory state remains volatile; CapStore/Audit crash behavior is fail-closed but not durable recovery.

## Checkpoint: Flagship Wallet/Graph Artifact

- Files changed: `apps/lattice_core/lib/lattice/flagship*`, `apps/lattice_core/lib/lattice/graph*`, `apps/lattice_server/lib/lattice_server/flagship_handler.ex`, `examples/flagship_demo/*`, `scripts/lattice_flagship_demo.sh`, docs, and focused tests.
- Command run: implementation edit pass.
- Result: added a browser-visible canonical story where a wallet realm issues one caveated cap to a planner tab, a $199 bookshop purchase succeeds, over-budget/wrong-vendor/stolen-cap/replay-after-revoke attempts fail, the wallet ledger proves denied operations did not reach the target process, and the same graph snapshot powers the UI plus JSON/Mermaid/DOT exports.
- Blocker or remaining limitation: the flagship UI uses polling JSON rather than WebSocket/SSE because clarity and reliability were prioritized for the research artifact.

## Checkpoint: Flagship Evidence Hardening

- Files changed: `.github/workflows/flagship.yml`, `scripts/lattice_verify_flagship.sh`, `Lattice.Flagship.Claims`, flagship UI files, HTTP/test coverage, and docs.
- Command run: implementation edit pass.
- Result: added a CI workflow that installs BEAM/Node/Playwright, runs the local flagship verification script, records the browser E2E, evaluates video acceptability, writes populated graph and claims artifacts, and uploads `output/playwright/` plus `output/flagship/`. The live inspector now has presenter-mode copy, numbered steps, richer node/edge details, selected-edge highlighting, a code-owned claims endpoint, and a claims JSON artifact.
- Blocker or remaining limitation: CI has not been observed on GitHub yet in this local run; the workflow is added for the next push or pull request.

---

# Lattice 2.0 — Replicas on a Capability-Attested Log

All 2.0 work lives in `apps/lattice_core/lib/lattice/` (alongside the reused v1
modules) and `apps/lattice_core/test/lattice2/`. Toolchain: Elixir 1.19.5 / OTP 28
(via asdf; the repo's mise config disables mise's erlang/elixir so asdf's working
OTP 28 + `mix` are used). Run mix with `~/.asdf/shims/mix`.

## Checkpoint: Phase 0 — Carry-forward (v1 baseline)
- Command: `mix test` (lattice_core).
- Result: v1 suite green (41 tests) before any 2.0 change; behavior 19 baseline.

## Checkpoint: Phase A — Log core
- Files: `lattice/{identity,op,dag,log,sync,net,clock}.ex`; `test/lattice2/log_sync_test.exs`.
- Behaviors: 1 (raw op-set convergence), 3 (idempotent sync), 4 (tamper rejection).
- Crypto verified on OTP 28: deterministic seeded Ed25519 (`:crypto.generate_key(:eddsa,
  :ed25519, seed32)`), sign/verify with tamper rejection, order-independent
  `Lattice.Canonical` bytes.
- Result: green.

## Checkpoint: Phase B — Replica + CRDTs + reduction
- Files: `lattice/crdt/{lww,or_set,causal_list}.ex`, `lattice/{replica,reduce,sim}.ex`,
  `lattice/demo/thread.ex`; `test/lattice2/{replica_reduce,crdt_property}_test.exs`.
- Behaviors: 1, 2 (delivery-order independence — byte-identical), 18 (same-path
  equivalence) + CRDT join-law property tests.
- Result: green. Surfaced and fixed two unrealistic property generators (reused element
  ids / non-unique LWW tags) that don't occur in the real system (ids are content
  hashes; tags are `{height, op_id}`).

## Checkpoint: Phase C — Authority + unified chain
- Files: `lattice/authority.ex`, `lattice/authority/delegation.ex`, evolved
  `lattice/cap.ex` (+`chain`/`replica`), `lattice/live.ex`;
  `test/lattice2/{authority,unified_chain}_test.exs`.
- Behaviors: 5 (cap-gated append), 6 (serialized authority / queue-through-holder),
  7 (offline-authoritative), 8 (stale-holder), 9 (double-transfer anomaly),
  10 (revocation), 16 (unified chain — keystone: one delegation authorizes a log
  append AND a live Gateway message; one revoke kills both).
- Result: green.

## Checkpoint: Phase D — Durable messaging + lifecycle
- Files: `lattice/{registry,materializer,promise}.ex`; wired into the supervision tree
  and `Lattice.reset!/0`; `test/lattice2/lifecycle_test.exs`.
- Behaviors: 11 (durable send, exactly-once, causal order), 12 (promise across
  dormancy, resolved from log), 13 (lifecycle monitors + permanent replica-wide
  tombstone), 14 (realm death + disk restore).
- Result: green.

## Checkpoint: Phase E — Succession, time travel, property suite
- Files: `lattice/{log,dag}.ex` (+`from_ops`, `reachable` fix, `heights`),
  `Lattice.state_at/3`; `test/lattice2/{succession_time_travel,convergence_property}_test.exs`.
- Behaviors: 15 (succession + returning-holder stale quarantine; premature succession
  quarantined), 17 (time travel via causal frontier), 18, 19.
- Fixed a real bug in `Dag.reachable/2` (pre-seeded accumulator skipped exploring the
  frontier ops' deps, yielding a size-1 slice) found by the time-travel test.
- Property suite (StreamData, 3 realms, randomized commands/transfers/partitions/
  delivery, seeded): (a) convergence, (b) single-writer authority at each honored op's
  causal position, (c) byte-identical re-run, (d) identical quarantine sets.

## Validation loop
- `mix format` — clean.
- `mix test` (lattice_core) — **9 properties, 67 tests, 0 failures.** Re-run across
  seeds 1/7/99/2024/555 and 12345 — stable.
- `elixir scripts/lattice2_demo.exs` and `mix run scripts/lattice2_demo.exs` — runs
  end-to-end with narrated output (collaborate → partition → divergent posts/edits →
  holder locks offline → tab's lock quarantined + audited → heal/merge → queued
  request replayed → transfer → offline-authoritative → succession after dormancy →
  returning holder's stale lock quarantined → `state_at` replay).

## Behavior coverage (all 19 + property suite)
| # | Behavior | Test |
|---|---|---|
| 1 | Convergence | log_sync, replica_reduce |
| 2 | Delivery-order independence | replica_reduce, crdt_property |
| 3 | Idempotent sync | log_sync |
| 4 | Tamper rejection | log_sync |
| 5 | Cap-gated append | authority |
| 6 | Authoritative serialization | authority |
| 7 | Offline-authoritative | authority |
| 8 | Stale-holder quarantine | authority |
| 9 | Double-transfer anomaly | authority |
| 10 | Revocation | authority |
| 11 | Durable send | lifecycle |
| 12 | Promise across dormancy | lifecycle |
| 13 | Lifecycle monitors / tombstone | lifecycle |
| 14 | Realm death + resurrection | lifecycle |
| 15 | Succession | succession_time_travel |
| 16 | Unified chain (keystone) | unified_chain |
| 17 | Time travel | succession_time_travel |
| 18 | Same-path equivalence | replica_reduce |
| 19 | v1 invariants preserved | lattice_core_poc_test (v1 suite) |
| — | Property suite (a–d) | convergence_property |

## Failing property seeds
None observed across seeds 1, 7, 99, 555, 2024, 12345 (100 runs each).

## Remaining limitations (honest boundaries)
- **No encryption** — signed, not sealed (see `threat_model_v2.md`). Plaintext bodies;
  Keyhive E2EE is out of scope.
- **No compaction** — a Replica's identity is its entire op-log; reduction re-folds all
  ops and sync still starts from full id sets. The compaction feasibility spike is done,
  and M2 adds carrier membership acknowledgements, but production snapshot-aware
  materialization/GC is not built. First scaling cliff (`path_to_real.md`, ADR 0006).
- **Browser/AtomVM parity is not done** — signed bytes now use `Lattice.Canonical`
  instead of pinned BEAM external-term bytes, but non-BEAM realms still need native
  implementations of the canonical subset and `Lattice.Carrier.Wire` (ADR 0001).
- **Succession dormancy = absence of heartbeats**, not a true liveness oracle (ADR 0004).
- **Public API name clashes** — v1 already defines `Lattice.call/3`, `Lattice.grant/4`,
  `Lattice.cast/3`. The 2.0 promise-`call`/capability-`grant` are reached via
  `Lattice.Registry` and in-log delegation ops rather than re-binding v1 names; the
  non-clashing 2.0 functions (`materialize`, `tombstone`, `monitor`, `send_durable`,
  `await`, `state_at`, `go_dormant`) are on the `Lattice` facade. Nothing assumes
  in-process locality.
- **Stretch goals**: ~~second OS-process BEAM node~~ — **done** by the plan-010
  carrier spike (`apps/lattice_node_spike`, ADR 0005): two BEAM OS processes converge
  over a real WebSocket, byte-identical to the `Lattice.Sim` oracle. Still not done:
  production snapshot compaction and a native browser/AtomVM realm.

## Checkpoint: M1 Close-Out Countersign

- Files changed: `docs/adr/0001-canonical-encoding.md`,
  `apps/lattice_core/test/lattice2/lifecycle_test.exs`, `docs/lattice_poc_status.md`.
- Behaviors: 1-19 unchanged; D-A1 doc delta closed in ADR 0001.
- Command run: `~/.asdf/shims/mix deps.get && ~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test && ~/.asdf/shims/mix run scripts/lattice2_demo.exs`.
- Result: succeeded on 2026-07-05. `mix test` used ExUnit seed 366664 and passed:
  `lattice_core` 13 properties, 123 tests; `lattice_server` 15 tests;
  `lattice_carrier_spike` 4 tests; `lattice_demo` 3 tests; `lattice_stress` 1 property,
  52 tests with browser/load tags excluded; `lattice_node_spike` 1 test. The narrated
  Lattice 2.0 demo completed through partition, quarantine, heal/merge, transfer,
  succession, stale-holder quarantine, and `state_at` replay.
- Blocker or remaining limitation: none for M1 close-out; M2 work followed as documented
  in `docs/path_to_real.md` and ADRs 0005/0006.

## Checkpoint: M2 Real Carrier Hardening

- Files changed: `apps/lattice_core/lib/lattice/canonical.ex`,
  `apps/lattice_core/lib/lattice/carrier/*`, `apps/lattice_core/lib/lattice/sync*`,
  `apps/lattice_core/lib/lattice/browser_log_store.ex`, `apps/lattice_node_spike/*`,
  `examples/atomvm_tab/log-store.js`, docs, and focused tests.
- Behaviors: existing Lattice 2.0 log, authority, reduction, and carrier semantics preserved;
  op/delegation signed bytes no longer depend on BEAM external-term encoding.
- Command run: `~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test`,
  `~/.asdf/shims/mix credo --strict`, and
  `(cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit)`.
- Result: succeeded on 2026-07-05. M2 adds canonical cross-runtime signed bytes,
  centralized JSON-safe carrier wire frames, explicit trust anchors plus signed
  challenge/response sessions, deterministic backoff helpers, dependency-closed partial
  sync shapes, bounded push batches, membership acknowledgements for future compaction GC,
  and a browser log-store payload plus IndexedDB adapter contract.
- Blocker or remaining limitation: M2 is a hardened carrier substrate, not the full
  productized runtime. Native browser/AtomVM peers still need their own
  `Lattice.Canonical`/`Lattice.Carrier.Wire` implementations and production compaction
  still needs snapshot-aware `Authority`/`Reduce`, GC coordination, and snapshot trust.

## Checkpoint: Township G1 Real Carrier Acceptance

- Files changed: `apps/lattice_node_spike/lib/lattice_node_spike/peer.ex`,
  `apps/lattice_node_spike/lib/lattice_node_spike/township_scenario.ex`,
  `apps/lattice_node_spike/priv/peer_node.exs`,
  `apps/lattice_node_spike/test/township_carrier_test.exs`, Township-facing docs.
- Behaviors: Township W0-W3 run over two physical BEAM OS processes through the reusable
  `Lattice.Carrier.WebSocket`, while `Lattice.Sim` remains the oracle. Plan 125 moved the client
  adapter out of spike ownership without changing this acceptance proof.
- Command run: `~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs`.
- Result: succeeded on 2026-07-07. The G1 test proves deterministic prefix agreement,
  wrong-key session rejection, partition/diverge/heal convergence, byte-identical
  materialized state, identical `:not_holder` authority quarantine for the stale clerk
  action, idempotent re-sync, and clean peer shutdown.
- Blocker or remaining limitation: G1 is accepted for two BEAM nodes. Non-BEAM
  browser/phone realms still depend on canonical CBOR/ADR-P08 work, and W4 remains
  stubbed until the M4 receipt-free primitive exists.

## Checkpoint: Township Read-Only Carrier Projection

- Files changed: `apps/township_web/lib/township_web/carrier_projection.ex`, the
  instrument LiveView/template and Vue hook, configured supervision, focused tests,
  `apps/lattice_node_spike/test/township_instrument_projection_test.exs`, and the live
  Playwright harness.
- Behaviors: when configured, the connected instrument periodically advertises and
  pulls from an authenticated real WebSocket peer, validates arrivals with
  `Lattice.Sync.deliver/2`, derives the shared read model/replay, and publishes explicit
  fresh, stale, connecting, or unavailable states through `TownshipWeb.PubSub`.
- Command run: `~/.asdf/shims/mix test
  apps/lattice_node_spike/test/township_instrument_projection_test.exs` and
  `npm run township:instrument:live-e2e` alongside the focused web suites.
- Result: Plan 126 proves the read-only WebSocket-to-PubSub-to-LiveView path against a
  second BEAM OS process and in a real browser. The observer starts from an empty log,
  never calls carrier push, and withholds authoritative values on pre-first-pull failure.
- Blocker or remaining limitation: this is periodic request/response polling, not server
  push. It adds no participant capability, write control, stable listener ownership,
  production TLS/deployment, full G1/Phase G completion, or receipt-free W4. It does not
  change or newly prove Tauri onboarding/cap persistence, mobile secure-store custody,
  or real app convergence.

## Checkpoint: Stable Read-Only Carrier Server

- Files changed: `apps/lattice_carrier_server`, the Plan 127 second-BEAM and browser
  harnesses, umbrella boundary docs, and focused contracts.
- Behaviors: a supervised embedded Ranch/Cowboy listener loads one injected or persisted
  signed log, authenticates an allowlisted transport realm against the exact replica and wire
  version, and serves only authenticated frontier and missing-op pull requests. Invalid sources
  fail closed; disconnect, denied requests, and listener/server restart do not mutate the source.
- Commands run: the focused `lattice_carrier_server` suite and
  `npm run township:instrument:server-e2e`, alongside the umbrella verification gates recorded
  in Plan 127.
- Result: Plan 127 proves the production carrier client and Plan 126 projection can consume the
  same source through a non-fixture server. A second BEAM OS process proves loss, stale retention,
  restart, and fresh recovery. The connected browser proof uses deterministic manual refreshes
  around an in-process server restart; it does not prove autonomous polling in the browser.
- Blocker or remaining limitation: the app owns a stable read-only listener boundary, not a
  production deployment. It has no TLS/public ingress packaging, inbound push, server-push
  subscription, participant identity/key/capability custody, write controls, or receipt-free W4.
  It does not complete G1/Phase G or change the established Tauri/mobile/app-convergence gates.

## Checkpoint: Durable Client-Signed Carrier Relay

- Files changed: `apps/lattice_carrier_server`, the reusable
  `Lattice.Carrier.WebSocket.relay/2` request, focused real-socket and persistence tests, and the
  second-BEAM Township projection proof recorded in Plan 128.
- Behaviors: a path-backed server may opt selected trusted transport realms into relaying one
  already-signed operation. Structural delivery is serialized, a changed log is atomically
  persisted before acknowledgement, and only then does the holder expose it to frontier and pull
  requests. Duplicate, rejected, pending, and unchanged quarantined deliveries do not rewrite the
  source; a failed persistence leaves the old in-memory and restart state observable.
- Oracle: a distinct authenticated observer pulls a Sim-generated participant operation before and
  after server OS-process restart and obtains the same op ids and Township read model. A signed but
  authority-invalid operation is structurally accepted by the relay and remains quarantined by the
  downstream materializer, proving that semantic authority remains a materialization-time decision.
- Blocker or remaining limitation: this is an opt-in one-op request/response relay, not a generic
  push API or server-push feed. It adds no `/township` write control, participant private-key or
  separate capability custody, production deployment, G1/Phase G completion, or receipt-free W4.
  Plan 128 does not change or newly prove Tauri onboarding/cap persistence, mobile secure-store
  custody, or real app convergence.

## Checkpoint: Packaged Tauri Stable-Relay Convergence

- Files changed: the TypeScript carrier relay/drain API, Tauri pairing submission ceremony,
  production-server subprocess support, Sim fixture and fresh-BEAM projection verifier, and the
  separate packaged stable-relay onboarding smoke recorded in Plan 129.
- Behaviors: omitted pairing mode remains generic push; explicit relay mode survives env, native KV,
  handoff/QR/deep-link ingress, equality, and UI confirmation. Relay drains one causally ordered
  signed frame at a time, retains quarantine/reject/pending entries, independently confirms empty
  duplicate responses, and preserves the full local outbox across later request failure.
- Oracle: the actual packaged macOS Tauri app pulls the Sim prefix and resident delegation from the
  production eight-argument stable server, authors the exact full Sim-generated post frame through
  native key custody, relays it, and drains the accepted outbox. After a server OS-process kill and
  restart from the same path and port, a distinct fresh-BEAM `TownshipWeb.CarrierProjection`
  matches Sim op ids, read model, and causal replay; the server key is not an operation author.
- Gates: `carrier:relay`, `carrier:relay-sync`, `stable:relay:contract`, and
  `tauri:stable-relay:onboarding:smoke`; the older `tauri:onboarding:smoke` remains a separate
  generic-push regression. The fast socket contract also proves observer relay refusal,
  relay-realm generic-push refusal, idempotency, and structural acceptance plus downstream
  authority quarantine.
- Commands run: the complete TS client and shell contract matrices; `npm run app:convergence`;
  static/live/stable Township browser gates plus shared browser E2E; bundle verification and
  immutability; forced test/prod warnings-as-errors compilation; xref cycles; both boundary
  Sobelow scans; pinned-OTP-28 `mix verify` and `mix check`.
- Result: succeeded on 2026-07-11. Both packaged carrier modes pass, the five-cycle xref baseline is
  unchanged, and the complete umbrella passes 331 tests plus 25 properties with strict Credo.
- Blocker or remaining limitation: Plan 129 reuses the native custody and mobile secure-store
  strategy unchanged; it adds no mobile relay/device claim, new secure-store implementation,
  server push, `/township` participant write path, server-held participant key/cap inventory,
  production TLS/deployment, G1/Phase G completion, or receipt-free W4.

## Checkpoint: LiveView-to-Tauri Participant Post Handoff

- Files changed: the strict Elixir/TypeScript action-intent contract, `/township` preparation form,
  shared Tauri participant deep-link dispatcher and review state, the Ubuntu cross-surface gate,
  packaged macOS action-handoff smoke, and flagship workflow wiring recorded in Plan 130.
- Behaviors: only a fresh carrier-backed LiveView may prepare one bounded, versioned, unsigned
  `post` request from `provenance.replica`. Deep-link ingress stages it separately from the local
  draft and performs no signing, KV/log/outbox mutation, pairing save, or carrier connection. The
  app validates the saved pairing replica and requires separate Use request, Post, and Sync actions;
  only then do its existing local cap/frontier, native signer, durable outbox, and relay seams run.
- Oracle: both gates consume a `Lattice.Sim` fixture rather than reconstructing the expected
  operation in Phoenix or TypeScript. They prove the authored frame is exact, the relay persists it,
  the outbox drains, the original LiveView/Vue projection equals Sim, and a distinct fresh BEAM
  observer still equals Sim after a same-path/port server restart. After the app-authored post is
  proven, the Ubuntu gate also relays the fixture's separately signed authority-invalid control and
  positively observes its `no_capability` quarantine in LiveView, Vue replay, and the fresh-process
  verifier; quarantine equality is not an empty-vs-empty assertion.
- Gates: `npm run township:action-handoff:e2e` is Ubuntu-running and wired into the flagship script
  and workflow. `npm run tauri:action-handoff:smoke` delivers the real LiveView-produced URL through
  LaunchServices to a freshly built release-mode app with native key/KV custody. Plan 131 now runs
  it as a mandatory hosted macOS lane alongside packaged stable-relay onboarding.
- Result: the focused action/LiveView, dispatcher/frontend/typecheck, Ubuntu Playwright, stable
  server regression, and freshly rebuilt packaged macOS gates passed on 2026-07-12. The full
  release matrix passed with 336 tests and 25 properties under pinned OTP 28, complete client and
  shell contracts, packaged app convergence, all browser/flagship gates, immutable bundle
  verification, warnings-as-errors compilation, the unchanged five-cycle xref baseline, both
  Sobelow boundaries, strict Credo, exact lockfile installation, and clean diff whitespace.
- Blocker or remaining limitation: this is the first participant `post` handoff, not a generic
  command bus, server push, broader participant controls, signed intent receipt, duplicate-op
  guarantee, production deployment, full G1/Phase G completion, mobile/device proof, new secure
  store, or receipt-free W4. Phoenix never receives participant keys, caps, delegations,
  dependencies, signatures, or authoring authority.

## Checkpoint: Packaged macOS Convergence CI Gate

- Files changed: the flagship workflow, its anti-decay Plan 131 contract, Tauri Linux build
  prerequisites for the existing native-core job, and cumulative status documentation.
- Behaviors: a non-optional `macos-15-intel` job installs pinned BEAM/Node/esbuild/Playwright and
  lockfile dependencies, rebuilds the shared client, then executes both unchanged packaged smokes.
  It has no `continue-on-error`, platform skip, stale-bundle reuse, or app-build bypass.
- Oracle: stable-relay onboarding and LiveView action handoff still consume their existing Sim
  fixtures and prove native signing/KV custody, durable acknowledgement, restart recovery, exact
  operation/state equality, and redacted evidence through actual app bundles.
- Gates: the Plan 131 ExUnit contract pins the runner, both smoke commands, real-build posture,
  root/client/shell setup, and absence of soft failure. Hosted run `29180961767` passed
  `Packaged macOS convergence`, `Unit + property suite`, and `Verify flagship artifact` on commit
  `85b2b3bd1b2c2a7b81b06aace61ec3c2b977ea2a`.
- Result: both real packaged macOS convergence smokes are CI-enforced. The first hosted run exposed
  missing root Phoenix asset dependencies and longstanding Ubuntu Wry build prerequisites; both
  were repaired without weakening the smokes or native tests, and the corrected rerun was green.
- Blocker or remaining limitation: Plan 131 adds no runtime feature, server push, broader
  participant control, deployment, Linux packaged-app/GUI result, mobile/device proof, secure-store
  change, G1/Phase G completion, or receipt-free W4.

## Checkpoint: Authenticated Carrier Availability Feed

- Files changed: the durable holder subscription registry, authenticated Cowboy feed protocol,
  active-once BEAM WebSocket request/notification demultiplexer, carrier subscription wrapper,
  push-assisted `TownshipWeb.CarrierProjection`, rendered provenance, and the Plan 132 real-socket,
  second-BEAM, and packaged browser gates.
- Behaviors: authenticated peers may `subscribe` and `unsubscribe`; a changed path-backed log is
  persisted before the holder advances its restart-stable generation and emits a bounded,
  coalesced `ops_available` hint. Each subscriber has at most one outstanding holder message, and
  acknowledgment returns the latest durable generation before the frame timer flushes. The hint is
  routed independently of request replies and wakes the existing verified
  frontier/pull/`Sync.deliver`/read-model path. It never materializes an operation directly. Close
  events stale the current projection, clear the old subscription reference, and
  enter bounded reconnect/backoff while the 60-second periodic poll remains a backstop. The owner
  preallocates a secret pending ref before the worker starts, so an early first-connect/reconnect hint
  queues one trailing pull; epoch-discarded workers close their private connection.
- Oracle: the first post converges with `server_push` provenance before the safety poll can run and
  matches `Lattice.Sim` in op ids, read model, and causal replay. Restarted subscriptions are re-proven by a second pushed generation after persisted reconnect recovery, both in the real
  second-BEAM test and through the packaged LiveView/Vue browser gate.
- Gates: focused holder/server/demultiplexer/projection suites; the second-BEAM availability-feed
  test; TypeScript typecheck; and `npm run tauri:action-handoff:smoke` with a freshly built app for
  final acceptance. Cumulative build-map contracts now run through plans 023-133.
- Result: the bounded availability protocol, verified-pull convergence, restart recovery, and
  post-restart re-subscription proofs are implemented. Hosted implementation run `29188555667` and
  branch-tip closure run `29189290561` both passed the flagship artifact, unit/property, and real
  packaged macOS convergence jobs.
- Blocker or remaining limitation: Plan 132 itself adds no direct TypeScript subscription,
  pushed-op/state materialization, broader participant controls, participant custody, mobile
  secure-store change, TLS/public deployment, complete G1/Phase G claim, or receipt-free W4. The
  subsequent direct-TypeScript substrate is recorded separately below.

## Checkpoint: Direct TypeScript Carrier Availability Feed

- Files changed: `clients/lattice-client/src/carrier.ts`, its deterministic fake-socket feed
  contract, the headless stable-server feed contract beside the Tauri shell, package scripts,
  hosted Ubuntu workflow steps, and cumulative Plan 133 documentation contracts.
- Behaviors: `CarrierWebSocketClient` permits one atomic request in flight and reserves
  `ops_available` for a pre-registered typed subscription route. The baseline remains exactly the
  `subscribe_result`; a newer pre-baseline hint survives in a latest-only mailbox. At most one
  latest availability and one `next()` waiter are retained. Duplicate generations coalesce;
  regression, malformed input, unsolicited replies, transport failure, and close tear down pending
  work and the old subscription fail closed. Unsubscribe is idempotent after its reply.
- Oracle: the real stable server emits the first hint before any test-controlled pull. Every
  subsequently pulled carrier frame passes canonical hash and Ed25519 signature verification, and
  sorted ids equal the Sim-derived post oracle. Duplicate relay is silent. Same-path restart
  preserves the baseline generation, rejects the old subscription, and a replacement subscription
  observes a second hint whose verified pull equals the restart Sim oracle.
- Gates: `npm run carrier:feed`, both TypeScript typechecks, and `npm run feed:contract` are the
  focused local seams. The existing `Unit + property suite` job installs both workspaces, runs the
  fake contract, rebuilds the shared client, and runs the live stable-server contract as hard steps.
- Result: implementation and focused fake/live gates are green. Full local regression is green at
  374 tests plus 25 properties, every shared-client script, both TypeScript typechecks, the complete
  shell `app:convergence` matrix, warning-free forced test/production compiles, unchanged xref,
  Sobelow, and workflow lint. Final exact-worktree Claude review is green with no blocker, high, or
  medium finding. Hosted implementation run `29192642981` is green across the flagship artifact,
  unit/property suite (including both new TypeScript feed gates), and packaged macOS convergence.
  Plan 133 status is `DONE`.
- Blocker or remaining limitation: No reactive Tauri/Vue app feed loop. Plan 133 changes no
  participant key, capability, pairing, onboarding, outbox, native storage, or mobile secure-store
  custody; it adds no pushed operation/state materialization, broader participant controls,
  TLS/public deployment, complete G1/Phase G claim, or receipt-free W4.

## Checkpoint: Reactive Packaged Tauri Availability Feed

- Files changed: the mandatory shared-sync operation verifier, structural frame decoder, reactive
  read-only Township refresh/controller, dynamic Vue matter projection and redacted DOM-digest
  trace, full Sim base oracle, headless lifecycle contract, real packaged macOS feed smoke,
  package/workflow gates, and cumulative Plan 134 documentation contracts.
- Behaviors: every pulled frame passes canonical hash and Ed25519 verification before conversion,
  integration, persistence, or shared-sync submission. A saved pairing opens one authenticated
  observer subscription; its baseline triggers initial convergence, later generations coalesce to
  one active refresh plus one latest trailing refresh, bounded reconnect retains the last verified
  matter, concurrent pairing replacements close and await the obsolete epoch, and unmount aborts
  persistence and later callbacks. Only a `fresh` projection replaces the rendered Vue matter.
- Oracle: the real packaged `Township.app` runs against the stable path-backed carrier while a
  separate resident identity relays two Sim-authored posts around a same-path server restart. DOM
  attributes and ordered SHA-256 commitments to visible proceedings, persisted semantic ids, and
  raw delegation-frame ids equal the independent `Lattice.Sim` base, `afterPost`, and
  `afterRestartPost` projections in strict trace order without recording raw proceedings content.
- Gates: `npm run carrier:relay-sync`, `npm run carrier:township:live`,
  `npm run feed:app:contract`, both TypeScript typechecks, the existing direct feed contract, and
  `npm run tauri:feed:smoke` are locally green. Complete `app:convergence`, the browser instrument
  and action-handoff lanes, Rust native tests, and flagship Worker/video/artifact verification pass.
  Pinned OTP 28 `mix verify` and `mix check` each pass the full umbrella; warning compiles, xref,
  both Sobelow boundaries, actionlint, formatting, and diff checks are green. The headless
  controller and third fresh-build packaged smoke are wired as hard flagship steps.
- Hosted implementation run `29210581826` is green at
  `bfe8bcf2c2d3e7276ba92922f6e991922992b1c2`. `Verify flagship artifact` completed in 3m28s,
  `Unit + property suite` completed in 4m34s, and `Packaged macOS convergence` completed in 8m16s;
  all three hard packaged stable-relay onboarding, action-handoff, and reactive-feed steps passed.
- Result: Full local regression is green at 375 tests plus 25 properties. The RED/GREEN
  implementation and real packaged restart gate pass. Reactive refresh never submits or compacts
  the authored outbox, no automatic Sync trace appears, raw action/proceedings content stays out of
  native trace, and no operation is authored by the observer identity. Final exact-worktree Claude
  review is green with no blocker, high, or medium finding. Plan 134 status is `DONE`.
- Blocker or remaining limitation: no mobile secure-store implementation change, mobile/device
  result, automatic participant publication, broader participant controls, production ingress/TLS
  deployment, complete G1/Phase G claim, or receipt-free W4.

## Checkpoint: Versioned Clerk Status Action Handoff

- Files changed: the exact v2 action-intent producer/decoder fixture, fresh-only LiveView status
  preparation, shared participant dispatcher, command-specific Tauri review and signing ceremony,
  Sim clerk fixture, dedicated packaged smoke, fast shell contracts, flagship wiring, and cumulative
  Plan 135 documentation contracts.
- Behaviors: v1 stays post-only. A fresh verified open matter prepares close and a locked matter
  prepares reopen; client parameters cannot choose the command. The app stages and accepts the
  request without side effects, signs against the validated pairing replica through the existing
  native-custody path, leaves one frame in the local outbox, and publishes only through a separate
  explicit Sync. A no-cap resident fails locally before signing, KV writes, or relay.
- Oracle: the real installed app and a separate LiveView observer converge through Sim-equal
  Open -> Locked -> Open against the stable path-backed relay. The smoke proves exact frames,
  explicit outbox drain, fresh reactive projections, redaction, and no server-authored operation.
- Gates: focused Elixir, TypeScript, Vue, and Plan contracts are green.
  `npm run tauri:clerk-action-handoff:smoke` is green when run standalone, and hard unit/packaged workflow
  steps are wired without a second hosted Tauri build. Full local regression is green at 378 tests plus 25 properties,
  complete shell/browser/flagship convergence, warnings-as-errors, xref, both Sobelow scans,
  actionlint, formatting, diff hygiene, and 23 Rust tests. Hosted implementation run `29216789652` is green at
  `6a55a91ad82ccc30cc52ed09142864b8d76c1bb4`: flagship completed in 3m19s, unit/property in
  4m14s, and packaged macOS in 11m39s with all four packaged steps green.
- Result: Plan 135 status is `DONE`; local and hosted evidence establish the scoped versioned
  clerk-status custody seam.
- Blocker or remaining limitation: no automatic authored-frame publication, mobile secure-store
  implementation, mobile/device result, member/delegation command bus, production ingress/TLS
  deployment, complete G1/Phase G claim, or receipt-free W4.

## Checkpoint: Versioned Field-Edit Action Handoff

- Files changed: the exact v3 title/summary action-intent producer and decoder fixtures,
  fresh-only LiveView field preparation, shared participant dispatcher, command-specific Tauri
  review and signing ceremony, multi-realm stable-server test harness, Sim field fixture,
  dedicated packaged smoke, fast shell contracts, workflow gate, and cumulative Plan 136 docs.
- Behaviors: v1 remains post-only and v2 remains clerk-status-only. A fresh instrument prepares
  `set_title` or `set_summary`; its server handler fixes the command despite client parameters.
  The app stages and accepts the request without storage, signing, draft replacement, or network
  activity, rechecks the saved replica before native-custody signing, leaves the exact frame in
  the local outbox, and publishes only through a separate explicit Sync. A post-only participant
  fails both field commands locally before native signing or KV writes.
- Oracle: the real installed app signs its resident summary from the shared base frontier, keeps
  that Sim-equal frame byte-identical while a distinct clerk relay publishes a concurrent summary,
  and then converges the stable source, Tauri feed, and LiveView to Sim's contested LWW result only
  after explicit Sync. The same app repeats the inert, pending, Sync, and three-surface convergence
  ceremony for title without server or observer authoring.
- Gates: focused Elixir, TypeScript, Vue, Plan, and no-cap contracts are green. Full local regression
  is green at 383 tests plus 25 properties, complete app/browser/flagship convergence,
  warnings-as-errors, the unchanged five-cycle xref baseline, both Sobelow scans, actionlint,
  formatting, diff hygiene, and 23 Rust tests. Final exact-worktree Claude review and its focused
  follow-ups returned `PROCEED` with no blocker, high, or medium finding.
- Hosted implementation run `29223172342` is green at
  `0382f96b582b4efd9a751b8b81c76be58f719691`. `Verify flagship artifact` completed in 3m49s,
  `Unit + property suite` completed in 4m30s, and `Packaged macOS convergence` completed in 11m24s.
  Stable onboarding, unchanged post, no-build clerk, no-build field edit, and reactive feed all
  passed in the required order.
- Result: Plan 136 status is `DONE`; local and hosted evidence establish the scoped versioned
  field-edit custody seam and contested convergence proof.
- Blocker or remaining limitation: no automatic authored-frame publication, mobile secure-store
  implementation, mobile/device result, roster/delegation/revocation/succession command bus,
  production ingress/TLS deployment, complete G1/Phase G claim, or receipt-free W4.
