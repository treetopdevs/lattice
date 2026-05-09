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
