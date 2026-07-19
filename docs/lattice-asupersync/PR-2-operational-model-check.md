# PR 2 — Mechanize the operational semantics (bounded exhaustive model check)

**Branch:** `feat/operational-model-check`
**Scope:** discharge the paper's "Mechanize the operational semantics" future-work item at demonstrator strength. **No runtime behavior change.**
**Related:** WO — Asupersync borrows for Lattice, BORROW 2
**Do not merge if any box in "Acceptance gates" is unchecked.**
**Gated:** editing `docs/research/paper_skeleton.md` claims requires Nicholas's sign-off; do NOT include that edit in this PR unless explicitly approved.

## What this does

Every Lattice doc currently disclaims formal verification, and `paper_skeleton.md` lists "Mechanize the operational semantics" as future work. This PR takes the `Grant / Use / Deny / Attenuate / Bridge / Information Flow` rules and core judgment from `docs/research/operational_model.md`, encodes them as a **pure, deterministic model** (no GenServers, no transport), and checks the core authority invariants **exhaustively over all reachable states within a small bounded scope**, plus `StreamData` sampling beyond it.

The honest claim this earns: *invariants model-checked exhaustively at bounded scope; full mechanization remains future work.* Not "verified," not "proven."

## What this does NOT do

- Does not introduce Lean/Coq/TLA+/Dafny or any proof assistant.
- Does not modify `lattice_core` runtime code, the Gateway, transport, or demos.
- Does not claim "verified" or "proven" anywhere in code, docs, or PR text.
- Does not widen scope beyond bounded model-checking without separate approval.

## Changes

- New pure model (test-support; `apps/lattice_model` or under `apps/lattice_stress`): a reducer `step(state, command) -> state'` transcribing `operational_model.md` over the `Runtime State` (`Tabs`, `Caps`, `Bridges`, `Audit`, `IFC`). Deterministic, side-effect-free.
- Bounded exhaustive checker: BFS/DFS enumerating all reachable states from an initial state within a small scope (e.g. ≤3 tabs, ≤4 caps, delegation depth ≤3, ≤2 caveat kinds), asserting every invariant at every reachable state. Scope constants are configurable and documented.
- `StreamData` stateful sampling for scopes beyond exhaustive reach (fallback breadth, not the headline claim).
- `docs/authority_invariants.md`: add a section recording each invariant, the rule it derives from, its check method (exhaustive-at-scope-K vs sampled), and the residual proof gap (holds over all reachable states within scope, not all possible states).

## Invariants checked (transcribed from existing docs)

1. **No ambient authority** — no admitted op lacks a live cap owned by the acting tab for that target+op. _(core judgment)_
2. **Attenuation soundness** — every derived cap ≤ its parent on all dimensions. _(cross-refs PR 1's monotonicity law)_
3. **Revocation fail-closed + propagation** — after a cap or any ancestor is revoked, no op under it or any descendant succeeds. _(`Attenuate` recursive revoke)_
4. **TTL/use-limit soundness, race-safe** — no op after expiry or past use limit; last use is not double-spendable under interleaving. _(models the concurrent-exhaustion bug class the lab already caught)_
5. **Topology default-deny** — absent an explicit bridge record, no tab-to-tab effect. _(`Bridge` rule)_
6. **Lifecycle cleanup** — on tab disconnect/crash, all its caps + attached workers are revoked/reaped; no authority outlives its principal. _(models the CapStore/Topology deadlock class the lab already fixed)_
7. **IFC monotonicity** — no admitted flow with `rank(payload_label) > rank(target_label)`. _(`Information Flow` rule; lattice `public < internal < confidential < secret`)_

## The main risk: model/impl drift

A pure model that doesn't faithfully mirror the real `Gateway` proves nothing about the running system. Mitigations, both required:

- [ ] Every model rule cites the exact `operational_model.md` rule and the corresponding `lattice_core` function it mirrors, inline.
- [ ] A cross-check test drives a set of scenarios through **both** the model and the real `Gateway`/`CapStore` and asserts identical allow/deny outcomes, so drift is caught mechanically rather than by inspection.

## Acceptance gates (all must hold)

- [ ] `mix test` fully green; no changes to any existing `lattice_core` or `lattice_stress` assertion.
- [ ] Pure model is side-effect-free and deterministic (no process spawning, no clock/IO reads inside `step/2`; time modeled as data).
- [ ] Exhaustive checker enumerates the full reachable state space at the documented scope and asserts invariants 1–7 at every state; run is green and its scope is printed in output.
- [ ] Model/impl cross-check test present and green (see "drift" above).
- [ ] `StreamData` sampled checks present for out-of-scope breadth and green.
- [ ] `docs/authority_invariants.md` updated with the per-invariant method + proof-gap table; wording says "model-checked exhaustively within scope K," never "verified/proven."
- [ ] No `lattice_core` runtime file changed (diff is confined to model/test/doc paths).
- [ ] `paper_skeleton.md` NOT edited in this PR unless Nicholas approved (call it out explicitly either way).

## Reviewer notes

- If a model + bounded checker already exists (`apps/lattice_stress`, any `*_model_test.exs`), this PR shrinks to widening the invariant set/scope — say so, don't duplicate.
- If the existing property suite already covers an invariant exhaustively at small scope, cite it in `authority_invariants.md` instead of re-checking it.
- Prefer exhaustive-at-small-scope over sampling-at-large-scope for the headline invariants (2, 3, 4). Exhaustiveness within bound is the entire value; a wider sampled check is strictly weaker for the claim.
- The correct vocabulary everywhere: "proven law" only for PR 1's algebra laws; "model-checked exhaustively at bounded scope" for everything here. Reject any copy that says "verified" or "proven" of the system.
