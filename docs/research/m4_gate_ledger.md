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
| G5  | decision             | open            | —                                   | Anonymous-channel threat model; couples to R1/R2/R5/R7. |
| G6  | decision             | open            | —                                   | Unanimous-box close accepted for POC vs named BFT close. |
| G7  | terminal (DA design) | open            | —                                   | Availability spec; implementation is its own track. |
| G8  | decision             | open            | —                                   | Trustee corruption bound / quorum / DKG profile. Blocked on G2. |
| G9  | buildable            | open            | —                                   | Codec/domain-sep extends Lattice.Canonical. May start before G2. |
| G10 | buildable            | open            | —                                   | Secret-hygiene contracts incl. AtomVM bridge buffer. |
| G11 | buildable            | open            | —                                   | Conformance vectors. Blocked on G2. |
| G12 | terminal (external)  | open            | —                                   | Loop emits review package + reviewer brief; CANNOT close internally. |
| G13 | terminal (measure)   | **reopened (calibration)** | `apps/township_bench/priv/reports/g13_chide_encrypted_sort_1784292005.json` @ `m4/g13-benchmark-harness` 7e7f1692 | Structure emitted; G2 closure triggers calibration: `GroupOps.measure/2` over **ristretto255**, plus C12 harness parameterization (trustee/corrupt/quorum/candidate/dummy/revote knobs; per-profile op profile — `chide-es-r255-v1` has NO per-ballot pairing). Existing uncalibrated numbers do not describe the pinned profile. |

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
