# Plan 162: Close the five authority-judge binding gaps (root, genesis authorship, replica, tick shape)

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 764a1945..HEAD -- apps/lattice_core/lib/lattice/authority.ex clients/lattice-client/src/authority.ts apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex clients/lattice-client/test/vectors
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: **P0** — this is the V-01 / prime-directive class. Two of the three defects let a
  participant escalate their own authority; the third is a BEAM↔TypeScript divergence, which the
  build map names a STOP condition.
- **Effort**: M — pre-Round-5 estimate was ~30 lines across two files; Round 5 step 2b
  expands the production change across `authority.ex`, `authority.ts`, and `capability.ts`,
  plus exporter/tests/vectors. The work remains the adversarial vectors, the vector-
  regeneration diff, and proving each predicate is load-bearing.
- **Amended 2026-08-06 (Round 5)**: two further guards added as step 2b — `cap_ok/8` replica
  binding and malformed-tick rejection. Both are predicates that reject more; neither changes
  succession semantics, so the effort and risk grades below are unchanged and the
  "succession vectors stay byte-identical" STOP condition still holds. The **provenance** of
  `at_tick` is explicitly **not** in this plan — see `plans/175-succession-tick-provenance-spike.md`.
  **Executed 2026-08-08** — see "Execution evidence — step 2b amendments" below.
- **Risk**: MED — the change makes previously-`:ok` delegations invalid, which **will** change the
  quarantine reason recorded in at least one existing exported vector. Step 5 makes that explicit
  and enumerable rather than a surprise.
- **Depends on**: `plans/161-close-verification-gaps.md` (recommended — land the CI baseline first,
  so the suites that would catch a mistake here actually run)
- **Category**: security / bug
- **Planned at**: commit `764a1945`, 2026-07-29

## Authorized execution amendment (2026-07-29)

The first GREEN full-suite run exposed one pinned forged-transfer expectation in
`apps/lattice_core/test/township/export_vectors_test.exs`. Step 5 requires that expectation to move
from `transfer_not_holder` / `not_holder` to `invalid_transfer` / `invalid_capability`, but the test
file was accidentally omitted from the strict in-scope list. The operator authorized adding that
file to scope solely for the predicted expectation update and its explanatory assertion text.

The checkpoint reviews then showed that the same succession-candidate classification must survive
the existing compaction spike or a compacted log can disagree with the full authority analyzer.
The operator authorized the narrow addition of
`apps/lattice_core/test/support/compaction_spike.ex` and its existing test file to Plan 162 scope.

## Execution evidence (2026-07-29)

**DONE.** The prescribed RED/GREEN boundaries, mutation checks, two-reviewer feedback loop, and
completion gate are complete on `codex/round4-security-reliability`.

Prescribed implementation commits:

1. `7d5e0c06` — RED root-binding probes.
2. `5828f7cd` — Elixir root binding.
3. `995a295e` — authorized vector-test scope amendment.
4. `014dca84` — regenerated and enumerated vectors.
5. `1e2273cd` — TypeScript root binding.
6. `d5dd5ccf` — policy-binding mutation evidence.
7. `61354274` — initial execution record.

Immediate review-fix commits:

1. `65cdc61f` — succession candidates remain root-bound without becoming ordinary genesis roots;
   descendant capability laundering and genesis poisoning fail closed in both runtimes.
2. `a8c94759` — succession candidate chains survive compaction without becoming globally valid.
3. `9a0b0905` — retained succession-transfer compaction regression.
4. `9ef38b8c` — non-genesis root reasons, rooted-grant-as-genesis rejection, and cross-role
   succession-transfer isolation.
5. `ac6a17e4` — TypeScript authority-kind gating plus declared-role and role-scoped compaction
   invariants.
6. `ea0b8717` — positive covered-succession activation and all-evidence kind-guard regressions.
7. `7145fe65` — every evidence-bearing operation is checked; the heartbeat dormancy boundary and
   the previously shadowed policy/succession/invalid-genesis guards are mutation-detectable.
8. `bed149e1` — the sole heartbeat boundary fixture now fails loud if its preconditions drift.

RED evidence included the original forged post and replayed-policy attacks; descendant capability
laundering; succession-candidate genesis poisoning; a parented delegation presented as genesis;
cross-role candidate transfer; undeclared-role and cross-role compaction leakage; covered
capability/transfer activation; command-kind authority evidence; and the heartbeat dormancy
boundary. Each behavioral reviewer finding received a focused failing regression or a named
mutation failure before its smallest correction.

Final GREEN:

- `mix check`: 26 properties and 331 lattice-core tests, every umbrella app, 94
  lattice-carrier-server tests, and strict Credo all pass.
- TypeScript build, typecheck, conformance, V-01 guard, canonical bytes, Township authoring, and
  carrier/Township suites all pass.
- The compaction GATE passes one property and seven focused tests, including byte-identical state,
  quarantine reasons, holders, and requests across the new succession cases.
- An earlier full-suite run exposed the pre-existing carrier Holder timeout under load; its focused
  test passed immediately, and every subsequent full gate completed with all 94 carrier tests
  green. No carrier durability behavior changed.

Changed vector corpus, exhaustively:

- `township_authority_forged_transfer.json`: the forged root-less transfer now fails at delegation
  validation, moving `transfer_not_holder` / `not_holder` to the stronger
  `invalid_transfer` / `invalid_capability` reasons.
- `township_authority_unrooted_grant.json` (new): pins rejection of a self-issued delegation
  introduced by a grant.
- `township_authority_replayed_genesis.json` (new): pins genesis author binding, holder stability,
  and the root-authored succession policy.
- `township_authority_rooted_transfer_not_holder.json` (new): restores direct
  `transfer_not_holder` coverage with a valid rooted delegation.
- `township_authority_succession_capability_laundering.json` (new): an unhonored candidate and its
  descendants cannot authorize commands.
- `township_authority_rooted_grant_as_genesis.json` (new): a valid parented delegation cannot be
  repackaged as genesis or inject policy.
- `township_authority_succession_genesis_poisoning.json` (new): a succession candidate cannot be
  replayed as genesis while its legitimate succession path still works.
- `township_authority_nongenesis_root.json` (new): a root-less self-issued delegation introduced
  outside genesis/succession stays invalid with the cross-runtime reason pair pinned.
- `township_authority_cross_role_succession_transfer.json` (new): a candidate activated for one
  role cannot authorize a transfer for another role.

No other vector changed.

Claude and Agy both reviewed the implementation and every security review-fix range. All verified
findings were corrected and rechecked. Their terminal reviews report no actionable findings; Agy
withdrew one stale mutation-coverage claim after the exact poisoning-vector failure was reproduced.
Claude's generated-vector drift observation is intentionally **not** represented as complete here:
Plan 164 owns the required generated-output drift detector and remains scheduled last.

## Execution evidence — step 2b amendments (2026-08-08)

**DONE.** The two Round 5 guards are implemented with their prescribed tests and mutation
evidence; the earlier Round 4 record above is unchanged.

- **2b(d)** — `cap_ok/8` binds the cited delegation's replica to the op's replica
  (`:wrong_replica`, between the audience and grant-scope clauses). The same comparison was added
  to `validate_delegation` (now /6, threading `log.replica`), placed **below** the
  genesis/succession/impostor arms so the pinned `:impostor_genesis` reason and succession
  candidacy are unchanged — a same-root *sibling* chain still validates through the genesis arm
  and is refused at use time by `cap_ok/8`. Mirrored in TypeScript in
  `capabilityQuarantine` (`capability.ts`) and `delegationValidation` (`authority.ts`).
- **2b(e)** — `role_event/3` admits a tick into a role timeline only when
  `is_integer(tick) and tick >= 0 and tick <= Lattice.Canonical.max_integer()`
  (`portable_tick?/1`); a malformed tick returns `nil` (the existing "not a role event" signal).
  Non-integer succession proofs (e.g. `{:witnessed, certificate}`) still flow to
  `decide_succession_proof/7` unchanged. TypeScript already refused these — no TS change.

Mutation evidence (each guard reverted one at a time, then restored):

1. Reverting the `cap_ok/8` replica arm: the cross-replica replayed post is **honored**
   (`Sim.quarantined/3` returns `false`) — the vulnerability reproduced exactly as described.
2. Reverting the `validate_delegation` arm: the foreign root-less introduction falls back to
   `:unrooted_delegation` instead of `:wrong_replica`.
3. Reverting the `role_event/3` heartbeat guard: the second tick case raises
   `** (ArithmeticError) bad argument in arithmetic expression: "9" + 3` from
   `decide_succession_proof/7`, exactly the predicted failure.
4. Reverting the TypeScript `capabilityQuarantine` arm: conformance fails on
   `township_authority_cross_replica_replay` with `state.posts`, `quarantine set`, and
   `quarantine reason pairs` — the forged post materializes in the TS state.

Tests added (all green):

- `root_binding_test.exs`: same-root sibling-replica capability replay quarantines
  `:wrong_replica` and the replayed genesis quarantines `:unauthorized_genesis`; a foreign-replica
  root-less grant quarantines `:wrong_replica`; a signed `{:heartbeat, role, "9"}` is ignored
  without mutating the timeline; a succession after that malformed heartbeat returns normally and
  is honored (the ArithmeticError case).
- New exported vector `township_authority_cross_replica_replay.json` (the 2b(d) scenario **is**
  expressible in the exporter). **No existing vector changed** — both guards are no-ops for every
  honest log, and the three succession vectors are byte-identical.

Authorized scope notes for this amendment run:

- `clients/lattice-client/src/capability.ts` carries the TS use-time mirror (the file where
  `capabilityQuarantine` lives; the original in-scope list predates the 2b amendment).
- `clients/lattice-client/test/conformance.ts`: one comparator fix — the "quarantine reason ids"
  check compared a `localeCompare`-sorted list against a codepoint-`sort()`ed list; the new
  vector's quarantined ids (`h57…`/`Uiyx…`) are the first pair the two comparators order
  differently. The expectation now uses the same comparator as `sortedPairs`.

Final GREEN: full umbrella `mix check` (format, every app's tests, strict Credo) exit 0; TS
typecheck, conformance, v01:guard, canonical, township:authoring, carrier:township all pass;
regenerated `dist/**` committed; `mix sobelow --exit` clean. The plan-175 boundary grep
(`beacon` never coupled to succeed/heartbeat/transfer) returns nothing.

## Why this matters

`Lattice.Authority` is the deterministic judge every realm runs to decide which operations count.
Its root-binding logic has three holes, all of the same shape — **a root-less delegation, or a
genesis operation, is trusted without checking who authored it**:

1. **A self-issued delegation introduced by anything other than a `:genesis` op validates `:ok`.**
   The root-commitment check only fires when the delegation's id is in `genesis_ids`, i.e. when some
   op introduced it with a `{:genesis, d, policies}` body. So an attacker authors
   `{:grant, <self-issued delegation granting themselves ops: [:post, :admit, ...]>}`, then authors a
   command capped by it. `cap_ok` accepts (the delegation is valid, the audience matches, the command
   is in `d.ops`), and because `Township.Matter`'s convergent fields carry no `authority:` role,
   `roles_needed` is `[]` and `authority_ok/4`'s first clause short-circuits to `:ok`. The command
   is **honored**. Any realm that can land two ops in a matter's log can forge `post`, `set_title`,
   `set_summary`, `admit`, and `remove_member`.

2. **The genesis role-acquire arm has no author binding.** Replaying the real root's genesis
   delegation — which is public in every synced copy of the log — inside a *new* `:genesis` op
   authored by the attacker passes `root_matches?` (the audience really is the root) and calls
   `record_acquire`, resetting the role holder. The same op's body carries an unsigned `policies`
   map that `collect_policies/3` merges unconditionally, so the attacker also names the successor
   and the dormancy threshold.

3. **TypeScript and Elixir disagree about (2).** `authorityWriteHonored` in the TS client *does*
   require `delegation.issuerRealm === op.author` for a genesis; Elixir does not. So for the exact
   operation in (2), `Lattice.Sim` honors it and `materialize()` quarantines it — divergent
   quarantine sets, the declared STOP condition. TypeScript is additionally self-inconsistent:
   `collectPolicies` has no author check, so an op the TS reducer distrusts enough to quarantine
   still gets to name the successor for the role it just quarantined the write to.

Because Elixir and TypeScript agree on the *wrong* answer for (1), the conformance corpus cannot see
it. That is why this needs adversarial vectors, not review.

After this plan: a root-less delegation is valid only if it is a root-matching genesis or the
successor self-issue that `decide_succeed/8` separately authorizes; a genesis op confers a role
acquisition and succession policy only when its author is the delegation's audience; and both
runtimes are pinned to that by exported vectors.

## Current state

### The three defect sites in `apps/lattice_core/lib/lattice/authority.ex`

**(a) `validate_delegation/4` — `authority.ex:412-435`.** The `parent_id == nil` branch:

```elixir
  defp validate_delegation(%Delegation{} = d, delegations, commitment, genesis_ids) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      is_nil(d.parent_id) ->
        cond do
          d.issuer != d.audience ->
            {:error, :nongenesis_root}

          # A self-issued delegation offered *as a genesis* (in a `:genesis` op) is the
          # replica's root claim: on a bound replica it is honored only if its audience
          # matches the committed root key, so a forged genesis confers nothing.
          MapSet.member?(genesis_ids, d.id) and not root_matches?(commitment, d.audience) ->
            {:error, :impostor_genesis}

          true ->
            :ok
        end
      ...
```

The `true -> :ok` arm is the hole: it is reached by every root-less self-issued delegation that was
*not* introduced by a `:genesis` op.

`genesis_ids` is built at `authority.ex:151-157` and is deliberately narrow:

```elixir
  defp genesis_deleg_ids(ordered) do
    for op <- ordered, match?({:genesis, %Delegation{}, _}, op.body), into: MapSet.new() do
      {:genesis, %Delegation{id: id}, _} = op.body
      id
    end
  end
```

`root_matches?` is at `authority.ex:143-144`:

```elixir
  defp root_matches?(nil, _audience), do: true
  defp root_matches?(commitment, audience), do: root_tag(audience) == commitment
```

(The `nil` clause preserves legacy unbound replicas — keep it.)

**(b) the genesis arm of `build_role_timeline/6` — `authority.ex:590-596`:**

```elixir
        {:genesis, d} ->
          if deleg_valid[d.id] == :ok and MapSet.member?(d.roles, role) do
            record_acquire(st, op, d.audience, 0)
          else
            st
          end
```

Contrast the sibling arm `decide_succeed/8` at `authority.ex:661-670`, which **does** bind the
author — this is the predicate shape to copy:

```elixir
      deleg_valid[d.id] != :ok or op.author != d.audience or op.author != d.issuer or
          not MapSet.member?(d.roles, role) ->
        reject(st, op, :invalid_succession, role)
```

and `decide_transfer/7` at `authority.ex:640-646`, which binds `op.author != d.issuer`.

**(c) `collect_policies/3` — `authority.ex:388-400`:**

```elixir
  defp collect_policies(ordered, delegations, deleg_valid) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, %Delegation{id: id} = d, policies} when is_map(policies) ->
          if Map.get(deleg_valid, id) == :ok and valid_delegation_intro?(delegations, d, op.id),
            do: Map.merge(acc, policies),
            else: acc

        _ ->
          acc
      end
    end)
  end
```

`policies` is an unsigned field of the op body, fully controlled by `op.author`.

**Why (1) reaches a honored command.** `cap_ok/8` at `authority.ex:884-905` checks
`deleg_valid[d.id] != :ok` first, then audience, granted ops, visibility, roles, revocation, lease.
A self-issued delegation passes every one of those. Then `authority_ok/4` at `authority.ex:956`:

```elixir
  defp authority_ok(_op, [], _ancestors, _timelines), do: :ok
```

`roles_needed` comes from `mutation_roles/2`, which maps each mutated field through
`module.authority_role(field)`. In `apps/lattice_core/lib/township/matter.ex:38-42` only one field
carries a role:

```elixir
    field(:title, merge: :lww, default: "")
    field(:summary, merge: :lww, default: "")
    field(:posts, merge: :causal_list)
    field(:members, merge: :or_set)
    field(:clerk_locked?, authority: :clerk, default: false)
```

so `post` / `set_title` / `set_summary` / `admit` / `remove_member` (`matter.ex:46-50`) all yield
`roles_needed == []`.

**Corroborating evidence already in the tree.** `lattice.export_vectors.ex:925-957`
(`township_authority_forged_transfer`) constructs exactly this forged delegation and asserts it
stays *structurally valid*:

```elixir
    forged_delegation =
      Delegation.genesis(mallory, replica,
        ops: [:close_matter, :reopen_matter],
        roles: [:clerk],
        live: true
      )

    unless Delegation.valid_sig?(forged_delegation) do
      raise "expected the non-holder's self-issued delegation to stay structurally valid"
    end
```

and expects the quarantine to be exactly `transfer_not_holder` + `not_holder` — i.e. today the
forgery is stopped **only** by the role gate, which does not exist for convergent commands.

### The two defect sites in `clients/lattice-client/src/authority.ts`

**(d) `validateDelegations` — `authority.ts:948-959`** mirrors Elixir's hole exactly:

```ts
  if (delegation.parentId === null) {
    if (delegation.issuer !== delegation.audience) {
      validation = { valid: false, reason: "nongenesis_root" };
    } else if (
      genesisIds.has(delegation.id) &&
      outerReplica !== undefined &&
      !replicaRootMatches(outerReplica, delegation.audience)
    ) {
      validation = { valid: false, reason: "impostor_genesis" };
    } else {
      validation = { valid: true };
    }
  } else {
```

**(e) `collectPolicies` — `authority.ts:809-830`** has no author check:

```ts
  for (const op of ops) {
    const evidence = op.authority;
    if (evidence?.type !== "genesis" || evidence.policies === undefined) continue;
    if (
      !validDelegation(evidence.delegation, delegations) ||
      op.replica === undefined ||
      !replicaRootMatches(op.replica, evidence.delegation.audience)
    ) {
      continue;
    }
```

**Already correct on the TS side** — `authorityWriteHonored` at `authority.ts:442-450`, which is the
counterpart to Elixir's (b) and is what Elixir must be brought up to:

```ts
  if (evidence.type === "genesis") {
    return (
      delegation.parentId === null &&
      delegation.issuer === delegation.audience &&
      delegation.issuerRealm === op.author &&
      op.replica !== undefined &&
      replicaRootMatches(op.replica, delegation.audience)
    );
  }
```

Note the TS uses **realm identifiers** (`issuerRealm`, `op.author`) where Elixir uses **public
keys** (`d.audience`, `op.author`). Mirror the semantics, not the literal expression.

### Blast radius — who legitimately authors a root-less delegation

Verified across the tree:

- `apps/lattice_core/lib/lattice/sim.ex:60` — `Sim.create_replica/3` mints the genesis via
  `Delegation.genesis(creator, replica, ...)` and appends it from the creating realm, so
  `op.author == d.audience` holds for every legitimate genesis.
- `clients/lattice-client/src/township.ts:215` — `authorTownshipGenesis` sets `parentId: null` for a
  `genesis` body only.
- `clients/lattice-client/src/township.ts:318` — `authorTownshipDelegation` **throws**
  (`"no local delegation authorizes grant"`) when no parent delegation is found, so the TS client
  never authors an unrooted grant in a normal flow.
- `apps/lattice_core/lib/lattice/authority.ex:666` — the succession path deliberately self-issues a
  root-less delegation inside a `{:succeed, role, d, proof}` op. **This must keep working.**
  `decide_succeed/8` is what authorizes it (author == audience == issuer == `policy.successor`), so
  the delegation itself must still validate `:ok` for that gate to be reached.

Everything else that constructs a root-less delegation lives in `lattice.export_vectors.ex` or under
`apps/*/test/` and is adversarial by design.

### Repo conventions to follow

- **RED before GREEN.** Every landed plan in this repo records a failing oracle probe first, then
  the fix, then a deliberate mutation proving the fix is load-bearing. See
  `plans/148-valid-genesis-holder-policy-projection-parity.md` for the shape.
- Vectors are generated by `mix lattice.export_vectors` and consumed by
  `clients/lattice-client/test/conformance.ts`, which compares TS `materialize()` output against the
  Sim oracle's state and quarantine set.
- New adversarial scenarios use the `capability_scenario/4` helper at
  `lattice.export_vectors.ex:1665` plus the `assert_authority_reason!/3`,
  `assert_authority_honored!/2`, and `assert_post_absent!/2` guards at `:1682-1699`. A model
  scenario to copy is `township_capability_invalid` at `:1155-1200`.
- Scenarios are registered in the `fixed` list in `scenarios/0` at `lattice.export_vectors.ex:66-103`.
- Elixir modules carry `@moduledoc`/`@spec`; all code is `mix format`-clean.

## Commands you will need

**Toolchain**: invoke mix as `~/.asdf/shims/mix` (`mix` on `PATH` is a broken mise shim). For
commands that spawn BEAM child processes, prefix the explicit PATH per `AGENTS.md:19-21`.

| Purpose | Command | Expected on success |
|---|---|---|
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 (format + full suite + credo --strict) |
| Elixir tests only | `~/.asdf/shims/mix test` | all pass |
| Authority tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` | all pass |
| Township tests | `~/.asdf/shims/mix test apps/lattice_core/test/township/` | all pass |
| Regenerate vectors | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors` | writes N files |
| TS typecheck | `npm --prefix clients/lattice-client run typecheck` | exit 0 |
| TS conformance | `npm --prefix clients/lattice-client run conformance` | exit 0, all PASS |
| TS V-01 guard | `npm --prefix clients/lattice-client run v01:guard` | exit 0 |
| TS canonical parity | `npm --prefix clients/lattice-client run canonical` | exit 0 |
| TS build | `npm --prefix clients/lattice-client run build` | exit 0 |

**Important**: regenerate vectors with `MIX_ENV=test`, not the default `:dev`. A stale `_build/dev`
can carry `.beam` mtimes newer than freshly checked-out sources, so Mix's staleness check skips the
recompile and the task silently runs old code — this exact failure was observed in CI and is
documented at `.github/workflows/flagship.yml:118-125`. Run `~/.asdf/shims/mix test` first in the
same session to force a correct `:test` recompile.

## Scope

**In scope** (the only files you may modify):

- `apps/lattice_core/lib/lattice/authority.ex`
- `clients/lattice-client/src/authority.ts`
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (new scenarios + the one expectation
  update step 5 identifies)
- `clients/lattice-client/test/vectors/*.json` (regenerated output — never hand-edited)
- `clients/lattice-client/dist/**` (regenerated by `npm run build` — never hand-edited)
- `apps/lattice_core/test/lattice2/root_binding_test.exs` (add cases)
- `apps/lattice_core/test/township/export_vectors_test.exs` (authorized predicted forged-transfer
  expectation update only)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_core/lib/township/matter.ex` — do **not** "fix" this by adding an `authority:` role
  to `posts` or `members`. That changes the civic model's convergence semantics and is a
  `CLAUDE.md` boundary violation. The bug is in the judge, not the replica.
- `apps/lattice_core/lib/lattice/log.ex` — structural acceptance is deliberately separate from
  semantic authority. Do not add authority checks to `Log.accept/2`.
- `apps/lattice_carrier_server/**` — the carrier is transport-only and must not decide semantic
  authority. This fix does not belong there.
- `clients/lattice-client/src/carrier.ts` — the command-decode fail-open defect is real but is owned
  by **plan 163**. Do not fix it here; the two changes would be impossible to review together.
- `clients/lattice-client/src/authority.ts`'s `outerReplica` inference at `:905` — also owned by
  **plan 163**.
- `Lattice.Attestation` / `Township.Election` — frozen per `CLAUDE.md`.
- Any reason atom rename for `:impostor_genesis` or `:nongenesis_root` — those are pinned by
  existing vectors and by plan 148's parity result.

## Git workflow

- Branch: `advisor/162-authority-root-binding`
- Commit per step (RED probe, Elixir fix, regenerated vectors, TS fix, mutation evidence).
  Conventional commits, e.g. `fix(authority): bind root-less delegations to the replica root`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (RED): Add the two adversarial exporter scenarios and watch them fail

Add two private scenario builders to `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`,
modeled on `township_capability_invalid` at `:1155`, and register both in the `fixed` list in
`scenarios/0` (`:66-103`).

**Scenario A — `township_authority_unrooted_grant`.** This is defect (1):

- `Sim.new(Matter, "replica:matter:unrooted-grant", ["clerk", "mallory"], seed: "township:unrooted-grant")`
- `Sim.create_replica(sim, "clerk")`, then `Sim.sync_all(sim)`
- Build `unrooted = Delegation.genesis(mallory, replica, ops: [:post], roles: [], live: true)` —
  self-issued, `parent_id: nil`, audience = mallory. Assert `Delegation.valid_sig?(unrooted)` so the
  scenario proves the refusal is semantic, not a signature artifact.
- Introduce it with an `Op.new(mallory, replica, Log.frontier(log), :authority, {:grant, unrooted})`
  — note the **`:grant`** body, not `:genesis`. That is the whole point.
- Author `Op.new(mallory, replica, Log.frontier(log), :command, {:post, [rejected_post]}, cap: unrooted.id)`.
- Assert with `assert_authority_reason!(log, target.id, :invalid_capability)` and
  `assert_post_absent!(log, rejected_post)`.
- Return via `capability_scenario("township_authority_unrooted_grant", sim, log, %{...})` with
  `"targetOperationId"`, `"expectedReason" => "invalid_capability"`, `"rejectedPost"`, and
  `"unrootedDelegationId" => unrooted.id`.

**Scenario B — `township_authority_replayed_genesis`.** This is defects (2) and (3):

- Create the replica from `"clerk"` with an explicit succession policy, as
  `township_zoning_variance_24` does at `:302`:
  `Sim.create_replica(sim, "clerk", policies: %{clerk: %{successor: "resident", dormant_ticks: 3}})`.
  Capture the returned genesis delegation — that is the **real root's** delegation.
- `Sim.sync_all(sim)`.
- Have `"mallory"` author a *second* `:genesis` op re-introducing that exact same delegation, with an
  attacker-chosen policy body:
  `Op.new(mallory, replica, Log.frontier(log), :authority, {:genesis, genesis_delegation, %{clerk: %{successor: "mallory", dormant_ticks: 0}}})`.
- Have the genuine clerk author a `close_matter` command after the replay.
- Assert: the clerk's command is honored (`assert_authority_honored!/2`); the replayed genesis op is
  quarantined (`assert_authority_reason!/3` — see the note below on which atom); and
  `Authority.analyze(Matter, log).holders[:clerk]` is still the clerk.
- Also assert the injected policy did **not** take effect. The cheapest robust check: capture
  `Authority.analyze(Matter, log)` and confirm the effective successor policy is unchanged. If the
  analysis map does not expose policies directly, assert the behavioral consequence instead — a
  `:succeed` op authored by mallory at tick 0 must be rejected. Choose one and state which in your
  report.

**Which reason atom for the replayed genesis?** Do not guess. After writing the scenario without the
assertion, run the exporter and print `Authority.analyze(Matter, log).reasons` to see what the fixed
code produces, then pin that. The genesis arm currently has no `reject/4` call at all, so you will
need to add one as part of step 2 — pick a new atom `:unauthorized_genesis` and use it consistently
in both runtimes.

**Verify (this step must FAIL)**:

```sh
~/.asdf/shims/mix test && MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors
```

→ must **raise** from your `assert_*!` guards. Record the exact failure text — that is the RED
evidence. Scenario A should fail because the post materializes; scenario B should fail because the
clerk loses the role.

If either scenario **passes** before the fix, the vulnerability does not exist as described —
STOP and report, with the analysis output.

### Step 2 (GREEN): Bind the three Elixir sites

**(a) `validate_delegation/4`.** Thread a `succession_ids` set alongside `genesis_ids` — the ids of
delegations introduced by a `{:succeed, role, d, tick}` op — and replace the `parent_id == nil`
`cond` with:

```elixir
      is_nil(d.parent_id) ->
        cond do
          d.issuer != d.audience ->
            {:error, :nongenesis_root}

          MapSet.member?(genesis_ids, d.id) and not root_matches?(commitment, d.audience) ->
            {:error, :impostor_genesis}

          MapSet.member?(genesis_ids, d.id) ->
            :ok

          # The successor self-issue inside a `:succeed` op is deliberately root-less;
          # `decide_succeed/8` is what authorizes it (author == audience == issuer ==
          # policy.successor). Every other root-less delegation is unanchored and confers
          # nothing, whichever op introduced it.
          MapSet.member?(succession_ids, d.id) ->
            :ok

          true ->
            {:error, :unrooted_delegation}
        end
```

Build `succession_ids` with a helper next to `genesis_deleg_ids/1` (`authority.ex:151`), matching
on `{:succeed, _role, %Delegation{}, _tick}` bodies, and extend `deleg_context/2` (`authority.ex:147`)
to return it. Thread it through `validate_delegations/3` → `validate_delegation/4`.

Clause order is load-bearing: the `:impostor_genesis` clause must stay **before** the plain
genesis-`:ok` clause so existing vectors keep their reason atom.

**(b) The genesis role-acquire arm** (`authority.ex:590`). Add the author binding and reject
explicitly rather than silently skipping, so the operation appears in the quarantine set on every
realm:

```elixir
        {:genesis, d} ->
          cond do
            deleg_valid[d.id] != :ok or not MapSet.member?(d.roles, role) ->
              st

            op.author != d.audience ->
              reject(st, op, :unauthorized_genesis, role)

            true ->
              record_acquire(st, op, d.audience, 0)
          end
```

Keep the existing `st` (silent skip) behavior for the invalid-delegation and wrong-role cases —
those are already reported through `invalid_delegation_ops/2`, and changing them would perturb
unrelated vectors.

Since a genesis delegation is self-issued (`d.issuer == d.audience`, enforced by (a)),
`op.author != d.audience` is the same binding `decide_succeed/8` uses.

**(c) `collect_policies/3`** (`authority.ex:388`). Add the same predicate:

```elixir
        {:genesis, %Delegation{id: id, audience: audience} = d, policies}
        when is_map(policies) ->
          if Map.get(deleg_valid, id) == :ok and valid_delegation_intro?(delegations, d, op.id) and
               op.author == audience,
             do: Map.merge(acc, policies),
             else: acc
```

**Verify**:

```sh
~/.asdf/shims/mix test
```

→ all pass. If `apps/lattice_core/test/lattice2/root_binding_test.exs` or any authority/township test
fails, read the failure carefully — it may be a legitimate expectation that must move (record it), or
it may mean the succession path broke (a STOP condition; see below).

### Step 2b (GREEN): Bind the two remaining authority sites

Two further guards were found in the 2026-08-06 security round. They belong in this plan because
they share `authority.ex`, `authority.ts`, the vector exporter, and the same regenerated
fixtures — running them as a separate concurrent plan would produce a diff nobody can review.

Both are **guards**: they add a predicate and reject more. Neither changes succession semantics,
so this plan's "succession vectors stay byte-identical" STOP condition still holds. (The
*provenance* of `at_tick` — that it is claimant-asserted rather than derived from the root-signed
beacon clock — is a semantic redesign and is deliberately **not** here. It is
`plans/175-succession-tick-provenance-spike.md`. If you find yourself changing what a valid
succession op means, STOP: you are in the wrong plan.)

**(d) `cap_ok/8` never binds a cited delegation's replica to the op's replica.**

`authority.ex:884-905` checks validity, audience, granted ops, causal visibility, roles,
revocation, and lease — but never compares `d.replica` to `op.replica`:

```elixir
        cond do
          deleg_valid[d.id] != :ok -> {:error, :invalid_capability}
          op.author != d.audience -> {:error, :capability_wrong_audience}
          not MapSet.member?(d.ops, cmd) -> {:error, :operation_not_granted}
```

So a capability scoped to matter X is honored on matter Y: an attacker replays X's public
delegation chain into Y's log via `{:grant, ...}` and authors there. Note the asymmetry this
closes — `verify_chain/2` (`authority.ex:168-169`) and `Live.authorize/2` (`live.ex:44-52`)
**both** already reject `:wrong_replica`, so today the live ephemeral path is strictly stricter
than the durable-state path, inverting the "one delegation chain, two uses" invariant.

Add to the `cond`, before the ops check:

```elixir
          d.replica != op.replica -> {:error, :wrong_replica}
```

Reuse the existing `:wrong_replica` atom (`log.ex:138-139`) rather than minting a new one.
Also add the same comparison to `validate_delegation/6` against the threaded `log.replica`
value (the pre-change arity was `/4` before `succession_ids` and `log.replica` were threaded).

This must be a no-op for honest logs: `Sim.grant/4` (`sim.ex:91`) and `transfer/5` (`:112`) both
pass `sim.replica`. If any existing vector changes, that is a finding — report it in step 5.

**(e) Malformed and non-portable ticks enter authority timelines unguarded.**

`role_event/3` at `authority.ex:614-621` pattern-matches `tick` with **no guard at all** on the
transfer and heartbeat arms:

```elixir
      {:transfer, ^role, %Delegation{} = d, tick} ->
        if valid_delegation_intro?(delegations, d, op.id), do: {:transfer, d, tick}

      {:succeed, ^role, %Delegation{} = d, tick} ->
        if valid_delegation_intro?(delegations, d, op.id), do: {:succeed, d, tick}

      {:heartbeat, ^role, tick} ->
        {:heartbeat, tick}
```

`decide_succession_proof/7` *is* guarded `when is_integer(at_tick)`, but nothing guards the path
into `record_acquire/4`, so a non-integer tick is written into `st.acquires`. Later,
`last_active_from/3` (`:756-762`) computes `Enum.max([0 | ticks])` — which succeeds on any term,
because Erlang orders all terms — and `decide_succession_proof` then evaluates
`at_tick < last_active + dormant_ticks`, raising `ArithmeticError` on the `+`.

A holder can therefore author a **validly signed** heartbeat carrying `tick: "9"` and
permanently break every later authority analysis of that replica. `Canonical.signable?/1`
accepts a binary there and `Wire.decode_term/1` transports it, so it is reachable over the
carrier. TypeScript already refuses these, so this is also a live BEAM↔TS divergence.

Reject before the timeline is mutated, in `role_event/3`, returning `nil` (the existing
"not a role event" signal) for a malformed tick — or, if you prefer an explicit quarantine
reason, add one and mirror it in TypeScript. Whichever you choose, the tick must satisfy
`is_integer(tick) and tick >= 0 and tick <= Lattice.Canonical.max_integer()` before it reaches
`record_acquire/4` or `decide_heartbeat/4`.

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/` → exit 0. No succession vector
changes yet (step 5 confirms this formally).

### Step 3 (GREEN): Confirm the exporter scenarios now pass

```sh
~/.asdf/shims/mix test && MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors
```

→ exits 0 and writes the vector files, with both new scenarios' guards satisfied.

### Step 4: Prove the succession path still works

This is the single highest-risk regression. Run the succession-specific suites explicitly:

```sh
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/
```

→ all pass, including the witnessed-succession, succession-time-travel, and lease suites.

Then confirm the succession vectors regenerated unchanged (step 5 covers the mechanics). If
`township_succession_w3.json`, `township_succession_unproven_tick.json`, or
`township_succession_witnessed_recovery.json` changed, your `succession_ids` threading is wrong —
STOP and report.

### Step 5: Enumerate every vector that changed, and justify each

This is the review artifact. Regenerate, then diff:

```sh
git status --porcelain clients/lattice-client/test/vectors
git diff --stat clients/lattice-client/test/vectors
```

**Expected changes:**

- **2 new files**: `township_authority_unrooted_grant.json`, `township_authority_replayed_genesis.json`.
- **`township_authority_forged_transfer.json` WILL change.** This is intended and predicted. That
  scenario (`lattice.export_vectors.ex:915-960`) builds a root-less self-issued delegation with
  `Delegation.genesis(mallory, replica, ...)` and introduces it via a `{:transfer, ...}` op — not a
  `:genesis` op, so it is not in `genesis_ids` and not in `succession_ids`. After the fix it
  validates `:unrooted_delegation`, and `decide_transfer/7` (`authority.ex:640-643`) checks
  `deleg_valid[d.id] != :ok` **first**, so the reason moves:
  - `forged_transfer` : `transfer_not_holder` → `invalid_transfer`
  - `mallory_command` : `not_holder` → `invalid_capability` (via `cap_ok/8`'s first clause)

  Update the `expected_quarantine` list at `lattice.export_vectors.ex:952-957` to match, and add a
  comment recording *why* the reason moved (the forgery is now refused one gate earlier, for a
  stronger reason). Do not weaken the assertion to make it pass.

- **`township_authority_forged_root.json` and `township_authority_embedded_replica_bypass.json`**
  may change if their forged delegations are also introduced by non-`:genesis` ops. Inspect them
  (`lattice.export_vectors.ex:404`, `:422`, `:513`, `:571`) and record the outcome either way.

**Coverage regression to repair.** After this change, `township_authority_forged_transfer` no longer
exercises the `transfer_not_holder` reason atom — it is now short-circuited by the delegation gate.
Add a scenario that still reaches it: a **properly rooted** delegation (granted by the clerk, so
`parent_id != nil`) held by a realm that is not the current role holder, attempting a transfer.
Name it `township_authority_rooted_transfer_not_holder` and assert
`assert_authority_reason!(log, transfer.id, :transfer_not_holder)`.

**STOP if any vector changes that you cannot explain in one sentence naming the gate that moved.**
In particular, if `township_genesis_projection_parity.json` (plan 148's pinned parity result, which
contains two valid same-root genesis introductions) changes its acquisition timeline, that means one
of its genesis ops is authored by a realm other than the delegation audience — report it before
proceeding, because plan 148 pinned that projection deliberately.

**Verify**: your report contains a line per changed vector: filename, what changed, and why.

### Step 6 (RED): Run TS conformance and watch it fail

```sh
npm --prefix clients/lattice-client run conformance
```

→ must **FAIL** on at least the two new scenarios. Expected shape:

- `township_authority_unrooted_grant` — TS still honors the unrooted grant (it has the same hole at
  `authority.ts:948-959`), so its state contains the forged post and its quarantine set omits the
  command.
- `township_authority_replayed_genesis` — TS may already quarantine the write (it has the author
  check at `authority.ts:444`) but still absorbs the policies (`authority.ts:809-830` has none), and
  it will not carry the new `:unauthorized_genesis` reason atom.

Record the exact failure output. This is the RED evidence that the TS hole is independently real.

### Step 7 (GREEN): Mirror the predicates in TypeScript

**(d) `validateDelegations`** (`authority.ts:948-959`). Add a `successionIds` set built the same way
`genesisIds` is built at `authority.ts:900-904` (scan ops for `op.authority?.type === "succeed"`),
and extend the `parentId === null` branch with the two new arms — root-matching genesis → valid,
succession self-issue → valid, everything else → `{ valid: false, reason: "unrooted_delegation" }`.
Keep `impostor_genesis` and `nongenesis_root` exactly as they are.

**(e) `collectPolicies`** (`authority.ts:809-830`). Add the author binding, expressed in the same
realm-vs-pubkey idiom the file already uses in `authorityWriteHonored` at `authority.ts:445`
(`delegation.issuerRealm === op.author`).

**(f) The new reason atom.** Make sure `unrooted_delegation` and `unauthorized_genesis` flow through
the client's single quarantine path so `materialize()` reports them — follow how an existing reason
such as `impostor_genesis` reaches `quarantinedWrites` and then `materialize.ts`.

**Verify**:

```sh
npm --prefix clients/lattice-client run typecheck \
  && npm --prefix clients/lattice-client run conformance \
  && npm --prefix clients/lattice-client run v01:guard \
  && npm --prefix clients/lattice-client run canonical
```

→ all exit 0, all PASS.

### Step 8: Prove every predicate is load-bearing (mutation evidence)

Revert each of the five predicates **one at a time**, confirm a specific named failure, then restore.
Record the failing assertion for each.

| # | Mutation | Expected failure |
|---|---|---|
| 1 | Elixir (a): remove the `true -> {:error, :unrooted_delegation}` arm (restore `:ok`) | exporter raises in `township_authority_unrooted_grant` — the post materializes |
| 2 | Elixir (b): remove the `op.author != d.audience` reject | exporter raises in `township_authority_replayed_genesis` — the clerk loses the role |
| 3 | Elixir (c): remove `op.author == audience` from `collect_policies` | `township_authority_replayed_genesis`'s policy assertion fails |
| 4 | TS (d): restore the old `parentId === null` branch | `npm run conformance` fails on `township_authority_unrooted_grant` |
| 5 | TS (e): remove the author check from `collectPolicies` | `npm run conformance` fails on `township_authority_replayed_genesis` |

If any mutation does **not** produce a failure, that predicate is untested — add the assertion that
catches it before proceeding.

### Step 9: Add direct Elixir regression tests

Add cases to `apps/lattice_core/test/lattice2/root_binding_test.exs`. Its existing suite only forges
`Delegation.genesis(evil, ...)` (attacker as audience) at `:38-77`, which is why neither of these
defects was caught. Add:

1. **Unrooted grant confers nothing** — a self-issued delegation introduced by `{:grant, d}` is
   `:unrooted_delegation`, and a command capped by it quarantines `:invalid_capability` and does not
   materialize.
2. **Replayed genesis does not move the holder** — re-appending the genuine root's genesis delegation
   from a different author leaves `holders[:clerk]` unchanged and quarantines the replay.
3. **Replayed genesis does not inject policy** — the successor named in a replayed genesis op's body
   does not become the effective successor.
4. **The succession self-issue still validates** — a legitimate `:succeed` op with a root-less
   self-issued delegation is still honored (this is the guard against over-tightening).

**Verify**:

```sh
~/.asdf/shims/mix test apps/lattice_core/test/lattice2/root_binding_test.exs
```

→ all pass, including 4 new cases.

### Step 10: Full gate

```sh
~/.asdf/shims/mix check
npm --prefix clients/lattice-client run build
npm --prefix clients/lattice-client run typecheck
npm --prefix clients/lattice-client run conformance
npm --prefix clients/lattice-client run v01:guard
npm --prefix clients/lattice-client run canonical
npm --prefix clients/lattice-client run township:authoring
npm --prefix clients/lattice-client run carrier:township
cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit && cd ../..
```

→ all exit 0.

`npm run build` regenerates `clients/lattice-client/dist/**`, which is tracked in git. Commit the
regenerated output together with the source change — a partial commit leaves local shell contracts
testing stale compiled code.

## Test plan

- **New exported vectors** (`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`):
  `township_authority_unrooted_grant`, `township_authority_replayed_genesis`,
  `township_authority_rooted_transfer_not_holder`. Model after `township_capability_invalid`
  (`:1155-1200`); use `capability_scenario/4` and the `assert_*!` guards.
- **New Elixir unit tests** (`apps/lattice_core/test/lattice2/root_binding_test.exs`): the four cases
  in step 9. Model after the existing `forge_genesis` cases at `:38-77`.
- **Updated expectation**: `township_authority_forged_transfer`'s `expected_quarantine`
  (`lattice.export_vectors.ex:952-957`), with a comment explaining the moved gate.
- **Cross-runtime**: `npm run conformance` is the gate that the two implementations agree. It must be
  RED before step 7 and GREEN after.
- **Mutation**: step 8's five reverts, each with a named failing assertion.
- **Step 2b (d) — cross-replica capability replay**: a new Elixir case in
  `root_binding_test.exs` that grants on replica X, replays the delegation into replica Y via
  `{:grant, ...}`, authors a command there, and asserts `:wrong_replica`. Require the generated
  vector at `clients/lattice-client/test/vectors/township_authority_cross_replica_replay.json`
  and a passing TypeScript conformance assertion that mirrors the Elixir quarantine reasons in
  `authority.ts` (including sibling `:transfer` replay coverage). Do not treat a unit test alone
  as sufficient.
- **Step 2b (e) — malformed tick**: two Elixir cases. First, a signed `{:heartbeat, role, "9"}`
  op does not mutate the role timeline and does not raise. Second — the one that proves the
  guard is load-bearing — construct the same op, then run a succession that would evaluate
  `at_tick < last_active + dormant_ticks`, and assert `Authority.analyze/2` returns normally
  rather than raising `ArithmeticError`. Revert the guard and confirm the second case raises.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/root_binding_test.exs` passes with 4 new cases
- [ ] `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors` exits 0
- [ ] `clients/lattice-client/test/vectors/township_authority_unrooted_grant.json` and `…_replayed_genesis.json` and `…_rooted_transfer_not_holder.json` exist
- [ ] `npm --prefix clients/lattice-client run typecheck` exits 0
- [ ] `npm --prefix clients/lattice-client run conformance` exits 0, all PASS
- [ ] `npm --prefix clients/lattice-client run v01:guard` exits 0
- [ ] `npm --prefix clients/lattice-client run canonical` exits 0
- [ ] `npm --prefix clients/lattice-client run build` exits 0 and regenerated `dist/**` is committed
- [ ] `grep -n 'unrooted_delegation' apps/lattice_core/lib/lattice/authority.ex clients/lattice-client/src/authority.ts` returns hits in both files
- [ ] `grep -n 'unauthorized_genesis' apps/lattice_core/lib/lattice/authority.ex clients/lattice-client/src/authority.ts` returns hits in both files
- [ ] All five step-8 mutations produce a named failure, recorded in your report
- [ ] Your report lists every changed vector file with a one-sentence justification
- [ ] The three succession vectors are byte-identical to their pre-change versions
- [ ] `grep -n 'wrong_replica' apps/lattice_core/lib/lattice/authority.ex clients/lattice-client/src/authority.ts` returns hits in both files (step 2b(d))
- [ ] The step 2b(d) cross-replica case and both step 2b(e) tick cases exist and pass
- [ ] `clients/lattice-client/test/vectors/township_authority_cross_replica_replay.json` exists and `npm --prefix clients/lattice-client run conformance` asserts it against `authority.ts`
- [ ] Reverting the step 2b(e) guard makes the second tick case raise `ArithmeticError`, recorded in your report
- [ ] `grep -rn 'beacon' apps/lattice_core/lib/lattice/authority.ex | grep -i 'succe\|heartbeat\|transfer'` returns **nothing** — confirming this plan did not begin the tick-provenance redesign that belongs to plan 175
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 162 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Either step-1 scenario passes before the fix.** The vulnerability would not exist as described
  and this plan's premise is wrong. Report the `Authority.analyze/2` output.
- **Any succession test or succession vector changes.** The `:succeed` path deliberately relies on a
  root-less self-issued delegation; breaking it means the `succession_ids` threading is wrong. Do
  not "fix" it by loosening the new predicate back toward `:ok` — report instead.
- **`township_genesis_projection_parity.json` changes its acquisition timeline.** That is plan 148's
  deliberately pinned parity result.
- **A vector changes that you cannot explain in one sentence naming the gate that moved.**
- **A step-8 mutation produces no failure** and you cannot construct an assertion that catches it.
- **The fix appears to require touching `Township.Matter`, `Log.accept/2`, or the carrier server.**
  It does not; that would be a design change, not a bug fix.
- You find that some legitimate production flow authors a root-less delegation outside a `:genesis`
  or `:succeed` op. The blast-radius survey in "Current state" says none does — if you find one,
  that changes the fix and needs the operator's decision.

## Maintenance notes

- **Reviewer focus**: the clause ordering inside `validate_delegation/4`. `:impostor_genesis` must
  stay ahead of the plain genesis `:ok` arm, or the existing forged-root vectors silently change
  their reason atom. And the succession arm must be an *allowlist by introducing-op kind*, never a
  blanket exemption for root-less delegations.
- **The reason atoms are now a cross-runtime contract.** `unrooted_delegation` and
  `unauthorized_genesis` must be spelled identically in Elixir and TypeScript. There are three
  reason-atom namespaces in this codebase (structural in `log.ex`, ~31 authority atoms in
  `authority.ex`, election-side in `projector.ex`); a unified dictionary has been discussed and
  deferred — if it lands, these two go in it.
- **Any future replica whose commands touch only convergent fields inherits this risk shape.** The
  root cause is that `authority_ok(_op, [], …)` short-circuits: capability validity is the *only*
  gate for a convergent command. That is the correct design — which is exactly why delegation
  validity must be airtight.
- **Deferred out of this plan**: the TS `outerReplica` trust-anchor inference (`authority.ts:905`)
  and the fail-open command decode in `carrier.ts:1164` — both owned by plan 163, and both are in the
  same trust chain. Land 163 promptly after this one; until it lands, a hostile carrier peer can
  still shift the TS client's root commitment out from under the predicate this plan just added.
- **Hosted CI**: per this repo's convention, the plan is not closed until the flagship workflow is
  green across all three jobs at the exact implementation tip. Record the run id.
