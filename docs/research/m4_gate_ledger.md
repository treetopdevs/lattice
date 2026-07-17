# M4 gate-closure ledger (authoritative)

Maintained by the outer gate-closure loop in the main checkout. The copy on
`m4/g13-benchmark-harness` is a seed for the parallel harness; this file owns the
authoritative merge. Status vocabulary: `open` · `in-progress` · `review` · `closed` ·
`terminal-emitted` · `human-flagged`.

Gates are the thirteen blocking gates of `m4_interface_redesign_brief.md` §15.
Cross-cutting findings: the 2026-07-16 review register R1–R10 in
`docs/zk-m4-election-path-findings_1.html`.

| Gate | Type | Status | Evidence artifact | Notes |
|------|------|--------|-------------------|-------|
| G1  | terminal (product)   | human-flagged   | —                                   | Product accepts multi-role election. Out of loop scope. |
| G2  | decision             | **closed**      | `docs/research/m4_g2_profile_pin.md` | Pin `chide-es-r255-v1` (ES-CHide 2023/837 rev 2023-06-06, ristretto255, 3-of-5 Shamir q=t+1, box-private admission, cleanse-remove-all). Cleared 3-agent review 2026-07-17; `parameters_digest=mGfBR4aCA8oT5yTTE6MDsZNlt443SsKtFlyKtEzfhNs`. Unblocks G4/G8/G11/G13-calibration. |
| G3  | buildable            | open            | verify-only Rustler NIF (pending)   | Profile-agnostic scaffolding may start before G2. |
| G4  | buildable (op parts) | open            | —                                   | Blocked on G2 for credential specifics. |
| G5  | decision             | **closed**      | `docs/research/m4_g5_channel_threat_model.md` | `channel-onion-clientcover-noreceipt-v1`: Tor onion adapter bound; box-inside-metadata-trust; client-authored cover; no receipt (v1); hybrid batch trigger (accepted-content, k a cover-stream target); abort deferred to G8/G13. Cleared 3-agent review 2026-07-17. Authorizes: v2 spec schema + `channel_manifest_ref`, claim-condition schema, cover-indistinguishability G11 obligation. |
| G6  | decision             | open            | —                                   | Unanimous-box close accepted for POC vs named BFT close. |
| G7  | terminal (DA design) | open            | —                                   | Availability spec; implementation is its own track. |
| G8  | decision             | **closed**      | `docs/research/m4_g8_trustee_profile.md` | `trustee-ops-r255-v1`: HSM custody; off-board mesh (not Lattice, per closed G2); NIZK-of-invalidity DKG complaints (no live share on board); all-n mix with mix-liveness NOT claimed (fixed q-subset gives no liveness); volatile mix witnesses; frozen deterministic abort — DAG-frontier cut (no clock exists), non-circular quorum cert, in-spec cap pending G13 cover-cost; no resharing v1. Cleared 3-agent review 2026-07-17. Unblocks/feeds G4/G6/G11; authorizes merged v2 spec + profile-aware threshold validator + projector abort validator. |
| G9  | buildable            | open            | —                                   | Codec/domain-sep extends Lattice.Canonical. May start before G2. |
| G10 | buildable            | open            | —                                   | Secret-hygiene contracts incl. AtomVM bridge buffer. |
| G11 | buildable            | open            | —                                   | Conformance vectors. Blocked on G2. |
| G12 | terminal (external)  | open            | —                                   | Loop emits review package + reviewer brief; CANNOT close internally. |
| G13 | terminal (measure)   | **terminal-emitted, calibration=MEASURED** | `apps/township_bench/priv/reports/g13_chide_es_r255_1784301497.json` @ `m4/g13-benchmark-harness` 08bf1f2d | Calibrated over **real ristretto255** (verify-only Rustler NIF, curve25519-dalek 4.1.3; scalar-mult ~30µs, point-add ~0.13µs measured). Variant `chide_es_r255`, pinned 5/2/3, all C12 knobs echoed, zero pairings. **10k: 108.6s single-core / 32.9s parallel(5 trustees) / 82.7MB net / 95.5MB artifacts / 14.0s cold verify.** Town-scale ACCEPTABILITY remains a human product decision — the loop's job (emitted + measured) is done. 13/13 tests green. |

## Invariant check log

- 2026-07-17 iteration 1 start: invariants 1–5 verified against tree state — all
  SecurityProfile claims `:not_claimed` (F1 foundation only), Stub frozen
  `receipt_free? == false`, `M4Placeholder` empty, no ballots/credentials on
  `Township.Matter`, W0–W3 untouched.

## Iteration log

- **Iteration 1 (2026-07-17):** selected G2 (decision). Why: unblocks G4/G8/G11/G13-
  calibration; R1/R2 escalate admission posture into it. Artifact: pinned profile
  decision doc. Exit: 3-agent review clean, residual assumptions named. G13 input:
  no harness report yet — findings-doc cost table (48 CPU-days / 668 GB at 10k for
  quadratic CHide; O(n log n) encrypted-sorting variant unmeasured) stands in.
- **Iteration 1 progress:** ideation (Opus) produced options A/B/C; EVALUATE-plan ran
  agy (R13–R20) + codex (C1–C13) with Claude arbitration. B killed (contract conflict
  C11 + R13), C killed (cost/DoS R19). Decision draft `m4_g2_profile_pin.md` pins
  amended Option A as `chide-es-r255-v1` (ES-CHide ePrint 2023/837 rev 2023-06-06 —
  verified single-revision upstream; ristretto255; GJKR-Pedersen DKG; Bayer–Groth
  shuffle; Sigma/FS proofs; 5/2/3; box-private admission; cleanse-keep-first duplicate
  policy). G2 → review. Cross-gate: C12 requires harness parameterization before
  G13-calibration (routed to parallel worktree). Ops note: mid-iteration the Codex
  evaluator process died leaving stale `running` state; repaired and resumed via
  `codex exec resume` (CLI healthy post ChatGPT-app consolidation).
- **Iteration 1 closure (2026-07-17):** G2 CLOSED. Doc cleared 3-agent review after
  3 inner cycles: round 2 produced agy A1–A3 (digest-mining and primitive-
  incompatibility killed the keep-first duplicate policy → replaced by order-free
  remove-all; trustee pairwise-channel assumption named) + codex G2-1–G2-4
  (3-of-5/q=t+1 symbol fix, exact digest pipeline, domain-tag scoping, cleansing
  input set) + claude CL1 (provenance hash excluded from identity digest); round 3
  both reviewers independently converged on the same final must-fix (stale manifest
  policy id) — fixed, digest recomputed. Invariant re-check across tree: 1–5 intact
  (no claim flips, Stub frozen false, M4Placeholder empty, Matter clean, W0–W3
  untouched; confirmed by codex rounds 2–3 findings C7/C8 and "no invariant breach"
  round-3 note).
- **Cross-gate regression watch after G2:** (a) G5 is now constrained — the pinned
  box-private admission + preserved open-posting cover traffic must be the baseline
  of the G5 threat model; a G5 outcome contradicting box-private-v1 reopens G2 §4.
  (b) G12's composition surface now carries three named deviations/obligations:
  board-model realization, remove-all duplicate-rule fidelity (RV-3), and admission
  posture. (c) G8 inherits RV-2 (mix liveness), A3 (trustee channels), and the
  profile-aware threshold validator (C2). (d) G13 reopened for calibration — routed
  to the parallel worktree (ristretto255 GroupOps.measure + C12 knobs).
- **Iteration 2 closure (2026-07-17): G5 CLOSED.** Decision `channel-onion-
  clientcover-noreceipt-v1` cleared 3-agent review over 3 inner cycles (cycle 1: A/B/C
  evaluated, all non-viable, C rejected as deferral per codex #11; cycle 2: synthesized
  Option D, one independently-converged high finding New-01/NEW-1; cycle 3: fixed,
  agy CLEARS + codex pre-cleared). Invariants intact (codex "no claim-state breach",
  all `:not_claimed`). Cross-gate regression watch after G5:
    - **G8 inherits from G5:** overload/abort cap value + authorization (G5 named only
      the mechanism + fixed-rate throttle; agy F-06/codex #9 defer the cap), plus the
      pre-existing RV-2 (mix liveness) and A3 (trustee pairwise channels).
    - **G13 gets a named follow-on:** a cover-cost run (dummy-volume vs tally-cost curve)
      is the precondition before any overload cap is set. Harness already parameterized
      (C12) and measured; this is a specific run, not new harness work.
    - **G12 inherits:** the Tor adapter (`transport-tor-onion-v3-v1`) assessment
      sign-off obligation and the claim-condition (adapter/observer) composition surface.
    - **G4 inherits RV-G5-1:** confirm the pinned ballot proofs are NM-CPA non-malleable
      so remove-all cannot be weaponized for replay-nullification by a non-credential
      holder (cross-ref to G2 §2; a clarification of an already-assumed property, not a
      G2 reopen).
    - **Newly authorized buildable work:** `township-election-v2` spec schema with
      `channel_manifest_ref` (ArtifactRef, foundation-resolved, offline-bundle-required);
      `township-election-channel-v1` manifest schema; claim-set schema versioning with
      adapter/observer conditions; G11 cover-indistinguishability conformance.
    - **G3 asset noted:** the G13 worktree's verify-only ristretto255 Rustler NIF
      (curve25519-dalek 4.1.3, timing-only) is a concrete pattern for G3's verify-only
      NIF scaffolding — profile-agnostic, already builds/loads in this environment.
- **Iteration 3 closure (2026-07-17): G8 CLOSED.** Decision `trustee-ops-r255-v1`
  cleared 3-agent review. Cycle-1 killed options B (codex #8: on-board live shares breach
  G10 + Lattice-carrier trustee channels contradict closed G2 §202; codex #9: fixed
  q-subset mix gives no liveness) and C (codex #11/agy #6: resharing reopens G2).
  Synthesis: A's contract-fit posture + agy's NIZK-of-invalidity DKG complaints (verifiable
  on-board, zero live shares — resolves the G10/auditability tension both flagged) +
  volatile mix witnesses + codex's deterministic-abort freezes. RV-2 arbitrated: q-subset
  mix is *sound* (agy) but delivers no *liveness* without proven committee reselection
  (codex) → all-n mix, mix-liveness a named availability non-claim. Abort redesigned over
  cycles 2–4 from a (non-existent) tick-window to a DAG-frontier cut using
  `Lattice.Dag.reachable/2`, non-circular `Canonical.term` certificate, frontier == abort-op
  deps; converged (each cycle narrower, all reviewer-prescribed). Invariants intact (codex
  "all :not_claimed"). Cross-gate regression watch after G8:
    - **G4 inherits:** the NIZK-of-invalidity scheme is a ristretto255 Sigma statement
      (G3/G11 implement); RV-G5-1 (NM-CPA ballot non-malleability) remains G4's.
    - **G6 interaction:** abort reason `:close_stalled` couples to the close policy; G6
      (still the last open decision gate) must be consistent with the G8 abort cut.
    - **G11 inherits:** conformance vectors for the abort-certificate byte-freeze, the
      profile-aware threshold validator (q=t+1 ∧ n−t≥q), and the NIZK-of-invalidity.
    - **G13 hard dependency:** the cover-cost run now blocks `max_admitted_artifacts`
      *and* thus v2 spec finalization — it is a finalization gate, not just a number.
    - **Newly authorized buildable (merged with G5's v2 work):** one
      `township-election-v2` carrying `channel_manifest_ref` (G5) + `abort_policy` +
      `trustee_channel_manifest_ref` (G8), v1 byte-identical; profile-aware
      `validate_thresholds` dispatched by full ProfileRef; projector abort-cert validator
      + deterministic lifecycle fold (replacing the hard-coded `phase: :setup`).
    - **No G2 reopen** — G8 fixed operations around the pinned crypto, unchanged.
- **G13 calibration MEASURED (2026-07-17), worktree commit 08bf1f2d.** Real
  ristretto255 timings via verify-only Rustler NIF (curve25519-dalek 4.1.3):
  scalar-mult ~30µs, point-add ~0.13µs. Pinned-profile `chide_es_r255` at 5/2/3,
  10k participants / 21k effective ballots: 108.6s single-core, 32.9s
  committee-parallel, 82.7MB exchanged, 95.5MB replay artifacts, 14.0s cold verify
  — zero pairings, ~3.4× cheaper single-core than the old pairing-priced placeholder.
  This is the truthful terminal G13 state; whether the numbers are acceptable at town
  scale is the human product decision the loop does not make. Report never fakes
  `:measured` — degrades to `:uncalibrated`+blocker if the NIF can't build; legacy
  pairing variants always `:uncalibrated`.
