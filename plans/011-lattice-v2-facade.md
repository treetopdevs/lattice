# Plan 011 (design): A clean `Lattice.V2` facade resolving the v1/v2 API name clash

> **Executor instructions**: This plan has a design step (settle the API surface) and an
> implementation step (a thin, tested facade). Do the design step's decisions first,
> recorded in the module's `@moduledoc`. Honor STOP conditions. Update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice.ex apps/lattice_core/lib/lattice/registry.ex`
> If these changed, re-read the v2 facade section before proceeding.

## Status

- **Priority**: P3 (direction)
- **Effort**: S–M
- **Risk**: LOW (additive facade; no v1 behavior change)
- **Depends on**: none
- **Category**: direction / dx
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The v2 public API is split and partly awkward because v1 already owns the obvious names.
`apps/lattice_core/lib/lattice.ex` documents this directly: v1 defines `call/3` (Gateway),
`grant/4` (tab cap), `cast/3`; the v2 **promise `call`** and **capability `grant`** are
therefore reached via `Lattice.Registry` and in-log delegation ops, while non-clashing v2
verbs (`materialize/2`, `tombstone/2`, `monitor/2`, `send_durable/3`, `await/2`,
`state_at/3`, `go_dormant/2`) sit on `Lattice`. A learner must juggle two regimes and
discover that "the v2 call" is `Lattice.Registry.call/4`. A single, documented
`Lattice.V2` facade gives v2 a coherent surface without breaking any v1 caller.

## Current state

- `apps/lattice_core/lib/lattice.ex`:
  - v1: `grant/4` (line ~28), `call/3` (~66), `cast/3` (~67).
  - v2 section (after `external_cap/1`): `materialize/2`, `go_dormant/2`, `tombstone/2`,
    `monitor/2`, `send_durable/3`, `await/2`, `state_at/3`, with a comment explaining the
    clash and that promise-`call`/capability-`grant` live on `Lattice.Registry`.
- `apps/lattice_core/lib/lattice/registry.ex` — the durable runtime: `host/4`,
  `materialize/2`, `go_dormant/2`, `tombstone/2`, `monitor/3`, `deliver/4` (durable send),
  `sync/3`, `call/4` (promise), `await/3`, `dump/3`, `restore/4`, `state/2`, `log/2`.
- `apps/lattice_core/lib/lattice/sim.ex` — the pure simulator API (create_replica, grant,
  transfer, succeed, revoke, command, partition/heal/sync, state, …). This is the other
  "v2 surface" used by tests/demo.
- No `Lattice.V2` module exists.

## Design step (decide, then encode in `@moduledoc`)

Settle and document these before/while implementing:
1. **Surface**: which v2 verbs the facade exposes and their canonical names. Proposed:
   `Lattice.V2.materialize/2`, `dormant/2`, `tombstone/2`, `monitor/2`, `send/3`
   (durable send), `call/4` + `await/2` (promise), `state/2`, `state_at/3`. All delegate
   to `Lattice.Registry`/`Lattice`/`Authority` — no new logic.
2. **Capability/grant naming**: how a caller issues a v2 delegation through the facade
   (delegations are in-log ops authored by a realm; today tests build them via
   `Lattice.Authority.Delegation` + ops, and `Lattice.Sim` wraps that). Decide whether
   the facade exposes a `grant`/`delegate` that drives the runtime, or whether that stays
   in `Sim`/`Registry`. Record the decision; do not over-build.
3. **v1 deprecation**: decide NOT to rename/deprecate v1 in this plan (keep it
   non-breaking). Note a future option (a `Lattice.V1` alias or `@deprecated`) as an open
   question, not an action.

## Deliverables

- `apps/lattice_core/lib/lattice/v2.ex` — a thin, documented facade delegating to existing
  runtime functions. Each function is a one-liner `defdelegate`/wrapper; the value is
  coherence + discoverability, not new behavior.
- A doc table (in the `@moduledoc` and/or README, coordinate with plan 009) mapping
  v1 verb ↔ v2 verb so readers see the two regimes side by side.
- Tests: `apps/lattice_core/test/lattice2/v2_facade_test.exs` proving each facade function
  routes to the same result as the underlying runtime call (e.g. `Lattice.V2.materialize/2`
  == `Lattice.Registry.materialize/2`), modeled after `lifecycle_test.exs`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `cd apps/lattice_core && ~/.asdf/shims/mix compile` | 0 warnings |
| Facade tests | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/v2_facade_test.exs` | pass |
| Full suite | `~/.asdf/shims/mix test` | all pass (v1 unchanged) |
| Format | `~/.asdf/shims/mix format` | exit 0 |

## Scope

**In scope**: `apps/lattice_core/lib/lattice/v2.ex` (new), a new facade test, and (if doing
the doc table here rather than in plan 009) a small README/`@moduledoc` table.

**Out of scope**:
- Changing or deprecating any v1 function on `Lattice` — strictly additive.
- Changing `Registry`/`Authority`/`Sim` behavior — the facade only delegates.
- Renaming the existing non-clashing v2 functions already on `Lattice` (keep them;
  `Lattice.V2` can delegate to them).

## STOP conditions

- If exposing a v2 `grant`/`delegate` on the facade would require new runtime logic (not
  just delegation) — STOP and report; keep the facade to verbs that already exist, and
  list the missing primitive as an open question.
- If any v1 test changes behavior because of the new module — that means the facade isn't
  purely additive; revert and report.

## Open questions for the maintainer

- Is v2 intended to become the primary API (then a later plan deprecates v1 names), or do
  both stay first-class indefinitely?
- Should the pure `Lattice.Sim` surface and the live `Lattice.Registry` surface converge
  behind one facade, or remain "simulation vs runtime" deliberately?

## Maintenance notes

- Keep `Lattice.V2` a delegation-only layer; if logic creeps in, push it down into the
  runtime modules so the facade stays trivially correct.
- Coordinate the v1↔v2 doc table with plan 009 (README v2 section) to avoid duplication.
