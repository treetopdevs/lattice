# Plan 002: Add a `mix verify` one-command health gate

> **Executor instructions**: Follow step by step; run each verification and confirm
> before moving on. Honor STOP conditions. Update this plan's row in `plans/README.md`
> when done.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- mix.exs`
> If `mix.exs` changed since this plan was written, compare the "Current state" excerpt
> to the live file before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (complements 001)
- **Category**: dx
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

There is no single command that tells a developer (or an agent) "is the repo healthy?".
The CI parity steps are `mix format --check-formatted` then `mix test`, but a contributor
must know to run both in order. A `mix verify` alias makes the health gate one command,
documents the intended pre-push check, and gives plan 001's CI job a named local
equivalent.

## Current state

- Root `mix.exs` is the umbrella project file and has **no `aliases`**:
  ```elixir
  defmodule Lattice.MixProject do
    use Mix.Project

    def project do
      [
        apps_path: "apps",
        version: "0.1.0",
        start_permanent: Mix.env() == :prod,
        deps: deps()
      ]
    end

    defp deps do
      []
    end
  end
  ```
- `.formatter.exs` at root drives `mix format` across `apps/*`.
- Run mix locally as `~/.asdf/shims/mix` (mise `mix` shim is broken; asdf provides the
  working OTP 28 toolchain).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Run the new alias | `~/.asdf/shims/mix verify` | runs format-check then full test; exits 0 |
| Format check | `~/.asdf/shims/mix format --check-formatted` | exit 0 |
| Full suite | `~/.asdf/shims/mix test` | all pass |

## Scope

**In scope**:
- `mix.exs` (root only)

**Out of scope**:
- `apps/*/mix.exs` — aliases belong at the umbrella root so `mix verify` runs across all
  apps; do not add per-app aliases.
- Adding new deps (credo/dialyzer) — that is plan 003. Keep this alias to
  format + test only so it has no new dependencies.

## Git workflow

- Branch: `advisor/002-mix-verify-alias`
- One commit, short imperative message (e.g. `Add mix verify alias (format + test)`).
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add an `aliases` entry and wire it into `project/0`

Edit root `mix.exs`:
- add `aliases: aliases()` to the keyword list returned by `project/0`;
- add a private `aliases/0`:
  ```elixir
  defp aliases do
    [
      verify: ["format --check-formatted", "test"]
    ]
  end
  ```

**Verify**: `~/.asdf/shims/mix help verify` prints the alias (an alias is listed), and
`grep -n "verify:" mix.exs` returns the new line.

### Step 2: Run the alias end-to-end

**Verify**: `~/.asdf/shims/mix verify` → runs the format check, then the full suite,
and exits 0 with `0 failures`. (If formatting is clean and tests pass, the alias passes.)

## Test plan

No unit tests. Verification is behavioral:
- `~/.asdf/shims/mix verify` exits 0.
- Intentionally introduce a formatting error in a scratch file under `/tmp` is NOT
  needed; instead confirm the alias chains correctly by observing both phases run in
  the output ("Checking formatted files" then the ExUnit run).

## Done criteria

ALL must hold:
- [ ] `mix.exs` `project/0` includes `aliases: aliases()`.
- [ ] `aliases/0` defines `verify: ["format --check-formatted", "test"]`.
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `git status` shows only `mix.exs` modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- `mix.exs` already defines `aliases` differently from the "Current state" excerpt
  (drifted) — reconcile rather than overwrite.
- `~/.asdf/shims/mix verify` fails because the suite is already red (report the failing
  tests; do not "fix" them here).

## Maintenance notes

- When plan 003 lands credo/sobelow, extend this alias (or add a `mix check` alias) to
  include them: `verify: ["format --check-formatted", "test"]`, `check: ["verify", "credo --strict", "sobelow --exit"]`.
- Document `mix verify` in the README "Run It" / Development section (plan 009 touches
  the README; coordinate so the command appears there).
