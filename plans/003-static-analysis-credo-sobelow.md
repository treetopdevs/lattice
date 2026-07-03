# Plan 003: Add static analysis — Credo (lint) and Sobelow (security)

> **Executor instructions**: Follow step by step; run each verification and confirm
> before moving on. Honor STOP conditions. Update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- mix.exs mix.lock`
> If these changed, reconcile against "Current state" before proceeding; on a real
> mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (pairs with 001/002)
- **Category**: dx / security
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The repo has `mix format` but **no static analysis**: no Credo (style/consistency/
complexity), no Sobelow (Elixir security linter), no Dialyzer. The codebase has a real
network boundary (`apps/lattice_server`, a Cowboy WebSocket server parsing untrusted
JSON) where Sobelow is high-leverage, and ~12.5K LOC where Credo prevents drift. Both
are dev-only and runtime-free. (Dialyzer is deliberately deferred — see Maintenance
notes — because it needs a PLT build and spec backfill, which is a larger effort.)

## Current state

- Root `mix.exs` `deps/0` is empty: `defp deps do [] end`.
- No `.credo.exs` and no `.sobelow-conf` at repo root.
- `mix.lock` contains no `credo`/`sobelow` entries.
- Run mix as `~/.asdf/shims/mix` locally.
- `apps/lattice_server` is the security-relevant app (Cowboy boundary):
  `apps/lattice_server/lib/lattice/transport/web_socket.ex`,
  `apps/lattice_server/lib/lattice_server/*.ex`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Fetch deps | `~/.asdf/shims/mix deps.get` | resolves credo + sobelow |
| Credo | `~/.asdf/shims/mix credo` (then `--strict`) | runs; review findings |
| Sobelow (server app) | `cd apps/lattice_server && ~/.asdf/shims/mix sobelow` | runs; review findings |
| Format | `~/.asdf/shims/mix format` | exit 0 |
| Tests | `~/.asdf/shims/mix test` | unaffected, all pass |

## Scope

**In scope**:
- `mix.exs` (root — add dev/test deps)
- `mix.lock` (updated by `mix deps.get`)
- `.credo.exs` (create)
- `.sobelow-conf` (create, optional — only if needed to scope/quiet false positives)

**Out of scope**:
- Do NOT "fix" every Credo/Sobelow finding in this plan. This plan **installs and
  configures** the tools and gets them to a clean (or explicitly-baselined) exit. Real
  remediations are separate follow-up findings — record them, don't sprawl.
- Do NOT add Dialyzer here (deferred).
- Do NOT modify application source except to silence a confirmed-false-positive via
  config, not code.

## Git workflow

- Branch: `advisor/003-static-analysis`
- Commit 1: add deps + configs. Commit 2 (if needed): config tuning to reach a clean
  exit. Short imperative messages.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add the dev/test dependencies

Edit root `mix.exs` `deps/0`:
```elixir
defp deps do
  [
    {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
    {:sobelow, "~> 0.13", only: [:dev, :test], runtime: false}
  ]
end
```

**Verify**: `~/.asdf/shims/mix deps.get` → resolves and writes `credo` + `sobelow` into
`mix.lock`. `grep -E "credo|sobelow" mix.lock` → both present.

### Step 2: Generate and commit a Credo config, then run it

- `~/.asdf/shims/mix credo gen.config` → creates `.credo.exs`.
- Run `~/.asdf/shims/mix credo`. Read the output. Two acceptable end-states:
  1. **Clean** (no issues) — done.
  2. **Findings exist** — do NOT fix code here. Instead, in `.credo.exs`, set the run to
     non-strict defaults (the generated config already is) and, if specific checks are
     noisy for this codebase's deliberate style, lower their priority or disable them
     **with a one-line comment explaining why**. The goal is a meaningful, green
     `mix credo` that the team can keep green — not zero signal. Record any genuine
     issues you suppressed as follow-ups in `plans/README.md` "Findings considered".

**Verify**: `~/.asdf/shims/mix credo` exits 0 (clean or baselined).

### Step 3: Run Sobelow on the server app

Sobelow targets a single app (it scans one Mix project). The network boundary is
`apps/lattice_server`.

- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow` (the dep is available umbrella-
  wide). Read findings.
- For a Cowboy-(not-Phoenix)-based app, many Phoenix-specific checks won't apply.
  Confirmed false positives go in a `.sobelow-conf` (run `mix sobelow --save-config` in
  `apps/lattice_server` to scaffold it) with a comment; genuine findings are recorded as
  follow-ups (e.g. the WS error-reason leak is already tracked by plan 007 — do not
  double-fix it here).

**Verify**: `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` returns 0 (or a
documented baseline). Capture the finding list in the commit message or
`plans/README.md`.

### Step 4: Confirm nothing else broke

**Verify**: `~/.asdf/shims/mix format` (format the new `.credo.exs`/`.sobelow-conf` if
Elixir) → exit 0; `~/.asdf/shims/mix test` → all pass (deps are `runtime: false`, so the
suite is unaffected).

## Test plan

No application tests. The deliverable is two working tools:
- `mix credo` runs and exits 0.
- `mix sobelow` (in `apps/lattice_server`) runs and exits 0 (or documented baseline).
- The full `mix test` suite is unchanged and green.

## Done criteria

ALL must hold:
- [ ] `mix.exs` declares `credo` and `sobelow` as `only: [:dev, :test], runtime: false`.
- [ ] `mix.lock` contains both.
- [ ] `.credo.exs` exists and `~/.asdf/shims/mix credo` exits 0.
- [ ] `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` exits 0 (clean or
      baselined with a committed `.sobelow-conf`).
- [ ] `~/.asdf/shims/mix test` still passes.
- [ ] Any suppressed-but-genuine findings are listed in `plans/README.md`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- Credo or Sobelow surfaces a **high-severity, clearly-genuine** issue that needs a code
  change to resolve (don't fix it here; report it so it becomes its own finding/plan).
- `mix deps.get` cannot resolve the versions (report the resolver error; try the latest
  compatible `~> 1.7` / `~> 0.13` line, do not pin an arbitrary old version).
- Adding the deps breaks compilation of an app (report the error).

## Maintenance notes

- **Deferred follow-up — Dialyzer**: add `{:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false}`
  later. The v2 modules already carry ~100 `@spec`s, so Dialyzer would pay off, but it
  needs a PLT cache (slow first build) and likely spec backfill in v1 modules — scope it
  as its own plan.
- Once green, wire `mix credo --strict` and `mix sobelow --exit` into the CI `unit` job
  (plan 001) and/or a `mix check` alias (plan 002 Maintenance note).
- A reviewer should check that no genuine security finding was silenced in `.sobelow-conf`
  without a recorded follow-up.
