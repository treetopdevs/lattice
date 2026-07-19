# PR 1 — Caveat attenuation as a proven composition algebra

**Branch:** `feat/caveat-algebra`
**Scope:** formalization + hardening of existing attenuation. **No behavior change.**
**Related:** WO — Asupersync borrows for Lattice, BORROW 1
**Do not merge if any box in "Acceptance gates" is unchecked.**

## What this does

Lattice's `Attenuate` rule (`docs/research/operational_model.md`) already narrows every dimension of a delegated cap correctly, and `Lattice.Graph.Policy` already spot-checks "no child cap with more authority than its parent." The one unformalized premise is `child caveats are equal or stricter` — "stricter" is asserted but never defined as a partial order, and composition (narrow by A then B) is never proven order-independent or monotone.

This PR defines caveat attenuation as an explicit meet-semilattice inside the existing `Lattice.Cap.Caveat` / `Lattice.Cap.Attenuation` modules, and upgrades the "no wider than parent" spot check into universally-quantified properties in `lattice_stress`. It replaces the implicit "equal or stricter" check on the `delegate`/`Gateway` path with the now-defined `≤`, computing exactly the same allow/deny decisions.

## What this does NOT do

- Does not add a new module for caveats (uses the existing ones).
- Does not change any allow/deny decision for any currently-passing test.
- Does not touch transport, topology, audit format, or the demos' behavior.
- Does not introduce any dependency.

## Changes

- `Lattice.Cap.Caveat`: define `stricter_or_equal?/2` (the `≤` partial order) and `meet/2` per caveat kind actually present in the struct. _(Enumerate real kinds from the struct — the flagship uses at least `vendor = X`, `amount <= N`, `confirmation required`, provenance label. List them in the PR body.)_
- `Lattice.Cap.Attenuation` (or `Lattice.Cap.Delegation`, wherever `delegate` lives): `combine/2` over full caveat sets — missing constraint = top (unconstrained); any contradiction = ⊥ collapsing the cap to **deny**, never allow.
- Call-site swap on `delegate/3` and `Gateway` authorization to compute effective caveats via `combine`, replacing the prose "equal or stricter" check.
- `docs/research/operational_model.md`: replace the `Attenuate` rule's prose line `child caveats are equal or stricter` with a reference to the defined `≤`, and note the three laws.

## The three laws (asserted as properties, not prose)

1. **Attenuation monotonicity** — `combine(P, C) ≤ P` on every dimension. A child can never out-authorize its parent. (This is `Graph.Policy`'s existing check, now universally quantified.)
2. **Meet associativity + commutativity** — a delegation chain's effective authority is independent of how narrowing steps are grouped/ordered, for all composable dimensions. Any legitimately order-dependent kind is documented as an explicit exception, not forced into the algebra.
3. **Identity** — the unconstrained caveat set is the identity of `combine`.

## Acceptance gates (all must hold)

- [ ] `mix test` fully green, including all pre-existing `lattice_core` and `lattice_stress` tests, with **zero** changes to their assertions.
- [ ] New `StreamData` properties added to `lattice_stress` and green:
  - [ ] random root cap + random delegation chain ⇒ effective cap `≤` every ancestor on every dimension.
  - [ ] chain with shuffled narrowing order ⇒ identical effective cap.
  - [ ] contradictory/exhausted caveat sets (disjoint vendor, past expiry, zero uses, empty op set) ⇒ Gateway **denies** AND the target probe's delivery count is unchanged (reusing the lab's "deny means non-delivery" evidence rule).
- [ ] **Demo parity:** `scripts/lattice_verify_flagship.sh` passes and `output/flagship/claims.json` + graph JSON/DOT/Mermaid are unchanged vs. `main` (diff the deterministic artifacts).
- [ ] **LiveOps parity:** `scripts/lattice_liveops_demo.sh` runs green; deterministic `output/liveops/*` artifacts unchanged vs. `main`.
- [ ] No allow/deny decision changed: confirmed by the two parity checks above plus the unchanged existing adversarial suite.
- [ ] `operational_model.md` updated so the spec matches the code (the `Attenuate` prose line replaced by the defined `≤`).
- [ ] PR body lists the actual enumerated caveat kinds and, for each, its `≤` and `meet`.

## Reviewer notes

- The security-load-bearing law is monotonicity. If a property ever finds a widening path, that is a real vulnerability the spot check was missing, not a test bug — stop and surface it.
- If `Lattice.Cap.Caveat` already defines a `≤`/meet with monotonicity under test, this PR shrinks to adding associativity/commutativity properties + the doc update; say so in the body rather than reimplementing.
- Keep the diff surgical. This is a refactor-with-laws, not a redesign.
