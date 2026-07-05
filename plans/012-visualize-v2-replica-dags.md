# Plan 012 (design/impl): Visualize v2 Replica op-logs/DAGs via the existing graph exporter

> **Executor instructions**: Design step first (decide what to render), then a focused
> implementation reusing `Lattice.Graph.Export`. Honor STOP conditions. Update
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/graph apps/lattice_core/lib/lattice/dag.ex apps/lattice_core/lib/lattice/authority.ex`
> If these moved, re-read them before implementing.

## Status

- **Priority**: P3 (direction)
- **Effort**: S–M
- **Risk**: LOW (read-only visualization; no engine change)
- **Depends on**: none
- **Category**: direction / docs
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The repo already has a production-quality v1 trust-graph inspector
(`Lattice.Graph.Snapshot` + `Lattice.Graph.Export` rendering JSON/DOT/Mermaid, used by the
flagship demo). The v2 engine has nothing visual — its proof is a narrated text demo
(`scripts/lattice2_demo.exs`) and property tests. A v2 Replica is a causal **DAG of
signed ops** with a deterministic reduction and an authority **quarantine** set — exactly
the kind of structure a DAG diagram explains far better than prose. Rendering a Replica
log (ops as nodes, `deps` as edges, quarantine status as color/label, holder timeline)
would be a high-leverage pedagogical artifact built mostly from existing pieces.

## Current state

- `apps/lattice_core/lib/lattice/graph/export.ex` — `Lattice.Graph.Export.export(graph, :mermaid | :dot | :json)`
  (entry point used in `scripts/lattice_verify_flagship.sh:35-36`). Read it to learn the
  `graph` shape it expects (nodes/edges).
- `apps/lattice_core/lib/lattice/graph/snapshot.ex` — builds the v1 graph from
  `Topology`/`CapStore`/`Audit`. **v1-specific**; do not retrofit v2 into it.
- v2 inputs available: a `Lattice.Log` (`Log.ops/1`, `Log.topo_ops/1`, `Log.frontier/1`);
  `Lattice.Dag.heights/1` (causal height for layout); `Lattice.Authority.analyze/2`
  (returns `%{quarantine, reasons, holders, audit}`); `Lattice.Reduce.reduce/3`.
- `Lattice.Sim` can produce a realistic log (partition → diverge → sync → merge) for a
  demo scenario deterministically.

## Design step (decide, record in `@moduledoc`)

- **What is a node**: each op (id short-hash, `kind`, a body summary). Group/rank by
  `Dag.heights/1` so the diagram reads top-to-bottom causally.
- **What is an edge**: `deps` (op → each dependency).
- **Status overlay**: color/label quarantined ops (`Authority.analyze`'s `quarantine` +
  `reasons`) distinctly from honored ops; optionally mark the authority `holders`.
- **Output**: reuse `Lattice.Graph.Export` if the `graph` shape fits; if it doesn't map
  cleanly, emit Mermaid directly (a small function) rather than contorting the v1 shape —
  decide based on reading `export.ex`.

## Deliverables

1. `apps/lattice_core/lib/lattice/graph/replica_snapshot.ex` — `build(module, log)` →
   a graph value (nodes/edges/status) for a v2 Replica log, plus a render to Mermaid
   (reuse `Graph.Export` or a local renderer).
2. A script `scripts/lattice2_visual_demo.exs` that runs a `Lattice.Sim` partition→sync
   scenario and prints/writes the Mermaid (and optionally DOT/JSON) for the merged log,
   showing one quarantined op (e.g. a stale-holder lock) highlighted.
3. Tests `apps/lattice_core/test/lattice2/replica_snapshot_test.exs`: for a known small
   log, assert node/edge counts match the op/deps counts and that a quarantined op is
   flagged.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `cd apps/lattice_core && ~/.asdf/shims/mix compile` | 0 warnings |
| Snapshot tests | `cd apps/lattice_core && ~/.asdf/shims/mix test test/lattice2/replica_snapshot_test.exs` | pass |
| Visual demo | `~/.asdf/shims/mix run scripts/lattice2_visual_demo.exs` | prints valid Mermaid |
| Full suite | `~/.asdf/shims/mix test` | all pass |

## Scope

**In scope**: the new `replica_snapshot.ex`, the visual demo script, its test, and reuse
of `Lattice.Graph.Export`.

**Out of scope**:
- `apps/lattice_core/lib/lattice/graph/snapshot.ex` (v1) — do not modify; build a separate
  v2 module so the v1 flagship pipeline is untouched.
- The web UI / LiveView — this plan produces Mermaid/DOT text artifacts (renderable in
  Markdown/CI), not a new interactive page. A web inspector is a possible follow-up.
- Any change to `Dag`/`Authority`/`Reduce`/`Log` (read-only consumers).

## STOP conditions

- If `Lattice.Graph.Export`'s `graph` shape cannot represent op-DAG nodes/edges without
  changing `export.ex`, do NOT change `export.ex` — emit Mermaid from a small local
  function instead and note the divergence.
- If rendering requires data `Authority.analyze/2` does not expose (e.g. per-op holder),
  report it rather than adding fields to the analysis output here.

## Open questions for the maintainer

- Static text artifacts (Mermaid/DOT) only, or eventually a live web inspector like the
  v1 flagship UI?
- Should the diagram show the reduced state alongside the DAG, or just the DAG + quarantine?

## Maintenance notes

- Keep this module a pure consumer of `Log`/`Dag`/`Authority` so it never affects engine
  determinism.
- If plan 005 (reduction refactor) lands, re-verify `Authority.analyze`'s output shape is
  unchanged (this module reads `quarantine`/`reasons`/`holders`).
