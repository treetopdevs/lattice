# Capability-Gated Process Messaging: Operational Model

This is a precise executable specification, not a mechanized formal proof.

## Runtime State

Lattice state contains:

- `Tabs`: tab id -> realm/session/lifecycle/worker/cap metadata.
- `Caps`: cap id -> target/owner/op/caveat/provenance/session state.
- `Bridges`: cap id -> from-tab/to-tab bridge policy.
- `Audit`: append-only in-memory event stream for tests and demos.
- `IFC`: runtime labels and observed flow attempts.

## Core Judgment

An operation is admitted only when:

```text
Caps[cap_id] = cap
cap.owner_tab_id = tab_id
op in cap.ops
cap is not revoked
cap is not expired
cap.use_limit is not exhausted
all ancestors of cap are live
payload satisfies cap.schema
payload satisfies all caveats
cap.session advances on payload session_step
target topology policy admits the edge
```

Only then may the gateway forward:

```text
tab_id --cap_id/op/payload--> Lattice.Gateway --> target process or tab bridge
```

## Rules

### Grant

```text
connected(tab)
fresh(cap_id)
target = normalized_target(raw_target)
-----------------------------------------
grant(tab, target, ops, caveats) -> cap
```

The grant records `tab --holds--> cap --authorizes--> target`.

### Use

```text
authorize(tab, cap, op, payload) = ok(cap')
topology_allows(tab, cap'.target)
-----------------------------------------
call/cast(tab, cap, payload) forwards
```

Authorization increments use count and may advance a session automaton. When a
child cap is exercised, successful authorization also consumes parent-chain use
limits and advances parent-chain session state.

### Deny

Any failed premise records an audit denial. No forwarding occurs.

### Attenuate

```text
parent.delegation_allowed?
child.ops subset parent.ops
child.target = parent.target
child.expiry <= parent.expiry
child.use_limit <= parent.use_limit
child caveats are equal or stricter
child schema preserves parent schema
child session preserves parent session protocol
-----------------------------------------
delegate(parent, child_tab, child_constraints) -> child
```

Child provenance records parent id, root id, delegating tab, receiving tab, and
time. Revoking a parent recursively revokes descendants in this implementation.

### Bridge

```text
connected(tab_a)
connected(tab_b)
cap.target = tab_b
cap.owner = tab_a
bridge[cap.id] = {tab_a, tab_b}
-----------------------------------------
tab_a may call tab_b through cap
```

A normal cap targeting another tab is not sufficient. The explicit bridge
record is required.

### Information Flow

```text
rank(payload_label) <= rank(target_label)
-----------------------------------------
flow allowed
```

The prototype lattice is `public < internal < confidential < secret`.

## Executable Evidence

- `apps/lattice_core/test/lattice_research_test.exs`
- `mix lattice.research.demo`
- `mix lattice.graph.snapshot`
