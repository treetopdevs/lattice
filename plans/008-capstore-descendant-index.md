# Plan 008: CapStore — index child caps for O(1) descendant lookup; stop ignoring register_cap result

> **Executor instructions**: Follow step by step; run each verification. Honor STOP
> conditions. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/cap_store.ex`
> If it changed, compare "Current state" to the live code first; on a real mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: MED (v1 hot path: grant/delegate/revoke; well-covered by tests)
- **Depends on**: none
- **Category**: perf + bug
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

`CapStore.descendant_ids/2` recomputes the descendants of a cap by scanning the **entire
caps map** once per node in the delegation subtree — O(caps²) per `revoke` of a cap with
children. At the same time, `register_cap/2` results are discarded after a check-then-act
window, so on a tab disconnecting between the `tab_connected?` check and `register_cap`,
a cap can be stored in `CapStore` but never registered in `Topology` (a silent
inconsistency). A parent→children index fixes the complexity and lets the grant/delegate
paths surface a failed `register_cap` instead of swallowing it.

## Current state

`apps/lattice_core/lib/lattice/cap_store.ex`:
- State is `%{caps: %{cap_id => %Cap{}}}` (see `init/1`). No reverse index.
- `descendant_ids/2` (the O(caps²) recursion):
  ```elixir
  defp descendant_ids(caps, cap_id) do
    children =
      caps
      |> Enum.filter(fn {_id, cap} -> cap.parent_id == cap_id end)
      |> Enum.map(fn {id, _cap} -> id end)

    children ++ Enum.flat_map(children, &descendant_ids(caps, &1))
  end
  ```
  Called from the `:revoke` handler: `affected_ids = [cap_id | descendant_ids(state.caps, cap_id)]`.
- `:grant` handler stores the cap then calls, ignoring the result:
  ```elixir
  Topology.register_cap(tab_id, cap.id)
  {:reply, {:ok, cap}, put_in(state, [:caps, cap.id], cap)}
  ```
- `:delegate` handler similarly: `Topology.register_cap(to_tab_id, child.id)` then
  `{:reply, {:ok, child}, put_in(state, [:caps, child.id], child)}`.
- `Topology.register_cap/2` returns `:ok` or `{:error, :tab_not_connected}` (verify by
  reading `topology.ex`).
- Caps have `parent_id` (nil for roots) and `root_id`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Core POC tests | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice_core_poc_test.exs` | all pass |
| Adversarial authority | `cd apps/lattice_stress && ~/.asdf/shims/mix test test/adversarial_authority_test.exs test/property_authority_invariant_test.exs` | all pass |
| Compile (warnings) | `cd apps/lattice_core && ~/.asdf/shims/mix compile` | 0 warnings |
| Full suite | `~/.asdf/shims/mix test` | all pass |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/cap_store.ex`

**Out of scope**:
- `apps/lattice_core/lib/lattice/topology.ex` — do not change `register_cap`'s contract;
  only consume its return value in CapStore.
- The `revoke_tab` path's `Task.start` in `topology.ex` — that fire-and-forget is
  intentional (avoids a documented Topology↔CapStore lock inversion); leave it.
- Public `CapStore` API (`grant/4`, `delegate/4`, `revoke/2`, `authorize/4`, …) — keep
  signatures and return shapes; this is internal-state + internal-handler work only.

## Git workflow

- Branch: `advisor/008-capstore-descendant-index`
- Commit per change (index, then register_cap handling). Short imperative messages.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a parent→children index to state and maintain it

Extend the GenServer state from `%{caps: ...}` to `%{caps: ..., children: %{parent_id => MapSet(child_id)}}`
(update `init/1` and the `:reset` handler to initialize `children: %{}`).

Maintain it:
- On `:grant` and `:delegate`, when a cap with `parent_id` is stored, add the child id to
  `children[parent_id]`. (Root caps with `parent_id == nil` need no index entry.)
- On `:revoke`, you may leave stale index entries for revoked caps (revoked caps remain
  in `caps` marked revoked in this codebase — confirm by reading the revoke handler,
  which marks rather than deletes). If revoked caps are deleted anywhere, prune the index
  there too. The index is an optimization for traversal, not a source of truth.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix compile` → 0 warnings.

### Step 2: Rewrite `descendant_ids` to use the index

Replace the O(caps²) scan with an index walk:
```elixir
defp descendant_ids(children_index, cap_id) do
  case Map.get(children_index, cap_id) do
    nil -> []
    set ->
      kids = MapSet.to_list(set)
      kids ++ Enum.flat_map(kids, &descendant_ids(children_index, &1))
  end
end
```
Update the `:revoke` caller to pass `state.children` instead of `state.caps`. Keep the
result semantics identical (the set of transitive descendant ids).

**Verify**: `cd apps/lattice_stress && ~/.asdf/shims/mix test test/adversarial_authority_test.exs`
→ all pass (this exercises delegation chains + cascade revoke).

### Step 3: Surface `register_cap` failures in grant/delegate

In the `:grant` handler, make storing the cap conditional on a successful
`Topology.register_cap/2`:
```elixir
case Topology.register_cap(tab_id, cap.id) do
  :ok ->
    Audit.record(:grant, %{...})  # keep the existing grant audit
    {:reply, {:ok, cap}, put_in(state, [:caps, cap.id], cap) |> index_child(cap)}
  {:error, reason} ->
    Audit.record(:deny, %{tab_id: tab_id, cap_id: cap.id, reason: reason})
    {:reply, {:error, reason}, state}
end
```
(Adjust to the existing audit ordering; the key change is: do not store-and-register-
ignoring-failure. On failure, do not add the cap to state.) Apply the same pattern in the
`:delegate` handler for `Topology.register_cap(to_tab_id, child.id)` — fold it into the
existing `with` chain: `:ok <- Topology.register_cap(to_tab_id, child.id)`.

**Verify**: `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice_core_poc_test.exs`
→ all pass (covers grant/delegate/revoke happy + denial paths).

### Step 4: Full suite + format

**Verify**: `~/.asdf/shims/mix test` (repo root) → all pass; `~/.asdf/shims/mix format` → exit 0.

## Test plan

- Add a focused test to `apps/lattice_core/test/lattice_core_poc_test.exs` (or a sibling
  cap-store test) covering: a 3-level delegation chain (root → child → grandchild);
  revoking the root marks **all three** revoked (descendant index correctness). Model the
  setup after existing delegation tests in that file.
- The register_cap behavior is hard to unit-test without forcing a disconnect race; at
  minimum assert that a successful grant still registers (existing tests) and that the
  handler no longer ignores the return (code review + the `with`/`case` shape). If a
  deterministic disconnect-injection helper exists in `apps/lattice_stress`
  (`race_concurrency_test.exs`), add a case there; otherwise note it as covered by review.
- Verification: `~/.asdf/shims/mix test` → all pass including the new chain-revoke test.

## Done criteria

ALL must hold:
- [ ] `descendant_ids` walks a `children` index, not the full caps map
      (`grep -n "Enum.filter(fn {_id, cap} -> cap.parent_id" apps/lattice_core/lib/lattice/cap_store.ex` → no matches).
- [ ] State carries `children` (init + reset initialize it; grant/delegate maintain it).
- [ ] `:grant` and `:delegate` no longer ignore `Topology.register_cap/2` — a failure
      prevents storing the cap and returns an error.
- [ ] `cd apps/lattice_core && ~/.asdf/shims/mix compile` → 0 warnings.
- [ ] Full `~/.asdf/shims/mix test` passes; format clean.
- [ ] Public `CapStore` API signatures unchanged; `git status` shows only `cap_store.ex`
      (+ the test file if you added the chain-revoke test there).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:
- The revoke handler **deletes** caps (rather than marking `revoked?`) anywhere — then the
  index must be pruned on delete and on revoke; confirm the lifecycle before assuming
  "mark, don't delete".
- Making grant/delegate fail-closed on `register_cap` error breaks an existing test that
  assumed the cap is stored regardless — that test encodes the current fail-open behavior;
  report it and confirm fail-closed is the intended semantics before changing the test.
- `Topology.register_cap/2` does not actually return `{:error, _}` (read `topology.ex`) —
  if it always returns `:ok`, the register_cap part is moot; do the index part only and
  report.

## Maintenance notes

- The `children` index is an optimization, not the source of truth (`caps[*].parent_id`
  remains authoritative). A reviewer should confirm the two cannot diverge in a way that
  drops a descendant from a cascade revoke (the new chain-revoke test guards this).
- If caps ever start being deleted from state, add index pruning at that site.
