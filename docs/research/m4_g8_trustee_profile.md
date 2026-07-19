# G8 decision — trustee operational profile `trustee-ops-r255-v1`

**Status:** decision **cleared 3-agent review**, 2026-07-17. Cycle-1 EVALUATE: agy 1–7
(RV-2 confirmed sound), codex 1–11; options B and C killed (B: G10 live-share breach +
Lattice-carrier trustee channels contra closed G2; C: resharing reopens G2). Synthesized
Option D (A's contract-fit posture + agy's NIZK/volatile-witness crypto fixes + codex's
deterministic-abort freezes). agy cleared cycle-2; codex's abort mechanism took cycles
2–4 to converge (tick-window dropped for a DAG-frontier cut, non-circular certificate,
`reachable/2` validator, frozen `Canonical.term` preimage) — codex final CLEARS §6
against live `Lattice.Dag`/`Canonical`/`Op` contracts. Zero unaddressed blocker/high
findings; residual assumptions named; all `SecurityProfile` claims `:not_claimed`.
**Gate:** G8 (brief §15.8) — "Trustee corruption bound, tally-share quorum, DKG, key
custody, restart, randomness persistence, abort, and resharing semantics are fixed and
validated as one profile."
**Binding, unchangeable:** closed G2 pin `chide-es-r255-v1` (ristretto255; GJKR-Pedersen
DKG; degree-2 Shamir n=5/t=2/q=3, `q=t+1` and `n−t≥q`; Bayer–Groth shuffle; PET/
conditional-zeroing encrypted-sort; threshold ElGamal + Chaum–Pedersen; remove-all) —
G8 fixes *operations around* the crypto, never the crypto. Closed G5 pin
`channel-onion-clientcover-noreceipt-v1` — hands G8 the abort cap + authorization, RV-2,
A3. No `SecurityProfile` claim flips; no secret-bearing value in any transcript.

## 0. Why Option D, not A/B/C

The two passes split on selection — agy chose B (its q-subset mix is cryptographically
sound), codex chose A (B conflicts with closed contracts). Arbitration reconciles both:

- **agy's RV-2 result stands:** a q-subset mix is *sound* — n−t≥q means any 3 trustees
  hold ≥1 honest mixer (unlinkability), and t+1=3 shares run the cleansing PETs and
  threshold decryption, publicly verified by Chaum–Pedersen.
- **codex #9 stands and defeats B's headline:** a *fixed* q=3 committee delivers **no
  liveness fault-tolerance** — losing one designated mixer stalls it exactly like all-n.
  Real fault-tolerance needs deterministic committee *reselection*, an unproven new
  construction that would reopen theorem review. So B's "tolerate 2 absences" is not
  actually delivered in v1.
- **codex #8 (blocker) kills B as written:** on-board live-share reveals violate G10,
  and routing trustee channels over Lattice contradicts the closed G2 pin (which places
  them off-board/off-Lattice). agy #2 independently flagged the share-reveal leak.

Option D takes **A's off-board/off-Lattice posture** (codex's contract winner) and
**amends it with agy's crypto fixes** (NIZK-of-invalidity disqualification evidence,
volatile mix witnesses), makes **mix-liveness an explicit non-claim** rather than
pretending a fixed subset buys it, and **freezes abort deterministically** per codex's
three blockers. C is rejected: its proactive resharing changes the frozen construction
(reopens G2) and is unspecified.

## 1. The pin

| Field | Value |
|---|---|
| Profile id | `trustee-ops-r255-v1` |
| Custody | **hardware-sealed** (PKCS#11 HSM / sealed enclave) for the trustee signing key and DKG share `x_j`, non-exportable; software keystore permitted **only** for `transport-deterministic-test-v1`. G3 owns constant-time/isolation/key-handling review depth |
| DKG | GJKR-Pedersen; **commitments on-board**; complaint **transport off-board** over the §3 mesh; **disqualification evidence on-board as a NIZK-of-invalidity** — non-secret, deterministically verifiable by the pure projector/offline verifier (never a raw share) |
| A3 pairwise channels | **dedicated out-of-band authenticated mesh** (Noise IK / mutually-authenticated TLS), static X25519 keys pinned in the v2 spec `trustee_channel_manifest_ref`. **Not the Lattice carrier** (matches closed G2 §202) |
| Mix | **all-n=5** re-encryption shuffle (Bayer–Groth), paper-faithful; a q-subset mix is sound (agy RV-2) but a *fixed* subset buys no liveness (codex #9), so v1 keeps all-n and does not claim mix-liveness |
| Mix liveness | **not claimed** — a withholding/crashed trustee stalls the tally; recovery is the abort path, named under the availability non-claim (codex #10) |
| Decrypt liveness | q=3 threshold (Chaum–Pedersen), tolerates n−q=2 absent for decryption only |
| Restart | persist **public output bytes** atomically before publish, keyed `(election, role, phase, round)`; republish identical on restart; **secret witnesses volatile-only** (agy #3) |
| Resharing | **none in v1**; trustee set frozen per election; replacement = new election |
| Abort | **frozen deterministic v2 `abort_policy`** — DAG-frontier cut (no clock, no tick source exists), non-circular quorum certificate (≥q=3 distinct co-signers), in-spec cap; projector lifecycle fold validates it |

## 2. Custody, DKG, and the NIZK-of-invalidity synthesis

- **Custody (a):** `x_j` and the signing key live in an HSM/sealed enclave,
  non-exportable. DKG dealer coefficients `a_ik` are sealed during DKG and **erased
  after share aggregation**; `x_j` is sealed until `:finalized`/`:aborted`, then wiped.
  The enclave audit log is never mirrored to the board (G10).
- **DKG complaint adjudication — the reconciliation of agy #2/#5 and codex #8/#10.**
  The tension: GJKR robustness wants public complaint verifiability, but a raw share
  reveal of a *retained* (∈QUAL) dealer publishes a live secret onto a permanent log
  (agy #2: degrades the post-election threshold; codex #8: G10 breach), while A's
  original "off-board adjudication + bare justification digest" is **not verifiable** by
  the pure projector (agy #5, codex #10). **Resolution:** the complaint's *transport*
  runs off-board over the mesh, but the on-board disqualification artifact is a
  **NIZK-of-invalidity** — a non-interactive zero-knowledge proof that dealer *i*'s
  encrypted share to complainer *j* is inconsistent with *i*'s published Pedersen
  commitments, revealing **no live share bytes**. This is publicly and deterministically
  verifiable by the projector/offline verifier, and leaks no secret. It is the strict
  synthesis both reviewers point toward, and it upgrades A's posture.
- **QUAL:** because n=5 is pinned, |QUAL| must reach 5. A *justified* (NIZK-verified)
  disqualification of any dealer breaks the frozen roster and is fatal → abort → new
  election. A bogus complaint (its NIZK fails to verify) disqualifies nothing; a
  complainer cannot force abort by lying. A genuinely faulty dealer forcing
  disqualification→abort is the **named availability non-claim** (codex #10): v1 does
  not claim liveness against a trustee that sabotages its own DKG.

## 3. A3 pairwise channels

Dedicated **out-of-band authenticated mesh** between the HSM-fronting trustee servers
(Noise IK or mutually-authenticated TLS), keyed by static X25519 identity keys pinned in
the v2 spec field `trustee_channel_manifest_ref`. **Explicitly not the Lattice carrier**
— closed G2 places trustee channels outside the board and outside Lattice, and codex #8
confirms routing them over the carrier violates that. Trustee MPC traffic (encrypted
shares `s_ij`, mix hand-offs) travels the mesh as authenticated bounded frames and
**never becomes a board op** (codex #7: `publish_protocol_artifact` is for public
outputs/proofs, not secret transport; no share/mix-transport board command exists or may
be added).

## 4. Mix, liveness, and the honest floor (RV-2 resolved)

- **Mix = all-n=5** sequential Bayer–Groth re-encryption shuffle, paper-faithful.
- **Why not the q-subset mix:** agy proved it *sound*, but codex #9 shows a *fixed* q=3
  committee stalls on the loss of any one designated mixer — it buys no liveness over
  all-n while adding a G12 composition obligation (does the tally theorem hold when only
  a q-subset shuffles?). Genuine liveness would require deterministic committee
  reselection — an unproven construction, out of scope for v1. **Named future upgrade:**
  a proven reselection/committee construction is the path to mix-liveness fault
  tolerance; v1 does not attempt it.
- **Mix liveness = not claimed.** A withholding or crashed trustee stalls the tally.
  This is the availability non-claim (brief §11, codex #10), not a security failure.
  Recovery is the deterministic abort path (§6), which yields a clean verifiable
  terminal state — not a partial tally.
- **Decrypt liveness = q=3** (Chaum–Pedersen threshold), tolerant of n−q=2 absent
  trustees for the decryption step only.

## 5. Restart, randomness, secret deletion (R3/R14 for trustees)

- **Persist-before-publish:** the **public output bytes** of every randomized
  contribution (DKG commitments, mix output + Bayer–Groth proof, decryption share +
  Chaum–Pedersen proof) are written to sealed durable state **atomically before** the
  publish effect, keyed `(election, role, phase, round)`. Restart with bytes present →
  **republish identical**; never recompute.
- **Secret witnesses are volatile-only** (agy #3): the mix secret permutation and
  re-encryption exponents, and decryption-proof nonces, live in volatile memory and are
  **erased the instant the output+proof is durably committed**. They are **never**
  persisted "for determinism." Crash *before* commit → the output was never published →
  a fresh reshuffle (new permutation) is correct and safe. Crash *after* commit →
  republish the committed public bytes, never reshuffle. This obeys both rules at once
  and forecloses an implementer rebuilding R14 by persisting the shuffle witness.

## 6. Abort — frozen, deterministic, causal (codex #4/#5/#6 blockers)

The board's `abort_election [election_id, reason, abort_certificate]` is currently
`no_state` and semantically unvalidated. v1 freezes a deterministic policy:

- **v2 spec field `abort_policy`** (frozen, rides `spec_digest`→`election_id`, not
  `parameters_digest`):
  ```elixir
  %{
    id: :trustee_quorum_v1,
    proposer: :supervisor,
    cosigners: :trustees,
    quorum: 3,                          # = q = t+1; >1, so never a single holder (F-06)
    reason_codes: [:dkg_disqualification, :mix_contribution_absent,
                   :overload_cap_exceeded, :close_stalled],
    max_admitted_artifacts: <pending G13 cover-cost run>
  }
  ```
  There is **no `liveness_window_ticks`** and no time parameter: the repo has no trusted
  logical-tick source (`Lattice.Clock` is test/demo-only; dormancy's `at_tick` is
  `author_asserted_untrusted` — codex #5). A time-based deadline is therefore
  unimplementable and is dropped.
- **Non-circular certificate construction (codex #5a).** The signed **claim** is a
  signature-free preimage: the exact byte-frozen encoding is
  `Lattice.Canonical.term(["township-election-abort-v1", claim_map])` where `claim_map`
  has string keys and **normalized lists** — `causal_frontier` a lexicographically
  sorted, deduplicated list of op IDs, `evidence_refs` a sorted list (codex #5e), and
  scalar fields `election_id, phase, reason_code, tally_start_op_id,
  missing_contribution_ref`. The **certificate** wraps this frozen claim with the
  supervisor proposal signature plus **≥ q=3 distinct trustee co-signatures over the
  claim bytes**, signatures sorted canonically, distinct-signer enforced by pubkey
  identity. Signatures are **outside** the preimage they sign — no circularity.
- **DAG-frontier cut, not a clock (codex #5b — mirrors the unanimous-boxes close cut,
  brief §9).** Absence in an eventually-consistent DAG can only be proved *relative to a
  certified cut*, never globally. `causal_frontier` is the normalized set of op IDs, and
  **the signed `causal_frontier` must equal the abort op's direct `deps`** (codex #5d) —
  a one-directional "deps cover frontier" rule would let the abort op additionally depend
  on the allegedly-missing contribution while the smaller signed frontier omits it, so
  equality is required. The projector verifies via `Lattice.Dag.reachable/2` (the correct
  set API — it includes the frontier members themselves, unlike `ancestors/2`; codex #5c)
  over the abort op's deps: (1) it **rejects any frontier op ID unknown to the log**
  (`reachable/2` silently drops unknowns); (2) `tally_start_op_id` ∈
  `reachable(ops, causal_frontier)`; (3) `missing_contribution_ref` ∉
  `reachable(ops, causal_frontier)`. Deterministic and replayable with no timestamp.
- **What q=t+1 does and does not establish.** A corrupt quorum could author an abort op
  whose frontier deliberately excludes a contribution its members have actually seen —
  but that needs q=3 colluding signers, and only t=2 are corrupt, so every valid quorum
  contains **≥1 honest trustee** who will not co-sign a frontier omitting a contribution
  present in *its own* causal view. This is what the quorum establishes: the cut does not
  omit a contribution seen by an honest signer. It does **not** prevent a *genuinely
  concurrent* contribution — one no honest signer has yet observed — from being excluded
  by the cut; that contribution is, relative to the cut, absent, and its exclusion is the
  **accepted availability non-claim** (a late contribution missing the cut → stall →
  abort), *not* something the quorum prevents. This is stated as a non-claim, never as an
  attack the mechanism defeats.
- **No trusted deadline; patience is operational.** Nothing time-bounds when the quorum
  may form. An honest trustee waits (by its own untrusted local judgement) before
  co-signing an absence claim; that patience is operator policy, not a protocol-enforced
  timer — the honest reflection of "no trusted time." The protocol enforces only quorum
  + honest-in-quorum + frontier-anchored cut-relative absence.
- **Cap frozen in-spec (codex #6 blocker):** `max_admitted_artifacts` is a **frozen v2
  spec field**, part of election identity — it is **not** operator-overridable at replay
  time (that would change whether the same abort is valid, breaking immutable replay).
  Operational tuning = a new election. **Value is pending G13's cover-cost run** (the
  G5→G13 follow-on): the 50k extrapolation is explicitly *not* the answer; the number
  comes from measured dummy-volume-vs-tally-cost at the pinned profile. Until that run
  lands, the field is `<pending>` and no election may finalize its spec — a named
  dependency, not a frozen guess.
- **No-reopen (codex #4):** the projector needs a deterministic lifecycle fold to derive
  phase (currently hard-coded `:setup` at projector.ex:334) and enforce terminality and
  no-reopen once `:aborted`. This is buildable work this decision authorizes.
- **Kill-button posture (agy #4, F-06):** the quorum (>1, distinct signers) means abort
  is never unilateral; there is no window and no clock (codex #5f — patience before
  co-signing is unbounded operator policy, §"No trusted deadline"). A t=2 minority *can*
  stall the all-n mix and eventually enable a quorum-authorized abort — this is the
  accepted availability non-claim, not a security
  break; the abort recovers to a clean, verifiable terminal state rather than a partial
  or forged tally.

## 7. Resharing (both #6/#11)

**None in v1.** The trustee set is frozen per election; replacing a trustee or refreshing
shares requires a **new election** (new `election_id`). C's optional proactive resharing
is rejected: it adds a Herzberg-style construction absent from the closed G2 algorithm
pin (reopening G2/theorem review), leaves replacement keys/capabilities unspecified, and
"old shares provably wiped" is not externally provable. A construction-defined resharing
ceremony is a named future gate, not v1.

## 8. Authorized buildable work / deferred

- **Authorizes:** profile-aware `validate_thresholds` **dispatched by the complete
  `ProfileRef`** (codex #1: not a global rule — generic fixtures use other relations),
  enforcing `q=t+1` **and** `n−t≥q`; the **merged `township-election-v2`** schema
  carrying G5's `channel_manifest_ref` **plus** `abort_policy` and
  `trustee_channel_manifest_ref` (codex #2: one v2, byte-identical v1 preserved, no
  competing shapes); the projector abort-certificate validator + deterministic lifecycle
  fold (codex #4); the NIZK-of-invalidity DKG-complaint artifact + verifier (§2).
- **Defers (named owners):** `max_admitted_artifacts` value → G13 cover-cost run;
  honest-trustee co-signing patience → operator policy (not protocol-timed; no trusted
  clock exists); mix-liveness fault tolerance (committee reselection) → future
  construction gate; HSM
  vs software custody depth → G3 review; the NIZK-of-invalidity concrete scheme → G3/G11
  (must be a ristretto255 Sigma/Fiat–Shamir statement, no new curve — consistent with G2
  §2).

## 9. Non-claims (all held)

All twelve `SecurityProfile` claims stay `:not_claimed`. Availability, forced-abstention,
censorship: `:not_claimed` — the mix-liveness stall, the DKG-disqualification kill path,
and the abort recovery all live under these non-claims. No claim is flipped or even
conditioned by this decision.

## Appendix A — consolidated G8 register (EVALUATE-plan 2026-07-17)

| # | Pass | Finding | Sev | Disposition |
|---|---|---|---|---|
| RV-2 | agy | q-subset mix soundness & privacy | (answered) | Confirmed sound (n−t≥q ⇒ ≥1 honest mixer; t+1 shares run cleansing). But see codex #9 — soundness ≠ liveness. |
| 2 | agy | On-board GJKR share reveals degrade post-election threshold (permanent log) | high | Integrated §2: on-board evidence is a NIZK-of-invalidity, no live share published. |
| 3 | agy | Mix permutation/exponents persisted for restart = R14 receipt | medium | Integrated §5: secret witnesses volatile-only; fresh reshuffle only on pre-commit crash. |
| 4 | agy | Abort kill-button via all-n stall to deadline | high | Integrated §6: quorum (>1, distinct signers), no window/clock; residual stall named under availability non-claim (codex #10). |
| 5 | agy | Off-board complaint adjudication unauditable | medium | Integrated §2: NIZK-of-invalidity is deterministically verifiable by the pure projector — supersedes off-board bare-digest. |
| 6 | agy | Proactive resharing reopens G2 | high | Adopted §7: no resharing in v1. |
| 7 | agy | Threshold + abort-cert validators missing | medium | Integrated §8: profile-aware validator + projector abort validator authorized. |
| 1 | codex | `validate_thresholds` checks only generic ranges (5/2/2 passes) | high | Integrated §8: profile-aware dispatch keyed by full ProfileRef, enforcing q=t+1 ∧ n−t≥q, not a global rule. |
| 2 | codex | New fields require a real schema version | blocker | Integrated §8: one merged `township-election-v2` (channel_manifest_ref + abort_policy + trustee_channel_manifest_ref); v1 byte-identical. |
| 3 | codex | Digest placement correct (spec_digest→election_id, not parameters_digest) | confirmed | Confirmed §1/§6. |
| 4 | codex | Projector never checks abort reason/cert; phase hard-coded :setup | high | Integrated §6: deterministic lifecycle fold + abort-cert validator authorized. |
| 5 | codex | Abort not deterministically implementable; no trusted timestamp | blocker | Integrated §6 (cycle 2 redesign): DROPPED the tick-window (no trusted tick source exists — Clock is test-only, dormancy at_tick is author-asserted-untrusted). Replaced with a DAG-frontier cut, no clock. |
| 5a | codex (cycle 2) | Circular preimage: quorum_signatures inside the signed preimage | blocker | Integrated §6: signature-free `claim` preimage; signatures wrap it outside, sorted, distinct-signer enforced. |
| 5b | codex (cycle 2) | Causal absence underspecified; a signer could omit a concurrent contribution to fake absence | blocker | Integrated §6: `causal_frontier` explicit, projector verifies via real DAG reachability; q=t+1 guarantees ≥1 honest co-signer so the cut omits nothing an honest signer saw (mirrors unanimous-boxes close cut). Genuinely-concurrent exclusion named as availability non-claim, not "prevented" (codex cycle-3 clarification). |
| 5c | codex (cycle 3) | Doc said `ancestors(frontier)`; wrong API (excludes the op; drops unknown IDs silently) | blocker | Integrated §6: use `Lattice.Dag.reachable/2` (includes frontier members); validator rejects unknown frontier op IDs. |
| 5d | codex (cycle 3) | "deps cover frontier" is one-directional; abort op could depend on the missing contribution while signed frontier omits it | blocker | Integrated §6: signed `causal_frontier` must **equal** the abort op's direct `deps`; absence evaluated over `reachable(ops, abort_op.deps)`. |
| 5e | codex (cycle 3) | Claim byte encoding not frozen (frontier/evidence ordering unspecified) | blocker | Integrated §6: exact `Canonical.term(["township-election-abort-v1", claim_map])` with sorted/deduped `causal_frontier` and sorted `evidence_refs`. |
| 5f | codex (cycle 3) | Leftover "causal window"/"bounded logical window" contradicting window removal | high | Integrated §6 + appendix: all window language removed; patience is unbounded operator policy. |
| 6 | codex | Overload cap operator-overridable contradicts immutable replay | blocker | Integrated §6: cap frozen in v2 spec (new value = new election); default from G13 cover-cost run, not the 50k extrapolation. |
| 7 | codex | Off-board MPC transport must stay off the board | high | Integrated §3: mesh frames never become board ops; no transport command added. |
| 8 | codex | B: on-board live shares (G10) + Lattice-carrier trustee channels (contra closed G2) | blocker | B rejected; §2 uses NIZK (no live share), §3 uses out-of-band mesh (off Lattice). |
| 9 | codex | B: fixed q-subset committee gives no liveness (loss of one mixer stalls) | high | Adopted §4: all-n mix, mix-liveness not claimed; reselection deferred as a future construction. |
| 10 | codex | Any DKG disqualification fatal = one dealer forces abort; A/C bare-digest unverifiable | high | Integrated §2/§4: NIZK evidence makes disqualification verifiable; the fatal kill path named under the availability non-claim. |
| 11 | codex | C resharing changes frozen construction, unspecified | blocker | Adopted §7: no resharing in v1. |

**Killed options.** B: G10 live-share breach + Lattice-carrier trustee channel contra
closed G2 (codex #8) + false fixed-committee liveness (codex #9). C: resharing reopens
G2 and is unspecified (codex #11, agy #6). Option D = A's contract-fit posture + agy's
NIZK/volatile-witness crypto fixes + codex's deterministic-abort freezes.
