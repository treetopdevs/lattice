# Plan 167: A divergence explainer — turn "two binaries differ" into an answer

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- apps/lattice_core/lib/township apps/lattice_core/lib/lattice/log.ex apps/lattice_core/lib/lattice/authority.ex apps/lattice_node_spike/lib apps/lattice_core/lib/mix/tasks
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 — nothing is broken today. This is a capability the next milestone needs and
  cannot currently produce.
- **Effort**: M (coarse — this is a direction plan, so the estimate is looser than a fix plan's)
- **Risk**: LOW — a pure function over data both replicas already hold. It changes no runtime path,
  adds no custody surface, and runs only on failure.
- **Depends on**: `plans/162-authority-root-binding.md` (plan 167 consumes
  `Authority.analyze/2` and must describe the post-root-binding verdicts).
- **Category**: direction
- **Planned at**: commit `764a1945`, 2026-07-29
- **Reconciled at**: commit `91bb6ca6`, 2026-07-29

## Why this matters

Every convergence claim in this repo is a byte-equality assertion on an opaque blob. The oracle is
`:erlang.term_to_binary(state, [:deterministic, ...])`, and the assertion is `assert bytes_a == bytes_b`.
When it holds, that is a strong claim. When it fails, the operator gets "two binaries differ" and
nothing else — no indication of which op is missing, which field diverged, or which realm quarantined
what.

That is survivable inside a deterministic ExUnit harness where you can re-run with a debugger. It is
**not** survivable in the setting the project is heading into. `plans/158-real-device-beta-poc-program-map.md`
schedules a seven-day, 5–10-person pilot whose exit criterion is literally "no **unexplained** state
loss/divergence" — two physical devices, real networks, offline windows, force-stops, reboots. No
ticket in plan 158 builds the tool that would explain one.

The inputs already exist and are already public: `Log.op_ids/1`, `Log.frontier/1`,
`Log.quarantine/1`, and `Authority.analyze/2`'s `reasons` map. Nothing needs to be computed that
isn't. What is missing is roughly one pure module that diffs two of them and says: *op X is present
only on A; the first differing field is `posts`; B quarantined op Y as `:not_holder` while A honored
it.* A red assert becomes a one-line answer.

This is a **design/spike plan**: the deliverable is a working explainer plus a decision record about
its output shape, not a large feature. Scope it that way.

## Current state

### Where convergence is asserted today

`apps/lattice_node_spike/lib/lattice_node_spike/township_scenario.ex:128-132` — the universal oracle
reduces a log to one opaque binary:

```elixir
Lattice.state(Matter, log) |> :erlang.term_to_binary([:deterministic, ...])
```

Every convergence claim compares two of those:

- `apps/lattice_node_spike/test/township_carrier_test.exs:146-149` and `:164`
- `apps/lattice_carrier_server/test/lattice_carrier_server_test.exs:90`

No diff or compare helper exists anywhere. Verified:

```sh
grep -rn 'def diff\|def compare\|divergen' apps/lattice_core/lib apps/township_web/lib apps/lattice_carrier_server/lib
```

returns only a doc comment in `apps/lattice_core/lib/lattice/graph/replica_snapshot.ex:34`.

### The inputs, all already public

`apps/lattice_core/lib/lattice/log.ex`:

```elixir
  @spec op_ids(t()) :: MapSet.t(Op.id())
  def op_ids(%__MODULE__{ops: ops}), do: ops |> Map.keys() |> MapSet.new()

  @spec topo_ops(t()) :: [Op.t()]
  def topo_ops(%__MODULE__{ops: ops}), do: Dag.topo_sort(ops)

  @spec frontier(t()) :: [Op.id()]
  def frontier(%__MODULE__{ops: ops, referenced: referenced}) do

  @spec quarantine(t()) :: [quarantine_entry()]
  def quarantine(%__MODULE__{quarantine: q}), do: Enum.reverse(q)

  @spec verified_quarantine(t()) :: ...
```

`apps/lattice_core/lib/lattice/authority.ex:255-320` — `analyze/2` returns a map including
`quarantine` (a `MapSet` of op ids), `reasons` (op id → reason atom), `holders` (role → holder),
`holder_epochs`, and `audit`. Note from a prior review: the `audit` list contains **only quarantine
events** — the full acquisition chronology is internal timeline state, not exposed. Do not assume
`audit` gives you a role history.

`apps/lattice_core/lib/township/read_model.ex:65-73` already consumes exactly these fields for the
instrument, so the shapes are known-good to work with.

### Where an explainer would plug in

- **Test failure messages** — the byte-equality asserts listed above.
- **Two audit bundles.** `apps/lattice_core/lib/township/audit_bundle.ex` exposes
  `write(dir, log, opts)` and `verify(dir)`, and `matter.log` (a `Log.dump/2` output) is its trusted
  root. Two bundles from two devices is exactly the pilot-support case.
- **A mix task**, following `apps/lattice_core/lib/mix/tasks/lattice.township.verify_bundle.ex`:

```elixir
defmodule Mix.Tasks.Lattice.Township.VerifyBundle do
  @moduledoc """
  Verify a Township outsider audit bundle from its `matter.log` root.

      mix lattice.township.verify_bundle --dir artifacts/township
  """

  use Mix.Task

  alias Township.AuditBundle

  @shortdoc "Verify a Township outsider audit bundle"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} = OptionParser.parse(argv, strict: [dir: :string])

    case {opts[:dir], rest, invalid} do
      {dir, [], []} when is_binary(dir) and dir != "" -> verify(dir)
      _other -> Mix.raise("usage: mix lattice.township.verify_bundle --dir PATH")
    end
  end
  ...
```

Match this shape exactly: `OptionParser.parse` with `strict:`, a `Mix.raise` usage message,
`@shortdoc`, and `Mix.shell().info/1` for output.

### Repo conventions to follow

- Modules under `apps/lattice_core/lib/township/` carry `@moduledoc` and `@spec`. All code is
  `mix format`-clean and passes `mix credo --strict`.
- Township tests live in `apps/lattice_core/test/township/`. Read
  `apps/lattice_core/test/township/audit_bundle_test.exs` for the fixture-construction pattern
  (building a `Sim`, producing a log, writing a bundle).
- `Lattice.Sim`'s public surface — `new/4`, `create_replica/2`, `grant/4`, `transfer/5`, `succeed/4`,
  `command/5`, `partition/3`, `heal/3`, `sync_all/1`, `state/2`, `log/2`, `quarantined/3` — is how
  divergent logs are constructed in tests. See `CLAUDE.md`'s "API reality check" section for exact
  signatures; do not invent parallel APIs.

## Commands you will need

**Toolchain**: invoke mix as `~/.asdf/shims/mix`.

| Purpose | Command | Expected on success |
|---|---|---|
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 |
| Township tests | `~/.asdf/shims/mix test apps/lattice_core/test/township/` | all pass |
| The new test | `~/.asdf/shims/mix test apps/lattice_core/test/township/divergence_test.exs` | all pass |
| Node-spike carrier test | `~/.asdf/shims/mix test apps/lattice_node_spike/` | all pass |
| Credo | `~/.asdf/shims/mix credo --strict` | exit 0 |
| Run the new task | `~/.asdf/shims/mix lattice.township.explain_divergence --a DIR_A --b DIR_B` | prints a report |

## Scope

**In scope**:

- `apps/lattice_core/lib/township/divergence.ex` (create)
- `apps/lattice_core/lib/mix/tasks/lattice.township.explain_divergence.ex` (create)
- `apps/lattice_core/test/township/divergence_test.exs` (create)
- `apps/lattice_node_spike/test/township_carrier_test.exs` (failure-message enrichment only)
- `apps/lattice_carrier_server/test/lattice_carrier_server_test.exs` (failure-message enrichment only)
- `AGENTS.md` (one line in "Where the docs are" or the command list, if the task warrants mention)
- `plans/README.md` (status row)

**Out of scope**:

- **Replacing or weakening any byte-equality assertion.** The opaque comparison stays exactly as it
  is — it is the oracle. The explainer runs *only when it fails*, to describe the failure. If you
  find yourself changing what is asserted, STOP.
- **Any change to `Lattice.Log`, `Lattice.Authority`, `Lattice.Reduce`, or `Township.Matter`.** The
  explainer is a consumer of existing public functions. If you need a new public function to write
  it, that is a real finding — report it rather than adding one, because the substrate surface is
  deliberately small.
- **`Township.AuditBundle`'s format.** Reading `matter.log` via the existing `Log.restore/1` path is
  fine; changing what a bundle contains is not.
- **Any TypeScript work.** A TS-side explainer is a reasonable follow-on and is explicitly deferred.
- **Anything touching custody, the carrier, or authoring.** This is a read-only diagnostic.
- **Performance work.** The explainer runs on failure, not in a hot path. Do not optimize it.

## Git workflow

- Branch: `advisor/167-divergence-explainer`
- Conventional commits, e.g. `feat(township): explain log divergence instead of asserting bytes differ`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Decide the output shape, and write it down first

This is a design plan, so the first deliverable is a decision, not code. Write the target output —
literally, as a code comment or a `@moduledoc` example — before implementing.

The proposed shape, to accept or amend:

```elixir
%{
  converged?: false,
  only_in_a: [op_id],            # ops A has that B does not
  only_in_b: [op_id],            # ops B has that A does not
  frontier_a: [op_id],
  frontier_b: [op_id],
  state_mismatches: [
    %{field: :posts, a: ..., b: ...}   # per-field, in schema order
  ],
  quarantine_delta: [
    %{op_id: id, reason_a: :not_holder, reason_b: nil}
  ],
  holder_delta: [
    %{role: :clerk, a: "realm:x", b: "realm:y"}
  ],
  structural_delta: [
    %{op_id: id, a: :bad_signature, b: nil}   # from Log.quarantine/1
  ]
}
```

Design constraints to honor, and to state in the `@moduledoc`:

- **The oracle is unchanged.** Divergence is still *defined* by byte inequality; this map only
  describes it. If the map is empty but bytes differ, the explainer is incomplete — see step 4.
- **Deterministic output.** Sort every list by op id (or schema field order) so two runs of the
  explainer on the same pair produce identical output. This module is a diagnostic for a
  determinism-obsessed system; non-deterministic output would be a bad joke.
- **No secrets, no key material.** The output may be pasted into an issue. Op ids, realm labels,
  field names, and reason atoms only. If a field value could be participant content (e.g. a `post`
  body), decide whether to include it, truncate it, or fingerprint it — **state the decision and its
  reasoning in the moduledoc.** For pilot support, a truncated preview is probably right; for a
  civic tool, unbounded content in a paste target is probably wrong.
- **Both structural and authority quarantine.** They are different namespaces: structural reasons
  live on the log (`Log.quarantine/1`, e.g. `:bad_signature`), authority reasons come from
  `Authority.analyze/2`'s `reasons`. A divergence can come from either, and conflating them will
  mislead exactly when it matters.

**Verify**: the decision is written into `apps/lattice_core/lib/township/divergence.ex`'s
`@moduledoc` before any logic exists.

### Step 2: Implement `Township.Divergence.explain/2`

Create `apps/lattice_core/lib/township/divergence.ex` with a single public function:

```elixir
@spec explain(Log.t(), Log.t()) :: map()
def explain(%Log{} = a, %Log{} = b)
```

Build it from the existing public inputs only:

- op-set difference — `Log.op_ids/1` on both, `MapSet.difference/2` both ways
- frontier — `Log.frontier/1` on both
- state — `Lattice.state(Matter, log)` on both, compared field by field in schema order
- authority — `Authority.analyze(Matter, log)` on both; diff `reasons` and `holders`
- structural — `Log.quarantine/1` on both

Keep it a pure function. No process, no IO, no side effects.

If the two logs have different `replica` strings, that is not a divergence — it is a category error.
Return an explicit `%{error: :different_replicas, a: ..., b: ...}` rather than a misleading diff.

**Verify**:

```sh
~/.asdf/shims/mix compile --warnings-as-errors
~/.asdf/shims/mix credo --strict
```

→ both exit 0.

### Step 3: Write the tests, driving each divergence class deliberately

Create `apps/lattice_core/test/township/divergence_test.exs`. Model the fixture construction on
`apps/lattice_core/test/township/audit_bundle_test.exs`.

Cover, one test per class — each constructed with `Lattice.Sim` so the divergence is real, not
synthetic:

1. **Converged** — two synced logs. `explain/2` reports `converged?: true` and every delta empty.
   This is the most important test: a false positive makes the tool useless.
2. **Missing op** — partition, author on A only, do not heal. `only_in_a` names exactly that op;
   `state_mismatches` names the affected field.
3. **Authority quarantine divergence** — one realm quarantines an op the other honors (a stale
   post-transfer command is the canonical case; see how `township_carrier_test.exs` builds its
   `:not_holder` scenario). `quarantine_delta` names the op and both reasons.
4. **Holder divergence** — the two logs disagree on the current role holder. `holder_delta` names the
   role and both holders.
5. **Structural quarantine divergence** — one log has a `:bad_signature` entry the other does not.
   `structural_delta` names it, and it does **not** appear in `quarantine_delta`.
6. **Different replicas** — returns `{:error, :different_replicas}`-shaped output, not a diff.
7. **Determinism** — `explain(a, b)` called twice returns identical output; and `explain(b, a)` is
   the mirror image (every `only_in_a` is the other's `only_in_b`).

**Verify**:

```sh
~/.asdf/shims/mix test apps/lattice_core/test/township/divergence_test.exs
```

→ all pass, 7 tests.

### Step 4: Prove the explainer is complete against the oracle

This is the step that makes the tool trustworthy. Add a property-style test asserting the **contract
between the explainer and the oracle**:

> For any two logs on the same replica: if the oracle bytes differ, `explain/2` must report at least
> one non-empty delta. And if the oracle bytes are equal, `explain/2` must report `converged?: true`.

Use the existing StreamData generators the repo already has for convergence properties — see
`apps/lattice_core/test/township/` and `apps/lattice_stress/test/` for the established generator
patterns (`convergence_property_test.exs`, `matter_property_test.exs`).

An explainer that returns "no differences" on a genuinely divergent pair is worse than no explainer,
because it will be trusted. This property is the guard against that.

**Verify**:

```sh
~/.asdf/shims/mix test apps/lattice_core/test/township/
```

→ all pass. If the property fails, the explainer is missing a divergence class — find it and add it
(the likely candidates are CRDT-internal ordering and fields not covered by the field-by-field
comparison).

### Step 5: Add the mix task

Create `apps/lattice_core/lib/mix/tasks/lattice.township.explain_divergence.ex`, modeled **exactly**
on `lattice.township.verify_bundle.ex` (shown in "Current state"):

```
mix lattice.township.explain_divergence --a artifacts/device_a --b artifacts/device_b
```

It should load `matter.log` from each directory via the same path `AuditBundle` uses, call
`Township.Divergence.explain/2`, and print a human-readable report through `Mix.shell().info/1`.

Print, in this order: a one-line verdict, then only the non-empty sections. An operator reading this
at 11pm during a pilot should get the answer in the first three lines.

Support `--format json` for machine consumption; default to the human-readable form.

**Verify**: write two bundles from the divergent fixture in step 3's test 2, then:

```sh
~/.asdf/shims/mix lattice.township.explain_divergence --a <dir_a> --b <dir_b>
```

→ prints a report naming the missing op and the affected field. Also verify the usage error:

```sh
~/.asdf/shims/mix lattice.township.explain_divergence
```

→ raises with a usage message, matching `verify_bundle`'s behavior.

### Step 6: Wire it into the existing convergence assertions

In `apps/lattice_node_spike/test/township_carrier_test.exs` and
`apps/lattice_carrier_server/test/lattice_carrier_server_test.exs`, enrich the **failure message** of
the byte-equality asserts so a red run prints the explanation.

The assertion itself does not change — only its message:

```elixir
assert bytes_a == bytes_b, """
Township state diverged between realms.

#{inspect(Township.Divergence.explain(log_a, log_b), pretty: true, limit: :infinity)}
"""
```

Confirm the explainer is only invoked on failure (ExUnit evaluates the message lazily for `assert`
with a message — verify this rather than assuming; if it is eager, guard it).

**Verify**:

```sh
~/.asdf/shims/mix test apps/lattice_node_spike/ apps/lattice_carrier_server/
```

→ all pass. Then deliberately break one assertion (compare A against a third, divergent log),
confirm the failure output contains the explanation, and revert.

### Step 7: Full gate

```sh
~/.asdf/shims/mix check
~/.asdf/shims/mix test apps/lattice_core/test/township/
~/.asdf/shims/mix test apps/lattice_node_spike/
~/.asdf/shims/mix test apps/lattice_carrier_server/
```

→ all exit 0.

## Test plan

- **New file**: `apps/lattice_core/test/township/divergence_test.exs`, 7 tests (step 3) plus the
  oracle-completeness property (step 4). Model fixture construction on
  `apps/lattice_core/test/township/audit_bundle_test.exs`.
- **The property is the load-bearing test**: bytes differ ⟹ at least one non-empty delta; bytes equal
  ⟹ `converged?: true`.
- **Manual verification**: the mix task on two real bundles from a divergent fixture (step 5), and the
  deliberately-broken assertion (step 6).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `apps/lattice_core/lib/township/divergence.ex` exists with `@moduledoc` and `@spec`
- [ ] The `@moduledoc` states the output shape, the determinism guarantee, and the decision about participant content in field values
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/divergence_test.exs` passes with 7 tests plus the property
- [ ] `~/.asdf/shims/mix lattice.township.explain_divergence --a DIR --b DIR` prints a report on two divergent bundles, and raises a usage message with no args
- [ ] `--format json` produces parseable JSON
- [ ] `explain(a, b)` called twice returns identical output (asserted in the test)
- [ ] A deliberately broken convergence assertion prints the explanation (demonstrated and reverted)
- [ ] `~/.asdf/shims/mix check` exits 0 (includes `credo --strict`)
- [ ] `~/.asdf/shims/mix test apps/lattice_node_spike/` and `apps/lattice_carrier_server/` pass
- [ ] No byte-equality assertion was weakened — `git diff` shows only message changes at those sites
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 167 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Step 4's completeness property fails and you cannot find the missing divergence class.** Report
  the counterexample. A partial explainer is fine and useful — but it must *say* it is partial, and
  that is a moduledoc decision the operator should make.
- **You need a new public function on `Lattice.Log`, `Lattice.Authority`, or `Lattice.Reduce`** to
  compute a delta. That is a real finding about the substrate's read surface (a public
  `Authority.observe/2` is already proposed as `plans/157-authority-observability-surface.md`) — report
  it rather than widening the API inside a diagnostic plan.
- **The explainer would need to include participant content** (post bodies, member names) to be
  useful, and you are unsure whether that is acceptable in a paste target. That is a privacy decision
  for a civic tool — ask.
- **ExUnit evaluates the assertion message eagerly**, making the explainer run on every passing
  assertion. Guard it or report it; a diagnostic that costs two full `Authority.analyze/2` passes per
  passing assertion is a performance regression in the test suite.
- You find yourself changing what the convergence assertions assert.

## Maintenance notes

- **Reviewer focus**: the completeness property from step 4. Everything else is presentation; that
  property is what makes the tool safe to trust. Also check that the byte-equality assertions are
  genuinely unchanged.
- **This is deliberately Elixir-only.** The pilot in plan 158 puts a TypeScript/Rust app on two
  physical devices, so a TS-side explainer — or an exported diff both runtimes can produce — is the
  obvious follow-on. It is out of scope here because it depends on an unsettled question: whether the
  audit bundle gets a cross-runtime format at all (the current bundle's trusted root is
  `Log.dump/2`'s `:erlang.term_to_binary` output, which no non-BEAM outsider can read). That question
  is a separate direction finding and deserves its own plan.
- **The explainer will need updating when a new divergence class appears** — a new CRDT field type, a
  new quarantine namespace, a new authority concept. The step-4 property is what will tell you: it
  will start failing on a pair the explainer cannot describe. Treat that failure as the signal it is,
  not as a flaky property.
- **Related surfaced-but-unplanned work**: reason atoms currently span three namespaces (structural in
  `log.ex`, ~31 authority atoms in `authority.ex`, election-side reasons in `projector.ex` and
  `unanimous_boxes_v1.ex`), and the election ones surface nowhere human-readable. A unified
  quarantine-reason dictionary has been discussed and deferred pending plans 154 and 156. If it lands,
  this explainer should render through it rather than printing raw atoms.
