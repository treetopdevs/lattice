# Plan 006: Direct unit tests for v2 infra (Net, Clock, Materializer, Promise) + stronger property runs

> **Executor instructions**: Follow step by step; run each verification. Honor STOP
> conditions. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/net.ex apps/lattice_core/lib/lattice/clock.ex apps/lattice_core/lib/lattice/materializer.ex apps/lattice_core/lib/lattice/promise.ex apps/lattice_core/test/lattice2/convergence_property_test.exs`
> If any changed, compare "Current state" to the live code first; on a real mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (adds tests; one tiny test-file edit)
- **Depends on**: none (lands cleaner after 001 so CI runs the new tests)
- **Category**: tests
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

Four Lattice 2.0 infrastructure modules have **no direct tests** — they are only
exercised transitively through behavior suites: `Lattice.Net` (deterministic partition/
heal + seeded delivery queue), `Lattice.Clock` (logical tick source feeding succession),
`Lattice.Materializer` (the live-process lifecycle handle), and `Lattice.Promise`
(durable request/response struct). A bug in any of these (e.g. queue ordering, clock
reset, `whereis` registration) would only surface as a confusing failure in a large
integration test. Direct unit tests localize such bugs and document the contracts. This
plan also raises the central determinism property's run count and removes a dead
assertion.

## Current state

- Test layout: v2 tests live in `apps/lattice_core/test/lattice2/`. Pure-data tests use
  `use ExUnit.Case, async: true` + `use ExUnitProperties` (see
  `test/lattice2/crdt_property_test.exs`). Tests that touch the running app's GenServers
  use `use ExUnit.Case, async: false` with `setup do Lattice.reset!(); :ok end` (see
  `test/lattice2/lifecycle_test.exs`).
- Module contracts (read each file before testing):
  - `Lattice.Net` (`net.ex`) — pure: `new/1` (`seed:` opt), `partition/3`, `heal/3`,
    `connected?/3`, `partitioned?/3`, `enqueue/4`, `drain/2` (returns `{net, delivered}`,
    delivers only currently-connected links in a seeded deterministic order; partitioned
    messages stay queued), `pending/1`.
  - `Lattice.Clock` (`clock.ex`) — an `Agent` started by the application supervisor:
    `now/0`, `advance/1` (returns new tick), `set/1`, `reset/0` (→ 0). Global singleton.
  - `Lattice.Materializer` (`materializer.ex`) — `whereis/1` (pid or nil),
    `query/2` (returns `{:error, :not_live}` when no live process), `child_spec/1`,
    `via/1`. Live processes are started by `Lattice.Registry.materialize/2` and
    registered in the `Lattice.Materializer.Registry` (Elixir Registry).
  - `Lattice.Promise` (`promise.ex`) — a struct with `@enforce_keys [:ref, :replica, :target, :from]`.
- `apps/lattice_core/test/lattice2/convergence_property_test.exs`:
  - No `max_runs` override (StreamData default = 100 runs/property).
  - Line 146 contains a dead `assert true` at the end of property "b".

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Run new tests | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/net_test.exs test/lattice2/clock_test.exs test/lattice2/materializer_test.exs test/lattice2/promise_test.exs` | all pass |
| v2 suite | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/` | all pass |
| Full suite | `~/.asdf/shims/mix test` | all pass |
| Format | `~/.asdf/shims/mix format` | exit 0 |

## Scope

**In scope** (create the four test files; edit the one property test):
- `apps/lattice_core/test/lattice2/net_test.exs` (create)
- `apps/lattice_core/test/lattice2/clock_test.exs` (create)
- `apps/lattice_core/test/lattice2/materializer_test.exs` (create)
- `apps/lattice_core/test/lattice2/promise_test.exs` (create)
- `apps/lattice_core/test/lattice2/convergence_property_test.exs` (edit: max_runs + remove `assert true`)

**Out of scope**:
- Any `lib/` source. If a unit test reveals a real bug in `net.ex`/`clock.ex`/etc., STOP
  and report it as a new finding — do not fix source in this plan.
- v1 module tests (gateway/topology/cap_store) — separate concern.

## Git workflow

- Branch: `advisor/006-v2-infra-tests`
- One commit per test file (or one cohesive commit). Short imperative messages.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: `net_test.exs` (pure, `async: true`)

Cover: `partition` then `connected?/partitioned?` reflect it and `heal` reverses it
(both link directions — `connected?(net, a, b) == connected?(net, b, a)`); `enqueue`
holds a message while partitioned (`drain` returns it only after `heal`); `drain` returns
currently-connected messages and leaves partitioned ones (`pending/1` reflects the
remainder); determinism — same `seed:` + same enqueue order ⇒ identical `drain` order
(assert by building two identical nets and comparing the delivered lists).

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/net_test.exs` → all pass.

### Step 2: `clock_test.exs` (`async: false`, reset in setup)

`Lattice.Clock` is a global Agent started by the app, so use `async: false` and
`setup do Lattice.Clock.reset(); :ok end`. Cover: `now/0` is 0 after reset; `advance/1`
increments and returns the new value; `advance/0` (default 1) if defined; `set/1`
overrides; `reset/0` returns to 0. Assert monotonicity across two `advance` calls.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/clock_test.exs` → all pass.

### Step 3: `materializer_test.exs` (`async: false`, `Lattice.reset!` in setup)

Model after `test/lattice2/lifecycle_test.exs` setup. Cover: `whereis/1` returns `nil`
for an unknown `{realm, replica}` key; `query/2` returns `{:error, :not_live}` when no
live process; after `Lattice.Registry.host/4` + `Lattice.Registry.materialize/2`,
`whereis/1` returns a live pid and `query/2` answers (use the same hosting helper shape
as `lifecycle_test.exs`'s `hosted/0`). Cover `child_spec/1` returns a map with the
expected `:id`/`:start`. Keep the test focused on the Materializer's own surface, not the
full lifecycle (that's `lifecycle_test.exs`).

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/materializer_test.exs` → all pass.

### Step 4: `promise_test.exs` (pure, `async: true`)

Minimal: building a `%Lattice.Promise{ref: ..., replica: ..., target: ..., from: ...}`
succeeds; omitting an enforced key raises (assert with
`assert_raise ArgumentError, fn -> struct!(Lattice.Promise, %{}) end`). This pins the
struct contract that `Registry.call/4`/`await` depend on.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/promise_test.exs` → all pass.

### Step 5: Strengthen the determinism property + remove the dead assertion

In `convergence_property_test.exs`:
- Add `@moduletag timeout: 120_000` and raise the run count for the determinism-critical
  properties. The simplest portable way is per-property: change each
  `check all ... do` to `check all ..., max_runs: 500 do`. (If you prefer a single knob,
  add `@moduletag max_runs: 500` — confirm your StreamData version honors the module tag
  by running the file and watching the case count; if it does not visibly increase, use
  the per-`check` form.)
- Delete the dead `assert true` at the end of property "b" (currently line ~146); the
  real assertion is the `for`-loop above it that checks holder == author. Leave that loop.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs` →
`3 properties, 0 failures`, and the run is visibly slower (more cases). `grep -n "assert true" test/lattice2/convergence_property_test.exs` → no matches.

### Step 6: Format + full suite

**Verify**: `~/.asdf/shims/mix format` → exit 0; `~/.asdf/shims/mix test` (repo root) → all pass.

## Test plan

The plan *is* the test plan. New files cover:
- Net: partition/heal symmetry, queue-holds-while-partitioned, seeded delivery
  determinism, `pending` accounting.
- Clock: reset/advance/set/now monotonicity.
- Materializer: `whereis` miss/hit, `query` not-live vs live, `child_spec`.
- Promise: struct construction + enforced-key violation.
- Property: 500 runs on the determinism/convergence/authority properties.
Structural patterns to copy: `crdt_property_test.exs` (pure + StreamData),
`lifecycle_test.exs` (app/Registry + `Lattice.reset!`).

## Done criteria

ALL must hold:
- [ ] Four new files exist under `apps/lattice_core/test/lattice2/` and pass.
- [ ] `convergence_property_test.exs` runs its core properties at ≥500 cases and has no
      `assert true`.
- [ ] `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/` → all pass.
- [ ] `~/.asdf/shims/mix test` (repo root) → all pass; `~/.asdf/shims/mix format` clean.
- [ ] `git status` shows only the four new test files + the one edited property test.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:
- A new unit test fails because the **module behaves wrongly** (a real bug) — report it
  as a finding; do not edit `lib/` to make the test pass.
- Raising `max_runs` makes a property **fail** on some seed — that is a genuine
  determinism/convergence counterexample; STOP and report the failing seed and shrunk
  input (this is the most valuable possible outcome — do not lower `max_runs` to hide it).
- `clock_test.exs`/`materializer_test.exs` cannot run because the app isn't started in
  the test env — check `test/test_helper.exs` starts the `:lattice_core` app; if not,
  report rather than starting processes ad hoc.

## Maintenance notes

- If 500 runs makes CI too slow, gate the higher count behind an env check
  (`max_runs: System.get_env("CI") && 500 || 200`) rather than lowering it everywhere.
- When `Lattice.Net` grows a real transport (plan 010), these tests pin the simulated
  contract the real carrier must match.
