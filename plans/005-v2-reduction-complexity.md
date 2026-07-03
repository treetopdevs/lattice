# Plan 005: Cut the v2 reduction/authority O(n²) re-scans (semantics-preserving)

> **Executor instructions**: Follow step by step. This touches the determinism-critical
> engine — the verification gate (an unchanged, byte-identical test suite) is how you
> know you did not change behavior. Honor STOP conditions. Update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/authority.ex apps/lattice_core/lib/lattice/reduce.ex apps/lattice_core/lib/lattice/dag.ex`
> If any changed, compare the "Current state" excerpts to the live code; on a real
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (core engine — but fully covered by determinism/property tests)
- **Depends on**: 001 recommended (so CI guards the refactor), not required
- **Category**: perf
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The Lattice 2.0 reduction engine recomputes whole-log structures repeatedly. Two hot
spots are pure functions whose output is independent of the optimization, so they can be
made near-linear with **no behavior change**:

1. `Lattice.Authority`'s `holder_as_of/3` and `last_active_as_of/3` iterate the **entire
   ordered op list** on every call, and they are called per authority/role event — so
   authority analysis is roughly O(events × ops). They only ever consult a handful of
   "acquire"/"heartbeat" decisions that are already tracked per role.
2. `Lattice.Reduce` computes `Dag.ancestors(ops, op.id)` **per OR-Set remove op**, each a
   fresh DAG walk — O(removes × ops). `Dag.all_ancestors/1` already computes every op's
   ancestor set in one pass.

Both fixes are internal (no public signature changes) and verified by the existing
determinism + property suite remaining byte-identical.

## Current state

`apps/lattice_core/lib/lattice/authority.ex`:
- `build_role_timeline/6` folds ops into a per-role state `st` with `holder`,
  `acquires` (a list of `%{op_id, holder, at_tick}` in canonical order), `decided`,
  `quarantine`, `audit`.
- The full-scan helpers:
  ```elixir
  defp holder_as_of(anc, decided, ordered) do
    Enum.reduce(ordered, nil, fn op, holder ->
      case Map.get(decided, op.id) do
        %{type: :acquire, holder: h} -> if MapSet.member?(anc, op.id), do: h, else: holder
        _ -> holder
      end
    end)
  end

  defp last_active_as_of(anc, decided, ordered) do
    Enum.reduce(ordered, 0, fn op, acc ->
      case Map.get(decided, op.id) do
        %{type: type, at_tick: tick} when type in [:acquire, :heartbeat] ->
          if MapSet.member?(anc, op.id), do: max(acc, tick), else: acc
        _ -> acc
      end
    end)
  end
  ```
  Called from `decide_transfer/8`, `decide_succeed/9`, `decide_heartbeat/5`.
- A near-identical helper already exists for the command path and scans only `acquires`:
  ```elixir
  defp holder_from_acquires(acquires, anc) do
    acquires
    |> Enum.filter(&MapSet.member?(anc, &1.op_id))
    |> List.last()
    |> case do
      nil -> nil
      %{holder: h} -> h
    end
  end
  ```

`apps/lattice_core/lib/lattice/reduce.ex`:
- `reduce_crdts/3` builds CRDTs; `build_or_set/2` does, per remove:
  ```elixir
  {_field, op, {:remove, elem}}, set ->
    ancestors = Dag.ancestors(ops, op.id)
    observed = elem_adds |> Map.get(elem, MapSet.new()) |> MapSet.intersection(ancestors)
    OrSet.remove(set, observed)
  ```
  `ops` is in scope in `reduce_crdts`; `Dag.all_ancestors(ops)` returns `%{op_id => MapSet}`.

`apps/lattice_core/lib/lattice/dag.ex` already provides `all_ancestors/1` and
`heights/1` (both single-pass).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `cd apps/lattice_core && ~/.asdf/shims/mix compile` | exit 0, no warnings |
| v2 suite | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/` | all pass |
| Property determinism, many seeds | `cd apps/lattice_core && for s in 1 7 99 2024 555; do ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs --seed $s; done` | `3 properties, 0 failures` each |
| Full suite | `~/.asdf/shims/mix test` (repo root) | all pass |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/authority.ex`
- `apps/lattice_core/lib/lattice/reduce.ex`

**Out of scope**:
- `apps/lattice_core/lib/lattice/dag.ex` — reuse its existing `all_ancestors/1`; do not
  change it.
- Public function signatures of `Authority.analyze/2`, `Reduce.reduce/3`,
  `Reduce.reduce_crdts/3` — DO NOT change them (callers in `Registry`, `Sim`, `Lattice`,
  tests rely on them). This is an internal-only refactor.
- The larger cross-module optimization (compute one shared `topo_sort` for both
  `Authority.analyze` and `Reduce`) — deferred (see Maintenance notes); it changes
  signatures and is higher risk.

## Git workflow

- Branch: `advisor/005-v2-reduction-complexity`
- Commit per sub-change (authority, then reduce) so each is independently verifiable.
- Short imperative messages. Do NOT push/PR unless instructed.

## Steps

### Step 1: Track heartbeats per role and replace the holder full-scan

In `build_role_timeline/6`'s `init`, add `heartbeats: []` alongside `acquires`.

In `decide_heartbeat/5`, when the heartbeat is valid (authored by the holder-at-deps),
append `%{op_id: op.id, at_tick: at_tick}` to `st.heartbeats` (in addition to the
existing `decided` entry).

Replace every `holder_as_of(anc, st.decided, ordered)` call (in `decide_transfer`,
`decide_succeed`, `decide_heartbeat`) with `holder_from_acquires(st.acquires, anc)`.
These are equivalent: `acquires` is already in canonical order, so the last acquire whose
`op_id ∈ anc` is the holder-as-of-deps.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/authority_test.exs test/lattice2/succession_time_travel_test.exs`
→ all pass (these cover transfer/succession/stale-holder/heartbeat-dormancy).

### Step 2: Replace the `last_active` full-scan with an acquires+heartbeats scan

Add a helper:
```elixir
defp last_active_from(acquires, heartbeats, anc) do
  ticks =
    for ev <- acquires ++ heartbeats, MapSet.member?(anc, ev.op_id), do: ev.at_tick
  Enum.max([0 | ticks])
end
```
Replace `last_active_as_of(anc, st.decided, ordered)` in `decide_succeed` with
`last_active_from(st.acquires, st.heartbeats, anc)`.

Then delete the now-unused `holder_as_of/3` and `last_active_as_of/3` (compile will warn
if anything still calls them — it must not).

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix compile` → 0 warnings (no unused
function warnings), then `~/.asdf/shims/mix test test/lattice2/succession_time_travel_test.exs`
→ pass (premature-succession + dormancy thresholds depend on `last_active`).

### Step 3: Compute OR-Set ancestors once in reduction

In `Reduce.reduce_crdts/3`, after `ops` is established, compute
`all_ancestors = Dag.all_ancestors(ops)` once. Thread it into `build_field`/`build_or_set`
(extend the `ctx` map that is already passed, e.g. add `all_ancestors: all_ancestors`).
In `build_or_set`, replace `Dag.ancestors(ops, op.id)` with
`Map.get(all_ancestors, op.id, MapSet.new())`.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/replica_reduce_test.exs test/lattice2/crdt_property_test.exs`
→ pass (these cover OR-Set add-wins + delivery-order independence).

### Step 4: Full determinism + suite gate

Run the property suite across multiple seeds and the whole suite.

**Verify**:
- `cd apps/lattice_core && for s in 1 7 99 2024 555; do ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs --seed $s; done` → each prints `3 properties, 0 failures`.
- `~/.asdf/shims/mix test` (repo root) → all pass, 0 failures.
- `~/.asdf/shims/mix run scripts/lattice2_demo.exs` → runs to "Demo complete".

## Test plan

No new behavior, so no new behavior tests are required; the existing determinism and
property suite is the oracle:
- `convergence_property_test.exs` property (c) asserts re-running a scenario is
  **byte-identical** and property (d) asserts **identical quarantine sets across realms**.
  If your refactor changed any reduction or quarantine output, these fail — that is the
  intended trip-wire.
- Optionally (nice-to-have, not required): add a micro-benchmark note in the commit
  message showing the change is behavior-neutral (e.g. same `Sim.state` for a fixed seed
  before/after).

## Done criteria

ALL must hold:
- [ ] `holder_as_of/3` and `last_active_as_of/3` are removed; their callers use
      `holder_from_acquires/2` and `last_active_from/3`.
- [ ] `build_or_set` uses a once-computed `Dag.all_ancestors/1` map, not per-op
      `Dag.ancestors/2`.
- [ ] `grep -n "holder_as_of\|last_active_as_of" apps/lattice_core/lib/lattice/authority.ex` → no matches.
- [ ] `grep -n "Dag.ancestors(" apps/lattice_core/lib/lattice/reduce.ex` → no matches.
- [ ] `cd apps/lattice_core && ~/.asdf/shims/mix compile` → 0 warnings.
- [ ] Full `~/.asdf/shims/mix test` passes; property suite green across seeds 1/7/99/2024/555.
- [ ] No public signature changed (`Authority.analyze/2`, `Reduce.reduce/3`,
      `Reduce.reduce_crdts/3` unchanged); `git status` shows only the two in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:
- Any `lattice2` test or property fails after a change — especially a determinism
  (byte-identical) or quarantine-set assertion. That means the refactor changed
  semantics; revert that step and report, do not "adjust the test".
- You find that `holder_from_acquires/2` and `holder_as_of/3` are NOT equivalent for some
  case (e.g. `decided` contained acquires not in `acquires`) — report it rather than
  forcing the swap.
- The change appears to require editing `dag.ex` or a public signature.

## Maintenance notes

- **Deferred follow-up**: `Registry.current_state/1` runs both `Authority.analyze` and
  `Reduce.reduce`, each independently `topo_sort`-ing the same ops; `process_inbox` and
  `do_sync` re-run `current_state` repeatedly. A larger optimization computes the
  canonical order + ancestors once and threads a context object through both — but it
  changes public signatures and should be its own plan with its own determinism gate.
- A reviewer should confirm the determinism property assertions are unchanged and green,
  and that no public API signature moved.
