# ADR 0004 — Succession validation

## Status

Accepted (POC; legacy tick mode characterized, witnessed recovery opt-in).

## Context

A serialized role can be handed on explicitly by its holder (a `:transfer`), but recovery also
needs an authorization rule when that holder cannot transfer. The original POC used explicit ticks
in the log so every replica could replay the same result without reading a wall clock. That log
proves who signed each tick assertion; it does not prove that the holder was dormant.

Carrier connection state, a process-local clock, and counts of otherwise free log identities were
rejected as recovery authority: none distinguishes partition from failure, and each would give an
untrusted process or transport boundary semantic control. The selected opt-in floor is instead an
explicit governance decision by a witness set pinned in valid genesis.

## Decision

### Legacy tick mode

The legacy succession policy is recorded in the log at genesis:
`policies[role] = %{successor: <pubkey>, dormant_ticks: n}` (the demo/tests resolve a realm id to
its public key at creation time).

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

This mode remains accepted for compatibility and executable characterization. Its `at_tick` values
are author assertions, not trusted dormancy evidence.

### Witnessed recovery mode

A valid genesis may opt one role into witnessed recovery instead:

```elixir
%{
  successor: successor_pubkey,
  recovery: %{
    mode: :witnessed,
    version: 1,
    witnesses: [witness_pubkey, ...],
    threshold: m
  }
}
```

The effective policy is the existing canonical-DAG merge result: the last valid genesis entry for
the role wins globally. Witnessed recovery does not add a policy-update or migration ceremony. The
policy is invalid unless its witness keys are distinct 32-byte Ed25519 public keys and its threshold
is within `1..length(witnesses)`; witness keys are normalized by raw-byte order for policy identity.

A witnessed succession keeps the existing authority event but replaces the integer proof with
`{:witnessed, certificate}`. It is honored only when:

1. its author is the policy's designated successor and presents the existing well-formed
   self-issued role delegation;
2. the certificate claim exactly binds version, replica, role, current holder, the current holder's
   acquisition operation id, designated successor public key, and the normalized recovery-policy
   id; and
3. at least the configured threshold of distinct pinned witnesses signs the domain-separated claim
   with valid Ed25519 signatures in canonical raw-key order.

Malformed, unknown, duplicate, out-of-order, invalid, or subthreshold signature entries reject the
whole certificate with a deterministic authority-quarantine reason. An extra invalid entry is not
ignored after a valid threshold. A witnessed proof under a legacy policy, or a legacy tick under a
witnessed policy, is also rejected. The BEAM reducer and TypeScript client independently verify and
reduce the checked `township_succession_witnessed_recovery` vector.

## Rationale

* **Log-derivable and deterministic.** Both modes carry all reducer inputs in signed operations;
  every realm computes the same verdict and `state_at` replay remains exact.
* **Explicit governance floor.** Witnessed mode raises recovery authorization from one successor
  assertion to the configured genesis-pinned threshold without pretending that signatures prove
  absence.
* **No live clock or transport authority.** Neither mode reads a live clock or carrier connection
  state during reduction.

## Caveats (honest limitations)

* **Tick provenance is author-asserted and untrusted.** An operation signature authenticates who
  asserted `at_tick`; it does not prove elapsed logical time or holder unavailability. The
  Sim-generated `township_succession_unproven_tick` vector pins the current result: an immediate
  successor-authored `at_tick: 1_000_000` is honored with no heartbeat and no clock advancement.
* **Witnessed recovery is authorization, not an absence proof.** A threshold certificate proves
  only that the configured keys signed one exact governance recovery claim. It does not prove
  physical absence, elapsed time, process or network liveness, witness independence or honesty,
  non-coercion, consensus, or receipt-freeness.
* **`Lattice.Clock` is not an authority input.** It is an in-process test/demo Agent; no heartbeat,
  succession-authoring, or carrier path reads it when constructing an operation.
* **The carrier is transport-only.** Connection liveness is explicitly rejected as semantic
  recovery authority. The carrier does not choose witnesses, inspect dormancy, or sign recovery
  claims.
* **A heartbeat the successor has not yet seen does not block succession.** If the
  holder heartbeats while partitioned from the successor, the successor may succeed on
  its (older) `last_active` view; on heal the holder's subsequent ops are stale per
  ADR 0003. Witnesses likewise authorize the causal view named by a claim; they do not turn a
  partition into consensus or linearizable authority.
* **Policy migration remains open.** Only one effective succession policy per role is modelled, and
  existing global valid-genesis merge semantics remain. No post-genesis witness rotation is added.
* **User-facing succession remains blocked.** A separate plan must design review, witness
  collection, native custody, reconfirmation/expiry if desired, and explicit publication before a
  v7, LiveView, Tauri, or mobile authoring surface is allowed.
