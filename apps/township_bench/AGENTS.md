# township_bench — G13 cost harness (parallel worktree)

This app lives on branch `m4/g13-benchmark-harness`, run as a **parallel worktree**
alongside the main gate-closure loop. Its whole reason to exist early: G13
(town-scale cost) is the gate most likely to kill the encrypted-sorting CHide profile
outright, and it is the cheapest expensive truth to learn. Price the construction
before the other twelve gates' work is sunk into it.

## Scope — do exactly this
- Model the DOMINANT cost of the candidate construction from its **reference
  algorithms** (op counts × calibrated units), at 100 / 1,000 / 10,000 participants.
- Emit the gate-13 metric set verbatim: CPU, wall time, memory, network bytes,
  artifact bytes, cold/warm verification, trustee count, candidate count, dummy
  ballots, revotes.
- Keep the calibration seam (`GroupOps`) honest: it was uncalibrated until G2 pinned
  a curve; since G2 closed on `chide-es-r255-v1` (2026-07-17, ristretto255) it measures
  real scalar-mult/point-add timings through a verify-only Rustler NIF over
  curve25519-dalek — and it degrades back to `:uncalibrated`, naming the blocker, in
  any environment where the NIF cannot build or load.
- Measured units apply ONLY to the no-pairing `chide_es_r255` variant; the legacy
  pairing-priced variants always report `:uncalibrated`.

## Do NOT
- Run real MPC / DKG / decryption. That is F2/F3 work; this harness decides whether
  it is worth starting.
- Touch `Township.Matter`, `Lattice.Attestation`, or any SecurityProfile claim.
- Read an uncalibrated estimate as measured cost. Every report prints its calibration
  status for exactly this reason (findings §14/R7).
- Mark G13 "closed". The loop's terminal state for G13 is **emitted**: the harness
  ran and produced metrics. Whether the numbers are acceptable is a human product
  decision, not a test result.

## Contract with the outer loop
- On each run with `--json`, write a report to `priv/reports/`. The outer loop reads
  the latest to set G13 = `terminal-emitted` in `docs/research/m4_gate_ledger.md`.
- When G2 pins the profile, implement `GroupOps.measure/2` over the pinned curve
  (Rustler NIF, verify-only build), swap `calibrate/0` to `:measured`, re-run. The
  harness contract is unchanged; only the numbers become truthful.

## Run
    mix township.bench.g13 --json
    mix township.bench.g13 --variant chide_quadratic --scales 100,1000,10000 --json
    # Pinned profile chide-es-r255-v1 with its pinned committee (C12 knobs):
    mix township.bench.g13 --variant chide_es_r255 \
      --trustees 5 --max-corrupt 2 --share-quorum 3 --json

## Merge discipline
This worktree stays green independently. It merges to main only to publish reports
and the calibrated model; it never carries a claim flip or a Stub change.
