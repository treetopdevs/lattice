# Plan 001: CI gates the full unit/property suite (with dependency caching)

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If a "STOP conditions"
> item occurs, stop and report — do not improvise. When done, update this plan's row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- .github/workflows/flagship.yml scripts/lattice_verify_flagship.sh`
> If either file changed since this plan was written, compare the "Current state"
> excerpts to the live files before proceeding; on a mismatch, treat it as a STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

The repository's only CI workflow (`flagship.yml`) runs just three flagship test
files plus a format check. The main suite — ~142 ExUnit tests and ~10 StreamData
properties across all apps, including the entire Lattice 2.0 engine
(`apps/lattice_core/test/lattice2/`) and the adversarial `lattice_stress` suite — is
**never run in CI**. It can therefore break on `main` without anyone noticing until a
human runs `mix test` locally. This is the verification-baseline gap that every other
risky change depends on. Adding a unit-test CI job (with dependency caching to keep it
fast) closes it.

## Current state

- `.github/workflows/flagship.yml` — the single workflow. Its one job (`verify`) runs
  `scripts/lattice_verify_flagship.sh` (line 52) and caches **npm only** (line 34); no
  Elixir `deps`/`_build` cache.
- `scripts/lattice_verify_flagship.sh:20-22` — the only `mix` test invocation in CI:
  ```sh
  mix format --check-formatted
  mix test apps/lattice_core/test/lattice_flagship_test.exs apps/lattice_server/test/flagship_http_test.exs apps/lattice_server/test/federated_workers_http_test.exs
  mix compile
  ```
  Three files only.
- The full suite passes locally today (`~142 tests, ~10 properties, 0 failures`).
- **Toolchain note (critical)**: locally, `mix` must be invoked as `~/.asdf/shims/mix`
  because the repo's `.mise.toml` disables mise's erlang/elixir and the mise `mix`
  shim is broken. **In GitHub Actions this does NOT apply** — `erlef/setup-beam@v1`
  puts a working `mix` on `PATH`, so the workflow uses plain `mix` (see existing
  `run: mix deps.get` at line 37). Do not change the workflow to use asdf paths.

## Commands you will need

| Purpose | Command (local) | Expected |
|---------|-----------------|----------|
| Format check | `~/.asdf/shims/mix format --check-formatted` | exit 0 |
| Full suite | `~/.asdf/shims/mix test` (from repo root) | all pass, 0 failures |
| YAML sanity | `~/.asdf/shims/mix run -e ':ok' ` (no YAML linter in repo) | n/a — review by eye |

(There is no YAML linter in this repo; validate the workflow by reading it and, if you
have `gh`, optionally `gh workflow view`.)

## Scope

**In scope** (only files you may modify):
- `.github/workflows/flagship.yml`

**Out of scope** (do NOT touch):
- `scripts/lattice_verify_flagship.sh` — it is intentionally flagship-scoped; leave the
  flagship job using it unchanged.
- Any application source or test file. This plan changes CI only.

## Git workflow

- Branch: `advisor/001-ci-gate-full-test-suite`
- One commit; message style matches repo (short imperative, e.g.
  `Run full unit/property suite in CI with dep caching`).
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add a `unit` job that runs the whole suite with caching

Edit `.github/workflows/flagship.yml`. Under `jobs:`, add a second job alongside
`verify` (do not modify `verify`). The job must:

1. checkout (`actions/checkout@v4`);
2. set up BEAM with the **same pinned versions** as `verify` (`otp-version: "28.0"`,
   `elixir-version: "1.19.5"`);
3. restore an Elixir cache for `deps` and `_build` keyed on the lockfile;
4. `mix deps.get`;
5. `mix format --check-formatted`;
6. `mix test` (no file args → full umbrella suite).

Target shape (place after the `verify` job, same indentation level):

```yaml
  unit:
    name: Unit + property suite
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - name: Set up BEAM
        uses: erlef/setup-beam@v1
        with:
          otp-version: "28.0"
          elixir-version: "1.19.5"
      - name: Cache deps and _build
        uses: actions/cache@v4
        with:
          path: |
            deps
            _build
          key: ${{ runner.os }}-mix-${{ hashFiles('mix.lock') }}
          restore-keys: ${{ runner.os }}-mix-
      - name: Install dependencies
        run: mix deps.get
      - name: Check formatting
        run: mix format --check-formatted
      - name: Run full test suite
        run: mix test
```

Note: the workflow's top-level `on.push`/`on.pull_request` already use
`paths-ignore: ['docs/**', '**/*.md']`. That is fine — keep it; doc-only changes need
neither job.

**Verify**: Re-read the file. Confirm: (a) `verify` job is byte-for-byte unchanged
except indentation context; (b) the new `unit` job exists with the cache step and a
bare `mix test`. `grep -n "mix test$" .github/workflows/flagship.yml` → matches the new
`run: mix test` line.

### Step 2: Confirm the suite the job will run is green locally

From the repo root:

**Verify**: `~/.asdf/shims/mix format --check-formatted` → exit 0, then
`~/.asdf/shims/mix test` → ends with `0 failures` (browser_e2e/load tagged tests are
excluded by default; that is expected and matches what CI will do).

## Test plan

No application tests change. The "test" here is the workflow itself:
- Locally reproduce exactly what the job does: `mix deps.get` (already done),
  `mix format --check-formatted`, `mix test`. All must pass.
- If `gh` is available and the operator allows it, `gh workflow view "Flagship evidence"`
  should list both jobs after the change is pushed — but DO NOT push unless instructed.

## Done criteria

ALL must hold:
- [ ] `.github/workflows/flagship.yml` defines two jobs: `verify` (unchanged) and a new
      `unit` job.
- [ ] The `unit` job runs a bare `mix test` (full suite) and `mix format --check-formatted`.
- [ ] The `unit` job has an `actions/cache@v4` step for `deps` + `_build` keyed on
      `hashFiles('mix.lock')`.
- [ ] `~/.asdf/shims/mix test` exits 0 locally (the job will pass).
- [ ] `git status` shows only `.github/workflows/flagship.yml` modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:
- `flagship.yml` no longer matches the "Current state" excerpt (drifted).
- `~/.asdf/shims/mix test` fails locally before your change — the suite is already red;
  report which tests fail rather than adding a job that will be red on day one.
- Adding the job appears to require changing `scripts/lattice_verify_flagship.sh` or any
  app file.

## Maintenance notes

- If a new app or a heavy test tag is added later, decide whether the `unit` job should
  exclude it (mirror local `mix test` default excludes: `browser_e2e`, `load`).
- The cache key is the lockfile hash; if builds start picking up stale artifacts after
  an OTP/Elixir bump, bust the cache by changing the `key` prefix.
- A reviewer should confirm the `verify` (flagship) job was not weakened and that the
  new job's BEAM versions match it.
