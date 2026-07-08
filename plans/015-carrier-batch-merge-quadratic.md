# Plan 015: Remove the O(n²) list-append in `Carrier.Batch.merge_reports` (real carrier push path)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Toolchain**: run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a
> broken mise shim — see `AGENTS.md`). CI uses plain `mix`.
>
> **Drift check (run first)**:
> `git diff --stat 6b2cfe5..HEAD -- apps/lattice_core/lib/lattice/carrier/batch.ex apps/lattice_core/test/lattice2/carrier_batch_test.exs`
> If either file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (recommended after 014 so the batch properties guard this refactor)
- **Category**: perf
- **Planned at**: commit `6b2cfe5`, 2026-07-07

## Why this matters

`Lattice.Carrier.Batch.merge_reports/1` combines the per-batch acceptance
reports produced when the real WebSocket carrier splits a push into bounded
frames. It is called on the live push path in
`apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex:109` after every
chunked `push/2`. The current implementation appends with `++` inside an
`Enum.reduce`, which is O(left length) per step. Merging `B` batch-reports whose
sizes sum to `N` accepted/quarantined/rejected/pending ids costs
O(N·B) instead of O(N) — a real, if modest, penalty that grows with the number
of batches in a large sync (e.g. 1000 ops → ~16 batches of 64). The fix is a
mechanical prepend-then-reverse that makes merging linear, with no behavioral
change: the merged report must remain field-wise in-order concatenation.

## Current state

`apps/lattice_core/lib/lattice/carrier/batch.ex:47-58`:

```elixir
@spec merge_reports([Lattice.Sync.report()]) :: Lattice.Sync.report()
def merge_reports(reports) do
  Enum.reduce(reports, %{accepted: [], quarantined: [], rejected: [], pending: []}, fn report,
                                                                                       acc ->
    %{
      accepted: acc.accepted ++ report.accepted,
      quarantined: acc.quarantined ++ report.quarantined,
      rejected: acc.rejected ++ report.rejected,
      pending: acc.pending ++ report.pending
    }
  end)
end
```

Each `acc.<field> ++ report.<field>` copies the entire accumulated list. A
`report` is `%{accepted: [id], quarantined: [{id, reason}], rejected: [{id, reason}], pending: [id]}`
(see `Lattice.Sync.report` / `apps/lattice_core/lib/lattice/sync.ex` `finalize/2`).

Production caller — `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex:98-118`:
the chunked batches are pushed one frame at a time by `push_batches/4`, which
accumulates `reports` in reverse and reverses once (`push_batches/4` clause at
`ws_carrier.ex:130-131`), then hands the in-order list to `Batch.merge_reports/1`
at line 109. So `merge_reports` receives reports in batch order and must
preserve that order.

Existing test (the behavior you must not change) —
`apps/lattice_core/test/lattice2/carrier_batch_test.exs:40`:

```elixir
assert Batch.merge_reports(reports) == %{
         # ... field-wise in-order concatenation of the two input reports
       }
```

## Commands you will need

| Purpose        | Command                                                                             | Expected            |
|----------------|-------------------------------------------------------------------------------------|---------------------|
| Compile        | `~/.asdf/shims/mix compile`                                                          | exit 0              |
| Batch tests    | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs`      | all pass            |
| Carrier tests  | `~/.asdf/shims/mix test apps/lattice_node_spike/`                                    | all pass            |
| Format         | `~/.asdf/shims/mix format --check-formatted`                                         | exit 0              |
| Full gate      | `~/.asdf/shims/mix verify`                                                           | format ok + all pass|

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/carrier/batch.ex` — rewrite `merge_reports/1` only.
- `apps/lattice_core/test/lattice2/carrier_batch_test.exs` — only if Step 2's
  property (order-preservation on ≥3 reports) is not already present from plan 014.

**Out of scope** (do NOT touch):
- `Carrier.Batch.chunk/2` / `chunk!/2` — unrelated; leave as-is.
- `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex` — the caller is
  correct; do not change it.
- `apps/lattice_core/lib/lattice/sync.ex` — the report shape is defined there;
  do not alter it.

## Git workflow

- Branch: `advisor/015-carrier-batch-merge-quadratic`
- Commit message style (conventional commits, per `git log`), e.g.
  `perf(carrier): make Batch.merge_reports linear`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Rewrite `merge_reports/1` to prepend-then-reverse

Replace the body so each field accumulates by prepending each report's list
(cheap) and reverses once at the end, preserving the exact output order:

```elixir
@spec merge_reports([Lattice.Sync.report()]) :: Lattice.Sync.report()
def merge_reports(reports) do
  merged =
    Enum.reduce(reports, %{accepted: [], quarantined: [], rejected: [], pending: []}, fn report,
                                                                                         acc ->
      %{
        accepted: prepend_reverse(acc.accepted, report.accepted),
        quarantined: prepend_reverse(acc.quarantined, report.quarantined),
        rejected: prepend_reverse(acc.rejected, report.rejected),
        pending: prepend_reverse(acc.pending, report.pending)
      }
    end)

  %{
    accepted: Enum.reverse(merged.accepted),
    quarantined: Enum.reverse(merged.quarantined),
    rejected: Enum.reverse(merged.rejected),
    pending: Enum.reverse(merged.pending)
  }
end

# Prepend `items` (in order) onto `acc` (which is held reversed), keeping the
# whole accumulator reversed so the final Enum.reverse restores input order.
defp prepend_reverse(acc, items), do: Enum.reduce(items, acc, fn item, a -> [item | a] end)
```

This is O(N) total (each id is prepended once and reversed once) and produces
byte-identical output to the old `++` version. If you prefer, an equivalent and
also-linear form builds four reversed accumulators explicitly — either is fine
so long as the final order matches the old behavior.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs`
→ all pass (the existing `merge_reports` example test at line 40 must still pass
unchanged — that is your order-equivalence check).

### Step 2: Add/confirm an order-preservation test on ≥3 reports

If plan 014's `property "merge_reports concatenation is order-preserving"` is
already present in `carrier_batch_test.exs`, this step is done — note that and
skip. Otherwise add one example test merging **three** reports with distinct ids
per field and assert the result equals the manual in-order concatenation (three
reports is enough to catch an accumulator that reverses or drops order; the
existing test only uses two).

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs` → all pass.

### Step 3: Confirm the real carrier still converges

**Verify**: `~/.asdf/shims/mix test apps/lattice_node_spike/` → all pass
(the `node_carrier_spike_test.exs` GATE asserts byte-identical convergence over
a real socket; a broken merge would surface as a divergence or wrong push
report).

## Test plan

- Reuse the existing `carrier_batch_test.exs` "merges sync reports preserving
  order" test as the behavioral oracle; add the three-report case if absent.
- No new test file. The determinism/round-trip properties from plan 014 (if
  landed) provide the stronger guard.
- Verification: batch tests + `apps/lattice_node_spike/` tests all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix compile` exits 0, no new warnings.
- [ ] `grep -n "++" apps/lattice_core/lib/lattice/carrier/batch.ex` shows no `++`
      remaining inside `merge_reports/1` (the `chunk` function may retain its own
      list ops — that is out of scope and fine).
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs` exits 0.
- [ ] `~/.asdf/shims/mix test apps/lattice_node_spike/` exits 0.
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `git status` shows only the in-scope file(s) modified.
- [ ] `plans/README.md` status row for 015 updated.

## STOP conditions

Stop and report back if:

- The existing `merge_reports` example test (`carrier_batch_test.exs:40`) fails
  after your change — the output order no longer matches; do not edit the test
  to fit your code.
- `apps/lattice_node_spike/` tests fail (a merge-order bug can break the
  byte-identity GATE).
- You discover `merge_reports/1` has additional callers with different ordering
  expectations (`grep -rn "merge_reports" apps/ --include=*.ex`); if a caller
  depends on a different order, STOP and report rather than guessing.

## Maintenance notes

- If the report shape in `Lattice.Sync` gains a field, `merge_reports/1` must
  merge it too — the four fields are enumerated explicitly here by design (a
  silently-dropped field would corrupt sync accounting).
- This is a pure hot-path micro-optimization; a reviewer should confirm only
  that output order is unchanged (the whole risk surface).
