# Plan 157: Expose role chronology and lease/beacon state as a public Authority surface, and render it in the instrument

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c9a05b40..HEAD -- apps/lattice_core/lib/lattice/authority.ex apps/lattice_core/lib/township/read_model.ex apps/township_web/lib/township_web/instrument_live.html.heex`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED — touches the file that hosts the deterministic authority judge; the
  design below is additive-only, but the blast radius on mistakes is the whole oracle
- **Depends on**: 155 (edits the same roles panel; land 155 first to avoid conflicts)
- **Category**: direction
- **Planned at**: commit `c9a05b40`, 2026-07-18

## Why this matters

Two governance stories are computed inside `Lattice.Authority.analyze/2` and then
discarded. First, **role chronology**: every holder acquisition (`%{op_id, holder,
at_tick}`) is accumulated per role in the timeline state, but `analyze/2` exports only
the *latest* acquire (`holder_epochs`) — there is no way to answer "who has held clerk,
in what order, acquired by which op" without re-reading the log by hand. Second,
**leases and beacons** (plan 149, just merged): valid beacon epochs and per-delegation
`expires_epoch` are computed by private helpers (`collect_beacons/3`,
`collect_delegations/1`), and the only public surface is per-id booleans
(`expired?/2`, `delegation_active?/2`) — you cannot enumerate "which leases exist,
what are their expiry epochs, what is the current beacon frontier". This plan adds a
new public, pure, read-only function — deliberately *beside* `analyze/2`, not inside
it — and renders the result in the instrument's roles panel. The `analyze/2` result
map is consumed by conformance machinery and stays byte-for-byte untouched.

## Current state

- `apps/lattice_core/lib/lattice/authority.ex` (~950 lines) — the deterministic judge.
  - `analyze/2` (line 260) computes, along the way:
    `delegations = collect_delegations(ordered)` (line 266),
    `{beacons, beacon_q} = collect_beacons(ordered, ancestors, root)` (line 271), and
    per-role `timelines` (line 278) whose state includes
    `acquires: [%{op_id, holder, at_tick}]` (timeline init at line 576–583;
    `record_acquire/4` at line 631 appends `%{op_id: op.id, holder: new_holder, at_tick: at_tick}`).
  - The exported result map (lines 319–327) keeps only:
    ```elixir
    %{
      quarantine: ..., reasons: ..., holders: holders,
      holder_epochs: holder_epochs,   # ONLY the last acquire per role (lines 285-294)
      policies: policies, audit: role_audit ++ cmd_audit, requests: requests
    }
    ```
  - `collect_beacons/3` (line 532) returns `{[%{op_id, epoch}], quarantine_map}`;
    validity is causal and root-authored (`classify_beacon/6`, line 547).
  - `expired?/2` (line 221) shows the existing live-path composition pattern this plan
    must copy exactly:
    ```elixir
    # authority.ex:221-241
    def expired?(%Log{} = log, delegation_id) do
      ordered = Log.topo_ops(log)
      ancestors = Dag.all_ancestors(Log.ops(log))
      {commitment, genesis_ids} = deleg_context(log, ordered)
      delegations = collect_delegations(ordered)
      deleg_valid = validate_delegations(delegations, commitment, genesis_ids)
      root = resolve_root(ordered, delegations, deleg_valid, commitment)
      {beacons, _beacon_q} = collect_beacons(ordered, ancestors, root)

      case Map.fetch(delegations, delegation_id) do
        {:ok, %{deleg: %Delegation{} = d}} ->
          d
          |> delegation_chain_links(delegations)
          |> Enum.any?(fn %Delegation{expires_epoch: expires} ->
            expires != nil and Enum.any?(beacons, fn %{epoch: epoch} -> epoch > expires end)
          end)

        _ ->
          false
      end
    end
    ```
  - Delegations carry `expires_epoch` (nil for unleased; see `Lattice.Delegation`
    struct in `apps/lattice_core/lib/lattice/delegation.ex` — check the exact key list
    there before use; `issuer`, `audience`, `roles`, `ops` are used by
    `read_model.ex:227-233`).
- `apps/lattice_core/lib/township/read_model.ex` — `observe/2` builds `roles:` from
  `Authority.analyze/2` (lines 65–70); this is where the new view gets threaded to the
  web layer.
- `apps/township_web/lib/township_web/instrument_live.html.heex` — roles panel at
  lines 392–420 (holders + quarantine strip; plan 155 adds an audit-ledger block —
  this plan's markup goes after it).
- Tests that pin the judge:
  `apps/lattice_core/test/township/lease_property_test.exs` (plan 149 lease behavior),
  `apps/lattice_core/test/lattice/` authority/property suites, and the Sim-exported TS
  conformance vectors (`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`,
  regenerated + compared in CI). None of these may observe any change.
- Sim producers for fixtures: `Lattice.Sim.grant(sim, ..., expires_epoch: n)` and
  `Sim.beacon/3` (`apps/lattice_core/lib/lattice/sim.ex:96,161`); lease lapse
  quarantines `:lease_expired` (see `CLAUDE.md` API reality check).

## Commands you will need

Local toolchain rule (from `AGENTS.md`):

```
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix <task>
```

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| New tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice/authority_observe_test.exs` | all pass |
| Lease properties (regression) | `~/.asdf/shims/mix test apps/lattice_core/test/township/lease_property_test.exs` | all pass, unchanged |
| Vector stability | `~/.asdf/shims/mix lattice.export_vectors` then `git status clients/` | regenerated vectors byte-identical (no diff) |
| Full gate | `~/.asdf/shims/mix verify` | green |
| Strict lint | `~/.asdf/shims/mix check` | green |
| Sobelow (township_web touched) | `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip` | no findings |

(If `mix lattice.export_vectors` writes somewhere other than `clients/`, check the task
source for its output dir and `git status` that dir instead.)

## Scope

**In scope**:

- `apps/lattice_core/lib/lattice/authority.ex` — ONE new public function (+ doc/spec);
  no edits to any existing function body
- `apps/lattice_core/lib/township/read_model.ex` — thread the new view into `roles:`
- `apps/township_web/lib/township_web/instrument_live.html.heex` — render it
- `apps/lattice_core/test/lattice/authority_observe_test.exs` (create)
- `apps/lattice_core/test/township/read_model_test.exs` (extend only — add assertions,
  change none)
- `apps/township_web/test/township_web/instrument_live_test.exs` (extend only)

**Out of scope** (do NOT touch):

- The `analyze/2` result map — no new keys, no reordering, nothing. Consumers
  (ReadModel, CarrierStateReport, vector export, TS conformance) treat it as a
  contract.
- Every private helper in `authority.ex` — the new function composes them read-only.
- `Lattice.Sim`, `Lattice.Delegation`, canonical/wire encoding — plan 149 pinned
  `lattice-delegation-v3` bytes; nothing here may go near encoding.
- The TS client and exported vectors — if regeneration shows ANY diff, that's a STOP.
- `apps/lattice_core/lib/township/carrier_state_report.ex` — a future consumer, not
  this plan.

## Git workflow

- Branch: `advisor/157-authority-observability-surface`.
- Commit style: `feat(authority): public observe/2 chronology and lease view`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `Authority.observe/2`

Add to `authority.ex` (near `analyze/2`) a new public function:

```elixir
@doc """
Read-only observability view beside `analyze/2`: full per-role acquisition
chronology, valid beacon state, and per-delegation lease status at the current
frontier. Purely derived; adds no authority semantics and never affects
`analyze/2` results.
"""
@spec observe(module(), Log.t()) :: %{
        chronology: %{atom() => [%{op_id: Op.id(), holder: Identity.pubkey(), at_tick: non_neg_integer()}]},
        beacons: %{valid: [%{op_id: Op.id(), epoch: non_neg_integer()}], max_epoch: integer() | nil},
        leases: [%{delegation_id: String.t(), expires_epoch: non_neg_integer(),
                   issuer: Identity.pubkey(), audience: Identity.pubkey(), expired?: boolean()}]
      }
def observe(module, %Log{} = log) do
```

Implementation rules:

- Recompute exactly like the `expired?/2` excerpt: `ordered`, `ancestors`,
  `deleg_context`, `collect_delegations`, `validate_delegations`, `resolve_root`,
  `collect_beacons`. Call the same private helpers; do not fork their logic.
- `chronology`: build the per-role timelines exactly as `analyze/2` does (lines
  278–281 — same `build_role_timeline/6` call with the same `policies =
  collect_policies(...)` input) and export each timeline's full `acquires` list.
- `beacons`: the valid list from `collect_beacons`, plus
  `max_epoch = beacons |> Enum.map(& &1.epoch) |> Enum.max(fn -> nil end)`.
- `leases`: delegations where `deleg_valid[id] == :ok` and `expires_epoch != nil`;
  `expired?` computed with the same chain-link rule as `expired?/2` (reuse
  `delegation_chain_links/2` + the beacon comparison — or simply call the existing
  public `expired?(log, id)` per lease; prefer the public call for exactness even
  though it recomputes: correctness beats efficiency here, and this is a display
  path). Sort leases by `delegation_id` for determinism.
- Do not memoize, cache, or restructure anything in the module.

**Verify**: `~/.asdf/shims/mix compile` → exit 0, no warnings;
`git diff apps/lattice_core/lib/lattice/authority.ex` shows ONLY an added function
(and any needed alias) — zero changed existing lines.

### Step 2: core tests

Create `apps/lattice_core/test/lattice/authority_observe_test.exs` using `Lattice.Sim`
against `Township.Matter` (fixture style: `lease_property_test.exs` and
`workflows_test.exs`):

1. **Chronology**: genesis → transfer clerk → succeed clerk; assert the clerk
   chronology lists all acquisitions in order with the expected holders, and
   `List.last(chronology.clerk).holder == analyze(...).holders.clerk` (consistency
   with the judge).
2. **Beacons**: two valid beacons (epochs 1, 5) plus one stale and one non-root
   beacon; assert `valid` has exactly the two, `max_epoch == 5`, and the invalid ones
   are absent (they are already quarantined by `analyze/2` — assert that too, for the
   cross-check).
3. **Leases**: one grant with `expires_epoch: 3`, one without; beacon epoch 5; assert
   exactly one lease entry, `expired?: true`, and that it matches the public
   `Authority.expired?/2` for the same id. Repeat with beacon epoch 2 → `expired?: false`.
4. **Analyze untouched**: for each fixture, snapshot `Authority.analyze(Matter, log)`
   before and after calling `observe/2` and assert exact equality (guards against
   accidental statefulness), and assert the analyze result map's key set is exactly
   `[:audit, :holder_epochs, :holders, :policies, :quarantine, :reasons, :requests]`.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice/authority_observe_test.exs`
→ all pass. Then the regression row: lease properties + full
`~/.asdf/shims/mix test apps/lattice_core/test/` → green.

### Step 3: thread through the read model

In `read_model.ex` `observe/2`, compute `observability = Authority.observe(Matter, log)`
and extend the `roles:` map with **new keys only**:

```elixir
roles: %{
  holders: ...,          # unchanged
  quarantine: ...,       # unchanged
  reasons: ...,          # unchanged
  audit: ...,            # unchanged
  chronology: fingerprint_chronology(observability.chronology),
  beacons: observability.beacons |> Map.update!(:valid, &Enum.sort_by(&1, fn b -> b.op_id end)),
  leases: fingerprint_leases(observability.leases)
}
```

with private helpers converting pubkeys to fingerprints via `Identity.fingerprint/1`
(the established pattern — see `fingerprint_holders/1` at `read_model.ex:186`).

Extend `read_model_test.exs` with assertions that the three new keys exist and carry
the fixture's expected values; change no existing assertion.

**Caution**: `AuditBundle.audit_json/1` consumes `roles` but selects only
`reasons`/`holders`/`quarantine`/`audit` explicitly (`audit_bundle.ex:123-146`), so new
keys must not change bundle bytes. Prove it: `~/.asdf/shims/mix test
apps/lattice_core/test/township/audit_bundle_test.exs` must pass unchanged. If any
bundle byte assertion fails, STOP.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/township/` → all green.

### Step 4: render in the roles panel

In `instrument_live.html.heex`, after the plan-155 ledger block (or after the
quarantine strip if 155 hasn't landed — but it should land first), add:

- **Role chronology**: per role, an ordered list `holder fingerprint · acquired by
  <code>op(0,12)</code> · tick N`, wrapped in `data-role-chronology={role}`.
- **Leases & beacons strip**: "Beacon frontier: epoch N" (or "no valid beacons"),
  then one row per lease: delegation id (12 chars), issuer→audience fingerprints,
  `expires_epoch`, and a status word — `lapsed` when `expired?`, else `active` —
  with `data-lease-status={...}`. Copy the existing panel idioms (`field-label`,
  `data-*` hooks, `:for` comprehensions).

Extend `instrument_live_test.exs`: with the standard fixture, assert
`data-role-chronology` renders for clerk with ≥1 entry; if the shared fixture has no
leases/beacons, assert the "no valid beacons" empty-state string renders (do NOT
modify shared fixtures to force a lease — note it in your report instead).

**Verify**:
`~/.asdf/shims/mix test apps/township_web/test/township_web/instrument_live_test.exs`
→ all pass.

### Step 5: full gates + vector stability

**Verify**, in order:
1. `~/.asdf/shims/mix lattice.export_vectors` then `git status` on its output dir →
   **no modified files** (byte-identical vectors; the judge is untouched).
2. `~/.asdf/shims/mix verify` → green.
3. `~/.asdf/shims/mix check` → green.
4. `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip` → no findings.

## Test plan

Steps 2–4 name every case. Structural patterns: `lease_property_test.exs` (Sim lease
fixtures), `read_model_test.exs`, `instrument_live_test.exs`. The decisive regression
gates are the analyze-equality assertion (2.4), the audit-bundle byte stability
(Step 3), and vector regeneration (Step 5.1).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice/authority_observe_test.exs` exits 0 (cases 1–4)
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/` exits 0 with zero modified existing assertions (`git diff --stat` on existing test files shows additions only)
- [ ] `git diff apps/lattice_core/lib/lattice/authority.ex` contains no `-` lines on existing code (pure addition)
- [ ] Vector regeneration produces no diff
- [ ] `~/.asdf/shims/mix verify`, `mix check`, and township_web sobelow all exit 0
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` status row for 157 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `analyze/2`, `expired?/2`, the timeline init, or `collect_beacons/3` differ from the
  excerpts (the judge moved — it is the most contested file in the repo; reconcile
  with `git log --oneline -10 -- apps/lattice_core/lib/lattice/authority.ex`).
- Implementing `observe/2` seems to require *changing* any private helper's signature
  or behavior — the composition is meant to be read-only reuse; if it can't be, the
  design assumption failed.
- Vector regeneration, the lease property suite, or the audit-bundle byte tests show
  ANY diff/failure.
- The bundle/README work tempts you to add `chronology`/`leases` to `audit.json` —
  that changes verified bundle bytes and is a bundle-schema decision for the operator,
  not this plan.
- A parallel session has already added an observability surface to `authority.ex`
  (check for `def observe` before starting) — reconcile rather than duplicate.

## Maintenance notes

- This creates a second derivation path over the same private helpers as `analyze/2`;
  if a future plan changes lease/beacon semantics, both `observe/2` and `expired?/2`
  must move together — the consistency tests (2.3, 2.4) are the tripwire.
- Plan 154's HTML audit report should gain a chronology + leases section once this
  lands (explicitly deferred; it reads `ReadModel.observe` so the data is now there —
  but adding it to `audit.json`/bundle bytes is a schema decision, see STOP above).
- Performance: `observe/2` re-runs topo-sort/ancestors like every other public entry
  point (`expired?/2` does too). Fine at POC scale (≤10k participants was never
  reached in logs this size); if profiling ever shows it hot, cache at the caller, not
  in `Authority`.
- Reviewer scrutiny: the pure-addition diff on `authority.ex`, and that lease
  `expired?` delegates to the existing public function rather than re-deriving.
