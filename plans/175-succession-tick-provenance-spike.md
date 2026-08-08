# Plan 175 (SPIKE): Decide how succession gets a trustworthy clock

> **Executor instructions**: This is a **design spike, not a build plan**. Its deliverable is a
> written decision document and a follow-on build plan — **no production source file is
> modified**. If you find yourself editing `apps/lattice_core/lib/lattice/authority.ex`, you have
> left the spike. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```sh
> changed_paths="$(
>   {
>     git diff --name-only 91bb6ca6..HEAD
>     git diff --cached --name-only
>     git diff --name-only
>     git ls-files --others --exclude-standard
>   } | sed '/^$/d' | sort -u
> )"
> unexpected="$(printf '%s\n' "$changed_paths" | grep -Ev '^(docs/|plans/)' || true)"
> if [ -n "$unexpected" ]; then
>   printf 'production paths changed outside the spike boundary:\n%s\n' "$unexpected" >&2
>   exit 1
> fi
> ```
>
> This repository-wide allowlist covers committed, staged, working-tree, and untracked paths.
> If it reports any production path, reconcile the plan with the live code before proceeding.

## Status

- **Priority**: P1 — the dormancy gate is decorative today, and one variant is an irreversible
  denial of succession.
- **Effort**: M for the spike. The build it produces is **L** with **HIGH** risk.
- **Risk**: n/a for the spike. The reason this is a spike is that the build changes succession
  *semantics*, invalidates existing succession vectors, and affects every replica that has never
  emitted a beacon.
- **Depends on**: `plans/162-authority-root-binding.md` — 162 adds the tick **shape** guard
  (step 2b(e)); this spike addresses tick **provenance**. Land 162 first so the malformed-tick
  crash is closed before the semantics are redesigned.
- **Category**: security / direction
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this is separate from plan 162

Plan 162 collects the authority-judge **guards**: predicates that reject more without changing
what a valid operation means. It carries a hard STOP condition — "**Any succession test or
succession vector changes**" — and a done criterion that "the three succession vectors are
byte-identical to their pre-change versions". It also declares, at `plans/162:270-272`, that the
successor's root-less self-issue inside a `{:succeed, ...}` op **must keep working**.

Repairing tick provenance necessarily changes what a valid succession op is, which necessarily
changes those vectors. A plan cannot both require succession to behave as it does today and
redesign it. So this is not a regrade of 162 — it is a different plan, and it needs a design
decision before it can be written as a build.

## Why this matters

Succession is gated on dormancy: a designated successor may claim a role once the holder has been
inactive for `dormant_ticks`. The gate is:

```elixir
    if at_tick < last_active + dormant_ticks,
      do: reject(st, op, :premature_succession, role),
      else: record_acquire(st, op, d.audience, at_tick)
```

`at_tick` is lifted from the succeed op's body and is signed **only by the claimant**. Nothing
bounds it from above. `last_active_from/3` maxes over `at_tick` values that are themselves
self-asserted by earlier acquire and heartbeat ops. So:

- **Seizure.** The designated successor takes the role from a fully active holder at will by
  choosing `at_tick = last_active + dormant_ticks`. No elapsed time is required or proved; the
  dormancy threshold is decorative.
- **Irreversible lockout (when no recovery policy is configured).** A holder who self-transfers with
  `at_tick: 18_446_744_073_709_551_615` pins `last_active` at `Lattice.Canonical`'s integer
  ceiling (`canonical.ex:35`). No larger tick can ever be canonically encoded, so no future
  succession op can satisfy the comparison. Succession for that role is dead for the life of the
  replica via the legacy succession path — **unless** a recovery policy is configured, in which
  case the witnessed certificate path can recover via `record_acquire` without `at_tick`. The
  permanent lockout applies only to configurations with no recovery policy.

A root-signed logical clock already exists — the `{:beacon, epoch}` op from plan 149, with
monotonicity and authorization enforced in `classify_beacon/6`. It is consulted **only** for
lease lapse. Wiring it to succession is the obvious repair, and it is not a small one: none of
`decide_transfer/7`, `decide_succeed/8`, or `decide_heartbeat/4` receives `beacons` as a
parameter today, so the fix threads new data through the entire role-timeline fold.

`docs/adr/0004-succession-validation.md:102-105` documents the provenance limitation honestly and
names the pinning vector — so this is a known, recorded gap, not a surprise. What is missing is a
decision about what replaces it.

## Current state

### The gate — `apps/lattice_core/lib/lattice/authority.ex:681-688`

```elixir
  defp decide_succession_proof(st, op, role, d, at_tick, anc, %{dormant_ticks: dormant_ticks})
       when is_integer(at_tick) do
    last_active = last_active_from(st.acquires, st.heartbeats, anc)

    if at_tick < last_active + dormant_ticks,
      do: reject(st, op, :premature_succession, role),
      else: record_acquire(st, op, d.audience, at_tick)
  end
```

### The self-asserted inputs — `authority.ex:756-762`

```elixir
  # Latest activity tick (acquire or heartbeat) visible in `anc`; 0 if none.
  defp last_active_from(acquires, heartbeats, anc) do
    ticks =
      for ev <- acquires ++ heartbeats, MapSet.member?(anc, ev.op_id), do: ev.at_tick

    Enum.max([0 | ticks])
  end
```

### The clock that exists but is not wired in

`collect_beacons/3` (`authority.ex:532`) and `classify_beacon/6` (`:547-561`) build and validate
the root-signed epoch sequence. `beacons` is threaded into `cap_ok/8` (`:884`) and
`expired_as_of?/5` (`:924`) for lease lapse — and nowhere else. Confirm with:

```sh
grep -n "defp decide_transfer\|defp decide_succeed\|defp decide_heartbeat" apps/lattice_core/lib/lattice/authority.ex
```

None of the three takes `beacons`.

### The integer ceiling — `apps/lattice_core/lib/lattice/canonical.ex:35`

```elixir
  @uint64_max 18_446_744_073_709_551_615
```

## Decisions this spike must make

1. **What attests a tick?** Candidates: require the succeed op's ancestry to contain a valid
   beacon whose epoch satisfies the dormancy arithmetic; replace `at_tick` with the epoch itself;
   or keep `at_tick` but bound it by the greatest visible beacon epoch. Each has a different
   blast radius on the op body and the vectors — enumerate all three, do not assume the first.
2. **What happens on a replica with no beacons?** Every existing log is in this state for
   succession purposes. Options: succession is unavailable until a beacon exists (safe, and
   breaks existing behaviour); a legacy arm preserves current semantics for pre-change ops
   (compatible, and preserves the hole for old logs); or a migration emits a genesis beacon.
   Note the precedent: `delegation_bytes/7,8` handles exactly this shape with a `nil` arm that
   keeps v2 bytes verbatim.
3. **Does dormancy become epoch-based?** If ticks become epochs, `dormant_ticks` changes units
   and every configured policy changes meaning — including `Township.Matter:65`'s
   `after: {:dormant_ticks, 3}`. Decide whether the field is reinterpreted, renamed, or
   supplemented.
4. **Who must emit beacons, and how often?** Making succession depend on beacons makes the root
   a liveness dependency. If the root goes quiet, succession — the mechanism that exists
   *because* holders go quiet — stops working. Address this directly; it is the strongest
   argument against the obvious design.
5. **How is the `2^64-1` lockout repaired for logs that already contain one?** A bound on future
   ticks does not undo a pinned `last_active`. Decide whether the fix is retroactive (a rule that
   ignores implausible historical ticks) or whether affected replicas are simply unrecoverable —
   and if the latter, say so plainly.
6. **What does the BEAM↔TypeScript parity cost look like?** `authority.ts` mirrors the current
   rules. Whatever is chosen must land in both runtimes in lockstep, with regenerated vectors,
   or conformance goes red — which `CLAUDE.md` names a STOP condition.

## Steps

### Step 1: Read the recorded decisions before proposing new ones

Read `docs/adr/0004-succession-validation.md` in full, then
`apps/lattice_core/test/lattice2/succession_time_travel_test.exs`,
`witnessed_succession_test.exs`, and `docs/adr/` entries covering the epoch beacon (plan 149).

The ADR documents this limitation deliberately. Establish **why** it was accepted before
proposing to change it — the original reasoning may contain a constraint this spike must respect.

**Verify**: you can state in two sentences why the current design was accepted, and whether that
rationale still holds.

### Step 2: Establish the blast radius empirically

Determine, by reading and by running the existing suite, exactly which tests and which exported
vectors depend on self-asserted ticks:

```sh
grep -rn "at_tick\|dormant_ticks\|:succeed\|heartbeat" apps/lattice_core/test/lattice2/ | grep -v _build
grep -rln "succession\|succeed" clients/lattice-client/test/vectors/
```

Record the exact list. It is the cost estimate for every option in step 4, and plan 162's done
criteria require these same vectors to be byte-identical — so this list is also the proof that
the two plans are correctly separated.

**Verify**: you have an enumerated list of affected tests and vectors.

### Step 3: Confirm both exploits, in a throwaway

Write a scratch script (under the scratchpad path, **not** in the repo) that demonstrates:

1. **Seizure** — a designated successor acquiring a role against an active holder by choosing a
   large `at_tick`.
2. **Lockout** — a self-transfer at `18_446_744_073_709_551_615` after which no valid succession
   op can be constructed via the legacy path. Distinguish the two configurations: with
   `%{recovery: recovery}` policy, the witnessed certificate path can recover via
   `record_acquire` without `at_tick`, so the lockout is not permanent; without a recovery
   policy, the maximum tick blocks the legacy succession path permanently for the life of the
   replica. Demonstrate both if both are reachable.

Model it on `apps/lattice_core/test/lattice2/witnessed_succession_test.exs:182`, which already
uses `Sim.succeed(..., at_tick: 1_000_000)` and shows the shape.

Record both outcomes. If either does **not** reproduce, that is the most important finding this
spike can produce — report it and stop, because the premise is wrong.

**Verify**: both reproduce and the outputs are recorded, or the discrepancy is reported.

### Step 4: Write up the options and recommend one

For each of the three candidates in decision 1, write: what it proves, what it costs in vectors
and tests (from step 2), how it answers decisions 2–6, and how it behaves when the root stops
emitting beacons. Then **recommend one** in an explicit sentence.

Pay particular attention to decision 4. A design where succession depends on root liveness may be
worse than the current design in the failure mode succession exists to handle. If the
recommendation is "none of these — keep self-asserted ticks and publish the non-claim more
loudly", that is a legitimate outcome; say so with reasons.

**Verify**: three options written up, all six decisions answered, one recommendation stated.

### Step 5: Write the deliverable and the follow-on plan

Produce `docs/research/succession_tick_provenance.md` with the step-1 rationale, the step-2 blast
radius, the step-3 reproductions, and the step-4 options and recommendation.

Then either open the follow-on build plan, or — if step 4 concluded the change is not worth it at
POC stage — record that decision and open a much smaller documentation plan that:

- adds the caveat to `CLAUDE.md` and `README.md`, which today carry succession claims while the
  honest limitation lives two documents away in the ADR, and
- reconsiders `Township.Matter:65`'s `after: {:dormant_ticks, 3}`, which ships a dormancy policy
  on a gate that does not enforce dormancy.

**Verify**: the document exists, and either a build plan or a documentation plan follows from it.

## Done criteria

- [ ] `docs/research/succession_tick_provenance.md` exists and answers all six decisions
- [ ] It records the step-2 list of affected tests and vectors
- [ ] It records the step-3 reproductions of both seizure and lockout
- [ ] It recommends exactly one course of action in an explicit sentence, including "do not
      change it" if that is the conclusion
- [ ] A follow-on plan exists — build or documentation, per the recommendation
- [ ] `git status --porcelain` shows changes **only** under `docs/` and `plans/`
- [ ] `plans/README.md` status row for 175 updated

## STOP conditions

Stop and report back if:

- You find yourself editing `apps/lattice_core/lib/lattice/authority.ex` or
  `clients/lattice-client/src/authority.ts`. That is the build plan.
- Plan 162 has not landed. Its step 2b(e) closes the malformed-tick crash; redesigning tick
  semantics on top of a code path that still raises on a binary tick will waste the work.
- Either exploit fails to reproduce in step 3 — the premise is wrong and that is the finding.
- The recommendation would require changing `Lattice.Canonical`'s integer bound. That is a
  canonical-encoding change affecting every signed byte in the system; it needs its own plan and
  almost certainly is not the right answer.

## Maintenance notes

- **Why this is separate from 162**: 162's own STOP condition forbids succession vectors from
  changing, and this work necessarily changes them. Two plans, not one regraded plan.
- **The honest interim position**: until this lands, `after: {:dormant_ticks, n}` should be read
  as "a designated successor may claim this role once they assert a sufficiently large tick", not
  as a time-based control. That sentence belongs in `CLAUDE.md` regardless of what this spike
  decides.
- **Related, deliberately not in scope**: `stale_holder?/4` (`authority.ex:994-1016`) inspects
  only the immediately-following acquire and can over-quarantine a holder's own command when it
  is concurrent with that holder's re-acquisition. Availability-only, deterministic across
  replicas, and it sits in the same fold — worth folding into whichever build plan touches this
  code, but it is not a provenance question.
