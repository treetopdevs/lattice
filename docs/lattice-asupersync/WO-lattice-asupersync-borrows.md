# WO — Asupersync borrows for Lattice

**Target repo:** `treetopdevs/lattice` (BEAM umbrella; `lattice_core` is plain OTP, no Ash)
**Source of ideas:** `Dicklesworthstone/asupersync` (Rust structured-concurrency runtime)
**Author of record:** Nicholas (treetopdevs)
**Status:** proposal for agent evaluation. This WO was written *after* reading the repo docs, so the two borrows are scoped to the **actual** gaps, not imagined ones. Each still has a "reject if" gate — confirm against code before writing.

---

## 0. Read this first — what NOT to do

Asupersync and Lattice look similar (both refuse ambient authority, both funnel every operation through one chokepoint) but solve **different problems**. Do not port Asupersync's runtime, scheduler, region tree, channels, or cancellation protocol. Lattice runs on the BEAM, which already provides supervision, links, monitors, and structured shutdown — the exact things Asupersync builds by hand in Rust. Copying its machinery into OTP is backwards.

Exactly **two** ideas transfer, and after reading the docs both are **narrower than they first appear** because Lattice has already done most of the work:

1. **Turn the existing attenuation rule into a proven composition algebra.** Lattice's `Attenuate` rule (in `docs/research/operational_model.md`) is already correct and per-dimension explicit. What's missing is that it's stated as an *inference rule*, not an *algebra with laws*, and its one soft spot — "child caveats are equal or stricter" — is the only unformalized line in an otherwise crisp rule.
2. **Close the gap the paper already names as future work:** "Formal operational semantics mechanized in a proof assistant." Asupersync's Lean-checked core is the model for the *discipline*, not the tool. Scoped correctly, this is an executable machine-checkable model of the operational semantics, not a rewrite in Lean.

Neither borrow adds a dependency on Asupersync, a proof assistant, or a new runtime. Both are additive, low-risk, and do not change the capability model, transport, or demos.

---

## 1. Ground truth from the repo (already read — trust this, then re-verify)

### 1.1 What exists in `lattice_core` (from `docs/research/architecture.md`)
- `Lattice.Cap`, `Lattice.CapStore`, `Lattice.Gateway` — enforce ownership, target, op, revocation, expiry, use limits, payload caveats, typed contracts, session transitions before forwarding.
- **`Lattice.Cap.Attenuation`, `Lattice.Cap.Caveat`, `Lattice.Cap.Macaroon`, `Lattice.Cap.Delegation`, `Lattice.Cap.Membrane`** — model PID-as-capability authority and child caps. **These are the modules BORROW 1 touches.** The attenuation logic already lives here; do not create a parallel module.
- `Lattice.Topology`, `Lattice.Graph.*` — trust-graph snapshot + invariant validation.
- `Lattice.Graph.Policy` already checks, among others: **"no child cap with more authority than its parent."** BORROW 1 makes that check provable rather than spot-checked.
- `apps/lattice_stress` — adversarial lab: `StreamData` random command sequences, race tests (call/revoke, concurrent use-limit exhaustion, etc.), WebSocket abuse, failure semantics, load/soak.

### 1.2 The attenuation rule as it already stands (`docs/research/operational_model.md`, `Attenuate`)
```
parent.delegation_allowed?
child.ops        ⊆ parent.ops
child.target     = parent.target
child.expiry     ≤ parent.expiry
child.use_limit  ≤ parent.use_limit
child caveats are equal or stricter        ← the only unformalized premise
child schema preserves parent schema
child session preserves parent session protocol
------------------------------------------------
delegate(parent, child_tab, child_constraints) -> child
```
Plus: "Revoking a parent recursively revokes descendants." So attenuation, revocation propagation, and the "no wider than parent" graph check **already exist and are correct.** The gap is formalization, not implementation.

### 1.3 What every doc explicitly disclaims (this is why BORROW 2 exists and is honest)
- `authority_invariants.md`: authority invariant is "validated by tests and property-style checks, **not by mechanized formal verification.**"
- `operational_model.md`: opens with "a precise executable specification, **not a mechanized formal proof.**"
- `paper_skeleton.md` → Explicit Non-Claims: "**No formal verification is claimed.**" → Future Work: "**Mechanize the operational semantics.**"
- `stress_lab.md`: "The lab is adversarial but **not a formal proof.**"

The core judgment in `operational_model.md` (the big admit-only-when premise list) **is already the invariants register in inference-rule form.** BORROW 2 does not rewrite it — it makes a bounded, exhaustive, machine-checkable version of it.

---

## 2. The borrows

### BORROW 1 — Promote the attenuation rule to a proven caveat algebra

**The actual gap.** Every dimension of `Attenuate` except caveats is already a clean scalar/set narrowing with an obvious meet: `expiry` (earlier wins), `use_limit` (smaller wins), `ops` (set intersection / subset), `target` (equality), schema and session (preservation). These are trivially a meet-semilattice. The soft line is **"child caveats are equal or stricter."** "Stricter" is asserted, never defined as a partial order. That means:
- There is no machine-checkable definition of when one `Lattice.Cap.Caveat` is `≤` another.
- Nothing proves that composing narrowings is **order-independent** (narrow by caveat A then B = B then A) or **associative** across a multi-hop delegation chain.
- Nothing proves the meet is **monotone** — that `combine` can only ever shrink authority, never widen it on any dimension — as a law, rather than as the sampled `Graph.Policy` check "no child with more authority than parent."

**What to build.** Inside the existing `Lattice.Cap.Attenuation` / `Lattice.Cap.Caveat` modules (not a new module):
- Define an explicit partial order `≤` (or a `stricter_or_equal?/2`) over `Lattice.Cap.Caveat` values, per caveat kind actually present in the struct. **Enumerate the real caveat kinds from `Lattice.Cap.Caveat` before writing this** — from the flagship they include at least `vendor = X`, `amount <= N`, `confirmation required`, provenance label. Each kind needs a defined meet and a defined `≤`.
- Define `combine/2` (meet) over full caveat sets: the effective caveat set of a delegation is the meet of parent and child sets, where a missing constraint on one side is "top" (unconstrained) and any contradiction (e.g. `amount <= 300` meet `amount <= 500` = `<= 300`; disjoint vendor sets = ⊥) is handled explicitly, with ⊥ collapsing the cap to **deny**, never to allow.
- State (and test) the three laws:
  - **Attenuation monotonicity:** `combine(P, C) ≤ P` on every dimension. The load-bearing security law. This is `Graph.Policy`'s "no child with more authority" check, but as a universally-quantified property instead of a per-snapshot spot check.
  - **Meet associativity + commutativity** for the composable dimensions, so a delegation chain's effective authority is independent of grouping/order. If any caveat kind is legitimately order-dependent by design, document it as an explicit exception rather than forcing it into the algebra.
  - **Identity:** the unconstrained caveat set is the identity of `combine`.

**How to verify (this is the point — it plugs into `lattice_stress`).** Add `StreamData` properties alongside the existing random-command suite:
- Generate a random root cap + a random chain of delegations; assert the effective cap is `≤` every ancestor on every dimension (monotonicity — now proven over the generator's whole space, not one flagship path).
- Generate a chain, shuffle narrowing order, assert identical effective cap (order-independence).
- Generate caveat sets that must collapse to ⊥ (contradictory vendor, past expiry, zero uses, empty op set); assert the Gateway denies **and** the target probe delivery count is unchanged — reusing the lab's existing "deny means non-delivery" evidence rule from `stress_lab.md`.

**Wiring.** The `delegate/3` path and `Gateway` authorization should compute effective caveats via `combine`, replacing the implicit "equal or stricter" check with the defined `≤`. **Surgical:** no allow/deny decision may change for any currently-passing test. This is a formalization + hardening of *how* effective authority is computed, not a behavior change. Run full suite + flagship + LiveOps before/after; deterministic outputs must match. Then update `operational_model.md`'s `Attenuate` rule to replace the prose "child caveats are equal or stricter" with a reference to the now-defined `≤`, and note the three laws.

**Reject / trim if:** `Lattice.Cap.Caveat` already defines a `≤`/meet with monotonicity under property test — then BORROW 1 is largely done and the only add is the associativity/commutativity properties and the doc update. Or if caveats are genuinely non-lattice-shaped by design (unlikely given the flagship's caveats) — then the algebra framing is wrong and must not be forced.

**Effort:** ~2 sessions. One to read `Cap`/`Cap.Caveat`/`Cap.Attenuation`/`Gateway` and enumerate real caveat kinds + current checks; one to define `≤`/`combine`, wire the call sites, add the three property tests, verify demo parity, update the doc.

---

### BORROW 2 — Mechanize the operational semantics (the paper's own future-work item)

**Why this is the right borrow, stated honestly.** The paper already lists "Mechanize the operational semantics" as future work and "No formal verification is claimed" as a non-claim. Asupersync's Lean-checked invariants are the reference for *what closing that gap looks like*. But Lattice should NOT reach for Lean/Coq/TLA+/Dafny in this WO — that's a large, separate decision. The transferable discipline is: **take the `operational_model.md` core judgment + rules, encode them as a pure executable model, and check the key invariants exhaustively over a bounded scope**, upgrading the strongest claims from "sampled by property tests" to "checked over all reachable states within scope K."

**What to build.**
- A pure model module (test-support, e.g. under `apps/lattice_stress` or a new `apps/lattice_model`): the cap/gateway state machine transcribed directly from `operational_model.md` — `Grant`, `Use`, `Deny`, `Attenuate`, `Bridge`, `Information Flow` rules over the `Runtime State` (`Tabs`, `Caps`, `Bridges`, `Audit`, `IFC`). No GenServers, no transport — a deterministic reducer `step(state, command) -> state'`.
- A **bounded exhaustive checker**: enumerate all reachable states from an initial state within a small scope (e.g. ≤3 tabs, ≤4 caps, delegation depth ≤3, ≤2 caveat kinds), and assert each core invariant holds at every reachable state. This is a hand-rolled BFS/DFS over the model's state space in Elixir — no external prover. (A `StreamData`-based stateful model is the sampled fallback if exhaustive blows up; prefer exhaustive at small scope because that's the whole point — it's the sentence that survives review: "checked exhaustively within scope K," not "sampled.")
- The invariants to check (transcribe from the existing docs — these already exist, just not as machine-checked propositions):
  1. **No ambient authority:** no admitted op lacks a live cap owned by the acting tab for that target+op. (core judgment)
  2. **Attenuation soundness:** every derived cap ≤ its parent on all dimensions. (cross-ref BORROW 1)
  3. **Revocation fail-closed + propagation:** after a cap or any ancestor is revoked, no op under it or any descendant succeeds. (`Attenuate` recursive revoke)
  4. **TTL/use-limit soundness, race-safe:** no op after expiry or past use limit; last-use is not double-spendable under interleaving. (the lab already found a real concurrent-exhaustion class of bug — model it.)
  5. **Topology default-deny:** absent an explicit bridge record, no tab-to-tab effect. (`Bridge` rule)
  6. **Lifecycle cleanup:** on tab disconnect/crash, all its caps + attached workers are revoked/reaped; no authority outlives its principal. (the lab's CapStore/Topology deadlock fix lives here.)
  7. **IFC monotonicity:** no admitted flow with `rank(payload_label) > rank(target_label)`. (`Information Flow` rule)

**Deliverable framing.** "The Lattice operational semantics from `operational_model.md` are encoded as a pure executable model; invariants 1–7 are checked exhaustively over all reachable states within scope K, and by `StreamData` sampling beyond it." That is the honest middle ground between "we tested it" and "we proved it in a proof assistant," and it directly discharges the paper's "mechanize the operational semantics" future-work line at demonstrator strength.

**Do NOT:** introduce Lean/Coq/TLA+/Dafny; claim "verified" or "proven" — the correct word is "checked exhaustively within a bounded scope" / "model-checked at small scope." If full mechanized proof is later wanted, that's a separate WO and a separate tool decision, to be made with Nicholas.

**Reject / trim if:** a model + bounded checker already exists (check `apps/lattice_stress` and any `*_model_test.exs`). Then the only add is widening the invariant set or the scope. If the property suite already effectively covers a given invariant exhaustively at small scope, don't duplicate it — cite it in `authority_invariants.md` instead.

**Effort:** ~3–4 sessions: one to transcribe the rules into a pure reducer faithfully (the risk is model/impl drift — the model must match `operational_model.md` and the real `Gateway`, or it proves nothing about the system); one to write the exhaustive enumerator + scope controls; one to encode the 7 invariants and get them green; one to write results into `authority_invariants.md` and the paper's evaluation section. Gate the paper-section edit on Nicholas.

---

## 3. Framing note for `paper_skeleton.md`

If both land, the paper gains a clean comparative anchor for its Related-Work matrix and evaluation: *Asupersync formalizes structured-concurrency correctness for a single-trust-domain Rust runtime; Lattice formalizes least-authority across a multi-principal, partially-hostile browser-tab boundary on the BEAM — the same discipline (no ambient authority, single chokepoint, composable attenuation, machine-checkable invariants) applied at two different trust boundaries.* BORROW 1 lets the paper state "capabilities compose under an explicit algebra with proven attenuation-monotonicity" as a contribution rather than a demo observation. BORROW 2 lets the "Evaluation Plan" section add a model-checking row and lets "Explicit Non-Claims" soften from "no formal verification" to "invariants model-checked exhaustively at bounded scope; full mechanization remains future work" — which is both stronger and still honest.

Editorial voice: sharp, forward-looking, load-bearing sentences, no phantom opponents, no hedging. Frame both as design choices Lattice makes, not gaps being apologized for.

---

## 4. Order of operations
1. Read `Lattice.Cap`, `Lattice.Cap.Caveat`, `Lattice.Cap.Attenuation`, `Lattice.Cap.Delegation`, `Lattice.Gateway`, `Lattice.Graph.Policy`, and the `lattice_stress` property + race tests. Enumerate the **real** caveat kinds and confirm which invariants already have exhaustive vs sampled coverage. **Report findings before writing code.**
2. BORROW 1: define `≤`/`combine` in the existing caveat/attenuation modules; wire `delegate` + `Gateway`; add 3 property tests; verify flagship + LiveOps parity; update `operational_model.md`'s `Attenuate` prose.
3. BORROW 2: build the pure model reducer from `operational_model.md`; add the bounded exhaustive checker; encode invariants 1–7; write results into `authority_invariants.md`.
4. Gate on Nicholas before: introducing any proof assistant, editing `paper_skeleton.md`'s claims, or widening scope beyond bounded model-checking.
5. One PR per borrow. Each PR: no allow/deny change to existing passing tests; full stress lab green; deterministic demo outputs unchanged.

## 5. Hard constraints
- No new runtime, scheduler, channel, or cancellation mechanism. The BEAM is the runtime.
- No Asupersync dependency; these are conceptual borrows.
- No Lean/Coq/TLA+/Dafny in this WO.
- `lattice_core` stays plain OTP; do not introduce Ash to model caps.
- Never loosen the security posture. Both borrows are formalization + hardening only.
- Never claim "verified/proven." Correct words: "proven law" (for the algebra's tested laws) and "model-checked exhaustively at bounded scope" (for BORROW 2).
