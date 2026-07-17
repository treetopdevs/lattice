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
| G5  | decision             | **review** (cycle 2) | `docs/research/m4_g5_channel_threat_model.md` | Synthesized Option D `channel-onion-clientcover-noreceipt-v1` (Tor onion adapter bound; box-inside-metadata-trust; client-authored cover; no receipt; abort deferred to G8/G13). Cycle-1 EVALUATE: agy F-01–F-10, codex 1–11; A/B/C all non-viable-as-written, C rejected as deferral. Awaiting cycle-2 confirmation. |
| G6  | decision             | open            | —                                   | Unanimous-box close accepted for POC vs named BFT close. |
| G7  | terminal (DA design) | open            | —                                   | Availability spec; implementation is its own track. |
| G8  | decision             | open            | —                                   | Trustee corruption bound / quorum / DKG profile. Blocked on G2. |
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
