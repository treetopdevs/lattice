# PD-002 — Agent infrastructure (docs-only)

Converts the departing principal architect's judgment into procedure so
implementation agents (Opus/Codex class) can operate near-level. **Docs only —
no code, test, or behavior changes.**

**Grounding:** reconciled against `claude/beautiful-gould-6b25d2` @ `81b9bfd`
by full static read. Headline finding: **M1 (Lattice 2.0 core) is green
here** — all 19 behaviors with test mapping, 9 properties / 67 tests stable
across seeds 1/7/99/555/2024/12345, demo narrating end-to-end.

## Contents

- `docs/agent/HANDOFF.md` — the decision procedure: invariants,
  DO-NOT-IMPLEMENT boundary, tie-breaker order (falsifiability > determinism >
  deps-decidability > boring > seams > reversibility), escalation triggers,
  calibration cases, canonical glossary, M1 close-out checklist, M2 opening
  (W-series).
- `docs/agent/reconciliation_report.md` — pre-filled against this tree;
  **requires countersign**: run `mix test` (expect 9 properties, 67 tests, 0
  failures) and `mix run scripts/lattice2_demo.exs`, then sign §5. (Authoring
  environment had no Hex network — dynamic evidence deliberately left to the
  successor.)
- `docs/agent/register.md` — living register: Q-01..08 **all CLOSED** (five
  superseded by ADRs 0001–0004, often with stronger formulations — ADR 0003's
  two-clause honored-iff adopted as house style), V-01..04 verified, W-01..05
  open for M2, R-series research (human-owned).
- `docs/agent/adr_proposed/` — three genuinely open ADRs: **P08**
  canonical-CBOR wire schema (golden vectors + dual-encode migration; closes
  ADR 0001's BEAM-specific caveat); **P09** carrier selection by five
  falsifiable criteria (spike evidence recorded: fail-closed `tcp_filter_dist`
  works; Popcorn pins Elixir 1.17.3/OTP 26 vs the OTP 28 toolchain; standing
  lean = JS client now, dist seam kept warm); **P10** heartbeats derived from
  carrier liveness (closes the ADR 0004 caveat without letting reduction read
  liveness — invariant 5 preserved).
- `docs/agent/antipatterns.md` — AP-01..12, incl. two mined from this branch's
  own history: the `Dag.reachable/2` pre-seeded-accumulator class and the v1
  facade name-clash.
- `docs/agent/review_rubric.md` (16-point checklist incl. mechanical greps),
  `status_protocol.md` (falsifiability trail), `prompts/phase_task.md`
  (task-agent template, six-part output contract).
- Root `CLAUDE.md` + `AGENTS.md` so Claude-family and Codex-family agents
  auto-load the short rules and are pointed at the handoff.

## Known open delta

**D-A1:** the Addendum-01 cryptographic-agility note (Dilithium/SPHINCS+;
pinned-and-swappable) is **absent from `docs/`** — registered as an M1
close-out doc task, not silently patched here.

Per the package's own working agreements: merges to `main` remain
human-approved. This PR targets the 2.0 branch so the handoff lives beside the
tree it reconciles and rides along when the branch merges.
