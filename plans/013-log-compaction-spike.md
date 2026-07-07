# Plan 013 (research spike): Log compaction (Sedimentree-style) — feasibility + design, not production

> **Executor instructions**: This is a **research spike**. The deliverable is a design
> doc + a throwaway prototype that proves (or disproves) one key property — NOT a
> production implementation. Do not wire compaction into the live runtime. Hit the GATE,
> write the findings, list open questions, and STOP. Update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/log.ex apps/lattice_core/lib/lattice/reduce.ex apps/lattice_core/lib/lattice/authority.ex docs/path_to_real.md`

## Status

- **Priority**: P3 (direction)
- **Effort**: L–XL (spike is L; production is XL)
- **Risk**: HIGH (touches the determinism invariant — the core thesis)
- **Depends on**: 005 helpful (cheaper reduction makes snapshot/verify experiments faster)
- **Category**: direction
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

A Replica's identity is its **entire** op-log. `Lattice.Log` is an unbounded op map;
`Lattice.Reduce` re-folds every op on each materialize; `Lattice.Sync` ships full id-sets.
`docs/path_to_real.md` §4 and `docs/lattice_poc_status.md` name compaction the **first
scaling cliff** and explicitly out of POC scope. Without it, long-lived replicas (chat,
docs, governance) hit memory/sync limits. The hard part is that compaction must not break
**determinism** (a synced, compacted log must reduce to byte-identical state) or
**authority soundness** (stale-holder/revocation checks depend on causal ancestry that
compaction would discard). This spike establishes feasibility and a design before anyone
commits to building it.

## Current state

- `apps/lattice_core/lib/lattice/log.ex` — `%Log{replica, ops, referenced, quarantine}`;
  `dump/2`/`restore/1` (whole-log term_to_binary); no snapshot/GC API.
- `apps/lattice_core/lib/lattice/reduce.ex` — `reduce/3` folds all (honored) command ops;
  supports a `:frontier` causal slice (the basis for `state_at`).
- `apps/lattice_core/lib/lattice/authority.ex` — `analyze/2` quarantine/holder decisions
  depend on `Dag.all_ancestors` / causal position (stale-holder needs the holder-change
  DAG; revocation needs "op not causally before the revoke").
- `apps/lattice_core/lib/lattice/dag.ex` — `topo_sort`, `all_ancestors`, `heights`,
  `reachable`.
- `apps/lattice_core/test/lattice2/convergence_property_test.exs` — the determinism oracle
  (byte-identical re-run; identical quarantine sets across realms).

## Deliverables

1. `docs/adr/0006-compaction.md` (or `docs/lattice2_compaction.md`): the design.
   At minimum it must specify:
   - **Snapshot structure**: reduced state at a stable causal frontier + the *authority
     summary* needed to keep stale-holder/revocation checks sound after the ops beneath
     the snapshot are dropped (e.g. the holder-chain + active/revoked delegation set as of
     the frontier), with a verification hash.
   - **Verification**: re-reduce check — a snapshot is valid iff reducing the ops it
     summarizes yields it (deterministic, checkable by any realm).
   - **GC rule**: which ops may be dropped (those strictly beneath a snapshot all
     participants have acknowledged) and what must be retained for `state_at`/audit and
     for authority soundness.
   - **Sync impact**: how a realm syncs against a peer that has compacted (transfer the
     snapshot + ops above it).
2. A throwaway prototype (a spike module/test under `apps/lattice_core/test/` or a branch),
   NOT wired into `Registry`/`Sim`, that demonstrates the GATE property below on a
   synthetic log.

## GATE (the spike succeeds iff it proves this one property)

For a generated log `L` with a chosen stable frontier `F`:
- compute `snapshot = compact(L, F)`;
- build `L' = snapshot + (ops of L above F)`;
- assert `Reduce.reduce(L')` (with authority quarantine) is **byte-identical** to
  `Reduce.reduce(L)` — including the quarantine set — across a range of scenarios that
  include an authority transfer and a stale-holder quarantine straddling `F`.

If this cannot be made to hold for authority-bearing logs without retaining the full
authority DAG, that is the key finding — record it (it bounds what compaction can drop).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Spike test | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/compaction_spike_test.exs` | the GATE property holds (or documents where it fails) |
| Determinism oracle | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs` | unchanged, green |
| Full suite | `~/.asdf/shims/mix test` | unchanged, green (spike is additive) |

## Scope

**In scope**: a design doc + a throwaway spike test/module proving (or disproving) the
GATE. Reuse `Reduce`/`Authority`/`Dag` read-only.

**Out of scope (hard)**:
- Wiring compaction into `Lattice.Log`/`Registry`/`Sim`/`Sync` live paths — this spike must
  not change runtime behavior. Production integration is a separate XL plan gated on this
  spike's findings.
- Partial-sync "shapes" and incremental (non-refold) reduction — note as related but
  separate.
- Changing `Reduce`/`Authority`/`Dag` semantics.

## STOP conditions

- The GATE property fails for authority-bearing logs and the only fix is "retain
  everything" — STOP and record that compaction of authority history is the hard
  sub-problem (a real, valuable finding); do not force a green by weakening the property.
- The spike starts requiring changes to live engine modules — STOP; the spike must stay
  additive/throwaway.

## Open questions for the maintainer (the spike should inform these)

- Can the authority frontier be summarized soundly, or must the full holder/revocation
  DAG be retained (capping how much compaction buys)?
- Acknowledgement model for GC: how does a realm know all participants have a snapshot
  (needs the carrier from plan 010)? Compaction may be blocked on a real membership/ack
  mechanism.
- Snapshot trigger policy (op count / height / time) — out of scope for the spike; note it.

## Maintenance notes

- This is the highest-risk direction item; keep it a spike until the GATE property is
  demonstrably robust across the property generators. Do not let a green spike on a toy
  log be mistaken for production readiness.
- Coordinate with plan 010/M2: compaction's GC needs the carrier's membership/ack signal,
  and M2 now provides the tested helper. Production compaction still needs a caller,
  snapshot-aware reduction, GC coordination, and snapshot trust.
