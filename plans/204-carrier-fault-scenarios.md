# Plan 204: Carrier fault scenarios — stalled drain and relay crash on the plan 203 evidence format

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1017cb8..HEAD -- apps/lattice_carrier_server/lib/lattice_carrier_server/operator/ apps/lattice_carrier_server/lib/lattice_carrier_server/durability.ex apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex apps/lattice_carrier_server/test/operator/release_runtime_test.exs apps/lattice_carrier_server/test/township_projection_test.exs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (test-only; no change to carrier runtime code)
- **Depends on**: 203 (evidence format, verifier table, report)
- **Category**: dx / demonstration
- **Planned at**: commit `1017cb8`, 2026-10-14. Split out of plan 203 during its review (PR #116)
  because these two scenarios depend on process timing that is best written next to the landed
  evidence code, and plan 203 reached the 400-line cap.

## Why this matters

Plan 203 proves convergence and identical quarantine offline from a seed. The other two guarantees
in the fault panel live in real processes: a stalled shutdown must fail closed, and an acknowledged
op must survive a relay crash. This plan adds those two scenarios, writing plan 203's evidence
schema so they appear in the same report. Their process-level checks can only be **recorded**, not
re-derived offline; plan 203's report already labels them that way.

## Current state

- `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/release_quiesce.ex` —
  `drain(attempt, expected, timeout \\ 5_000)` validates `Runtime.deployment/0`, the manifest and
  instance inventory, closes admission, suspends listeners, then captures holders. Every capture
  failure collapses to `{:error, :release_refused}` (lines 40-48). `capture_holder/4` (line ~126)
  checks `remaining(deadline) > 0` **before** calling the holder, so a deadline that expires right
  after listener suspension returns an error without ever contacting the holder.
- `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex:386-404` — persistence runs in a
  task, but the holder waits for it with `Task.yield` inside `handle_call`, so it answers no call
  while a sync is stalled. Lines 206-213 refuse a relay with `{:error, :release_closed}` once the
  release gate is closed.
- `apps/lattice_carrier_server/test/operator/release_runtime_test.exs` — `setup` (lines 28-49) only
  stops and restores the application; the runtime with `f.holder`, `f.attempt`, `f.expected`,
  `f.path` comes from the private `boot/1` (lines 666-723). Lines 339-352 show the gated-sync
  pattern (`GatedSync`, `:sys.replace_state/2`, `{:sync_entered, worker}`, `:continue_sync`) and the
  released case where drain waits and succeeds.
- `apps/lattice_carrier_server/test/township_projection_test.exs:60` — "a client-signed relay
  survives a second-BEAM restart and matches Sim". Its second-BEAM launch helper is the pattern for
  the crash scenario; reuse the helper, not the Township replica.

## Commands you will need

Same toolchain setup as plan 203 ("Commands you will need"), then:

```bash
mix test apps/lattice_carrier_server/test/fault_scenario_test.exs
LATTICE_FAULT_OUT="$OUT" mix test apps/lattice_carrier_server/test/fault_scenario_test.exs --only fault_evidence
mix lattice.fault verify "$OUT/stall_shutdown"
mix lattice.fault report "$OUT"
```

## Scope

**In scope**: `apps/lattice_carrier_server/test/support/fault_scenario.ex`,
`apps/lattice_carrier_server/test/fault_scenario_test.exs`, the two scenarios' entries in plan
203's verifier-owned table, and this plan's index row. Test-only: fault injection never ships in
the `lattice_carrier_pilot` release.

**Out of scope**: any change to carrier `lib/`, `authority.ex`, `sim.ex`; editing
`release_runtime_test.exs` or Township test support.

## Git workflow

As plan 203: branch `claude/plan-204-carrier-fault-scenarios`, one commit per step, one PR claiming
the core tier only, one adversarial review, exact-tip hosted run as the gate.

## Steps

### Step 1 — Test support

Copy `boot/1` from `release_runtime_test.exs` (lines 666-723) and `GatedSync` (lines 7-21) into
`test/support/fault_scenario.ex`; do not edit the original test. Each scenario creates its replica
with an id derived deterministically from the scenario name and seed, so the verifier table can
compute the expected `log.replica` the same way.

**Verify**: a smoke test boots the runtime and relays one op.

### Step 2 — `stall_shutdown` (action: stall shutdown)

Boot; install the `GatedSync` observer; swap the holder's durability with
`:sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))` (arming `InjectedDurability`
does nothing here; the booted holder uses `Durability.Posix`); start one signed relay in a task;
`assert_receive {:sync_entered, worker}` so the holder is provably blocked **before** `drain/3`;
record `bytes_0 = File.read!(f.path)`; call `drain/3` with a short timeout.

Invariant **`fail_closed`** — checks, in this order:

1. `drain_returned_error` — `drain/3` returned `{:error, _}`.
2. `drain_call_reached_holder` — while the gate is still held,
   `Process.info(f.holder, :messages)` contains a `{:"$gen_call", _, {:drain_release, owner}}`
   for this release's owner. A suspended listener is not enough: `capture_holder/4` can return
   on its deadline check without calling the holder, and only the queued call proves the stall
   was the cause.
3. `bytes_unchanged_while_stalled` — `File.read!(f.path) == bytes_0`.
4. Send `:continue_sync` and await the original relay. Record `bytes_1 = File.read!(f.path)`
   (the released relay may legitimately change the log).
5. `admission_closed` — a second valid signed relay returns `{:error, :release_closed}` **and**
   `File.read!(f.path) == bytes_1` afterwards.
6. `acked_subset_of_persisted` — every op the client saw acknowledged is in the log
   `Log.restore_verified/1` returns for the path; an unverifiable log fails the check.

**Negative control**: send `:continue_sync` before `drain/3` times out (the released case of
lines 339-352); `drain/3` must succeed, so `drain_returned_error` is false and the verdict is
`violated`.

### Step 3 — `crash_relay` (action: crash gateway — here, the carrier relay)

Using the second-BEAM helper pattern from `township_projection_test.exs:60` with
`Treehouse.Thread`: relay N signed posts, record the acknowledged set, kill the peer BEAM with
`:erlang.halt/1` on the peer (not a graceful stop), restart it from the same path.

Invariant **`durable_ack`** — checks, in this order: `acked_survive_restart`, taken immediately
after restart and **before any resend** (pull the restarted relay's frontier and ops; a resend
would repopulate a lost log and hide the loss); then resend the outbox and check
`duplicates_silent` (resent acked frames change nothing), `frontier_after_equals_sim`,
`state_after_equals_sim`.

**Negative control**: restart from a fresh empty copy of the log path instead of the original
(simulated lost persistence); `acked_survive_restart` must be false and the verdict `violated`.

### Step 4 — Evidence and verifier table

With `LATTICE_FAULT_OUT` set, both scenarios write plan 203's evidence directory (tag
`@tag :fault_evidence`; timings under `"observed_ms"`, excluded from byte identity and `verify`).
Add both scenarios to plan 203's verifier-owned table: check names with source `process` (all
above) or `replay` (only the log-derived hashes and quarantine table), log prefix `thread` →
`Treehouse.Thread`, and the expected `log.replica` derived from scenario and seed. `verify` rejects
a log whose `replica` differs **before** any replay, so an authentic log for another Thread
replica cannot stand in.

**Verify**: the test file passes three times in a row; `mix lattice.fault verify` accepts both
directories and says the process checks are recorded; a directory with a substituted Thread log
from another replica is rejected; the report shows both cards as "replay verified, process checks
recorded".

### Step 5 — Index row

Set row 204's status cell to DONE with one line (rule 5): date, both verdicts, PR number.

## Done criteria

- Both scenarios hold, and both negative controls report `violated`, three runs in a row.
- `verify` accepts both evidence directories and rejects the substituted-replica directory.
- No diff under carrier `lib/`, `authority.ex`, `sim.ex`, `release_runtime_test.exs`, `township*`.
- Plan 203's done criteria for toolchain, `mix verify`, Sobelow, `@moduledoc`/`@spec`, hosted run
  and review apply unchanged.

## STOP conditions

- `drain_call_reached_holder` cannot be observed without changing carrier `lib/`.
- The second-BEAM helper is Township-coupled in a way that cannot be reused without editing
  Township test support.
- A scenario fails because the carrier acknowledges before persisting or admits after close. That
  is a finding against the carrier: file a row, do not change the scenario to pass.
