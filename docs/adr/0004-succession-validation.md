# ADR 0004 — Succession validation

## Status

Accepted (POC).

## Context

A serialized role can be handed on explicitly by its holder (a `:transfer`), but it must
also recover from a holder that has gone dormant and cannot transfer. Succession lets a
**designated successor** claim the role after the holder has been silent past a
threshold — and it must be verifiable from the log alone, deterministically, with no
wall clocks (invariant 5).

## Decision

The succession policy is recorded in the log at genesis:
`policies[role] = %{successor: <pubkey>, dormant_ticks: n}` (the demo/tests resolve a
realm id to its pubkey at creation time).

Dormancy is measured against the logical `Lattice.Clock`. The holder's liveness is
expressed in-log:

* acquiring the role (genesis/transfer/succession) sets `last_active` to the
  acquisition's `at_tick`;
* while live, the holder may emit `{:heartbeat, role, at_tick}` authority ops (valid
  only if authored by the holder-at-its-deps), which advance `last_active`.

A succession op `{:succeed, role, delegation, at_tick}` authored by realm `S` is
**valid** iff, evaluated over its causal ancestors:

1. `S` is the policy's designated `successor` for `role`;
2. the delegation is a well-formed self-issued grant of `role` to `S`;
3. `at_tick ≥ last_active + dormant_ticks` (the holder has been dormant long enough).

A valid succession moves the holder to `S`. A succession failing (3) is quarantined
`:premature_succession`; failing (1)/(2) is `:unauthorized_succession`/
`:invalid_succession`. After a valid succession, the original holder's later
authoritative ops that did not observe it are quarantined `:stale_holder`
([ADR 0003](0003-stale-holder-quarantine.md)) — behavior 15.

## Rationale

* **Log-derivable & deterministic.** Successor identity, the threshold, `last_active`,
  and `at_tick` are all in the log; every realm computes the same verdict.
* **No wall clock.** Ticks are explicit values carried in op bodies; reduction never
  reads live clock state, so `state_at`/replay are exact.

## Caveats (honest limitations)

* **Dormancy = absence of heartbeats**, not a true liveness oracle. A live-but-silent
  holder that stops heartbeating looks dormant. A production system would derive
  heartbeats from connection liveness (the carrier), not application calls; this POC
  emits them explicitly so dormancy windows are controllable and deterministic.
* **A heartbeat the successor has not yet seen does not block succession.** If the
  holder heartbeats while partitioned from the successor, the successor may succeed on
  its (older) `last_active` view; on heal the holder's subsequent ops are stale per
  ADR 0003. This is the intended single-writer resolution, not a bug.
* Only one succession policy per role is modelled.
