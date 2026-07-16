# Plan 010a (seam/work-package): Bind the real-carrier spike to Township W1/W3, and make the browser-realm encoding decision explicit

> **What this is.** A *seam document* between the substrate track (plan `010` —
> prove v2 over a real carrier) and the application track (the Township POC,
> `PD-001-A`). It does **not** restate plan 010 — read `010-real-carrier-spike.md`
> first; it is executor-grade on its own. This plan adds two things 010 does not
> carry: (1) an **application-level oracle** (Township W1/W3) that gives 010's
> convergence GATE a civic acceptance load instead of a synthetic one, and (2) the
> **encoding fork** that 010 defers — the moment a browser realm (a Vue/JS client,
> not a BEAM node) enters, `:erlang.term_to_binary` becomes impossible and canonical
> CBOR turns from "follow-up" into a Township-blocking prerequisite.
>
> **Drift check (run first):**
> `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/net.ex apps/lattice_core/lib/lattice/sync.ex apps/lattice_core/lib/lattice/op.ex docs/path_to_real.md plans/010-real-carrier-spike.md`
> If plan 010 has landed or moved, reconcile against its actual `Lattice.Carrier`
> behaviour before using the module names below.
>
> **Toolchain:** run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a
> broken mise shim). In GitHub Actions, plain `mix` works.

## Status

- **Priority**: P2 (direction seam)
- **Effort**: S as written (this is a binding + decision doc); the work it *gates* is 010 (L) + a CBOR migration (M) if the browser path is chosen
- **Depends on**: `010` (defines `Lattice.Carrier`); the Township overlay (defines W1/W3); `006` (pins the simulated `Net` contract the carrier must match)
- **Category**: direction / cross-track seam
- **Planned at**: against commit `81b9bfd`, same baseline as 010

## Why this exists — the relationship in one paragraph

Plan 010 proves the "no in-process locality" thesis by converging **two BEAM OS
processes** over a real WebSocket carrier and matching the `Lattice.Sim` oracle.
That is the right first step, and its light path is BEAM↔BEAM, so both peers speak
`term_to_binary` natively and the encoding never bites. **Township needs more than
that.** Township's exit gate `G1` (PD-001-A §A5) wants W0–W3 over a real carrier
including a **phone/browser realm** — and PD-001's whole L3 (Dark Forest OS) premise
is phone-hosted realms as first-class participants. A browser realm built as a
**Vue 3.5 + JS client** (the pragmatic cut both PD-001 and the toolchain preference
point to) is *not* a BEAM node and *cannot* produce `:erlang.term_to_binary`. So the
carrier decision and the encoding decision are **coupled**, and this document is
where that coupling is made explicit and handed to the two worktrees as a shared
success definition.

## The coupling finding (the load-bearing point)

`docs/path_to_real.md` already states it plainly: the ETF encoding is *"the only
place the current encoding is BEAM-specific,"* and canonical CBOR is the named
replacement so *"a Rust/JS/AtomVM peer and a BEAM peer hash and verify identically."*
`Lattice.Op` pins `:erlang.term_to_binary(…, [:deterministic, {:minor_version, 2}])`
(ADR-0001). Therefore:

| Carrier choice | Browser realm is… | Can it produce the pinned op hash? | Encoding consequence |
|---|---|---|---|
| **A · AtomVM/WASM node** | a real (minimal) BEAM node | Yes — `term_to_binary` runs natively | Encoding unchanged; **but** blocked today by *no Erlang distribution in AtomVM* and an *OTP-26 / Elixir-1.17 pin* that conflicts with the M1 core (OTP 28) and the latest-versions preference |
| **B · Vue/JS WS client** | a JS process speaking the sync protocol | **No** — a JS peer cannot emit byte-identical ETF | **CBOR migration (ADR-P08) becomes a hard prerequisite**, because Township property (c) "byte-identical replay" must hold *across* the Elixir↔JS boundary |

**Reading this table:** the browser realm's byte-identical-convergence requirement
(Township W1's property-(c) assertion, but now *cross-runtime*) is **impossible under
path A's blockers and impossible under path B until CBOR lands.** This is not a bug to
fix; it is a boundary condition to plan around — exactly the kind of impossibility
wall the program treats as a first-class design object. Plan 010's light path is
valuable precisely because it validates the *carrier seam* without paying the encoding
cost; this plan records that the encoding cost comes due the instant a non-BEAM realm
joins, and must not be discovered mid-Township.

## The carrier decision — framed as an evidence-driven spike, not an opinion

Plan 010 already recommends "light path first." This plan pins the **decision rule**
for the browser path that follows it, so the choice is settled by spike evidence and
recorded as an ADR (`docs/adr/0006-browser-realm-carrier.md`), never by preference.

**Candidates**
- **A — AtomVM/WASM realm** (PD-001's ambition; `docs/plans/2026-05-23-atomvm-browser-design.md`).
- **B — Vue 3.5 + JS WebSocket client realm** (PD-001's pragmatic cut; reuses the shipped Cowboy WS boundary).

**Evidence the spike must produce (the decision inputs):**
1. **Distribution/sync viability** — can the browser realm exchange op batches and
   reconcile frontiers against a BEAM peer *at all*? For A this is "does AtomVM-WASM
   have a working transport without Erlang distribution?"; for B it is "does the JS
   client reconcile via the `Lattice.Carrier` behaviour over the existing WS boundary?"
2. **Byte-identical hash parity** — feed both peers the same logical op; do their
   canonical encodings hash identically? For A, natively; for B, only after a JS
   canonical-CBOR encoder matches Elixir's CBOR byte-for-byte (this *is* the CBOR
   migration deliverable).
3. **Toolchain/version cost** — A pins OTP 26 / Elixir 1.17.3 (conflicts with the
   OTP-28 core and the latest-versions preference); B rides the current stack. Record
   the concrete integration cost, not a guess.
4. **Threat-model delta** — what each carrier changes about the A3 (seizure) and
   integrity guarantees; both must preserve `Lattice.Op.valid?/1` verification at the
   receiver (plan 010's tamper-rejection GATE).

**Decision rule:** choose the carrier that clears evidence (1) and (2) at the lowest
(3) cost without regressing (4). *If the spike shows A cannot clear (1) today (no
distribution) or forces the version regression in (3), B is selected and the CBOR
migration is scheduled as its enabling prerequisite — recorded as a finding, not a
preference.* Given the toolchain preference (latest Elixir / Phoenix LiveView / Vue),
B's realm is a **Vue 3.5** client; but that follows from the evidence and the seam
shape, not from taste, and A stays on the roadmap as the "first-class BEAM node"
end-state once AtomVM gains distribution.

## Township W1/W3 as the acceptance oracle (what this plan actually adds to 010)

Plan 010's GATE is engine-internal: *two processes converge a synthetic op set and
match `Sim`.* This plan replaces the synthetic op set with **Township's civic
workloads**, so "proven over a real carrier" means "a real civic scenario converges,"
which is the claim Township's G1 needs and 010 alone does not make.

- **W1 · Durable Deliberation** → the **partition/heal convergence** oracle.
  Run `Township.Matter`'s W1 scenario (both realms edit the `summary` LWW field and
  append posts while partitioned, then heal) across the **real carrier** instead of
  `Sim`. The existing `workflows_test.exs` W1 assertion (property a: realms converge;
  property c: byte-identical) is the pass condition — now over real IO, and (for the
  browser realm) *cross-runtime*.
- **W3 · Succession & Survival** → the **durability + partition-tolerance** oracle.
  Run W3's `Log.dump`/`Log.restore` and the succession beat with the surviving realm
  on a *separate OS process / device*. This is Township's "founding device destroyed"
  story executed physically — the A3 answer demonstrated, not asserted.

W0 (join-by-vouch) and W2 (roles/quarantine) are pure log-application and already pass
on `Sim`; they carry over unchanged and need no separate carrier oracle. **W4 stays on
the stub** — attestation crypto is a different track (M4), out of scope here.

## Deliverables

1. **`docs/adr/0006-browser-realm-carrier.md`** — the carrier decision (A vs B) with
   the four evidence inputs filled from the spike, the decision rule applied, and the
   CBOR consequence recorded. References `010`'s `Lattice.Carrier` behaviour.
2. **The encoding fork, written down** — if B is selected, open **`docs/adr/0007-cbor-canonical-encoding.md`**
   (the ADR-P08 the program has been deferring): canonical-CBOR encoding for `Lattice.Op`
   replacing the ETF pin, with the byte-identical cross-runtime requirement as its
   acceptance test. If A is selected, record why CBOR is deferred again and what unblocks it.
3. **Township-carrier acceptance harness** — a test/script that runs Township **W1 and
   W3** over the real carrier from plan 010 (BEAM↔BEAM first), asserting the *same*
   `workflows_test.exs` conditions the `Sim` versions assert. This is the artifact that
   turns 010's GATE into Township's G1.
4. **Findings note** appended to `docs/path_to_real.md` and the "stretch goals not done"
   list in `docs/lattice_poc_status.md`: carrier decision, encoding decision, and what
   the browser realm (path A or the CBOR-enabled path B) still needs.

## GATE criteria (this seam succeeds iff)

- Plan 010's own GATE is met (two BEAM processes converge byte-identically, sync is
  idempotent, tampered ops rejected) — this plan does not weaken it.
- **Township W1 converges over the real carrier**: the W1 partition/heal scenario run
  across two OS processes reaches the same converged `Township.Matter` state the `Sim`
  W1 test asserts (property a + c), matched against the `Sim` oracle.
- **Township W3 survives a physical kill/restore**: `Log.dump` on one process,
  `Log.restore` on another, reproduces the op set and materialized state (W3's assertion),
  over the real boundary.
- **The encoding decision is recorded as an ADR** with evidence — not left implicit.
  If B is chosen, a JS/CBOR peer hashes at least one op **byte-identically** to the
  BEAM peer (the migration's minimal proof); if that cannot be shown, that is the
  finding, and Township's browser realm is formally blocked on CBOR until it can.

## Scope

**In scope**: the carrier-decision ADR, the CBOR-decision ADR (or its deferral record),
a Township-W1/W3-over-real-carrier acceptance harness consuming 010's `Lattice.Carrier`,
and the findings note. Reuses `Township.Matter` and `workflows_test.exs` unchanged.

**Out of scope** (named on purpose):
- **Building the Vue 3.5 browser realm end-to-end** — that is the heavy-path browser
  plan 010 defers; this plan *decides* between A and B and pins the encoding prerequisite,
  it does not ship the browser client.
- **W4 / receipt-free attestation** — different track (M4, `PD-001 §6 R-02/R-03`); the
  stub stays.
- **Changing `Sync`/`Reduce`/`Authority`/`Log` semantics** — inherited from 010: the
  carrier is additive. If W1/W3 cannot converge over the carrier without touching these,
  **STOP and report** — that is a real finding about the "no in-process locality" claim.
- **Federation / cross-town identity** — M6, deliberately last.

## STOP conditions

- Township W1 cannot converge over the real carrier without changing engine semantics →
  report; the seam claim is at stake (this is 010's STOP condition, inherited).
- The op wire round-trip does not re-hash identically **across runtimes** (the ETF
  portability wall) → this is *expected* for path B and *is* the trigger to land CBOR;
  record it as the enabling finding, not a failure.
- The AtomVM path (A) cannot exchange ops without Erlang distribution → record; A is
  blocked until AtomVM gains it, and B + CBOR is the selected route.

## How to run this as two parallel Fable worktrees

This plan's reason to exist is to let the substrate and application tracks run **at the
same time** with a shared seam, rather than Township waiting on the carrier.

- **Worktree 1 (substrate):** execute plan `010` — define `Lattice.Carrier`, stand up
  two BEAM processes over WS, hit 010's GATE. Then this plan's carrier ADR + (if B) the
  CBOR ADR. Milestone-level delegation: hand Fable 010's GATE + this plan's decision
  rule and evidence inputs; let it write the ADRs against the live branch.
- **Worktree 2 (application):** keep Township's W0–W4 green on `Sim` (the overlay, today).
  When worktree 1 lands `Lattice.Carrier`, swap the W1/W3 harness from `Sim` to the real
  carrier — the assertions are written to carry over unchanged (PD-001 §6 V-03). No
  Township logic changes.

The two worktrees meet exactly at Deliverable 3 (the Township-carrier acceptance harness):
worktree 1 produces the carrier, worktree 2 produces the load, and this GATE is the
handshake.

## Tier-portability note (Fable)

Carrier/transport and encoding work is lower cybersecurity-classifier risk than the
attestation-crypto track, but WebSocket transport plus the object-capability framing can
still occasionally route a Fable session to the fallback tier. Frame the delegated tasks
as distributed-systems transport and serialization engineering (which they are), keep the
integrity/verification language descriptive, and expect the odd fallback session — the
ADRs and harness are plain enough to be tier-portable.

## Maintenance notes

- `Lattice.Sim` remains the conformance oracle for **both** worktrees: the real carrier
  (worktree 1) and the Township-over-carrier harness (worktree 2) must both reproduce the
  simulator's final state for a given op set. Do not let the carrier become its own oracle.
- When CBOR lands, `Township.Matter` and `workflows_test.exs` should need **no change** —
  if they do, the encoding migration leaked into the application layer and the `Op`
  boundary needs revisiting. That non-change is the proof the encoding fork stayed where
  it belongs.
