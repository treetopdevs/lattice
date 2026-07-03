# Goal 000: Foundation & Hardening — land plans 001–009 as one coherent effort

> **This is the umbrella goal document.** It sequences nine self-contained plans
> (`001`–`009`) into gated phases and defines the single end-state. It does **not**
> restate their steps — each linked plan is executor-grade on its own. A coordinator (or
> an `/improve execute <plan>` run per plan) follows the phase order here, runs each
> phase's gate before proceeding, and runs the **Global validation loop** at the end.
>
> The four direction items (`010`–`013`) are explicitly **out of this goal** — they are
> spikes/design work tracked separately.

## Objective

Make the repository's verification trustworthy and the Lattice 2.0 engine clean,
tested, and documented — without changing any proven behavior. Concretely, when this
goal is done:

- CI runs the **entire** unit + property suite (today it runs only 3 flagship files), so
  the ~142 tests / ~10 properties cannot silently rot;
- there is a one-command local health gate and static analysis (Credo + Sobelow), with an
  agent/toolchain guide so contributors don't hit the broken-mise footgun;
- the v2 reduction/authority engine no longer does O(n²) whole-log re-scans, proven
  behavior-neutral by the determinism property suite;
- the v2 infrastructure modules have direct tests and the central determinism property
  runs at higher depth;
- the WebSocket boundary stops leaking internal authorization reasons, CapStore revoke is
  O(subtree) instead of O(caps²) and no longer ignores `register_cap` failures;
- the README documents Lattice 2.0 and `mix docs` publishes the module docs.

## Non-negotiables (apply to every phase)

1. **The suite stays green the whole way.** Start from green (Phase 0) and never proceed
   past a phase whose gate is red. `~/.asdf/shims/mix test` ends in `0 failures` at every
   gate.
2. **Determinism is sacred.** Plan 005 is semantics-preserving; the determinism /
   identical-quarantine property assertions in
   `apps/lattice_core/test/lattice2/convergence_property_test.exs` are the trip-wire. If
   any determinism/byte-identical assertion fails, STOP — do not "adjust the test".
3. **No public v2 API signatures change** in 005/006/007/008
   (`Authority.analyze/2`, `Reduce.reduce/3`, `Reduce.reduce_crdts/3`, `CapStore` public
   functions). Additive only.
4. **Toolchain**: run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a broken
   mise shim; see `.mise.toml`). In GitHub Actions, plain `mix` works.
5. **Scope discipline**: each plan lists in-scope/out-of-scope files; honor them. Each
   plan has STOP conditions; honor them.

## Plans in scope (the nine)

| Plan | Title | Effort | Risk | Phase |
|------|-------|--------|------|-------|
| [001](001-ci-gate-full-test-suite.md) | CI gates the full suite (+dep cache) | S | LOW | 1 |
| [002](002-mix-verify-alias.md) | `mix verify` one-command gate | S | LOW | 1 |
| [003](003-static-analysis-credo-sobelow.md) | Credo + Sobelow | S–M | LOW | 1 |
| [004](004-agents-md-and-toolchain-doc.md) | `AGENTS.md` + toolchain doc | S | LOW | 1 |
| [005](005-v2-reduction-complexity.md) | Kill v2 reduction/authority O(n²) | M | MED | 2 |
| [006](006-v2-infra-tests.md) | v2 infra tests + 500-run properties | M | LOW | 2 |
| [007](007-ws-error-reason-leak.md) | Stop leaking auth reasons over WS | S | LOW–MED | 3 |
| [008](008-capstore-descendant-index.md) | CapStore child-index + `register_cap` | S–M | MED | 3 |
| [009](009-readme-v2-and-exdoc.md) | README v2 section + ex_doc | S | LOW | 3 |

## Execution phases & gates

Each phase's gate must pass before the next phase starts.

### Phase 0 — Establish the green baseline

Before any change, confirm the starting point is green and record it.

- `git rev-parse --short HEAD` (expect `81b9bfd` or later; if later, each plan's drift
  check applies).
- `~/.asdf/shims/mix test` → `0 failures`.
- `~/.asdf/shims/mix format --check-formatted` → exit 0.

**Gate**: suite green at HEAD. If red, STOP — the foundation goal cannot start on a red
suite; report what fails.

### Phase 1 — Verification & DX foundation (001 → 002 → 003 → 004)

Order matters lightly: do **001 first** (it makes everything after it CI-guarded), then
002, 003, 004. (004 must precede 009 because both edit `README.md`.)

After the four land, do the **Phase-1 integration capstone** (folds 003 into 001/002,
as noted in those plans' Maintenance sections):
- extend the CI `unit` job (from 001) to also run `mix credo --strict` and
  `cd apps/lattice_server && mix sobelow --exit`;
- add a `check` alias in root `mix.exs` (extending 002): `check: ["verify", "credo --strict"]`
  (Sobelow is per-app; document running it in `apps/lattice_server`).

**Gate**:
- `~/.asdf/shims/mix verify` → format-check + full suite, exit 0.
- `~/.asdf/shims/mix credo --strict` → exit 0 (clean or documented baseline).
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` → exit 0.
- `.github/workflows/flagship.yml` defines a `unit` job running the full `mix test` +
  format check + (after capstone) credo/sobelow, with `actions/cache@v4` for `deps`+`_build`.
- `AGENTS.md` exists at repo root and documents the `~/.asdf/shims/mix` rule.

### Phase 2 — v2 engine hygiene (005 → 006)

- **005** is the riskiest plan in the goal: it removes the O(n²) holder/ancestor
  re-scans. The acceptance is *byte-identical* behavior — verified by the property suite
  across multiple seeds.
- **006** adds direct tests for `Net`/`Clock`/`Materializer`/`Promise`, raises the
  determinism property to 500 runs, and removes a dead `assert true`. If 006's higher run
  count surfaces a determinism counterexample, that is a real bug — STOP and report the
  seed (do not lower `max_runs`).

Run 005 before 006 so the property suite (about to get heavier in 006) is already passing
against the refactor.

**Gate**:
- `cd apps/lattice_core && ~/.asdf/shims/mix compile` → 0 warnings.
- `cd apps/lattice_core && for s in 1 7 99 2024 555; do ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs --seed $s; done` → each `0 failures`.
- New test files `test/lattice2/{net,clock,materializer,promise}_test.exs` exist and pass.
- `grep -n "holder_as_of\|last_active_as_of" apps/lattice_core/lib/lattice/authority.ex` → no matches; `grep -n "Dag.ancestors(" apps/lattice_core/lib/lattice/reduce.ex` → no matches.
- `~/.asdf/shims/mix test` (full) → `0 failures`.

### Phase 3 — Hardening & docs (007 · 008 · 009)

These three are independent of one another; do in any order (009 after 004 for the
README). 

**Gate**:
- `grep -n "inspect(reason)" apps/lattice_server/lib/lattice/transport/web_socket.ex` → no matches (007).
- `grep -n "Enum.filter(fn {_id, cap} -> cap.parent_id" apps/lattice_core/lib/lattice/cap_store.ex` → no matches; grant/delegate consume `register_cap`'s result (008).
- `cd apps/lattice_core && ~/.asdf/shims/mix docs` → exit 0, produces HTML; README has a "Lattice 2.0" section (009).
- `~/.asdf/shims/mix test` (full) → `0 failures`.

### Phase 4 — Goal validation & integration

Run the **Global validation loop** (below). Update every `001`–`009` row in
`plans/README.md` to `DONE`. Prepare the integration branch for review (open a PR only if
the operator instructs it).

## Global validation loop (the goal's definition of done)

Run from the repo root unless noted. ALL must pass:

1. `~/.asdf/shims/mix format --check-formatted` → exit 0
2. `~/.asdf/shims/mix credo --strict` → exit 0
3. `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` → exit 0
4. `~/.asdf/shims/mix test` → `0 failures` (full umbrella; includes the new v2 infra tests)
5. `cd apps/lattice_core && for s in 1 7 99 2024 555; do ~/.asdf/shims/mix test test/lattice2/convergence_property_test.exs --seed $s; done` → each `0 failures`
6. `cd apps/lattice_core && ~/.asdf/shims/mix docs` → exit 0
7. `~/.asdf/shims/mix run scripts/lattice2_demo.exs` → runs to "Demo complete"
8. CI on the branch: both the existing `verify` (flagship) job and the new `unit` job are
   green.

## Integration / branch strategy

- **Recommended**: one integration branch `advisor/foundation-hardening`, with a commit
  (or small commit group) per plan, in phase order. Validate at each phase gate. This
  keeps the suite green throughout and yields one reviewable PR.
- **Alternative**: per-plan branches (`advisor/NNN-*` as each plan specifies) merged in
  phase order — use this if you want independent review/rollback per plan.
- Either way: do **not** push or open a PR unless the operator instructs it. Match the
  repo's short-imperative commit style (see `git log`).

## Risk register & rollback

| Plan | Main risk | Mitigation / trip-wire | Rollback |
|------|-----------|------------------------|----------|
| 005 | Refactor changes engine semantics | Determinism + identical-quarantine property across 5 seeds (gate); STOP on any failure | Revert the offending step's commit; engine is otherwise untouched |
| 007 | Client error-contract change breaks a consumer | Check `examples/*/client.js` for atom-specific handling; update tests to coarse codes | Revert; mapping is isolated to `web_socket.ex` |
| 008 | Fail-closed `register_cap` / index drift breaks v1 cap flow | `lattice_core_poc_test.exs` + adversarial authority tests (gate); new chain-revoke test | Revert; `cap_store.ex` only |
| 003 | Credo/Sobelow noise blocks the gate | Baseline noisy checks in config **with recorded follow-ups**, don't fix code in 003 | Loosen `.credo.exs`; deps are dev-only |
| 001/002/004/006/009 | Additive; low | Each is gated by its own Done criteria | Revert the single file/commit |

## Stop only when

- All nine plans' **Done criteria** are checked (see each plan file).
- The **Global validation loop** passes end-to-end.
- `plans/README.md` shows `001`–`009` as `DONE`.
- The integration branch is ready for review (PR opened only if instructed).

If any plan hits a STOP condition (drift, a genuine bug surfaced by a new test, a
determinism regression, or a needed out-of-scope change), stop that plan and report —
the goal pauses at that phase rather than improvising past it. A documented pause is
worth more than a forced green.

## Maintenance notes

- After this goal lands, the natural follow-ups are the direction spikes `010`–`013`
  (real carrier, `Lattice.V2` facade, v2 DAG visualization, compaction) and the deferred
  items recorded in `plans/README.md` (Dialyzer, dual-audit unification, LiveOps split,
  structured logging, dep de-duplication).
- The Phase-1 capstone (credo/sobelow in CI + a `mix check` alias) is what makes the new
  static-analysis gate durable; don't skip it, or the tools rot like the test suite did.
