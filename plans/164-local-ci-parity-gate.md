# Plan 164: One local command that mirrors CI, and stop `dist/` from lying

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- .github/workflows/flagship.yml AGENTS.md scripts clients/lattice-client/package.json clients/township-tauri-shell/package.json .gitignore
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 — no user-facing defect, but it is the single biggest source of wasted executor
  cycles in this repo, and it directly causes wrong local results.
- **Effort**: S
- **Risk**: LOW — additive tooling plus a build-hook change. Nothing in production changes.
- **Depends on**: `plans/161-close-verification-gaps.md` and
  `plans/166-shell-test-suite-honesty.md` (recommended — both add CI steps, and the parity checker
  must be written against the final `unit` job so it does not immediately fail on plan 166's
  `typecheck:test` and `mobile:tauri-readiness` additions)
- **Category**: dx
- **Planned at**: commit `764a1945`, 2026-07-29
- **Reconciled at**: commit `91bb6ca6`, 2026-07-29

## Why this matters

This repo is worked by agents executing self-contained plans. Two things make that go wrong in ways
the agent cannot detect:

**A. `mix verify` covers 3 of the ~36 steps CI runs.** The `unit` job runs the Elixir suite, then
vector regeneration, then ~25 npm contract scripts, then two `cargo test` invocations, then Credo
and Sobelow. `mix.exs:19-22` defines `verify` as `format --check-formatted` + `test` and `check` as
`verify` + `credo --strict` — no TypeScript, no Rust, no vectors. `AGENTS.md:29-36` offers only those
commands, mentions `clients/` **zero times**, and there is no `AGENTS.md` under
`clients/township-tauri-shell/` — a directory that owns 13 CI steps. An agent changing anything under
`clients/**` follows the documented gate, sees green, ships, and CI fails on a step whose existence
it had no way to learn short of reading the workflow YAML. Each miss is a full CI round trip.

**B. Local shell contracts test stale compiled code.** `clients/lattice-client` publishes through
`exports["."].import → ./dist/src/index.js`, and `dist/` is **tracked in git** (58 files). The shell
resolves the client through that map via a `file:` dependency. Only three shell scripts rebuild the
client first (`prebuild`, `pregovernance:native:contract`, `prefeed:contract`); the other nine
CI-gated contract scripts do not. So: edit `clients/lattice-client/src/*.ts`, run
`npm --prefix clients/township-tauri-shell run action:contract` to check your work, and get a **green
result computed against the last-committed `dist/`, not your edit**. CI, which rebuilds at
`flagship.yml:140-142`, then fails. This is the wrong-result failure mode, not merely a slow one.

There is also no drift guard: `grep -c 'git diff\|exit-code' .github/workflows/flagship.yml` returns
`0`, so nothing ever checks that the committed `dist/` and the 37 committed vector files match their
sources. The precedent is on record — `9108a618` landed a client `src/` change without the dist
refresh, and `d0d71449` ("build(client): refresh generated consent artifacts") fixed it the next day.

After this plan: one command runs what CI runs; a machine check fails when the workflow and that
command drift apart; and the compiled client is either always fresh or never trusted stale.

## Current state

### The `unit` job's step sequence

From `.github/workflows/flagship.yml`, the `unit` job, in order (setup/checkout/cache steps omitted):

| # | What | Working directory |
|---|---|---|
| 1 | `mix deps.get` | repo root |
| 2 | `mix format --check-formatted` | repo root |
| 3 | `mix test` | repo root |
| 4 | `MIX_ENV=test mix lattice.export_vectors --out clients/lattice-client/test/vectors` | repo root |
| 5 | `npm ci` | `clients/lattice-client` |
| 6 | `npm run typecheck` | `clients/lattice-client` |
| 7 | `npm run conformance` | `clients/lattice-client` |
| 8 | `npm run v01:guard` | `clients/lattice-client` |
| 9 | `npm run canonical` | `clients/lattice-client` |
| 10 | `npm run township:authoring` | `clients/lattice-client` |
| 11 | `npm run tauri:bridge` | `clients/lattice-client` |
| 12 | `npm run carrier:feed` | `clients/lattice-client` |
| 13 | `npm run build` | `clients/lattice-client` |
| 14 | `npm ci` | `clients/township-tauri-shell` |
| 15 | `npm run typecheck` | `clients/township-tauri-shell` |
| 16 | `npm run runtime:wiring:contract` | `clients/township-tauri-shell` |
| 17 | `npm run governance:native:contract` | `clients/township-tauri-shell` |
| 18 | `npm run native:contract` | `clients/township-tauri-shell` |
| 19 | `npm run intent-ui:contract` | `clients/township-tauri-shell` |
| 20 | `npm run action-handoff-support:contract` | `clients/township-tauri-shell` |
| 21 | `npm run action-intent:contract` | `clients/township-tauri-shell` |
| 22 | `npm run deeplink:dispatcher:contract` | `clients/township-tauri-shell` |
| 23 | `npm run action:contract` | `clients/township-tauri-shell` |
| 24 | `npm run grant:fixture:contract` | `clients/township-tauri-shell` |
| 25 | `npm run frontend:contract` | `clients/township-tauri-shell` |
| 26 | `npm run feed:app:contract` | `clients/township-tauri-shell` |
| 27 | `npm run feed:contract` | `clients/township-tauri-shell` |
| 28 | apt install Tauri Linux prerequisites | repo root (Linux only) |
| 29 | `cargo test` | `clients/township-tauri-shell/src-tauri` |
| 30 | `cargo test --features township-dev-trace --test dev_trace_commands` | `clients/township-tauri-shell/src-tauri` |
| 31 | `npm run carrier:township` | `clients/lattice-client` |
| 32 | `npm run carrier:relay` | `clients/lattice-client` |
| 33 | `npm run carrier:relay-sync` | `clients/lattice-client` |
| 34 | `npm run carrier:township:live` | `clients/lattice-client` |
| 35 | `mix credo --strict` | repo root |
| 36 | `cd apps/lattice_server && mix sobelow --exit` | repo root |

**Do not hardcode this table into the script.** Plan 161 adds steps to this job; more will follow.
Step 3 of this plan builds a checker that derives the list from the workflow, so the script and the
job cannot drift silently.

Note the ordering constraint documented at `flagship.yml:118-125`: step 4 must run in `MIX_ENV=test`
and depends on step 3 having just forced a `:test`-env recompile in the same session. A
cache-restored `_build/dev` can carry `.beam` mtimes newer than freshly checked-out sources, so
Mix's staleness check skips the recompile and the exporter silently runs stale code — observed in CI
regenerating a 9-scenario vector set instead of the current 19.

### The `dist/` resolution chain

- `clients/lattice-client/package.json` — `"build": "tsc -p tsconfig.json"`, and
  `"exports": { ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" } }`,
  with `"files": ["dist", "src"]`.
- `clients/township-tauri-shell/node_modules/@treetopdevs/lattice-client` is a symlink to
  `../../../lattice-client` (a `file:` dependency).
- Shell tests import the package name, e.g.
  `clients/township-tauri-shell/test/township_actions.ts:11` imports from `"@treetopdevs/lattice-client"`.
- Only three `pre*` hooks exist (`clients/township-tauri-shell/package.json:7`, `:18`, `:117`):

```json
    "prebuild": "npm --prefix ../lattice-client run build",
    "pregovernance:native:contract": "npm --prefix ../lattice-client run build",
    "prefeed:contract": "npm --prefix ../lattice-client run build",
```

- `git ls-files clients/lattice-client/dist` → 58 files (including 24 compiled *test* files under
  `dist/test/`, which ship inside the package's `files` list).
- `.gitignore:14` ignores `/clients/township-tauri-shell/dist/` — the sibling build output — with no
  entry or comment for `clients/lattice-client/dist/`. The two are treated oppositely and nothing
  explains why.
- `clients/lattice-client/test/vectors/` → 37 committed generated JSON files.

### Repo conventions to follow

- Shell scripts live in `scripts/` and are `#!/usr/bin/env bash` with `set -euo pipefail`. Read
  `scripts/lattice_verify_flagship.sh` as the exemplar for structure, environment-variable escape
  hatches (`LATTICE_SKIP_DEPS`, `LATTICE_SKIP_PLAYWRIGHT_INSTALL`), and output style.
- **Toolchain**: locally, mix must be invoked as `~/.asdf/shims/mix`; in CI plain `mix` works. Any
  script that runs both places must handle both — see
  `scripts/township_action_handoff_e2e.sh:6-9` for the existing (imperfect) pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 |
| Build client | `npm --prefix clients/lattice-client run build` | exit 0 |
| One shell contract | `npm --prefix clients/township-tauri-shell run action:contract` | exit 0 |
| Rust tests | `cd clients/township-tauri-shell/src-tauri && cargo test` | exit 0 |
| Shell script lint (if available) | `shellcheck scripts/verify_all.sh` | exit 0 |

## Scope

**In scope**:

- `scripts/verify_all.sh` (create)
- `scripts/check_ci_parity.mjs` (create — or wherever the repo's existing Node helper scripts live;
  check `scripts/` for the convention before choosing)
- `clients/township-tauri-shell/package.json` (add `pre*` hooks and one parity script)
- `.github/workflows/flagship.yml` (add exactly one step: the parity checker)
- `.gitignore` (one comment line explaining the `dist/` asymmetry — see step 5)
- `AGENTS.md` (the "Verify the repo is healthy" section)
- `clients/township-tauri-shell/AGENTS.md` (create)
- `plans/README.md` (status row)

**Out of scope**:

- **Any `.ex`, `.ts`, `.vue`, or `.rs` source file.** If running the new script surfaces a failure,
  that is a finding to report, not to fix here.
- **Any test file content.**
- **Untracking `clients/lattice-client/dist/`.** Step 5 explicitly chooses the `pre*`-hook route over
  gitignoring, because untracking breaks any consumer that assumes a prebuilt checkout. If you
  believe untracking is correct, report it as a recommendation — do not do it.
- **Restructuring the `unit` job into a matrix.** Real (it is ~36 serialized steps in a 20-minute
  box) but it interacts with the vector-regeneration ordering constraint and deserves its own plan.
- The `packaged_macos` and `verify` jobs — this plan mirrors `unit` only. Say so in the script's
  header comment so nobody mistakes it for full CI parity.
- `TOWNSHIP_BUILD_MAP.md`, `README.md`, `docs/acceptance_checklist.md` — all have real staleness
  problems, all deferred (see Maintenance notes).

## Git workflow

- Branch: `advisor/164-local-ci-parity-gate`
- Conventional commits, e.g. `build(dx): add scripts/verify_all.sh mirroring the CI unit job`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write `scripts/verify_all.sh`

Create an executable bash script that runs, in order, the same work the `unit` job does. Structure it
after `scripts/lattice_verify_flagship.sh`.

Requirements:

- `#!/usr/bin/env bash` and `set -euo pipefail`.
- A header comment stating plainly: **this mirrors the `unit` job of `.github/workflows/flagship.yml`
  only** — it does not run the `verify` (flagship evidence) or `packaged_macos` jobs.
- Resolve mix once at the top: use `$HOME/.asdf/shims/mix` when it exists and is executable,
  otherwise plain `mix`. Do **not** hardcode an OTP version into `PATH` — `scripts/township_action_handoff_e2e.sh:6-9`
  does that today and pins `28.3.1` while CI pins `28.1`; do not copy that mistake.
- Echo a clear banner before each stage (`=== [7/36] conformance ===`) so a failure is instantly
  attributable.
- Support `VERIFY_SKIP_NPM_CI=1` to skip the two `npm ci` invocations (they are slow and usually
  unnecessary locally) and `VERIFY_SKIP_CARGO=1` to skip the two `cargo test` runs (they need a Rust
  toolchain and, on Linux, the webkit2gtk system packages the workflow apt-installs at
  `flagship.yml`'s "Install Tauri Linux prerequisites" step).
- Preserve the `MIX_ENV=test` requirement on the vector-regeneration step, with a comment pointing
  at `flagship.yml:118-125` for why.
- Exit non-zero on the first failure (that is what `set -e` gives you), and print a final
  `verify_all: OK` line on success.

**Verify**:

```sh
chmod +x scripts/verify_all.sh
VERIFY_SKIP_NPM_CI=1 VERIFY_SKIP_CARGO=1 bash scripts/verify_all.sh
```

→ exit 0. If a stage fails, record which one and whether it is a pre-existing failure (check by
running that same stage's command directly on a clean checkout) — a pre-existing failure is a STOP
condition, not something to skip past.

### Step 2: Add the missing `pre*` rebuild hooks

Nine CI-gated shell scripts resolve `@treetopdevs/lattice-client` through its compiled `dist/` but do
not rebuild it first. Add a `pre<name>` hook for each, matching the existing pattern at
`clients/township-tauri-shell/package.json:117`:

```json
    "prefeed:contract": "npm --prefix ../lattice-client run build",
```

Add hooks for: `action:contract`, `action-intent:contract`, `native:contract`,
`action-handoff-support:contract`, `grant:fixture:contract`, `deeplink:dispatcher:contract`,
`runtime:wiring:contract`, `intent-ui:contract`, `frontend:contract`.

Before adding each one, confirm the script actually resolves the client package:

```sh
for s in township_actions township_action_intent native_workflow packaged_action_handoff_support township_grant_handoff_fixture township_deep_link_dispatcher; do
  echo "=== $s ==="
  grep -l '@treetopdevs/lattice-client' clients/township-tauri-shell/test/${s}.ts 2>/dev/null || echo "(no direct import)"
done
```

A script with no transitive dependency on the client does not need a hook — skip it and say so.
(`runtime:wiring:contract`, `intent-ui:contract`, and `frontend:contract` may fall in this category;
check rather than assume.)

**Verify**: prove the hook actually prevents stale results. Introduce a temporary observable change
in the client source — e.g. add an exported constant in `clients/lattice-client/src/index.ts` — then:

```sh
node -e "import('./clients/lattice-client/dist/src/index.js').then(m=>console.log('STALE' in m ? 'fresh' : 'stale'))"
npm --prefix clients/township-tauri-shell run action:contract >/dev/null 2>&1
node -e "import('./clients/lattice-client/dist/src/index.js').then(m=>console.log('STALE' in m ? 'fresh' : 'stale'))"
```

→ `stale` before, `fresh` after. Then revert the temporary source change and rebuild:

```sh
git checkout clients/lattice-client/src/index.ts
npm --prefix clients/lattice-client run build
git status --porcelain clients/lattice-client/dist
```

→ no output (dist back to its committed state).

### Step 3: Write the CI-parity checker

Create a small Node script (`scripts/check_ci_parity.mjs`, or match whatever convention `scripts/`
already uses for `.mjs` helpers) that:

1. Reads `.github/workflows/flagship.yml` as text.
2. Extracts, from the **`unit` job only**, every `run:` command that is an `npm run <script>`, a
   `cargo test …`, or a `mix …` invocation.
3. Reads `scripts/verify_all.sh` as text.
4. Fails with a non-zero exit and a readable diff listing any extracted command that does not appear
   in the script.

Keep it deliberately dumb — string extraction over the YAML text, no YAML parser dependency, since
the repo has no YAML library in any Node manifest. Scope the extraction to the `unit` job by
splitting on the top-level job keys (`  verify:`, `  unit:`, `  packaged_macos:`).

Register it as an npm script at the repo root `package.json`:

```json
    "ci:parity": "node scripts/check_ci_parity.mjs",
```

**Verify**:

```sh
node scripts/check_ci_parity.mjs
```

→ exit 0, prints something like `ci parity: 36/36 unit-job commands covered by scripts/verify_all.sh`.

Then prove it bites:

```sh
# temporarily add a fake step to the unit job, then:
node scripts/check_ci_parity.mjs
```

→ exit non-zero, naming the uncovered command. Remove the fake step and re-verify exit 0.

### Step 4: Wire the parity checker into CI

Add exactly one step to the `unit` job in `.github/workflows/flagship.yml`, placed **first** among
the run-steps (right after `mix deps.get`) so a drifted local gate fails fast and cheap:

```yaml
      - name: Local gate parity (scripts/verify_all.sh mirrors this job)
        run: node scripts/check_ci_parity.mjs
```

This makes the invariant self-enforcing: anyone adding a CI step is forced to add it to the local
script in the same commit.

**Verify**:

```sh
grep -c 'check_ci_parity' .github/workflows/flagship.yml
```

→ `1`.

### Step 5: Document the `dist/` decision

`clients/lattice-client/dist/` stays tracked (the `file:` consumers and any future package consumer
assume a prebuilt checkout). The `pre*` hooks from step 2 remove the stale-result hazard. What is
missing is an explanation, so the next person does not "fix" the asymmetry by untracking it.

Add a comment in `.gitignore` next to the existing shell entry at line 14:

```
# clients/lattice-client/dist/ is deliberately TRACKED (unlike the shell's dist/):
# the package publishes through exports["."] -> dist/src/index.js and the Tauri shell
# consumes it as a file: dependency, so a fresh checkout must be usable without a build.
# Shell contract scripts carry pre* hooks that rebuild it; CI rebuilds it before use.
/clients/township-tauri-shell/dist/
```

**Verify**:

```sh
grep -n 'deliberately TRACKED' .gitignore
```

→ one hit.

### Step 6: Add a generated-artifact drift guard to CI

Nothing currently checks that the committed `dist/` and the 37 committed vector files match their
sources. Add one step to the `unit` job, placed immediately after the existing
`- name: Build TS client for shell feed gate` step (which runs `npm run build` in
`clients/lattice-client`):

```yaml
      - name: Generated artifacts are in sync with sources
        run: git diff --exit-code -- clients/lattice-client/dist clients/lattice-client/test/vectors
```

By that point in the job the vectors have been regenerated and the client rebuilt, so any diff means
a contributor forgot to commit generated output.

**Verify** locally that it is currently clean:

```sh
~/.asdf/shims/mix test
MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors
npm --prefix clients/lattice-client run build
git diff --exit-code -- clients/lattice-client/dist clients/lattice-client/test/vectors
```

→ exit 0 and no output.

**If this is NOT clean on a fresh checkout, STOP and report.** It means committed generated output is
already out of sync with source, which is a finding in its own right and must be resolved (by
committing the regenerated output as a separate, clearly-labelled commit) before the guard can land.

### Step 7: Document the local gate

**In `AGENTS.md`**, extend the "Verify the repo is healthy" section (`AGENTS.md:29-36`). Keep the
existing commands and add the new one with an honest scope statement:

```sh
scripts/verify_all.sh                             # everything the CI `unit` job runs
VERIFY_SKIP_NPM_CI=1 VERIFY_SKIP_CARGO=1 scripts/verify_all.sh   # faster inner loop
```

State plainly that `mix verify` / `mix check` cover the Elixir side only, and that anything touching
`clients/**` must run `scripts/verify_all.sh` before it can be considered done. Update the
"Conventions" section (`AGENTS.md:96-102`) to say the same.

**Create `clients/township-tauri-shell/AGENTS.md`**, short and factual. It should cover:

- what this package is (the Tauri/Vue Township shell, with Rust native custody in `src-tauri/`)
- that it consumes `@treetopdevs/lattice-client` as a `file:` dependency through the client's
  compiled `dist/`, so the client must be built first (and that `pre*` hooks now do this)
- the list of contract scripts CI gates on, with one line each on what they cover
- the packaged smokes and the fact they need a built `.app`
- a pointer back to the root `AGENTS.md` for the toolchain rule

Model the tone on `clients/lattice-client/CLAUDE.md`, which already exists — read it first and match
its level of detail.

**Verify**:

```sh
grep -c 'verify_all' AGENTS.md
test -f clients/township-tauri-shell/AGENTS.md && echo present
```

→ at least `2` and `present`.

## Test plan

This plan adds tooling, not product tests. Its verification is behavioral:

- **Parity checker bites** — step 3's fake-step check must fail, then pass after removal.
- **`pre*` hook prevents staleness** — step 2's stale/fresh observation must flip.
- **Drift guard is clean** — step 6's `git diff --exit-code` exits 0 on a regenerated tree.
- **The script actually runs everything** — `bash scripts/verify_all.sh` exits 0 on a clean checkout.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `scripts/verify_all.sh` exists, is executable, and exits 0 on a clean checkout
- [ ] `node scripts/check_ci_parity.mjs` exits 0
- [ ] Adding a fake `npm run` step to the `unit` job makes the parity checker exit non-zero (demonstrated and reverted)
- [ ] `grep -c 'check_ci_parity' .github/workflows/flagship.yml` → `1`
- [ ] `git diff --exit-code -- clients/lattice-client/dist clients/lattice-client/test/vectors` exits 0 after a full regenerate + build
- [ ] Every shell contract script that imports `@treetopdevs/lattice-client` has a `pre*` rebuild hook (list them in your report, including any you determined did not need one and why)
- [ ] `grep -n 'deliberately TRACKED' .gitignore` returns one hit
- [ ] `clients/township-tauri-shell/AGENTS.md` exists
- [ ] `grep -c 'verify_all' AGENTS.md` ≥ 2
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 164 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Any stage of `scripts/verify_all.sh` fails on a clean checkout.** That is a pre-existing broken
  gate — a real finding. Report which stage and its output; do not add a skip flag to route around it.
- **Step 6's drift guard is not clean on a fresh checkout** — committed generated output is already
  stale. Report the diff; the fix is a separate labelled commit, and the operator should see it.
- **The parity checker cannot reliably scope to the `unit` job** because the workflow's structure
  makes text-splitting unsafe. Report it rather than shipping a checker that silently checks the
  wrong job — a checker that always passes is worse than none.
- **A `pre*` hook makes a previously-green contract script fail.** That means the script was passing
  against stale compiled code and the fresh build breaks it — a genuine finding, and exactly what
  this plan exists to surface. Report it; do not fix the source.
- You conclude that untracking `clients/lattice-client/dist/` is the correct fix. It may well be —
  but it changes the contract for every consumer, so it is the operator's call. Report the
  recommendation and finish the rest of the plan.

## Maintenance notes

- **Reviewer focus**: whether `scripts/verify_all.sh` resolves mix the same way both locally and in
  CI without hardcoding a patch version. The existing
  `scripts/township_action_handoff_e2e.sh:6-9` pins `erlang/28.3.1` while CI pins `28.1`; the local
  branch is simply never taken in CI, so the divergence is invisible until a local and a hosted run
  disagree — and that script's whole job is producing convergence evidence. Do not reproduce that
  pattern; a repo-root `.tool-versions` matching CI would be the durable fix (deferred here).
- **The parity checker is the durable part.** The script list will go stale the moment someone adds
  a CI step; the checker is what stops that from being silent. Keep it in CI, and keep it first in
  the job so it fails cheaply.
- **Deferred out of this plan, all real**: a repo-root `.tool-versions` matching CI's OTP 28.1 /
  Elixir 1.19.5 and removing the hardcoded PATH branch from `scripts/township_action_handoff_e2e.sh`;
  normalizing `apps/township_bench/mix.exs:23`'s `elixir: "~> 1.18"` to `~> 1.19` like the other nine
  apps; splitting the ~36-step `unit` job into a matrix (blocked on the vector-regeneration ordering
  constraint); adding `deps`/`_build` caching to the `verify` and `packaged_macos` jobs, which both
  cold-compile the umbrella today — the latter on `macos-15-intel`, billed at 10× Linux; correcting
  `README.md:281-289`'s Dependencies section, which claims the core app is "plain OTP" and omits
  Phoenix, LiveView, Rustler, Vue, Tauri, and two GitHub git deps; and repointing
  `TOWNSHIP_BUILD_MAP.md:14`'s grounding rule, which instructs agents to verify against branch
  `claude/beautiful-gould-6b25d2` (does not exist on `origin`) and lists 8 of 9 "paste target" files
  that are absent from the repo.
