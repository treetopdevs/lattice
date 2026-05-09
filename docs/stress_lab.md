# Lattice Stress Lab

The stress lab attacks the POC instead of expanding the framework surface. Its
core invariant is:

> A tab gains authority only through an explicit, live, unexpired, unrevoked,
> correctly scoped capability issued to that exact tab.

## What It Runs

- Adversarial authority tests for forged, stolen, revoked, expired, exhausted,
  malformed, cross-tab, raw pid/name, framework-internal, collision, reconnect,
  and SecretServer attempts.
- Race tests for call/revoke, call/disconnect, call/eject, bridge expiry,
  concurrent use-limit exhaustion, worker cleanup, bridge creation while a tab
  disconnects, bridge revocation in flight, MovableProcess disconnect, worker
  crash/eject, and CapStore grant/revoke pressure.
- Property tests using StreamData random command sequences.
- WebSocket abuse tests for malformed JSON, oversized input, malformed cap ids,
  mismatched target overrides, fake grant targets, slow tab-side clients, and
  socket disconnect replay.
- Failure semantics tests for crashed server targets, CapStore, Audit,
  SecretServer, and tab transports.
- A load/soak harness exposed as `mix lattice.stress`.
- A Playwright two-browser E2E script that opens two real browser tabs and
  verifies the actor-aware visual authority story.

## Commands

Default deterministic suite:

```sh
mix deps.get
mix test
```

Load harness:

```sh
mix lattice.stress --tabs 500 --caps 2000 --calls 50000 --bridges 1000
```

Smaller local smoke:

```sh
mix lattice.stress --tabs 25 --caps 100 --calls 1000 --bridges 25 --concurrency 16
```

Browser E2E:

```sh
npm install
npm run browser:e2e
mix test apps/lattice_stress/test/browser_e2e_test.exs --only browser_e2e
```

The browser E2E defaults to installed Google Chrome via Playwright's `chrome`
channel, then falls back to Playwright-managed Chromium if available. Set
`PLAYWRIGHT_CHANNEL` to force a channel. If neither installed Chrome nor a
Playwright browser is available, run `npx playwright install chromium`.

## Evidence Rules

For denied or invalid operations, tests assert both:

- the caller receives `{:error, reason}` or the documented WebSocket denial; and
- the intended target probe's delivery count does not change.

Probe targets are deliberately outside the Lattice framework surface. They live
in `apps/lattice_stress` and exist only to prove delivery or non-delivery.

## Bugs Found By The Lab

The first race pass found two real issues and the suite now guards them:

- CapStore and Topology could deadlock because CapStore checked tab connectivity
  while Topology revoked caps during disconnect. Lifecycle revocation now occurs
  from the facade after Topology closes the tab.
- Topology delivered tab-side calls from inside its GenServer. A slow tab could
  block lifecycle changes. Topology now returns delivery info and the gateway
  performs slow transport work outside Topology.

The property pass also tightened cast semantics:

- `GenServer.cast/2` reports `:ok` for dead pids, so server-pid casts now check
  process liveness and return `{:error, :target_down}` when the target is gone.

## Remaining Limits

- State is still in memory. CapStore or Audit crashes fail closed, but volatile
  history/caps are lost.
- The load harness is local-node pressure, not distributed clustering.
- Browser E2E verifies two real tabs and the WebSocket gateway, not AtomVM or raw
  Erlang distribution.
- The lab is adversarial but not a formal proof.
