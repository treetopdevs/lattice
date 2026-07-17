# M4 gate-closure ledger

Maintained by the outer gate-closure loop. This copy is seeded on the G13 worktree so
the parallel harness has a place to report; the main loop's worktree owns the
authoritative merge. Status vocabulary: `open` · `in-progress` · `review` · `closed` ·
`terminal-emitted` · `human-flagged`.

| Gate | Type | Status | Evidence artifact | Notes |
|------|------|--------|-------------------|-------|
| G1  | terminal (product)   | human-flagged     | —                                   | Product accepts multi-role election. Out of loop scope. |
| G2  | decision             | open              | docs/research/ (pending)            | Pin encrypted-sorting CHide profile. Gates G4/G8/G11/G13 calibration. |
| G3  | buildable            | open              | verify-only Rustler NIF (pending)   | Profile-agnostic scaffolding may start before G2. |
| G4  | buildable (op parts) | open              | —                                   | Blocked on G2 for credential specifics. |
| G5  | decision             | open              | —                                   | Anonymous-channel threat model; couples to §14/R1,R2. |
| G6  | decision             | open              | —                                   | Unanimous-box vs named BFT close. |
| G7  | terminal (DA design) | open              | —                                   | Availability spec; implementation own track. |
| G8  | decision             | open              | —                                   | Trustee corruption bound / quorum / DKG profile. Blocked on G2. |
| G9  | buildable            | open              | —                                   | Codec/domain-sep extends Lattice.Canonical. May start before G2. |
| G10 | buildable            | open              | —                                   | Secret-hygiene contracts incl. bridge buffer. |
| G11 | buildable            | open              | —                                   | Conformance vectors. Blocked on G2. |
| G12 | terminal (external)  | open              | —                                   | Loop emits review package; CANNOT close internally. |
| G13 | terminal (measure)   | **in-progress**   | apps/township_bench + priv/reports/ | **This worktree.** Runs against reference algorithms; calibration uncalibrated until G2. |

## G13 running note
Harness scaffolded iteration 0, before role runners exist. Emits mandated metrics at
100/1k/10k. Calibration seam (`GroupOps`) returns `:uncalibrated` until G2 pins a
curve; reports carry the status so no number is mistaken for measured cost. When G2
lands, calibrate over the pinned curve and re-run — the harness contract is stable.
