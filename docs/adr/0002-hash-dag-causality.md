# ADR 0002 — Hash-DAG causality over vector clocks

## Status
Accepted (POC).

## Context
Lattice needs (a) causal ordering of ops, (b) tamper-evidence, and (c) a deterministic
total order for fields that require one (LWW registers, the serialized authority
field). It must converge under arbitrary partition and delivery order.

## Decision
Causality is carried by a **content-addressed hash-DAG**: each op's `id` is the hash of
its content, and `deps` is the set of predecessor ids the author had observed (its
frontier). The causal frontier is the set of ops no other op depends on. Where a total
order is needed it is the **topological order of the DAG with op-id (hash) tiebreak**
(`Lattice.Dag.topo_sort/1`, Kahn's algorithm with a `:gb_sets` ready-set keyed by id).
CRDT ordering tags use `{causal_height, op_id}` where height is `0` for roots and
`1 + max(dep heights)`.

## Rationale
* **Tamper-evidence for free.** Because ids are content hashes and deps cite ids,
  mutating any op changes its id and orphans all descendants — no separate Merkle
  structure needed.
* **Determinism without coordination.** Topo+hash order is a pure function of the op
  set; every realm computes the same order, so the same ops reduce to byte-identical
  state regardless of arrival order (behaviors 2, 18).
* **No actor registry / no clock skew.** Vector clocks require a known, stable set of
  actor ids and grow with the number of actors; they also don't, by themselves, give
  tamper-evidence. The hash-DAG identifies causality structurally and needs no global
  actor enumeration.

## Consequences
* The frontier-diff sync (`Lattice.Sync`) reconciles by exchanging missing ids; the POC
  ships the full id set (tiny scale). A production carrier negotiates recursively from
  frontiers — an optimization, not a semantic change (see `path_to_real.md`).
* "Causal height" is a convenient deterministic, causality-respecting scalar for CRDT
  tags; it is **not** a Lamport clock shared across realms and is not used for security
  — only for ordering within a known op set.
* Concurrent operations get an arbitrary-but-deterministic order (hash tiebreak). This
  is correct for LWW/CausalList; for the OR-Set, concurrency is handled by the
  observed-remove rule (causal ancestry), not by the tiebreak.

## Alternatives considered
* **Vector clocks** — rejected: actor-set management, no tamper-evidence, no help with
  the single-writer authority token.
* **A single Lamport clock** — rejected: needs message exchange to advance and doesn't
  capture concurrency precisely enough for the OR-Set.
