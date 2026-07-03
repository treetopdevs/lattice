# Plan 009: Document Lattice 2.0 in the README and publish module docs via ex_doc

> **Executor instructions**: Follow step by step; run each verification. Honor STOP
> conditions. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- README.md apps/lattice_core/mix.exs docs/lattice2_design.md`
> If any changed, compare "Current state" first; on a real mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (coordinate README edits with plan 004 if both run)
- **Category**: docs
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The top-level `README.md` describes only the v1 capability plane. It never mentions
**Lattice 2.0 — "Replicas on a capability-attested log"**, which is fully implemented in
`apps/lattice_core/lib/lattice/` and heavily documented (`docs/lattice2_design.md`, four
ADRs, threat model v2, path-to-real). A reader can't discover v2 exists or how to run it.
Separately, the v2 modules carry substantial `@moduledoc`/`@doc`/`@spec` content that is
never rendered — there is no `ex_doc` setup, so `mix docs` doesn't exist. Both are
cheap, additive doc fixes.

## Current state

- `README.md`: "What This POC Proves", "Architecture", and "Dependencies" sections are
  all v1 (Cap/CapStore/Gateway/Topology/LiveOps/Flagship/Graph). No "Lattice 2.0"
  section. (The architecture list ends at `Lattice.LiveOps`.)
- The v2 facade lives on `Lattice` (`apps/lattice_core/lib/lattice.ex`, the section after
  `external_cap/1`): `materialize/2`, `go_dormant/2`, `tombstone/2`, `monitor/2`,
  `send_durable/3`, `await/2`, `state_at/3`; promise `call` + capability `grant` are on
  `Lattice.Registry`/in-log delegation ops (documented in that file).
- Demo: `scripts/lattice2_demo.exs` (runs via `~/.asdf/shims/mix run scripts/lattice2_demo.exs`
  or standalone `~/.asdf/shims/elixir scripts/lattice2_demo.exs`).
- Design docs already exist: `docs/lattice2_design.md`, `docs/adr/0001-0004*.md`,
  `docs/threat_model_v2.md`, `docs/path_to_real.md`, `docs/lattice_poc_status.md`.
- `apps/lattice_core/mix.exs` has no `:ex_doc` dep and no `:docs`/`:name`/`:source_url`
  config. Its `deps/0` currently is `[{:jason, "~> 1.4"}, {:stream_data, "~> 1.1", only: [:dev, :test]}]`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Fetch ex_doc | `~/.asdf/shims/mix deps.get` | resolves ex_doc |
| Build docs | `cd apps/lattice_core && ~/.asdf/shims/mix docs` | writes HTML to `doc/`, exit 0 |
| Tests unaffected | `~/.asdf/shims/mix test` | all pass |
| Format | `~/.asdf/shims/mix format` | exit 0 |

## Scope

**In scope**:
- `README.md` (add a "Lattice 2.0" section; do not rewrite v1 sections)
- `apps/lattice_core/mix.exs` (add ex_doc dev dep + `:docs` config)
- `mix.lock` (updated by `deps.get`)
- `.gitignore` (add `doc/` and/or `apps/*/doc/` if not already ignored — generated output)

**Out of scope**:
- The v2 design docs themselves — they exist and are accurate; do not duplicate their
  content into the README, link to them.
- Any source `@moduledoc`/`@doc` — ex_doc renders what already exists; no doc-comment
  edits needed.
- README toolchain/prereqs text — that's plan 004; if 004 has not run, you may add a
  one-line pointer but keep the v2 section as your edit.

## Git workflow

- Branch: `advisor/009-readme-v2-and-exdoc`
- Commit 1: README section. Commit 2: ex_doc setup + gitignore. Short imperative messages.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a "Lattice 2.0" section to the README

Insert a concise section (after "What This POC Proves" or before "Architecture"),
~20–35 lines, that states:
- the one-line thesis ("Replicas on a capability-attested log": a process whose identity
  is a durable, signed op-log; materializations are ephemeral, pure reductions);
- the headline guarantees (offline-convergent CRDT state; serialized authority via a
  transferable, revocable delegation; durable messaging + promises across dormancy;
  deterministic convergence under partition; one delegation chain authorizing both a log
  append and a live message);
- where the code is (`apps/lattice_core/lib/lattice/` — Op/Log/Sync/Net/Clock/Crdt/
  Replica/Reduce/Authority/Registry/Materializer/Promise/Live/Sim) and the facade on
  `Lattice` + `Lattice.Registry`;
- how to run it: `~/.asdf/shims/mix run scripts/lattice2_demo.exs`, and the tests under
  `apps/lattice_core/test/lattice2/`;
- links to `docs/lattice2_design.md`, `docs/adr/`, `docs/threat_model_v2.md`,
  `docs/path_to_real.md`, `docs/lattice_poc_status.md`.

Keep it factual and consistent with `docs/lattice2_design.md` (do not overclaim — note it
is a POC; no encryption; no compaction).

**Verify**: `grep -n "Lattice 2.0\|lattice2_demo\|lattice2_design" README.md` → matches.

### Step 2: Configure ex_doc in `apps/lattice_core/mix.exs`

- Add to `deps/0`: `{:ex_doc, "~> 0.34", only: :dev, runtime: false}`.
- Add to `project/0` a docs config, e.g.:
  ```elixir
  name: "Lattice",
  source_url: "https://github.com/treetopdevs/lattice",
  docs: [
    main: "Lattice",
    extras: [
      "../../docs/lattice2_design.md",
      "../../docs/threat_model_v2.md",
      "../../docs/path_to_real.md"
    ]
  ]
  ```
  (Adjust the extras list to files that exist; ex_doc will fail if an extra path is
  missing — verify each path resolves from `apps/lattice_core/`.)

**Verify**: `~/.asdf/shims/mix deps.get` resolves ex_doc; `cd apps/lattice_core && ~/.asdf/shims/mix docs`
exits 0 and writes `apps/lattice_core/doc/index.html` (or `doc/`). Open is not required;
exit 0 + an `index.html` is the gate.

### Step 3: Ignore generated docs

Add `doc/` (and `apps/*/doc/` if needed) to `.gitignore` so generated HTML isn't
committed.

**Verify**: `git status` does NOT list any `doc/` HTML as untracked after `mix docs`.

### Step 4: Tests + format unaffected

**Verify**: `~/.asdf/shims/mix test` → all pass (ex_doc is `only: :dev`); `~/.asdf/shims/mix format` → exit 0.

## Test plan

Docs/tooling only:
- `cd apps/lattice_core && ~/.asdf/shims/mix docs` exits 0 and produces HTML (the
  @moduledocs render).
- `grep` gates in Steps 1–3 confirm the README section and ignore rule.
- Full `mix test` unchanged.

## Done criteria

ALL must hold:
- [ ] `README.md` has a "Lattice 2.0" section linking the design docs and the demo command.
- [ ] `apps/lattice_core/mix.exs` declares `ex_doc` (`only: :dev, runtime: false`) and a
      `:docs` config; `cd apps/lattice_core && ~/.asdf/shims/mix docs` exits 0.
- [ ] Generated `doc/` is gitignored (not committed).
- [ ] `~/.asdf/shims/mix test` passes; `~/.asdf/shims/mix format` clean.
- [ ] `git status` shows only README, `apps/lattice_core/mix.exs`, `mix.lock`, `.gitignore`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- `mix docs` fails because an `extras:` path doesn't resolve — fix the path list (only
  list files that exist relative to `apps/lattice_core/`); if it still fails, report the
  error.
- `mix deps.get` cannot resolve `ex_doc ~> 0.34` — try the current `~> 0.3x` line; do not
  pin an arbitrary old version.

## Maintenance notes

- If umbrella-wide docs are wanted later (all apps), ex_doc can be configured at the root
  with `apps_path`; this plan scopes it to `lattice_core` where the rich v2 docs live.
- Coordinate with plan 004 (README toolchain section) to avoid overlapping README edits.
- A reviewer should sanity-check the README's v2 claims against `docs/lattice2_design.md`
  so the two don't drift.
