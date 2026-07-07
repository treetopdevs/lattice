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
