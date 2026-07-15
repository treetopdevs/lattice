# ADR 0004 — Succession validation

## Status

Accepted (POC).

## Context

A serialized role can be handed on explicitly by its holder (a `:transfer`), but a production
design also needs an honest answer for recovery when a holder is unavailable and cannot transfer.
The POC represents succession eligibility with explicit ticks in the log so every replica can
replay the same result without reading a wall clock (invariant 5). The current log proves who
signed each tick assertion; it does not independently prove that the holder was dormant.

## Decision

The succession policy is recorded in the log at genesis:
`policies[role] = %{successor: <pubkey>, dormant_ticks: n}` (the demo/tests resolve a
realm id to its pubkey at creation time).

The current reducer does not measure dormancy against a live `Lattice.Clock`. It compares explicit,
author-asserted ticks carried in authority operations:

* acquiring the role (genesis/transfer/succession) sets `last_active` to the
  acquisition's `at_tick`;
* while live, the holder may emit `{:heartbeat, role, at_tick}` authority ops (valid
  only if authored by the holder-at-its-deps), which advance `last_active`.

A succession op `{:succeed, role, delegation, at_tick}` authored by realm `S` is
**valid** iff, evaluated over its causal ancestors:

1. `S` is the policy's designated `successor` for `role`;
2. the delegation is a well-formed self-issued grant of `role` to `S`;
3. `at_tick ≥ last_active + dormant_ticks` (the asserted tick clears the configured threshold).

A succession valid under that deterministic rule moves the holder to `S`. A succession failing
(3) is quarantined
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

* **Tick provenance is author-asserted and untrusted.** An operation signature authenticates who
  asserted `at_tick`; it does not prove elapsed logical time or holder unavailability. The
  Sim-generated `township_succession_unproven_tick` vector pins the current result: an immediate
  successor-authored `at_tick: 1_000_000` is honored with no heartbeat and no clock advancement.
* **`Lattice.Clock` is not an authority input.** It is an in-process test/demo Agent; no heartbeat,
  succession-authoring, or carrier path reads it when constructing an operation.
* **The carrier is transport-only.** Connection liveness is not selected as semantic dormancy
  authority. A remediation must separately select and adversarially review a provenance model,
  such as a trust anchor, quorum, causal-activity rule, explicit availability tradeoff, or removal
  of production succession; this ADR does not choose one.
* **A heartbeat the successor has not yet seen does not block succession.** If the
  holder heartbeats while partitioned from the successor, the successor may succeed on
  its (older) `last_active` view; on heal the holder's subsequent ops are stale per
  ADR 0003. This is the intended single-writer resolution, not a bug.
* Only one succession policy per role is modelled.
