# Plan 184: Enforce revocation on `:transfer` and `:succeed`, and the holder check on the dormant-tick arm (Round 5c SEC-01 and CRYPTO-01)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c57c826ad..HEAD -- apps/lattice_core/lib/lattice/authority.ex apps/lattice_core/test/support/compaction_spike.ex clients/lattice-client/src/authority.ts clients/lattice-client/src/capability.ts apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex apps/lattice_core/test/lattice2/authority_test.exs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S–M
- **Risk**: MED (two added guards in the authority judge; may change verdicts on logs that today honor
  a post-revoke transfer or a dormant seizure across an unseen transfer; three runtimes move together)
- **Depends on**: plans/183-product-scoped-ci-and-legacy-fence.md (so CI runs the right jobs); plan 182 (policy)
- **Category**: security (correctness of the authority judge)
- **Planned at**: commit `c57c826ad`, 2026-10-08

## Why this matters

Round 5c (2026-08-07) recorded two authority-soundness gaps and said "fold into plan 162 step 2b".
Plan 162 was executed without them; both are still in the code at `c57c826ad`:

- **SEC-01**: `decide_transfer/8` and `decide_succeed/8` never consult the revocation set. A holder
  whose delegation chain was revoked can still author a `:transfer` (and, where the cited delegation
  has a revocable ancestor, a `:succeed`). `revoked_as_of?/5` is called only for `:command` ops inside
  `cap_ok/9`. Treehouse uses `:transfer` for admin and moderator handoff (`treehouse/space.ex:195-224`),
  so this is on the product path.
- **CRYPTO-01**: the dormant-ticks succession arm checks only `at_tick >= last_active + dormant_ticks`.
  It never checks that the holder visible at the op's dependencies is still the current holder, which
  the witnessed arm does. A designated successor on a branch that has not seen a concurrent
  `:transfer` can seize the role from the transfer's recipient.

Both fixes are "reject more" guards; they do not change what a valid op means. The three judge
implementations (Elixir, the TypeScript client, and the test-only compaction mirror) must move
together, and new Sim-exported vectors must pin the new verdicts in both runtimes.

## Current state

Elixir, `apps/lattice_core/lib/lattice/authority.ex`:

- `do_analyze/2` builds `revokes = collect_revokes(ordered, delegations, root)` at line 523 and the
  per-role timelines at lines 536–547 by calling
  `build_role_timeline(role, ordered, ancestors, delegations, deleg_valid, policies, continuation)`
  (7 arguments; `revokes` is not passed).
- `build_role_timeline/7` (line 1080) folds `ordered` and dispatches on `role_event/3`:
  `{:transfer, d, at_tick}` → `decide_transfer(st, op, role, d, at_tick, ancestors, deleg_valid, continuation.family)`
  (line 1125); `{:succeed, d, proof}` → `decide_continuation/7` for non-legacy families, else
  `decide_succeed(st, op, role, d, proof, ancestors, deleg_valid, policies)` (lines 1127–1131).
- `decide_transfer/8`, lines 1209–1231:

  ```elixir
  cond do
    not delegation_valid_at?(deleg_valid[d.id], st.acquires, anc) or
      op.author != d.issuer or not MapSet.member?(d.roles, role) ->
      reject(st, op, :invalid_transfer, role)
    holder_at_deps != op.author ->
      reject(st, op, :transfer_not_holder, role)
    st.holder != op.author ->
      reject(st, op, :double_transfer, role)
    family != :legacy and holder_acquire_from(st.acquires, anc) != List.last(st.acquires) ->
      reject(st, op, :double_transfer, role)
    true ->
      record_acquire(st, op, d, at_tick)
  end
  ```
- `decide_succeed/8`, lines 1242–1261: `:invalid_succession` (structural), `:unauthorized_succession`
  (policy successor), `:invalid_recovery_policy`, then `decide_succession_proof/7`.
- Dormant arm, lines 1263–1270:

  ```elixir
  defp decide_succession_proof(st, op, role, d, at_tick, anc, %{dormant_ticks: dormant_ticks})
       when is_integer(at_tick) do
    last_active = last_active_from(st.acquires, st.heartbeats, anc)
    if at_tick < last_active + dormant_ticks,
      do: reject(st, op, :premature_succession, role),
      else: record_acquire(st, op, d, at_tick)
  end
  ```
- Witnessed arm, lines 1289–1290, is the model for the holder check:
  `with %{holder: holder, op_id: holder_epoch} <- holder_acquire_from(st.acquires, anc), true <- st.holder == holder, …`
  and its `else` returns `reject(st, op, :recovery_claim_mismatch, role)`.
- `revoked_as_of?(op, deleg, delegations, revokes, ancestors)`, lines 1572–1579: true when any revoke
  names a delegation in `delegation_chain_ids(deleg, delegations)` and the revoke op is not a causal
  ancestor of `op`. Called once, at line 1514 inside `cap_ok/9`.
- `holder_acquire_from(acquires, anc)`, lines 1648–1652: last acquire whose `op_id` is in `anc`, or `nil`.
- `reject/4`, line 1329: puts `reason` in `st.quarantine` and appends an audit event.

Compaction mirror, `apps/lattice_core/test/support/compaction_spike.ex` (test-only; its GATE tests
compare it against the real pipeline): `seeded_transfer/8` (line 1128) mirrors `decide_transfer`
clause for clause; `seeded_succeed/8` (line 1165) and the dormant arm of `seeded_succession_proof`
(line 1176) mirror `decide_succeed`; `seeded_revoked_as_of?(op, d, ctx)` (line 1436) already exists
with `ctx.revokes` and `ctx.anc`.

TypeScript, `clients/lattice-client/src/authority.ts`:

- `authorityWriteRejectionReason(…)` (line 812) contains the transfer branch, lines 855–882:
  `invalid_transfer` (structural), then `holderAtDeps !== op.author → "transfer_not_holder"`,
  `state.holder !== op.author → "double_transfer"`, the non-legacy double-move check, else `undefined`.
- `successionRejectionReason(…)` (line 884): `invalid_succession`, `unauthorized_succession`, then the
  legacy arm (lines 913–927) computes `lastActive` from visible acquires and heartbeats and returns
  `"premature_succession"` or `undefined`; the witnessed arm (lines 936–949) computes
  `holderAcquire = [...state.acquires].reverse().find(a => visible.has(a.opId))` and returns
  `"recovery_claim_mismatch"` when `state.holder !== holderAcquire.holder`.
- `collectRevokes(…)` (line 1554) exists. The command-path revocation reason helper is in
  `clients/lattice-client/src/capability.ts:95-98` (returns `"revoked_capability" | "lease_expired" | null`).

Vector exporter, `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`: `scenarios/0` (line
187) lists fixed scenarios; each scenario function returns a map with `name`, `kind`, `log`,
`realms`, `perspectives`, `replica`, `realmByPubkey`, `oracleCarrierOps`, `authorityQuarantine`
and raises if the Sim result is not the expected shape. `township_authority_forged_transfer/0`
(lines 1322–1400) is the pattern: build a `Sim` with named realms and a seed, partition, author ops with
`Sim.append/4`, `Sim.command/5`, `Sim.transfer/5`, `Sim.revoke/3`, heal, `Sim.sync_all/1`, then assert
`authority_quarantine(log)` equals the sorted expected list of `[op_id, reason_string]` pairs.
`township_succession_unproven_tick/0` builds a legacy dormant-tick scenario (find it by name).

Tests: `apps/lattice_core/test/lattice2/authority_test.exs`, "behavior 10: ops authored under a revoked
delegation are quarantined" (lines 144–164) is the pattern for revocation tests:

```elixir
{sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post])
sim = Sim.sync_all(sim)
{sim, _r} = Sim.revoke(sim, "server", grant.id)
…
assert {true, :revoked_capability} = Sim.quarantined(sim, "server", after_post.id)
```

The TypeScript conformance harness (`clients/lattice-client/test/conformance.ts`) loads every
`*.json` in `test/vectors` and compares `materialize()`'s quarantine reasons and state with the
vector; a new vector file is picked up with no harness change.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Core suite | `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/lattice2` | 0 failures |
| Compaction GATE | same prefix, `mix test apps/lattice_core/test/lattice2/compaction_spike_test.exs apps/lattice_core/test/lattice2/application_compaction_mirror_test.exs` | 0 failures |
| Regenerate vectors | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && MIX_ENV=test ~/.asdf/shims/mix run -e 'Lattice.ContinuationVectors.write("clients/lattice-client/test/vectors")' && MIX_ENV=test ~/.asdf/shims/mix run -e 'Treehouse.EnrollmentVectors.write("clients/lattice-client/test/vectors")'` | writes files |
| TS build + conformance | `cd clients/lattice-client && npm ci && npm run build && npm run typecheck && npm run conformance && npm run canonical` | all pass |
| Full gate | `~/.asdf/shims/mix check` (same PATH prefix) | 0 failures, Credo clean |
| Shell gates that consume the client | `cd clients/treehouse-tauri-shell && npm ci && npm test` | pass |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/authority.ex`
- `apps/lattice_core/test/support/compaction_spike.ex`
- `clients/lattice-client/src/authority.ts` (and `dist/` rebuilt by `npm run build`)
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (add three scenarios)
- `clients/lattice-client/test/vectors/` (three new files; no existing file may change — see STOP)
- `apps/lattice_core/test/lattice2/authority_test.exs` (two new tests)
- `plans/README.md` row 184

**Out of scope**:
- Any restructuring of `decide_*` (plan 188). Add guards only.
- The legacy dormant-tick arm's existence (operator decision; not this plan).
- `Continuation.judge/7` (R04's family); its own revocation handling is not audited here.
- New reason atoms. Reuse `:revoked_capability` and `:double_transfer`.

## Git workflow

- Branch: `advisor/184-authority-guards` from `origin/main`.
- Commits per step; style like `fix(authority): refuse transfer and succession under a revoked chain`.
- Policy rule 3 applies: this diff touches `authority.ex` and `authority.ts`, so it needs a second
  independent review before merge. Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterize the gaps with failing tests (RED)

Add two tests to `apps/lattice_core/test/lattice2/authority_test.exs`, next to behavior 10:

1. "a holder whose delegation chain is revoked cannot transfer the role": root creates the replica on
   `Lattice.Demo.Thread`; root transfers `:moderator` to realm B via a delegation `d1`
   (`Sim.transfer/5`); sync; root revokes `d1` (`Sim.revoke/3`); sync; B transfers `:moderator` to
   realm C citing a child of `d1`; sync. Assert `{true, :revoked_capability} = Sim.quarantined(sim, "root", transfer_bc.id)`
   and `Authority.holder(Lattice.Demo.Thread, log, :moderator)` is still B.
2. "a dormant-tick succession that has not seen a concurrent transfer is quarantined": use a replica
   whose genesis installs a legacy policy `%{successor: S, dormant_ticks: n}` for the role (see how
   `township_succession_unproven_tick/0` in the exporter installs `policies:` through
   `Sim.create_replica/2`); holder H partitions from S; H transfers the role to B (visible to B, not S);
   S authors `:succeed` with `at_tick` at or above the threshold on its branch; heal and sync. Assert
   `{true, :double_transfer} = Sim.quarantined(sim, "h", succeed.id)` and the holder is B.

Run the core suite: both new tests must FAIL at this step (today the transfer is honored and S seizes).

**Verify**: exactly the two new tests fail; everything else passes.

### Step 2: Thread `revokes` into the role timeline (Elixir)

- Change `build_role_timeline/7` to `/8` by adding a `revokes` parameter after `deleg_valid`; update
  the single call site at lines 536–547 to pass the `revokes` bound at line 523.
- Pass `revokes` into `decide_transfer` (new arity 9) and `decide_succeed` (new arity 9); the
  `ancestors` map is already available in both.
- In `decide_transfer`, insert one clause **after** the `:invalid_transfer` clause and **before**
  `holder_at_deps != op.author`:
  `revoked_as_of?(op, d, delegations, revokes, ancestors) -> reject(st, op, :revoked_capability, role)`.
  `delegations` must also be passed in (it is a parameter of `build_role_timeline`). The order matters:
  structural invalidity first, revocation second, holder checks third, exactly as `cap_ok/9` orders
  validity before revocation.
- In `decide_succeed`, insert the same clause after `:invalid_succession` and before
  `:unauthorized_succession`.

**Verify**: `mix compile --warnings-as-errors` exits 0; the RED transfer test now passes.

### Step 3: Add the holder check to the dormant arm (Elixir)

Change the dormant arm to:

```elixir
defp decide_succession_proof(st, op, role, d, at_tick, anc, %{dormant_ticks: dormant_ticks})
     when is_integer(at_tick) do
  visible_holder =
    case holder_acquire_from(st.acquires, anc) do
      nil -> nil
      %{holder: holder} -> holder
    end

  last_active = last_active_from(st.acquires, st.heartbeats, anc)

  cond do
    st.holder != visible_holder -> reject(st, op, :double_transfer, role)
    at_tick < last_active + dormant_ticks -> reject(st, op, :premature_succession, role)
    true -> record_acquire(st, op, d, at_tick)
  end
end
```

Rationale for `:double_transfer`: it is the reason `decide_transfer` already uses when "a concurrent
transfer by the same holder already moved the token" (line 1222); the dormant claim is the same
anomaly class. Keep this order (holder check before the tick threshold) so the reason is stable.

**Verify**: the RED succession test passes; the core suite is green.

### Step 4: Mirror both changes in the compaction spike

Apply the same two guards to `seeded_transfer/8` (add the revoked clause using
`seeded_revoked_as_of?(op, d, ctx)` in the same position; thread `ctx` in if the function does not
receive it, following how `seeded_succeed`'s callers pass context), to `seeded_succeed/8`, and to the
dormant arm of `seeded_succession_proof` (holder check first, using the mirror's own
`seeded_holder_acquire_at/2` and `tl.holder`).

**Verify**: the compaction GATE tests pass.

### Step 5: Add three exporter scenarios and regenerate vectors

Add to `scenarios/0`, after `township_authority_cross_role_succession_transfer()`:

- `township_authority_revoked_transfer/0` — the Step 1 transfer story on `Township.Matter` with the
  `:clerk` role (clerk → B, root revokes, B → C). Expected quarantine:
  `[[transfer_bc.id, "revoked_capability"]]`; holder remains B; name `"township_authority_revoked_transfer"`.
- `township_authority_revoked_succession/0` — first probe whether a legacy `:succeed` can cite a
  delegation with a revocable ancestor (`succession_delegation?/2` and `Delegation.genesis/3` decide
  this). If it can, build the revoke-then-succeed story and expect `"revoked_capability"`. If it
  cannot (the self-issued succession delegation has no parent, so no earlier revoke can name its
  chain), do **not** fabricate a vector: record that result in this plan's Status section and in the
  README row, and keep the Step 2 guard as defensive code covered by the Elixir unit test only.
- `township_authority_dormant_succession_stale_holder/0` — the Step 1 succession story on the
  `@unproven_succession_replica` shape. Expected quarantine: `[[succeed.id, "double_transfer"]]`;
  holder is B.

Model each on `township_authority_forged_transfer/0`: raise on any unexpected Sim result so the
exporter cannot silently emit a vector that pins the wrong thing. Then regenerate with the command
from the table.

**Verify**: `git status --porcelain clients/lattice-client/test/vectors` lists only the two or three
new files as untracked and **no modified existing file**. If any existing vector changed, STOP.

### Step 6: Port the guards to TypeScript

In `authority.ts`:

- In the transfer branch of `authorityWriteRejectionReason` (lines 855–882), after the
  `invalid_transfer` return and before `transfer_not_holder`, return `"revoked_capability"` when the
  cited delegation's chain is revoked as of `op`. Reuse the revocation evaluation that the command path
  uses (`capability.ts:95-98` and the `collectRevokes` output already computed in
  `analyzeAuthority`); thread the revoke list into the function if it is not already in scope. The
  "as of" rule must match Elixir: a revoke counts unless its op is a causal ancestor of `op`.
- In `successionRejectionReason`, after `invalid_succession` and before `unauthorized_succession`,
  the same check.
- In the legacy arm (lines 913–927), before the `lastActive` computation, mirror the witnessed arm's
  holder lookup and return `"double_transfer"` when `state.holder !== holderAcquire?.holder`
  (treat an undefined `holderAcquire` as `undefined` holder, matching Elixir's `nil`).

Then `npm run build` (the committed `dist/` must be rebuilt) and `npm run conformance`.

**Verify**: `npm run typecheck`, `npm run conformance` and `npm run canonical` pass with the new
vectors present; `git diff --stat clients/lattice-client/dist` shows the rebuilt files.

### Step 7: Full gates and shell consumers

Run `mix check`, both Sobelow scans (per `AGENTS.md`), the Treehouse shell `npm test`, and
`clients/township-tauri-shell` `npm test` if plan 183's fence would run it for a core change (it
would; this is a core change).

**Verify**: all green.

## Test plan

- Elixir: the two new tests in `authority_test.exs` (Step 1), RED then GREEN.
- Vectors: two or three new Sim-exported scenarios, consumed by `conformance.ts` automatically.
- Mirror: existing GATE tests (`compaction_spike_test.exs`, `application_compaction_mirror_test.exs`).
- Property suites in `apps/lattice_core/test/lattice2` (convergence, identical quarantine,
  byte-identical replay) must stay green; they are the proof the guards are pure functions of the DAG.

## Done criteria

- [ ] the two new `authority_test.exs` tests pass; the core suite has 0 failures
- [ ] `grep -n "revoked_as_of?" apps/lattice_core/lib/lattice/authority.ex` shows calls in `decide_transfer` and `decide_succeed` in addition to `cap_ok`
- [ ] the dormant arm contains `st.holder != visible_holder` (or equivalent) before the tick check
- [ ] compaction GATE tests pass
- [ ] `git status --porcelain clients/lattice-client/test/vectors` shows only new files
- [ ] `npm run conformance` passes with the new vectors
- [ ] `mix check` passes; `dist/` rebuilt
- [ ] `plans/README.md` row 184 is one line and names the revoked-succession probe result

## STOP conditions

- Any **existing** vector file changes after regeneration. The guards must not alter verdicts of
  scenarios that never revoke before a transfer or seize across an unseen transfer; a change means the
  guard is misplaced or an existing scenario already exercised the gap. Report the diff.
- `revoked_as_of?/5`'s semantics turn out to require something not available inside
  `build_role_timeline` (it needs `delegations`, `revokes`, `ancestors`; all are in `do_analyze`'s scope).
- The compaction mirror's fold cannot reach `ctx.revokes` at the transfer site without a structural change.
- The TypeScript revocation helper in `capability.ts` has different "as of" semantics than Elixir
  (compare against `revoked_as_of?` before reuse); if they differ, report instead of choosing one.
- A convergence or identical-quarantine property test fails after the change.

## Maintenance notes

- Plan 188 restructures the judge into one guard pipeline; these two guards become rows in its guard
  table. Keep them as separate, named clauses until then so the restructure can be diffed against them.
- If plan 185 (Popcorn judge) returns GO, the TypeScript half of this plan becomes dead code on the
  Treehouse path; it is still required for the Township shell until that shell is retired.
- The README's Round 5c "vetted but NOT planned" entries for SEC-01 and CRYPTO-01 should be annotated
  "now plan 184" by the index update that lands with this plan.

## Review record (2026-10-08)

- Executed by an Opus executor in an isolated worktree; the reviewer re-ran the done criteria,
  read the full diff, and integrated eleven commits onto `claude/round6-plans-182-185`.
- Independent second review (Codex, `gpt-6.1-sol`, high reasoning): REQUEST CHANGES, resolved on the
  same branch before integration:
  1. BLOCKER: `collect_revokes/3` counted `:command`/`:inbox`-kind ops with a `{:revoke, id}` body; the
     TypeScript judge never did, and the new transfer guard turned that into a holder divergence. Fixed
     by `op.kind == :authority` in Elixir and in both mirror comprehensions; two 2026-09-06
     characterization pins in `application_compaction_mirror_test.exs` now expect no revocation; new unit
     test and vector `township_authority_command_shaped_revoke` (fake command quarantines
     `:malformed_command`, transfer honored). `Sim.revoke/3` authors `:authority` ops (`sim.ex:194-195`),
     so the normal path is unchanged. Operator note: this is a one-sided Elixir semantic change, aligned
     to TypeScript, justified by the judge's own rule that quarantined violators confer nothing.
  2. MAJOR, pre-existing: a genesis policy carrying both `dormant_ticks` and `recovery` yields
     `:invalid_recovery_policy` in Elixir and `recovery_certificate_required` in TypeScript. Filed as
     plan row 191; not fixed here.
  3. MINOR: `conformance.ts` compared reason strings only for `capabilityCase` vectors. It now compares
     them whenever a vector carries `authorityQuarantine` (71 vectors, all pass).
  4. Notes accepted as boundaries: clause order agrees across the three judges; the guards also change
     verdicts for a revoke concurrent with the transfer (`:revoked_capability`), for a second concurrent
     dormant claim by the same successor (`:double_transfer`), and for a transfer reusing the revoked
     genesis delegation (`:revoked_capability`); the non-legacy continuation family bypasses both guards
     by design; no crash paths found; the new tests and scenarios are non-vacuous and their seed-ordering
     preconditions are asserted.
- Deviations from the plan text, all documented by the executor: `build_role_timeline` has a second
  call site (`continuation_review_from_log`) that now also receives revokes; `delegations` and `revokes`
  travel as one `{delegations, revokes}` argument to respect Credo's arity cap; TypeScript
  `authorityWriteHonored` also gates on revocation (honored-ness is decided separately from the reason);
  `revokedAsOf` is exported from `capability.ts`; the plan's "as of" sentence was inverted and the code is
  the spec (a revoke counts unless `op.id` is in `ancestors[revoke_op]`).
- Not run: the Township shell has no `npm test` script; its CI steps are the named scripts in
  `flagship.yml`, which plan 183 scopes to Township changes.
- Post-integration finding (Codex connector on PR #107, P1, 2026-10-08): the dormant arm compared
  holder keys, so a round trip (`h -> b -> h`) or a self-transfer the claim never saw left the same
  holder key under a new acquire and the stale claim was honored. All three judges now compare the
  visible acquire with the timeline's last acquire (the idiom the non-legacy transfer arm already
  used); two unit tests and vector `township_authority_dormant_succession_stale_acquire` pin it. Not
  changed: a heartbeat the claim never saw still does not reject it (heartbeats are activity, not
  acquires, and the legacy tick is untrusted by ADR 0004); see the PR comment.

