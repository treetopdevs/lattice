# G2 decision — pinned election construction profile `chide-es-r255-v1`

**Status:** decision **cleared 3-agent review**, 2026-07-17. Review history: round 1
(options, agy R13–R20 + codex C1–C13), round 2 on this doc (agy A1–A3, codex
G2-1–G2-4, claude CL1), round 3 delta confirmation (agy F1 = codex G3-1, the same
stale manifest value, independently found by both and fixed with the reviewer-
prescribed identifier; all other integrations confirmed correct by both). Zero
unaddressed high-severity findings; residual assumptions named in §7. Codex round 3
additionally verified the §8 manifest is fully `Lattice.Canonical`-encodable with an
insertion-order-independent digest.
**Gate:** G2 of `m4_interface_redesign_brief.md` §15 — "One exact CHide/encrypted-sorting
profile, revision, algorithm set, parameters, and theorem mapping are pinned."
**What this document is NOT:** an implementation authorization beyond G2's own scope, a
claim-state change (every `SecurityProfile` claim remains `:not_claimed`), a
coercion-resistance claim, or a cost acceptance (G13 owns cost; product owns acceptance).

This decision was produced by the gate-closure inner loop: Opus-escalated ideation of
three candidate profiles, adversarial evaluation by agy (crypto/coercion posture,
findings R13–R20) and Codex (repo-contract posture, findings C1–C13), Claude
arbitration. The full consolidated register is Appendix A. Options B
(Semaphore/BBS three-curve stack) and C (full-JCJ-revote) were killed in review;
the pin below is Option A amended by every accepted finding.

---

## 1. The pin

| Field | Value |
|---|---|
| Profile id (`ProfileRef.id`) | `chide-es-r255-v1` |
| Construction | Encrypted-sorting CHide — *Faster coercion-resistant e-voting by encrypted sorting*, Aranha, Battagliola, Roy |
| Revision (`ProfileRef.version`) | IACR ePrint **2023/837, version 2023-06-06** (sole published revision; unrevised since submission — verified against eprint.iacr.org 2026-07-17) |
| Revision provenance | ☐ **manual completion field:** SHA-256 of the exact ePrint PDF bytes, to be recorded on first authorized fetch (an automated fetch was blocked by the archive's bot gate on 2026-07-17; the version identifier above is the pin, the byte hash is corroborating provenance) |
| `ProfileRef.parameters_digest` | `mGfBR4aCA8oT5yTTE6MDsZNlt443SsKtFlyKtEzfhNs` — SHA-256 of the canonical parameter manifest defined in §8, computed with `Lattice.Canonical` per the pinned pipeline |
| Theorem mapped | The paper's coercion-resistance result for the encrypted-sorting tally: the tally protocol securely realizes the ideal cleansed-tally functionality in the JCJ/CHide model, with ballot secrecy from IND-PA0/NM-CPA exponential ElGamal plus ballot well-formedness proofs. Assumption set: DDH in the pinned group; secure DKG and verifiable-shuffle subprotocols per the paper's composition requirements; programmable random-oracle model; honest same-view bulletin board; anonymous casting channel; untappable registration moment |

The board-model caveat is explicit: the theorem's bulletin-board assumption is **not**
automatically realized by Lattice + `unanimous_boxes_v1`. Showing that realization (or
its failure) is G12's composition-mapping work, and this pin binds that work to a
concrete target rather than closing it.

## 2. Algorithm set (exact)

Every "or" that appeared in ideation is resolved here (review finding C1).

- **Group:** ristretto255 (prime-order group over Curve25519). One group for the
  entire coercion layer — credentials, ballots, proofs, DKG, decryption. No pairing
  curve anywhere in profile v1.
- **Encryption:** exponential ElGamal over ristretto255; choices encoded as small
  exponents from the frozen choice list.
- **DKG:** Pedersen DKG hardened per GJKR (complaint round, qualified-set
  determination) over the ristretto255 scalar field, with Shamir sharing of
  **polynomial degree 2** — reconstruction threshold `q = 3` of `n = 5` shares
  (3-of-5). The corruption bound `t = 2` is a distinct security parameter, not the
  sharing threshold; the profile relation `q = t + 1` (§3) ties them (finding G2-1).
- **Verifiable shuffle:** Bayer–Groth shuffle argument over ristretto255 for the mix
  steps of the encrypted-sort network.
- **Encrypted-sort primitives:** the paper's encrypted equality tests (PET) and
  conditional-zeroing gates, instantiated over the same group.
- **Ballot well-formedness proofs:** Sigma-protocol NIZKs via Fiat–Shamir in the ROM —
  knowledge of plaintext, choice-in-domain (OR-proof over the frozen choice list,
  O(|choices|) size), and credential-encryption well-formedness. No SNARK, no trusted
  setup. **Named verification item RV-1 (§7):** the pinned revision's exact ballot
  statement set must be confirmed Sigma-expressible at O(|choices|) during G3/G11; if
  the paper's `isVal`/fake-credential mechanics require a membership-binding ballot
  proof, this pin reopens.
- **Threshold decryption:** t+1 decryption shares with Chaum–Pedersen
  correctness proofs.
- **Hash / domain separation:** SHA-256 everywhere at the artifact boundary (matches
  the repo). The `(profile_id, election_id, phase, round)` domain-tag scheme applies
  to **profile-internal digests only** — Fiat–Shamir transcripts and inner-envelope/
  transcript digests. The outer `ArtifactRef` digest construction
  (`[foundation_domain, codec, profile_artifact_id, bytes]`) is unchanged by this pin
  (finding G2-3). Poseidon and circuit-friendly hashes are absent by construction
  (no circuits).
- **Randomness/receipt rule (findings R3/R14):** clients and role runners persist the
  **ciphertext**, never the encryption randomness; randomness is securely erased
  immediately after ciphertext construction; a retry resubmits the identical persisted
  bytes and never re-encrypts. Role-runner randomized contributions follow the brief's
  persist-before-publish rule for the *artifact bytes*, with the same erase rule for
  ephemeral randomness inside them.

## 3. Parameter set

| Parameter | Pinned value | Constraint carried into the manifest |
|---|---|---|
| Trustees `n` | 5 | — |
| `max_corrupt_trustees` `t` | 2 | `0 ≤ t < n` |
| `tally_share_quorum` `q` | 3 | `q = t + 1` **and** `n − t ≥ q` (an honest quorum must exist with all corrupt trustees withholding) |
| Choice domain | ≤ 16 choices | frozen per election in `ElectionSpec.choices` |
| Security level | 128-bit | ristretto255 |
| Ballot ciphertext | 2 group elements (64 B compressed) per choice slot | exact bound in manifest |
| Ballot proof bound | ≤ 4 KiB | exact per-statement sizes in manifest |
| Any single artifact | ≤ 1 MiB | `:artifact_too_large` rejection above bound |

Review finding C2 (high) is accepted and carried forward: the current
`Township.Election.Spec.validate_thresholds/1` intentionally checks only generic range
bounds; the profile-specific relations in the table above (notably `q = t + 1`,
`n − t ≥ q`) are **not yet enforced in code**. They bind here in the manifest, and a
profile-aware validator is named G8/G4-adjacent buildable work unblocked by this pin.
Current `Spec` validation must not be cited as evidence for G8.

## 4. Board posture: admission, duplicates, cover traffic

These are the R1/R2 escalations the findings register pushed into G2.

- **Admission control: box-private only.** The board and its relayers check exactly
  what the brief §7 already permits — byte-size bounds and public well-formedness of
  the outer artifact. Nothing membership-shaped, nullifier-shaped, or
  eligibility-shaped is ever computed onto or published to the board. Profile v1
  contains **no Semaphore layer and no BBS layer**. The surrendered-secret scan (R1)
  is defeated structurally: there is no board-visible value deterministic from a
  voter secret.
- **Cover traffic preserved (R2):** because ingress is not membership-gated, non-member
  dummy ballots remain possible exactly as in the paper's open-posting model; the
  dummy/cover *policy* itself remains G5 work, with `dummy_ballots` priced by G13.
- **Duplicate policy (replaces ideation's wrong "dedup by digest forbids revoting" —
  finding C9; revised after review findings A1/A2):** exact byte-identical
  retransmissions deduplicate by inner artifact digest (transport concern, already
  implemented). Distinct ciphertexts carrying the same credential are a *protocol*
  concern resolved only inside encrypted cleansing, under the order-free rule
  **remove-all**: if a credential appears on more than one distinct ballot, every
  ballot carrying it is removed, publicly unclassified, exactly as fake-credential
  ballots are removed. There is deliberately no winner-selection order: an earlier
  draft's "keep-first under close-manifest order" both invited digest-grinding (a
  coercer mines ciphertext randomness until their ballot sorts first, finding A1)
  and required an encrypted index comparison the pinned PET/conditional-zeroing
  primitives cannot express without leaking (finding A2). Remove-all needs only
  neighbor PETs over the credential-sorted ciphertexts plus flag propagation —
  within the pinned primitive set — and gives a coercer nothing to grind for.
  Coercion semantics: evasion in this profile rests on decoy credentials
  (`make_decoy/3`), never on revoting; a same-credential duplicate therefore
  nullifies rather than elects a winner, which is consistent with forced-abstention
  resistance being a non-claim (§5) and adds no new coercion evidence. No revote UX
  is offered in v1; "no revoting" is a client/UX posture, and remove-all is what
  actually decides multiplicity. The cleansing input set is precisely the certified
  `CloseEvidence.ballot_digests` list (deduplicated, digest-sorted); remove-all
  consumes it as a **set** and takes no order semantics from it (finding G2-4). **Named verification item RV-3 (§7):** if the pinned
  revision's own duplicate-elimination rule differs and its tally theorem depends on
  that rule, this deviation must be carried explicitly by the G12 composition
  argument or the policy revisited.

## 5. Non-claims and exclusions carried by this profile

- **Everlasting privacy (R4): explicitly not claimed and not mitigated.** Exponential
  ElGamal ciphertexts on an immutable replicated log are harvestable by a future
  discrete-log-capable adversary; deletion is structurally impossible in Lattice.
  Product language must carry this.
- **Cross-curve composition (R8): vacuous by construction** — one curve. Named
  breaking condition: any future requirement to bind a credential to roster
  membership *inside one proof* forces a second curve or non-native field arithmetic
  and reopens both R8 and this pin. In-circuit cross-layer binding is forbidden by
  this profile.
- **Eligibility auditability (R17):** with box-private admission there is no public
  audit of admission decisions. Box honesty for ingress is a named operational
  assumption; fake-credential stuffing cannot change the tally result, only its size
  and cost. `claims.eligibility` remains `:not_claimed`.
- All twelve `SecurityProfile` claims remain `:not_claimed`. This document changes no
  claim state and authorizes no claim change.

## 6. Implementation-strategy direction (input to G3, not a mandate)

Verify-only on the BEAM: a Rustler NIF (or equivalent reviewed boundary) over a
maintained constant-time ristretto255 implementation (the `curve25519-dalek` family is
the reference point), exposing verification of Sigma proofs, shuffle proofs, and
decryption-share proofs plus group/scalar arithmetic. Proving stays off-BEAM
(client/host side); client ballot cost is a handful of exponentiations — no GPU
dependency, CPU-WASM fallback acceptable. G3's review selects the exact library and
audits constant-time behavior, key handling, and process isolation; this section
narrows G3's search space and mandates nothing beyond "single-group, verify-only,
no pairing stack."

## 7. Residual assumptions and named verification items

Exit-criterion requirement: these are the assumptions this decision *introduces or
inherits*, stated so no later gate mistakes them for settled facts.

1. **RV-1 — ballot-statement Sigma-expressibility.** Arbitration refuted agy R15's
   O(N) membership-proof claim (CHide ballots deliberately do not prove roster
   membership; membership resolution happens in encrypted cleansing so fake
   credentials stay unclassified), but the pinned revision's exact ballot proof
   statements must be transcribed and confirmed O(|choices|) Sigma-expressible when
   G3/G11 read the paper against implementation. Failure reopens G2.
2. **RV-2 — mixnet/DKG liveness semantics (R16).** The pin asserts t+1 decryption
   liveness; whether the paper's encrypted-sort/mix steps tolerate `n − q` absent
   trustees mid-protocol or require restart/abort must be fixed as G8 profile
   semantics. Until then, tally liveness under trustee failure is unproven.
3. **Preprint status (R20, defanged but present).** 2023/837 is a single-revision,
   three-year-stable preprint with no listed publication venue. The construction has
   not passed journal/conference review; G12's independent review must treat the
   paper itself, not only our composition, as review surface.
4. **Board-model realization (G12).** Honest-same-view board via Lattice +
   `unanimous_boxes_v1` is an obligation, not a fact; close liveness sacrifice (R18)
   is G6's accepted trade and unchanged here.
5. **Channel and registration assumptions (G4/G5).** Anonymous first-leg submission,
   the two-point timing observer (R5), batch-publication parameters, and untappable
   registration are consumed as assumptions by this profile and remain open gates.
6. **RV-3 — duplicate-rule fidelity (A1/A2 repair).** The pinned duplicate policy is
   order-free remove-all (§4). If the paper's specified duplicate-elimination rule
   differs and the tally theorem depends on it, the deviation must be carried by the
   G12 composition argument or the policy revisited.
7. **Secure pairwise trustee channels (A3).** GJKR-Pedersen DKG share distribution
   and threshold-decryption coordination assume authenticated, private pairwise
   channels between trustees. These channels are outside the board, outside Lattice,
   and outside the anonymous-ingress model; their establishment and key management
   are G8 operational semantics bound to this profile.
8. **Harness pricing gap (C12).** The G13 harness currently prices a generic
   3-trustee, pairing-verified profile and cannot yet price this pin (no trustee
   knob; mandatory per-ballot pairing cost that this profile does not have). The
   parallel worktree must parameterize trustees/candidates/dummy/revote and add a
   per-profile operation profile **before** G13 calibration; calibration numbers
   produced before that change do not describe `chide-es-r255-v1`.

## 8. Canonical parameter manifest (defines `parameters_digest`)

`ProfileRef.parameters_digest` is computed exactly as the repo's existing digest
convention (`Spec.digest/1`, `ProfileRef.artifact_id/1`) computes digests
(finding G2-2):

```elixir
["township-election-profile-manifest-v1", manifest_map]
|> Lattice.Canonical.term()
|> then(&:crypto.hash(:sha256, &1))
|> Base.url_encode64(padding: false)
```

where `manifest_map` is the following map with string keys and values exactly as
written (strings, non-negative integers, and lists of strings only; canonical map
ordering is supplied by `Lattice.Canonical`):

```elixir
%{
  "profile_id" => "chide-es-r255-v1",
  "construction" => %{
    "paper" => "eprint-2023-837",
    "title" => "Faster coercion-resistant e-voting by encrypted sorting",
    "revision" => "2023-06-06"
  },
  "group" => "ristretto255",
  "encryption" => "exp-elgamal-v1",
  "dkg" => "pedersen-gjkr-v1",
  "shuffle_proof" => "bayer-groth-v1",
  "pet" => "chide-es-pet-v1",
  "ballot_proofs" => "sigma-fs-sha256-v1",
  "decryption_proof" => "chaum-pedersen-v1",
  "hash" => "sha256",
  "domain_tag_scheme" => "profile/election/phase/round-v1",
  "trustees" => 5,
  "max_corrupt_trustees" => 2,
  "tally_share_quorum" => 3,
  "threshold_constraints" => ["q_eq_t_plus_1", "n_minus_t_gte_q"],
  "max_choices" => 16,
  "admission" => "box-private-v1",
  "duplicate_policy" => "cleanse-remove-all-v1",
  "revote_ux" => "none-v1",
  "randomness_rule" => "persist-ciphertext-erase-randomness-v1",
  "inner_codec" => "chide-es-r255-bytes-v1",
  "point_encoding" => "ristretto255-canonical-32",
  "scalar_encoding" => "le-32",
  "ballot_proof_max_bytes" => 4096,
  "artifact_max_bytes" => 1_048_576,
  "everlasting_privacy" => "not-claimed-v1",
  "cross_layer_in_circuit_binding" => "forbidden-v1"
}
```

**Provenance sidecar (finding CL1):** the ePrint PDF SHA-256 from §1 is deliberately
**excluded** from the digested manifest. The construction's identity is pinned by
`(paper, revision)`; the byte hash is corroborating provenance recorded alongside this
document when fetched. Including a later-filled field inside the manifest would mutate
`parameters_digest` — and therefore the profile identity — after elections had already
referenced it.

**Codec layering (finding C5):** the outer `ArtifactRef.codec` remains the foundation
value `"township-election-artifact-v1"`; the profile's binary formats live *inside*
resolved artifact bytes as the profile envelope `chide-es-r255-bytes-v1` named above.
The projector's codec allowlist is unchanged by this decision; implementing the inner
envelope, its bounds, and its cross-runtime conformance vectors is G9/G11 buildable
work that this pin makes definable.

## 9. What this pin unblocks / does not close

- **Unblocks:** G4 (credential delivery against a concrete construction), G8
  (trustee/DKG semantics against pinned algorithms), G11 (vectors against pinned
  formats), G13-calibration (measure `GroupOps` over ristretto255 — after the C12
  harness changes), and narrows G3.
- **Does not close:** anything else. In particular no security claim, no cost
  acceptance, no board-model realization, and no W4 change.

---

## Appendix A — consolidated review register (EVALUATE-plan, 2026-07-17)

Register format follows the 2026-07-16 R1–R10 register. Severity as assessed by the
originating pass; disposition as arbitrated.

| # | Pass | Attack | Severity | Disposition |
|---|---|---|---|---|
| R13 | agy | Board-published Semaphore nullifier lets a coercer with the surrendered EdDSA secret scan participation; box membership-gating also deletes non-member cover traffic. | high | Moot for the pin: Option B killed; profile v1 has no nullifier layer at all (§4). Recorded as a standing constraint on any future admission extension. |
| R14 | agy | Persisted/retained ballot-encryption randomness is a transferable receipt. | high | Integrated — §2 randomness/receipt rule: persist ciphertext, erase randomness, retries resubmit identical bytes (matches prior R3 disposition). |
| R15 | agy | Sigma-only proofs allegedly need O(N) roster-membership OR-proofs, exploding ballot size. | high (claimed) → medium (arbitrated) | Refuted as stated: CHide ballots do not prove membership publicly — membership resolves in encrypted cleansing precisely so fake credentials stay unclassified; ballot proofs are O(choices). Survives as named verification item RV-1 (§7). |
| R16 | agy | If mix/cleansing requires all n trustees sequentially, liveness threshold is n, not t+1. | medium | Integrated as RV-2 (§7); fixing exact liveness semantics is G8 work bound to this profile. |
| R17 | agy | Box-private admission removes public eligibility auditability; box becomes trusted for ingress. | medium | Accepted and named (§5): eligibility stays `:not_claimed`; box honesty is an explicit operational assumption; stuffing affects size/cost, not result. |
| R18 | agy/codex | Unanimous-box close sacrifices liveness; one withholding box stalls the election; theorem under incomplete board unclear. | medium | Out of G2 scope: the brief §9 accepts this trade deliberately; G6 owns close policy; G12 owns board-model realization. Cross-referenced in §7.4. |
| R19 | agy | Option C's cleansing scales with total submissions; trustee-layer DoS; cost-implausible at town scale. | high | Accepted — Option C killed. |
| R20 | agy | Pinning a moving preprint is premature. | medium | Defanged by evidence: 2023/837 has exactly one revision (2023-06-06), stable three years. Pin records version id + provenance hash field (§1); preprint status stays a named residual (§7.3). |
| C1 | codex | No option was an exact pin (curve/DKG/proof "or"s; `ProfileRef` cannot rescue an unspecified manifest). | high | Integrated — every choice resolved in §2/§3; canonical manifest defined in §8. |
| C2 | codex | `Spec.validate_thresholds/1` checks only generic ranges (accepts 5/2/2); options overstated it. | high | Integrated — §3 carries the profile constraints in the manifest and names the profile-aware validator as unblocked buildable work; current Spec validation explicitly not cited as G8 evidence. |
| C3 | codex | Board command surface fits all options without new op kinds. | low | Confirmed; §4 stays within the existing command families. |
| C4 | codex | Capability gating and box-authored voter-free ballots verified in code/tests. | low | Confirmed; unchanged. |
| C5 | codex | Projector accepts only the foundation codec; curve encodings cannot be the `ArtifactRef.codec`. | high | Integrated — §8 codec layering: outer codec unchanged; profile bytes are an inner envelope; G9/G11 implement. |
| C6 | codex | `Lattice.Canonical` carries refs fine; G9 = inner + outer conformance; B strains most. | medium | Confirmed; single-curve pin minimizes the surface. |
| C7 | codex | No option requires a claim flip; frozen research profile verified in code. | low | Confirmed; §5 restates. |
| C8 | codex | Ballots/credentials remain off `Township.Matter`; W0–W3 untouched. | low | Confirmed; invariant intact. |
| C9 | codex | "Revoting forbidden by digest dedup" is not expressible — digest dedup only collapses byte-identical retransmissions. | high | Integrated — §4 duplicate policy resolved inside encrypted cleansing; initially keep-first, superseded by order-free remove-all after A1/A2; "no revote" demoted to UX posture. |
| C10 | codex | C's "keep-last" under-specified vs permutation-invariance. | medium | Moot (C killed); the surviving remove-all policy consumes the certified ballot set with no order semantics (§4). |
| C11 | codex | B's membership-gating box exceeds the brief's contract; BBS-proof-in-ballot contradicts "nothing membership-shaped on board". | high | Accepted — Option B killed. |
| C12 | codex | G13 harness cannot price any option: no trustee knob, mandatory per-ballot pairing, fixed revote ratio. | high | Integrated as §7.6 — harness parameterization is a named precondition of G13 calibration; routed to the parallel worktree. |
| C13 | codex | Seam compatibility ≠ executability; runtime is a construction-independent foundation. | medium | Accepted — §9 phrases closure strictly as a profile decision. |

| CL1 | claude | Draft §8 placed the later-filled `pdf_sha256` field inside the digested manifest; completing it would have changed `parameters_digest` and silently re-identified the profile. | high | Integrated — provenance hash moved out of the manifest to a sidecar; identity rests on `(paper, revision)` (§8). |
| A1 | agy (round 2) | Digest mining: "keep-first under close-manifest order" lets a coercer grind ciphertext randomness until the coerced ballot sorts first, deterministically overriding the voter's ballot. | high | Integrated — duplicate policy changed to order-free remove-all (§4); no order exists to grind. |
| A2 | agy (round 2) | Keep-first requires encrypted index comparison; plaintext index leaks the input↔choice link, encrypted less-than is outside the pinned PET/conditional-zeroing primitive set. | high | Integrated — remove-all needs only neighbor PETs after the credential sort plus flag propagation, within the pinned primitives (§4). |
| A3 | agy (round 2) | GJKR DKG and threshold decryption assume secure authenticated pairwise trustee channels; the assumption was load-bearing but unnamed. | medium | Integrated — named as residual assumption §7.7; establishment/key management routed to G8. |
| G2-1 | codex (round 2) | "t-of-n Shamir" conflated the corruption bound t=2 with the reconstruction threshold; decryption needs q=3 shares. | high | Integrated — §2 pins degree-2 Shamir sharing, 3-of-5 reconstruction, with `q = t + 1` as the tying relation. |
| G2-2 | codex (round 2) | `parameters_digest` preimage and output encoding were unspecified; different constructions yield different profile identities. | high | Integrated — §8 pins the exact repo digest convention: `Canonical.term([tag, manifest])` → SHA-256 → base64url unpadded. |
| G2-3 | codex (round 2) | "Every artifact digest" domain-tag claim contradicted the unchanged outer `ArtifactRef` digest construction. | medium | Integrated — §2 limits the profile tag scheme to profile-internal (Fiat–Shamir/inner-envelope) digests. |
| G2-4 | codex (round 2) | "Close-manifest order" was imprecise about which certified list cleansing consumes. | medium | Integrated (and largely mooted by A1/A2's remove-all): §4 names `CloseEvidence.ballot_digests` as the input, consumed as a set with no order semantics. |
| F1 / G3-1 | agy + codex (round 3, independent convergence) | §8 manifest still pinned the superseded `cleanse-keep-first-manifest-order-v1` policy id, contradicting §4's remove-all and re-binding the A1/A2 vulnerability into `parameters_digest`. | high | Integrated — manifest value corrected to `cleanse-remove-all-v1`; §4/§8/Appendix now agree; final digest recomputed and recorded in §1. |

**Killed options.** B: contract conflict (C11) + cover-traffic regression (R13) +
largest G9/G12/G13 surface. C: cost-implausibility and trustee-layer DoS (R19) +
under-specified settlement (C10); its stronger coercion model was not required by the
town-scale threat model over A's.
