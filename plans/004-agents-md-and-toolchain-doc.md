# Plan 004: Add a repo-root agent guide and document the toolchain footgun

> **Executor instructions**: Follow step by step; confirm each verification. Honor STOP
> conditions. Update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- README.md .mise.toml`
> If these changed, reconcile against "Current state" first; on a real mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

These improvement plans are written to be executed by agents and new contributors who
have not seen this codebase. The single biggest cold-start footgun is the toolchain:
`mix` on `PATH` resolves to a **broken mise shim**, and the working toolchain is reached
only via `~/.asdf/shims/mix`. This is documented **only inside `.mise.toml`** — nowhere a
person or agent would look first. There is no `AGENTS.md`/`CLAUDE.md` at the repo root.
A concise agent guide that states the toolchain rule, the verification commands, and the
"safe vs. heavy" command map removes the most common way to get stuck.

## Current state

- No `AGENTS.md`, `CLAUDE.md`, or `.cursorrules` at the repo root (confirmed: `ls` finds
  none).
- `.mise.toml` (lines 1–27) documents the problem in detail: mise's global config pins
  erlang 27 and its `mix` shim leaks flags, so the file sets
  `disable_tools = ["erlang", "elixir"]` to fall through to asdf's working
  OTP 28 / Elixir 1.19.5. The fix exists but is undiscoverable.
- `README.md` "Run It" (lines 42–50) says `mix deps.get` / `mix test` with no mention of
  the asdf requirement or required versions.
- Verified working invocation: `~/.asdf/shims/mix` (asdf reads `~/.tool-versions`:
  erlang 28.3.1, elixir 1.19.5-otp-28).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm toolchain | `~/.asdf/shims/mix --version` | `Mix 1.19.5` / OTP 28 |
| Full suite | `~/.asdf/shims/mix test` | all pass (sanity that the doc's command works) |

## Scope

**In scope** (create/modify):
- `AGENTS.md` (create, repo root)
- `README.md` (add a short "Toolchain / Prerequisites" subsection only)

**Out of scope**:
- `.mise.toml` — leave it; it works. The doc references it; do not rewrite it.
- Do NOT create a duplicate `CLAUDE.md` — a single `AGENTS.md` at root is the
  convention; if you want tool-specific discoverability, make `CLAUDE.md` a one-line
  pointer to `AGENTS.md` (optional, not required).
- Do NOT change any build/test behavior.

## Git workflow

- Branch: `advisor/004-agents-md-toolchain`
- One commit, short imperative message (e.g. `Add AGENTS.md and document the asdf toolchain`).
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Create `AGENTS.md` at the repo root

Write a concise guide (target ~60–100 lines) with these sections. Keep statements
verifiable against the repo; do not invent commands.

- **Toolchain (read first)**: "Invoke mix/elixir as `~/.asdf/shims/mix` and
  `~/.asdf/shims/elixir`. `mix` on `PATH` is a broken mise shim (see `.mise.toml`).
  Required: Erlang/OTP 28, Elixir 1.19.5-otp-28 (asdf, from `~/.tool-versions`)." In
  CI (`erlef/setup-beam@v1`) plain `mix` works — this asdf rule is local only.
- **Verify the repo is healthy**: `~/.asdf/shims/mix test` (full suite); after plan 002
  lands, `~/.asdf/shims/mix verify`. Note the demo: `~/.asdf/shims/mix run scripts/lattice2_demo.exs`.
- **Layout**: one line each for `apps/lattice_core` (v1 capability plane + the Lattice
  2.0 replica-on-op-log engine), `apps/lattice_server` (Cowboy WebSocket boundary),
  `apps/lattice_demo`, `apps/lattice_stress`, `apps/lattice_carrier_spike`.
- **Where the docs are**: point to `docs/lattice2_design.md`, `docs/adr/`,
  `docs/threat_model_v2.md`, `docs/path_to_real.md`, `docs/lattice_poc_status.md`, and
  `plans/` (this advisor index).
- **Safe vs. heavy commands**: safe/read-only — `mix compile`, `mix test`, `mix format`,
  `mix run scripts/lattice2_demo.exs`. Heavy/external — `npm run *e2e` and
  `scripts/lattice_*_demo.sh` (need Node + Playwright + a port; the flagship one needs
  ffmpeg). `mix lattice.stress` is a load harness.
- **Conventions**: code is `mix format`-clean; v2 modules carry `@moduledoc`/`@spec`;
  tests in `apps/*/test/`, v2 tests under `apps/lattice_core/test/lattice2/`.

**Verify**: `test -f AGENTS.md` and the file contains the literal string
`~/.asdf/shims/mix`. `grep -c "asdf/shims/mix" AGENTS.md` ≥ 1.

### Step 2: Add a short Toolchain/Prerequisites subsection to the README

In `README.md`, add a brief subsection (just above or within "Run It", ~6–10 lines):
required Erlang/Elixir versions, the asdf invocation rule with a one-line "why" and a
pointer to `.mise.toml` and `AGENTS.md`. Keep the existing "Run It" commands; just note
that locally they run via `~/.asdf/shims/mix`.

**Verify**: `grep -n "asdf/shims/mix\|AGENTS.md" README.md` returns matches.

### Step 3: Sanity-check the documented command actually works

**Verify**: `~/.asdf/shims/mix --version` prints Mix 1.19.5 / OTP 28, and
`~/.asdf/shims/mix test` exits 0 — i.e. the command you told readers to run is correct.

## Test plan

Docs only; no unit tests. Verification is that the documented commands run as written
(Step 3) and the files contain the required pointers (Steps 1–2 greps).

## Done criteria

ALL must hold:
- [ ] `AGENTS.md` exists at repo root and documents the `~/.asdf/shims/mix` rule + the
      verify command + the app layout + the docs pointers.
- [ ] `README.md` has a Toolchain/Prerequisites note referencing the asdf rule and
      `AGENTS.md`.
- [ ] `~/.asdf/shims/mix test` exits 0 (the documented command is correct).
- [ ] `git status` shows only `AGENTS.md` (new) and `README.md` modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- A repo-root `AGENTS.md`/`CLAUDE.md` already exists with real content (reconcile, don't
  clobber).
- `~/.asdf/shims/mix` does not work in this environment (then the documented rule is
  wrong here — report the actual working invocation instead of writing a false one).

## Maintenance notes

- Plan 009 also edits the README (Lattice 2.0 section). If both run, keep the README
  edits non-overlapping (this plan: toolchain/prereqs; plan 009: the v2 overview).
- If the toolchain situation changes (mise fixed, or repo migrates fully to asdf or to
  Nix), update both `AGENTS.md` and the `.mise.toml` comment together.
