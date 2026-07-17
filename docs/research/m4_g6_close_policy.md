# G6 decision — close and ballot-set finality: confirm `:unanimous_boxes_v1`

**Status:** decision **cleared 3-agent review**, 2026-07-17. Cycle-1 EVALUATE: agy 1–10
(crypto), codex 1–12 (repo-contract, verified the confirmed policy matches the closed
verifier code). Both graded A `viable-with-changes` (documentary corrections only, no
design change); B rejected (out of scope / contract conflict), C not adopted. Cycle-2:
agy CLEARS; codex CLEARS after conditioning the abort-recovery prose (§2/§6) on the
G8 validator/lifecycle implementation, consistent with §3. Two reviewer findings
arbitrated with corrections: agy #9 (selective-tally look-ahead) refuted — ballots are
encrypted at close, no tally exists to condition on, and the proposed clock-based fix
rejected; agy #5 (abort frontier drift) — abort is idempotent-terminal. Zero unaddressed
high findings; all `SecurityProfile` claims `:not_claimed`; no closed pin reopened.
**Gate:** G6 (brief §15.6) — "The POC accepts unanimous-box close, or a named BFT close
protocol and proof replace it."
**Decision:** **confirm `:unanimous_boxes_v1`** as the pinned POC close policy. B (a named
BFT replacement) is out of scope for v1; C (a documentary upgrade wrapper) is not adopted
— the brief §9 already records the BFT-replacement requirements, so no new commitment is
minted. No `SecurityProfile` claim flips; W0–W3 unchanged; no closed gate reopened.

## 0. Why confirm, and why this is not a rubber-stamp

The close verifier `Township.Election.ClosePolicy.UnanimousBoxesV1` is already implemented
and part of the closed F1 foundation; `Spec.validate_close_policy/1` accepts only
`%{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all}`. Four closed gates are
already load-bearing on it (G2 cleansing consumes its `CloseEvidence.ballot_digests`; G5's
holdback caveat is built on its censorship gap; G8's abort names `:close_stalled` as the
recovery for its liveness sacrifice). Confirming it requires **no code change**; replacing
it would retroactively unpin parts of G2/G5/G8.

Codex verified A's property statements against the actual verifier and **confirmed the
core mechanics** (seal completeness `collect_seals/6` → `:checkpoint_incomplete` on
omission; manifest requires one seal per configured box; certificate requires every box
signature over the manifest digest with a matching `attest_close` in causal past;
pure withholding → `{:pending, [{:box_seal_missing, id}]}` with no forced/partial close;
competing certified manifests → `{:forked, [%{reason: :forked_close}]}` with no
hash/topo/author/arrival resolver; all twelve claims `:not_claimed`). The corrections
below are documentary — precision fixes to A's prose, not design changes.

## 1. Uniqueness guarantee (corrected per codex #1, #2, #5)

- Each configured box publishes **one logical seal digest through an authenticated
  `publish_box_seal` board op** (authentication is the signed outer op, not a bare
  "signs one seal"; same-digest retransmissions are permitted; **distinct** valid seal
  digests from one box constitute equivocation). The seal names the open certificate and
  every ballot wrapper the box authored in the seal's causal past; omission →
  `:checkpoint_incomplete`.
- A canonical manifest carries exactly one seal from **every** configured box plus the
  deduplicated, canonically sorted union of ballot artifact digests and wrapper op IDs.
  A close certificate carries the manifest ref and every box signature over the manifest
  digest, each cross-checked against an `attest_close` op in the certificate's causal
  past.
- **Uniqueness is guaranteed *if* at least one configured box is honest and never signs
  two different manifests** (codex #1: "if", not "iff" — the brief §9 wording; an
  all-Byzantine box set could still happen to sign only one manifest, so the honest box
  is sufficient, not necessary). Under `quorum: :all`, one honest non-equivocating box
  pins a single manifest digest no adversary controlling the other boxes can fork over
  that box's signature.
- **Equivocation vs fork precedence (codex #5):** equivocation invalidates a
  *non-forked* close (`{:invalid, [%{reason: :box_equivocation}]}`); two fully certified
  competing manifests surface first as `:forked_close` (the fork check runs before the
  equivocation check).

## 2. Liveness posture (confirmed by code)

Liveness is **intentionally sacrificed**. Pure withholding (no malformed publication) by
any configured box leaves `{:pending, [{:box_seal_missing, id}]}`; the election never
closes on its own, and no branch manufactures, times out, or selects a partial close
(codex #6, confirmed). This lives entirely under **`availability: :not_claimed`**;
**`closure_safety` stays `:not_claimed`** for this loop (the uniqueness property above
would support a future `:conditional` closure_safety claim only through the human F4
step — never conditioned here; codex #12 confirmed).

**Single-box liveness DoS (agy #1) is accepted as a v1 operational constraint:** any one
unavailable or withholding box stalls close → the designed recovery is a `:close_stalled`
abort → new election. This is the decisive operational judgement G6 must make, and the
answer for the town-scale POC is *acceptable* — **once the G8-authorized abort validator
and terminal lifecycle fold are implemented (§3)**, a stalled election recovers to a
clean verifiable terminal state, not a forged or partial result; until then the recovery
is a pinned design contract, not an executable guarantee. Either way the verifier never
forces or partially closes — it stays `:pending`. Operators need a re-run playbook; that
is an operational guideline, not a protocol guarantee.

## 3. Interaction with the G8 abort — corrected (codex #9, #10; arbitrates agy #5)

This is where A's original prose overstated, and the correction matters:

- **The G8 abort recovery is a closed *design contract*, not a repository guarantee
  today (codex #9).** `abort_election` is currently a `no_state` command, the projector
  is still hard-coded to `phase: :setup`, and G8 explicitly marks the abort-certificate
  validator and the deterministic terminal lifecycle fold as *buildable work it
  authorizes*. So the correct statement is: **once the authorized G8 validator/lifecycle
  work is implemented**, a withholding box → `:pending` → (unbounded operator patience,
  no trusted clock) → optional quorum-authorized `:close_stalled` abort → clean
  `:aborted` terminal. Until then, the recovery path is designed and pinned, not
  executable.
- **The close cut and the abort cut are DIFFERENT absence predicates and can disagree
  (codex #10 — corrects A's original "cannot disagree").** Close seal completeness is
  evaluated per seal op's own causal ancestors, and missing-box detection scans the
  verifier's supplied safe log — there is no single common certified frontier. G8's abort
  is instead relative to the abort op's *exact signed dependency frontier*, and
  explicitly permits genuinely concurrent contributions to fall outside that cut. So a
  G8 cut-relative absence can coexist with later/concurrent close evidence. **Reconciling
  the two is part of the future terminal-lifecycle rules** (the G8-authorized fold): the
  lifecycle fold must define precedence when an abort cut and close progress race. This
  is named as a forward obligation, not asserted as already-consistent.
- **Abort is idempotent-terminal (arbitrates agy #5).** agy worried divergent
  DAG-frontier abort certs cause "state divergence." They do not in the harmful sense:
  any valid abort certificate yields `:aborted`, and `:aborted` is a single terminal
  outcome with no *result* to disagree on — unlike `:forked_close`, which is two
  different manifests/results. Multiple valid abort certs (different frontiers, each with
  q=3 co-signers) all converge to `:aborted`. The lifecycle fold (above) still owns the
  abort-vs-close-progress precedence, but there is no fork-of-results hazard from
  multiple aborts.

## 4. Interaction with remove-all cleansing (corrected per codex #8)

On a successful close, `decide/7` constructs `ballot_digests` by mapping the certified
artifact digests, deduplicating, and canonically sorting them — **the verifier emits the
field; the closed G2 contract specifies its consumption as a set with no order semantics**
(codex #8: there is not yet a runtime G2 cleansing consumer in `apps/lattice_core/lib`;
G2 §4 is the contract). Ballots outside the certified manifest are **late/excluded**;
causal concurrency with a close proposal is not the eligibility rule (brief §9).
Remove-all's coercion posture (a same-credential duplicate nullifies rather than elects)
is unchanged by confirming this policy; RV-3 (G2 §4 duplicate-rule fidelity) remains a
named G12 obligation, not silently satisfied here.

## 5. The three explicit non-guarantees (agy #2/#3/#4, brief §9)

Confirming unanimous-box does **not** provide, and must never be read as providing:

1. **Ballot completeness / censorship resistance.** The close certificate does not prove
   a censoring box published a ballot it received (brief §9), and honest close-signing
   can *mask* earlier ingress censorship (agy #2: a box honest at close may have censored
   at ingress; dovetails G5 §3 / codex #7 — holdback is an SLA, not seal-verifiable).
   Carried under **`censorship_resistance: :not_claimed`**.
2. **Roster/DKG configuration finality (agy #3, brief §9).** The trustee, teller, and box
   *keys* are frozen in the immutable `ElectionSpec` (bound via `spec_digest`→
   `election_id`; already closed — a config swap is a new election). But the registration
   **roster content** (published via `publish_roster`) and the **DKG result** (published
   setup) are artifacts that require *equivalent sealing discipline* (brief §9) — a
   canonical, signed, non-equivocating seal — which the **ballot-set close does not
   provide**. This is a **named forward obligation** (owner: G4 for roster, G8/G4 for
   DKG-result sealing). No later gate may conflate ballot-set finality with
   configuration/roster/DKG finality.
3. **Close keys distinct from the trustee decryption threshold (agy #4, brief §9).** The
   box close keys and the CHide trustee decryption keys are separate key material even if
   operators overlap; they must be cryptographically and operationally separated so an
   online box compromise does not expose the offline decryption threshold.

## 6. Selective-withholding — arbitrated (refutes agy #9's premise)

agy #9 posited a box observing other manifests, **computing the intermediate tally**, and
signing or withholding based on the result. **The premise is false for this construction:
at close time ballots are still encrypted; the tally requires post-close trustee threshold
decryption, which has not occurred.** A box sees *which* ballot digests and *how many* are
included, never the result. So a box **cannot** condition its close signature on the
outcome. Result-independent strategic withholding remains possible, but that is exactly
the already-named liveness sacrifice (§2), recovered by the `:close_stalled` abort once
the G8-authorized validator/lifecycle work is implemented (§3); until then the close
stays `:pending`.

agy #9's proposed fix — "a protocol-level timeout after election end-time" — is
**rejected**: it reintroduces the wall-clock the construction cannot have (G8 established
there is no trusted logical-tick source; a time-based deadline is unimplementable). The
correct recovery is the clockless quorum-authorized `:close_stalled` abort (§3, once
implemented), not a timeout.

## 7. Options B and C

- **B (named BFT close, e.g. `close-bft-r255-v1`): out of scope for v1 / conflicts with
  the current contract.** The spec validator rejects any non-unanimous policy; a BFT close
  needs a new versioned spec + policy dispatch/verifier + `CloseEvidence`-shape
  compatibility + a **consensus-proven cross-attempt lock** (brief §9), and it **reopens
  G8's abort composition** (a stall now means `>f` faults, not one box). Its liveness
  benefit is **not bankable in v1** (still `:not_claimed` until proof + independent
  review — mirror of G8 #9). Recorded as the named future replacement, per brief §9.
- **C (documentary "unanimous-box now, BFT-later") not adopted.** Both reviewers judged
  C's delta marginal and scope-creep-prone (codex: "unnecessary scope commitment"; agy
  #10: keep strictly informational). The brief §9 *already* names the BFT-replacement
  requirements, so pre-committing to a specific `close-bft-r255-v1` here adds no value
  over the brief. The future path exists in brief §9; G6 confirms A and references it.

## 8. Non-claims & invariant integrity (codex #12 confirmed)

No `SecurityProfile` claim is flipped or even conditioned by G6; `closure_safety` and
`availability` stay `:not_claimed`; the eventual `:conditional` close-non-equivocation
claim is the human F4 step, out of this loop. `CloseEvidence` itself explicitly disclaims
global finality. Confirming A changes no G2/G5/G8 decision pin.

## 9. Named forward obligations (this decision authorizes / defers)

- **Buildable / already authorized elsewhere:** the G8 abort-certificate validator +
  deterministic terminal lifecycle fold (which must define abort-vs-close-progress
  precedence — §3); roster and DKG-result equivalent sealing (§5.2, owner G4/G8).
- **G12 composition surface:** RV-3 remove-all fidelity; the honest-box-for-close vs
  honest-box-for-ingress distinction as separate assumptions.
- **Operational:** a box-unavailability re-run playbook (§2).

## Appendix A — consolidated G6 register (EVALUATE-plan 2026-07-17)

| # | Pass | Finding | Sev | Disposition |
|---|---|---|---|---|
| a1 | agy | Single-box liveness DoS | high | Accepted §2 as v1 operational constraint; re-run playbook named. |
| a2 | agy | Ingress censorship shadowing | high | Integrated §5.1: close does not prove completeness/censorship; `censorship_resistance :not_claimed`. |
| a3 | agy | Roster/DKG config swap | critical | Integrated §5.2: keys frozen in spec (already closed); roster-content/DKG-result equivalent sealing = named forward obligation. |
| a4 | agy | Decryption-key collateral | high | Integrated §5.3: box close keys separated from trustee decryption keys. |
| a5 | agy | Abort cert frontier drift | medium | Arbitrated §3: abort is idempotent-terminal (`:aborted`, no result to fork); precedence owned by the lifecycle fold. |
| a6 | agy | Auto-resolution of forked close | critical | Confirmed §1/§3: verifier halts on `:forked_close`, no metadata resolver (codex #7 verified). |
| a7 | agy | Invariant slippage | medium | Integrated §8: no availability/censorship-claim language; claims stay `:not_claimed`. |
| a8 | agy | Unbankable BFT liveness | high | Adopted §7: B rejected for v1. |
| a9 | agy | Selective abort look-ahead | high | **Refuted §6:** no tally exists at close (ballots encrypted); withholding is result-independent = the named liveness sacrifice. Clock-based fix rejected (no trusted clock). |
| a10 | agy | C documentary scope creep | low | Adopted §7: C not adopted; brief §9 is the existing named path. |
| 1 | codex | "unique iff ≥1 honest box" too strong | medium | Integrated §1: "guaranteed if", per brief §9. |
| 2 | codex | "signs exactly one seal" imprecise (auth via signed board op) | medium | Integrated §1: authenticated `publish_box_seal` op; distinct digests = equivocation. |
| 3 | codex | Seal completeness correct | confirmed | Confirmed §1. |
| 4 | codex | Manifest/certificate properties correct | confirmed | Confirmed §1. |
| 5 | codex | Equivocation-vs-fork precedence | medium | Integrated §1: fork surfaces before equivocation. |
| 6 | codex | Pure absence → pending; no forced close | confirmed | Confirmed §2. |
| 7 | codex | Fork handling correct, no winner selection | confirmed | Confirmed §1/§3. |
| 8 | codex | CloseEvidence emits field; no runtime G2 consumer yet | medium | Integrated §4: verifier emits the field; G2 consumption is the closed contract. |
| 9 | codex | G8 recovery prose overstates current implementation | high | Integrated §3: recast as "once the authorized G8 validator/lifecycle work is implemented"; abort is a design contract, not a today-guarantee. |
| 10 | codex | "both DAG-frontier cuts, cannot disagree" is false | high | Integrated §3: close cut ≠ abort cut; they can coexist; reconciliation is future lifecycle work. |
| 11 | codex | Validator accepts only unanimous; A needs no change, B does | confirmed | Confirmed §0/§7. |
| 12 | codex | No pin reopened; no claim flipped/conditioned | confirmed | Confirmed §8. |
