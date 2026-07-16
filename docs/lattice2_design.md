# Lattice 2.0 — Design

Lattice 2.0 evolves the v1 capability POC into a **Replica** model: a process whose
identity is a durable, capability-attested **op-log**, and whose materializations are
ephemeral BEAM processes that are pure reductions of that log. This document
describes the architecture, the five non-negotiable invariants, the op model,
authority semantics, lifecycle states, and what the simulated realms stand for.

All Lattice 2.0 code lives in `apps/lattice_core/lib/lattice/` alongside the v1
modules it reuses (`Lattice.Cap`, `Lattice.Gateway`, `Lattice.Realm`/`Tab`,
`Lattice.Audit`). The v1 suite still passes (behavior 19).

## The five invariants

1. **The log is the truth; the connection is the cache.** Live delivery and
   post-partition sync flow through the *same* op-application path
   (`Lattice.Log.accept/2`) and the *same* reduction (`Lattice.Reduce`). A scenario
   run fully live and the same scenario run with partitions + sync produce identical
   final logs and state (behavior 18).
2. **One delegation chain, two uses.** The signed `Lattice.Authority.Delegation`
   that authorizes appending an op to a log also authorizes sending a live ephemeral
   message through the v1 Gateway (`Lattice.Live`). The unification is concrete: a
   single in-log `:revoke` op is consulted by *both* the append path (reduction
   quarantine) and the live path (`Live.authorize/2`), so one revoke kills both
   (behavior 16, the keystone). `Live.revoke/4` also revokes the linked v1 cap as
   defense-in-depth for a *direct* `Gateway.call` that bypasses `Live.authorize/2`.
3. **Determinism.** Given the same set of ops, every realm reduces to byte-identical
   state regardless of delivery order, partition schedule, or interleaving. Total
   order where needed is the topological order of the causal DAG with op-hash
   tiebreak (`Lattice.Dag`).
4. **Nothing is silently lost.** Structurally invalid ops (bad signatures) are
   quarantined in `Lattice.Log`; semantically invalid or stale ops (unauthorized,
   stale-holder, revoked, double-transfer losers) remain in the log but are excluded
   from reduction by `Lattice.Authority` and recorded in its audit trail.
5. **No live-clock authority.** Reduction never reads a wall clock or
   `Lattice.Clock`. Legacy succession and heartbeat operations carry caller-supplied
   `at_tick` values as deterministic replay inputs, not as proof of elapsed time or
   holder absence. Opt-in witnessed succession uses a genesis-pinned authorization
   certificate and no clock input. `Lattice.Clock` is only an explicitly advanced
   test/demo utility; no `Process.sleep`-based semantics decide authority.

## Op model

```elixir
%Lattice.Op{
  id:      <<sha256 of the canonical encoding of every field below>>,
  replica: replica_id,            # the Replica log this op belongs to
  author:  <<ed25519 public key>>, # the authoring realm
  deps:    [op_id, ...],          # causal frontier: direct predecessors (sorted)
  kind:    :command | :authority | :inbox | :tombstone,
  body:    term(),                # {:post, [text]} | {:transfer, role, deleg, tick} | ...
  cap:     delegation_id | nil,   # reference into the delegation chain justifying this op
  sig:     <<ed25519 signature by author over the canonical encoding>>
}
```

* **Canonical encoding** — `Lattice.Canonical`, a small CBOR-shaped subset over
  `{replica, author, sorted(deps), kind, body, cap}` with explicit tags for BEAM
  atoms/tuples/MapSets/delegations. See [ADR 0001](adr/0001-canonical-encoding.md).
* **Hash-chaining** — `id` is the content hash and `deps` cite predecessor ids, so
  the log is a tamper-evident hash-DAG: mutating any field changes the id and breaks
  every descendant. See [ADR 0002](adr/0002-hash-dag-causality.md).
* **Signing** — Ed25519 via OTP `:crypto` (`Lattice.Identity`). Each realm owns a
  keypair generated at creation; for deterministic simulation a realm may be derived
  from a seed (`Identity.from_seed/2`).

### Reduction

`Lattice.Reduce.reduce/3` materializes a log into state:

1. compute the causal slice (all ops, or those reachable from a `:frontier` for time
   travel), heights, and the canonical total order (`Lattice.Dag`);
2. exclude the authority quarantine (`:quarantine` opt) — unauthorized/stale ops;
3. fold each honored `:command` op's mutations into per-field CRDTs.

Because each field is a state-based CRDT whose join is commutative/associative/
idempotent, and ordering tags are `{causal_height, op_id}`, the result is independent
of delivery order — byte-identical convergence (behaviors 1, 2, 18).

### CRDTs (`Lattice.Crdt.*`, hand-rolled, property-tested)

| Field strategy | CRDT | Semantics |
|---|---|---|
| `merge: :lww` | `Lww` | last-writer-wins by `{height, op_id}` tag |
| `merge: :or_set` | `OrSet` | observed-remove set; removes retire only causally-visible add-tags (add-wins) |
| `merge: :causal_list` | `CausalList` | RGA-style; elements ordered by `{height, op_id}`, tombstone deletes |

## Authority semantics (`Lattice.Authority`)

Authority is in-log delegation. The unit is a signed `Delegation`
(issuer → audience, scoped to a replica, granting command `ops`, serialized `roles`,
and/or `live` send). The genesis op self-grants the creator full capability and
records the succession policies.

* **Cap-gated append** (behavior 5): a `:command` op must cite (`op.cap`) a delegation
  that is valid (signature + attenuation along the chain), causally visible (its
  defining op is an ancestor), addressed to the author, conferring the command, and
  not revoked-as-of the op.
* **Serialized authority** (behaviors 6–9): an op mutating an `authority:` field is
  honored only if its author is the role holder **at the op's causal position** and
  no valid holder-change moved the role away concurrently. A non-holder's direct
  mutation is quarantined; the intended pattern is to queue an inbox `:request` that
  the holder's materialization processes into a real command op.
* **Stale holder** (behaviors 8, 15): see [ADR 0003](adr/0003-stale-holder-quarantine.md).
* **Double transfer** (behavior 9): two concurrent transfers by one holder resolve by
  canonical order — the first wins, the rest are quarantined as `:double_transfer`
  anomalies and audited.
* **Revocation** (behavior 10): ops citing a revoked delegation that are not causally
  before the revoke are quarantined (`:revoked_capability`).
* **Succession** (behavior 15): legacy tick mode remains deterministic but untrusted;
  opt-in witnessed mode requires a threshold certificate under the effective valid
  genesis policy. See [ADR 0004](adr/0004-succession-validation.md).

Every quarantine decision is deterministic (a pure function of the op DAG), so all
realms compute identical quarantine sets after full sync (property d).

## Lifecycle states (`Lattice.Registry` + `Lattice.Materializer`)

A `{realm, replica}` pair is `:live`, `:dormant`, or `:tombstoned`:

* **live** — a `Lattice.Materializer` process exists (the live cache + query handle).
* **dormant** — the process has stopped; the log persists in `Lattice.Registry`. The
  Registry observes the process `:DOWN` and transitions to dormant.
* **tombstoned** — a `:tombstone` op is in the log; rematerialization is blocked
  forever, on every realm (the check reads the log, not a local flag).

Monitors subscribe to `{:lattice_lifecycle, key, state}` transitions and
`{:lattice_message, key, payload}` deliveries (behavior 13).

### Durable messaging & promises

* **Durable send** (behavior 11): a `{:message, to_realm, payload}` inbox op is
  delivered to the destination realm's next materialization exactly once (an in-log
  `{:delivered, id}` ack makes re-delivery idempotent), in causal order.
* **Promises** (behavior 12): `Lattice.Registry.call/4` authors a
  `{:request, ref, to_realm, query}` op and returns a `Lattice.Promise` (the v1 facade
  owns `Lattice.call/3`, so the 2.0 promise call lives on `Lattice.Registry`); the
  destination realm answers with a `{:response, ref, result}` op; `Lattice.await/2`
  reads the result from the log — surviving dormancy of either side, because
  resolution lives in the log, not a mailbox.

### Persistence (behavior 14)

`Lattice.Log.dump/2` / `restore/1` serialize a log to disk. Killing a realm's
processes and restoring its log from a dump, then rematerializing, recovers state,
authority, and pending promises intact.

## What the simulated realms represent

The two/three in-process "realms" in tests and the demo are stand-ins for **server
BEAM nodes** and **browser AtomVM nodes**. `Lattice.Net` is the simulated transport
(partition/heal + seeded delivery). Crucially, nothing in the public API assumes
in-process locality — realms are addressed by id — so a real AtomVM/WebSocket carrier
can replace `Lattice.Net` without changing application code. M2 proves the server-BEAM
side of that claim with `Lattice.Carrier` and `apps/lattice_node_spike`: two OS
processes sync over a real WebSocket and converge to the `Lattice.Sim` oracle. The
native browser/AtomVM peer still needs its own implementation of `Lattice.Canonical` and
`Lattice.Carrier.Wire`. See [path_to_real.md](path_to_real.md) and ADR 0005.

Compact proof harnesses are useful only when they exercise this canonical path.
Avoid parallel proof stacks that reimplement log, authority, attestation, or
reduction beside `Lattice.Log`, `Lattice.Authority`, `Lattice.Reduce`, and
`Lattice.Sync`; mergeable proof work should land as scenarios or regression tests
against the real modules so the evidence cannot drift from runtime semantics.

## Module map

| Concern | Modules |
|---|---|
| Op / encoding / signing | `Lattice.Op`, `Lattice.Identity` |
| Log / order / sync / transport | `Lattice.Log`, `Lattice.Dag`, `Lattice.Sync`, `Lattice.Net` |
| CRDTs / reduction / DSL | `Lattice.Crdt.{Lww,OrSet,CausalList}`, `Lattice.Reduce`, `Lattice.Replica`, `Lattice.Demo.Thread` |
| Authority | `Lattice.Authority`, `Lattice.Authority.Delegation`, `Lattice.Cap` (evolved), `Lattice.Live` |
| Lifecycle / messaging | `Lattice.Registry`, `Lattice.Materializer`, `Lattice.Promise` |
| Test/demo utilities | `Lattice.Sim`, `Lattice.Clock` |
| Public facade | `Lattice` (2.0 functions added alongside v1) |
