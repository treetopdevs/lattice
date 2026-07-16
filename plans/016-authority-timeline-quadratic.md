# Plan 016: Remove O(n²) list-append in `Authority` role timelines (per-state-read hot path)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. This
> plan touches the **authority engine**, the most security-critical module in the
> codebase — read the "STOP conditions" and the order-dependence warning in
> "Current state" before editing. If anything in "STOP conditions" occurs, stop
> and report — do not improvise. When done, update the status row in
> `plans/README.md`.
>
> **Toolchain**: run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a
> broken mise shim — see `AGENTS.md`). CI uses plain `mix`.
>
> **Drift check (run first)**:
> `git diff --stat 6b2cfe5..HEAD -- apps/lattice_core/lib/lattice/authority.ex`
> If it changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 014 recommended (its convergence/quarantine guards make this
  refactor safe to verify), 001/006 already provide the property suite.
- **Category**: perf
- **Planned at**: commit `6b2cfe5`, 2026-07-07

## Why this matters

`Lattice.Authority.analyze/2` is invoked by `Lattice.Authority.quarantine/2`,
which runs on **every** `Lattice.state/2` and `Lattice.state_at/3` call
(`apps/lattice_core/lib/lattice.ex:160-174`) — i.e. every materialization, demo
render, and most tests. Inside `analyze/2`, each role's timeline is built by an
`Enum.reduce` over the ordered ops that appends single events with `++ [item]`:

- `record_acquire/4` (line 510): `acquires: st.acquires ++ [%{...}]`
- `decide_heartbeat/4` (line 564): `heartbeats: st.heartbeats ++ [%{...}]`
- `reject/4` (line 577): `audit: st.audit ++ [%{...}]`

`x ++ [item]` copies the whole left list, so building a timeline of `K` events is
O(K²). For **heartbeats** this is the real exposure: a role held across a
long-lived matter emits one heartbeat op per activity, so `K` grows unbounded
with matter lifetime, making every state read quadratic in the heartbeat count.
`acquires` and `reject`/`audit` counts are usually small, but the pattern is the
same and worth fixing consistently.

## Current state — READ THE ORDER-DEPENDENCE WARNING

The naive fix ("prepend with `[item | list]`, reverse once at the end") is
**unsafe for `acquires`** and must be applied carefully. Two consumers read
`st.acquires` **positionally, during the same reduce that builds it**:

- `holder_from_acquires/2` (`authority.ex:743-751`) does
  `acquires |> Enum.filter(...) |> List.last()` — it depends on `acquires` being
  in **chronological (append) order** so `List.last/1` returns the most recent
  acquire. It is called mid-reduce at lines 518 and 559 (`decide_transfer`,
  `decide_heartbeat`) and post-reduce at line 727.
- `stale_holder?/4` (`authority.ex:755-777`) uses `Enum.with_index/1` and
  `Enum.at(tl.acquires, i + 1)` — it depends on the **positional/next-element**
  relationship in chronological order.

If you switch `acquires` to prepend without also fixing these readers, authority
decisions break silently (wrong holder, wrong staleness) — a security bug, not
just a perf regression. So `acquires` must stay in chronological order at every
read.

`heartbeats` is safer: the only reader is `last_active_from/3`
(`authority.ex:582-587`), which does `for ev <- acquires ++ heartbeats, ... do ev.at_tick` then `Enum.max/1` — **order-independent**. So heartbeats can be
reordered freely.

Current source (the three append sites):

```elixir
# record_acquire/4 — line 506
defp record_acquire(st, op, new_holder, at_tick) do
  %{
    st
    | holder: new_holder,
      acquires: st.acquires ++ [%{op_id: op.id, holder: new_holder, at_tick: at_tick}],
      decided:
        Map.put(st.decided, op.id, %{type: :acquire, holder: new_holder, at_tick: at_tick})
  }
end

# decide_heartbeat/4 — line 557 (append at line 564)
heartbeats: st.heartbeats ++ [%{op_id: op.id, at_tick: at_tick}],

# reject/4 — line 572 (append at line 577)
audit: st.audit ++ [%{event: :authority_quarantine, op: op.id, reason: reason, role: role}]
```

The timeline struct is initialized at `build_role_timeline/6` (line 450) with
`acquires: []`, `heartbeats: []`, and (via `reject`) an `audit:` list. The
timeline's `audit` is consumed by `analyze/2` at line 234
(`role_audit = Enum.flat_map(timelines, fn {_r, tl} -> tl.audit end)`) — order
matters for stable audit output, so preserve it.

## Recommended approach (lowest-risk)

Do **not** flip `acquires` to prepend. Instead:

1. **`heartbeats`** — safe to prepend since its only reader takes a max. Change
   `decide_heartbeat/4` to `heartbeats: [%{...} | st.heartbeats]`. No reader
   change needed (order-independent). This removes the unbounded-growth
   quadratic — the primary win. Optionally reverse once in `build_role_timeline`
   before returning, if you want the stored order to remain chronological for
   readability; not required for correctness.
2. **`acquires`** and **`audit`** — these are typically small (a role changes
   hands and is rejected a handful of times, not thousands). The safest change
   that removes the quadratic **without touching the positional readers** is to
   keep append semantics but build the list via prepend into a reversed
   accumulator and reverse **once at the point of first positional read is not
   possible** — so instead, leave `acquires`/`audit` as `++ [item]` **unless**
   you can prove the readers are updated correctly. Given the risk, the default
   recommendation is: **fix `heartbeats` only** (the one that actually scales),
   and leave `acquires`/`audit` unchanged.

If you want to also make `acquires` linear, the correct (higher-effort) refactor
is: store `acquires` reversed internally, and change `holder_from_acquires/2` to
`Enum.find` from the front (first match in reversed = most recent) and
`stale_holder?/4` to index against the reversed list. That is a larger change
with its own tests; only do it under an explicit instruction to, and treat the
positional readers as in-scope if so.

## Commands you will need

| Purpose            | Command                                                                                      | Expected            |
|--------------------|----------------------------------------------------------------------------------------------|---------------------|
| Compile            | `~/.asdf/shims/mix compile`                                                                   | exit 0              |
| Authority tests    | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/`                                     | all pass            |
| Township props     | `~/.asdf/shims/mix test apps/lattice_core/test/township/`                                     | all pass            |
| Stress authority   | `~/.asdf/shims/mix test apps/lattice_stress/test/property_authority_invariant_test.exs`       | all pass            |
| Format             | `~/.asdf/shims/mix format --check-formatted`                                                  | exit 0              |
| Full gate          | `~/.asdf/shims/mix verify`                                                                    | format ok + all pass|

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/authority.ex` — the `heartbeats` append in
  `decide_heartbeat/4` (default). Only touch `record_acquire/4` /
  `stale_holder?/4` / `holder_from_acquires/4` if you take the higher-effort
  `acquires` refactor under explicit instruction.

**Out of scope**:
- The delegation/validation logic, `resolve_root`, `validate_commands`, and every
  security decision — do not alter behavior, only the list-building mechanics of
  `heartbeats`.
- `apps/lattice_core/lib/lattice/reduce.ex`, `lattice.ex` — callers; unchanged.

## Git workflow

- Branch: `advisor/016-authority-timeline-quadratic`
- Commit: `perf(authority): prepend heartbeats to avoid O(n^2) timeline build`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `heartbeats` accumulation linear

In `decide_heartbeat/4` (`authority.ex:557-570`), change the append to a prepend:

```elixir
heartbeats: [%{op_id: op.id, at_tick: at_tick} | st.heartbeats],
```

Do **not** change any reader — `last_active_from/3` takes a max over
`acquires ++ heartbeats`, which is order-independent. (If you prefer stored
chronological order for readability, reverse `heartbeats` once in
`build_role_timeline/6` before it returns the timeline map, but confirm no other
consumer of `tl.heartbeats` exists first via
`grep -n "heartbeats" apps/lattice_core/lib/lattice/authority.ex`.)

**Verify**: `~/.asdf/shims/mix compile` → exit 0.

### Step 2: Run the full authority + convergence + Township suites

These suites assert authority soundness, identical quarantine, and byte-identical
replay — the exact invariants a mistimed timeline change would break.

**Verify**:
- `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` → all pass
- `~/.asdf/shims/mix test apps/lattice_core/test/township/` → all pass
- `~/.asdf/shims/mix test apps/lattice_stress/test/property_authority_invariant_test.exs` → all pass

### Step 3: Full gate

**Verify**: `~/.asdf/shims/mix verify` → format clean + entire suite passes.
Update `plans/README.md` status row for 016.

## Test plan

- No new test file is required: the existing property suites
  (`convergence_property_test.exs`, `matter_property_test.exs`,
  `property_authority_invariant_test.exs`) already assert the invariants that a
  timeline-order bug would violate, and they run randomized authority sequences
  including successions and heartbeats.
- Optional (nice-to-have): add one example test in
  `apps/lattice_core/test/lattice2/` that materializes a replica with a role held
  across **many** heartbeats and asserts the reduced state / `last_active` is
  unchanged from the pre-refactor expectation — documents the intent. Only add it
  if it does not require inventing new test scaffolding.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix compile` exits 0, no new warnings.
- [ ] `grep -n "st.heartbeats ++" apps/lattice_core/lib/lattice/authority.ex`
      returns nothing (the heartbeats append is gone).
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` exits 0.
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/` exits 0.
- [ ] `~/.asdf/shims/mix test apps/lattice_stress/test/property_authority_invariant_test.exs` exits 0.
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `git status` shows only `authority.ex` (and optionally one test file) modified.
- [ ] `plans/README.md` status row for 016 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- **Any** convergence, quarantine, byte-identity, or authority-invariant test
  fails after the change — that means order matters somewhere you didn't expect;
  revert and report, do not weaken the test.
- You find another reader of `tl.heartbeats` besides `last_active_from/3` that
  depends on order (`grep -n "heartbeats" apps/lattice_core/lib/lattice/authority.ex`).
- You are tempted to also flip `acquires` to prepend: STOP unless the operator
  explicitly asked for the higher-effort `acquires` refactor. The positional
  readers `holder_from_acquires/2` and `stale_holder?/4` make that unsafe as a
  drop-in, and a wrong holder decision is a security bug.

## Maintenance notes

- The remaining `++ [item]` on `acquires` and `audit` is intentional here: their
  event counts are small and their readers depend on chronological order. If a
  future workload makes `acquires` large (e.g. rapid role churn), revisit with
  the higher-effort refactor described above and bring the positional readers
  into scope.
- A reviewer should verify only that authority *decisions* are unchanged — the
  invariant suites are the evidence; the perf gain is incidental and needs no
  benchmark to accept.
