# Research Brief: M4 Receipt-Free Attestation Primitive

Status: open research gate (Phase F, `TOWNSHIP_BUILD_MAP.md` §4a context — this is
one of the program's two hard blockers, alongside ADR-P08/CBOR). Not started.

Audience: an agent or researcher picking this up cold, with no prior context on
this codebase beyond what's linked below.

## 1. Background — what already exists and why this brief exists

Township (`PD-001` milestone M5) is a town-scale civic instance running on the
Lattice substrate. One of its four workflows (W4) is "receipt-free attestation" —
members cast vouches on a matter such that no one, including the voter, can later
produce evidence of how they voted, even under coercion.

The codebase does **not** implement this yet, deliberately. It implements a seam:

- [`Lattice.Attestation`](../../apps/lattice_core/lib/lattice/attestation.ex) — a
  behaviour with four callbacks (`receipt_free?/0`, `cast_vouch/3`, `tally/2`,
  `produce_alt/2`).
- [`Lattice.Attestation.Stub`](../../apps/lattice_core/lib/lattice/attestation.ex) —
  the only real implementation today. It's honest: `receipt_free?/0` returns
  `false`. Vouches are plain signed tags; `produce_alt/2` fabricates an
  alternative with no cryptographic backing, so a coercer *is not* actually
  defeated.
- [`Lattice.Attestation.M4Placeholder`](../../apps/lattice_core/lib/lattice/attestation.ex) —
  an empty reserved slot with a doc comment sketching the expected shape
  (chameleon hash + designated-verifier proof, or whatever clears JCJ).
- [`Lattice.Attestation.Contract`](../../apps/lattice_core/test/support/attestation_contract.ex) —
  a shared ExUnit contract both `Stub` and the future M4 module must pass. Every
  property passes for both **except** one: the contract's receipt-freeness test
  currently `flunk`s outright for any module claiming `receipt_free?() == true`,
  because no indistinguishability check has been written yet (see lines 76–101 of
  that file). That `flunk` is the actual finish line for this research.

**The engineering bet already made:** if the four-callback interface captures
exactly what a receipt-free primitive needs, then landing the real primitive is a
drop-in module swap (`Stub` → real `M4` module) with **zero changes** to
Township's other three workflows (W0–W3), which are built and passing today. This
brief's job is to validate or falsify that bet, and to close the crypto gap it's
betting on.

## 2. Research goal

Determine whether a receipt-free (coercion-resistant, deniable) attestation
primitive in the JCJ (Juels–Catalano–Jakobsson) lineage can be:

1. **instantiated soundly** — the primitive itself actually delivers
   receipt-freeness/coercion-resistance under a stated adversary model, not just
   "looks plausible" — and
2. **composed correctly** with the rest of the Lattice stack — CRDT merge
   semantics, the `authority:`/capability model, and causal (DAG) ordering —
   without silently reintroducing a receipt, a distinguishing side channel, or a
   tallying inconsistency.

This is a **verdict-producing** research task, not an implementation task. A
correct, well-justified "no, and here is why every current primitive in this
family fails against the DAG's replay/audit properties" is as valid an outcome as
a "yes, here is the primitive and here is the proof sketch." Do not force a
positive answer.

This maps to `PD-001 §6 R-02/R-03` (referenced in the source comments but not
present as a standalone file in this checkout — treat the callback shapes and
this brief as the authoritative restatement of that requirement for this repo).

## 3. What "composes correctly with the rest of the Lattice stack" means, concretely

The primitive doesn't operate in isolation — it has to survive three properties
that the rest of Township already guarantees and must keep guaranteeing:

- **CRDT merge / convergence.** Vouch ops are appended to a replica's log as
  `:command` ops (see `vouch_body :: {:vouch, term()}`) and merged via the
  existing CRDT machinery. `tally/2` must stay a **deterministic, order-independent
  reduction** over that op set (this already holds for the Stub — see the
  contract test `"tally is deterministic and counts choices"`, which asserts
  `tally([b1,b2,b3]) == tally([b3,b1,b2])`). A candidate primitive that makes
  tally order-sensitive, or that requires an interactive/coordinator step to
  reduce, breaks the DAG-native "coordinator-free reconciliation" property this
  system relies on everywhere else.
- **Authority/capability model.** Vouches are cast by an `Identity`, routed
  through Township's `authority:` field semantics like any other command. The
  primitive must not require new ambient trust (e.g., a designated tallying
  authority that isn't already expressible as a Lattice capability), and must
  not leak the caster's identity to anyone who doesn't already hold the
  capability to see it.
- **Causal ordering / replay.** Lattice's core M1 properties (byte-identical
  replay, identical quarantine behavior under partition) must keep holding
  with real vouch/tally/equivocation ops in the log — including under the
  same replay-from-log and time-travel (`Lattice.state_at/3`) operations the
  rest of the system supports. A primitive that depends on operations being
  seen in a specific order, or on ops being deleted/rewritten after the fact,
  is disqualified outright — Lattice's log is append-only and this is a hard
  invariant, not a negotiable one.

## 4. The exact interface the primitive must fill

```elixir
@callback receipt_free?() :: boolean()
@callback cast_vouch(Identity.t(), choice :: term(), opts :: keyword()) ::
            {token(), vouch_body()}
@callback tally([vouch_body()], opts :: keyword()) :: tally_result()
@callback produce_alt(token(), demanded :: term()) :: vouch_body()
```

- `cast_vouch/3` returns an **opaque token** (kept client-side only) plus a
  `vouch_body` appended to the public log. The token is where any trapdoor
  material (e.g., a chameleon-hash collision key) must live — it is never
  logged, never replicated, never seen by anyone but the voter.
- `produce_alt/2` is the equivocation hook: given the private token and a
  coercer's `demanded` value, produce a vouch body that (a) is itself a
  valid, tallyable vouch and (b) is indistinguishable — to anyone who only
  sees op bodies on the log — from a genuine vouch for `demanded`. This is
  where receipt-freeness actually lives; everything else in the interface is
  plumbing.
- `tally/2` must remain the deterministic DAG reduction described above,
  unchanged in spirit from the Stub's implementation.

A valid research output should map its recommended primitive onto exactly these
four callbacks and flag anywhere the mapping is forced, awkward, or loses a
property — that is a signal the interface bet in §1 is wrong and needs to be
renegotiated, which is valuable information even if it's not "done."

## 5. Success criteria (binary gate — all must hold)

The research is complete, successful, and ready to hand to an implementation
agent only when it produces a written verdict that:

1. **Names a specific primitive construction** (e.g., "chameleon-hash
   commitment + designated-verifier re-opening proof," "deniable encryption
   scheme X," "linkable ring signature composition Y") — not a general
   direction. Include the specific paper(s)/scheme(s) and their known security
   reductions.
2. **States the adversary model explicitly** — what a coercer can see (op
   bodies on the replicated log, in what order, from what capability level),
   what they can demand of the voter, and whether the model is
   forced-abstention-resistant, not just receipt-free. JCJ-family schemes have
   known extensions/weaknesses here (e.g., coercion via forced randomness,
   or via network-level side channels outside the crypto) — the verdict must
   say which of these are in scope and which are explicitly out of scope for
   this POC.
3. **Gives a proof sketch or citation-backed argument for indistinguishability**
   — i.e., what the eventual replacement for `Contract`'s current `flunk` at
   `attestation_contract.ex:76-101` should actually assert, and why that
   assertion is sound. This does not need to be a full formal proof, but it
   needs to be more than "the paper says so" — it needs to connect the paper's
   guarantee to *this* system's exposure (an append-only public log, CRDT
   merge, no synchronous tallying authority).
4. **Explicitly addresses composition** with the three properties in §3 —
   determinism/order-independence of tally, no new ambient authority, and
   survival under append-only causal replay — with a verdict of "compatible,"
   "compatible with modification X," or "incompatible, because Y" for each.
5. **Maps the primitive onto the four `Lattice.Attestation` callbacks** from
   §4, flagging any callback whose contract needs to change and why.
6. **States whether the verdict is "land it"** (with the above filled in
   sufficiently that `Lattice.Attestation.M4Placeholder` could be implemented
   directly from the brief) **or "do not land it"** (with a clear
   falsification — the specific property that breaks and why no known
   variant in this family fixes it for this system's shape).

A "land it" verdict is only acceptable if items 1–5 are all filled in with
enough specificity that an implementation agent does not need to re-derive the
cryptography — vague positivity ("JCJ-style schemes generally support this") is
not a passing result.

A "do not land it" verdict is an acceptable and complete result on its own,
provided it's falsifiable — i.e., it names the specific incompatibility rather
than asserting difficulty in general terms.

## 6. Non-goals — explicitly out of scope for this research pass

- **Implementation.** This brief asks for a verdict and a design, not Elixir
  code. Do not touch `attestation.ex`, `attestation_contract.ex`, or write a
  new `M4` module. That is separate, follow-on work gated on this verdict
  landing.
- **Key rotation, recovery, E2EE, federation, cross-town identity.** Out of
  scope for the whole Township POC (`CLAUDE.md` "Constraints" section) —
  don't let the primitive selection get entangled with these.
- **Production compaction / GC coordination.** Assume the append-only log as
  currently modeled; do not design around a compaction scheme that doesn't
  exist yet.
- **UI/UX of the vouch-casting flow.** Not this brief's concern.
- **Performance/scalability tuning** of the chosen primitive beyond
  "plausible at ≤10k participants, town scale" (the POC's stated ceiling).
  A back-of-envelope cost estimate is useful; a full benchmark is not
  required.

## 7. Suggested starting points (not exhaustive, not prescriptive)

- Juels, Catalano, Jakobsson, "Coercion-Resistant Electronic Elections" — the
  JCJ paper itself and its known follow-on critiques/fixes (credential
  revocation, tallying complexity issues raised by Weber/Araújo et al., and
  later linear-time variants).
- Civitas (Clarkson, Chong, Myers) as a systems-level JCJ implementation —
  useful for seeing how JCJ's tallying-authority assumptions were handled in
  practice, and for identifying which of those assumptions this system
  cannot make (no synchronous tallying authority; append-only DAG instead of
  a bulletin board with erasure).
- Chameleon-hash-based deniable commitment schemes, as hinted at in
  `M4Placeholder`'s doc comment — evaluate specifically for compatibility
  with §3's determinism/order-independence requirement.
- MACI (Minimal Anti-Collusion Infrastructure) is referenced elsewhere in
  this codebase's comments as the source of the "DAG absorbs coordinator-free
  reconciliation" framing for `tally/2` — worth reading for how it separates
  coercion-resistance from tallying, even though its trust model (centralized
  coordinator) differs from Lattice's and should not be copied uncritically.

## 8. Deliverable format

A single Markdown document (suggested location:
`docs/research/m4_receipt_freeness_verdict.md`) structured to answer §5 items
1–6 in order, with inline citations. If the verdict is "land it," end with a
short section titled "Handoff to implementation" that an agent implementing
`Lattice.Attestation.M4Placeholder` could follow without re-reading the source
papers.
