# Plan 183: Product-scoped CI jobs, a required fan-in job, a vector drift guard, and retire `lattice_carrier_spike`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c57c826ad..HEAD -- .github/workflows/flagship.yml apps/lattice_carrier_spike scripts/lattice_browser_carrier_spike.sh package.json AGENTS.md mix.lock clients/township-tauri-shell/test/runtime_wiring_contract.mjs clients/township-tauri-shell/test/mobile_core_native_ci_contract.mjs clients/township-tauri-shell/test/android_pilot_signing_contract.mjs clients/township-tauri-shell/test/frontend_shell.mjs clients/treehouse-tauri-shell/test/enrollment_ci_contract.mjs apps/lattice_core/test/township/export_vectors_test.exs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (CI wiring; a fail-closed classifier; one app deletion with no runtime consumer)
- **Depends on**: plans/182-evidence-tier-policy.md (rule 10 names the fence)
- **Category**: dx
- **Planned at**: commit `c57c826ad`, 2026-10-08

## Why this matters

Every PR runs every product's CI. The Township shell (deprioritized to R34) runs its packaged macOS
smokes, 25 TypeScript contract steps and four Android pilot jobs on Treehouse PRs; the v1 demonstrator
(`apps/lattice_server`, `lattice_demo`, `lattice_stress`, `lattice_web_socket`, flagship modules; zero
commits since 2026-08-01) runs a Playwright-plus-ffmpeg job on every push; `apps/lattice_carrier_spike`
(the plan-010 predecessor whose keep-or-delete decision was deferred in Rounds 1, 2, 4 and 5c) still
compiles, tests and pins two git dependencies. Branch `main` has no branch protection (verified
2026-10-08: the GitHub API returns "Branch not protected"), so "required checks" are a convention.
Separately, the `unit` job regenerates the 91 committed oracle vectors and tests against the fresh
copies without ever checking that the committed files match, so a stale committed corpus passes CI.

After this plan: a `changes` job classifies the diff, product-only jobs and step groups skip when
their product is untouched, one `required` job fans the results in for branch protection, the
committed vectors must equal regenerated ones, and the carrier spike is gone.

## Current state

- `.github/workflows/flagship.yml` (1,095 lines). Triggers at lines 3–28: `push` to `main` and
  `pull_request`, both with `paths` ignoring `docs/**` and `**/*.md`; `workflow_dispatch` with input
  `require_android_pilot`. Jobs (name, runner, timeout, header line):

  | job | runner | timeout | line | product |
  |---|---|---|---|---|
  | `verify` "Verify flagship artifact" | ubuntu-latest | 25 | 35 | v1 legacy |
  | `unit` "Unit + property suite" | ubuntu-latest | 25 | 95 | core, with a Township step group |
  | `packaged_macos` "Packaged macOS convergence" | macos-15-intel | 90 | 361 | Township smokes (steps 420–474) plus Treehouse ordinary preview (steps 476–496) |
  | `treehouse_packaged_macos_enrollment` | macos-15-intel | 90 | 504 | Treehouse |
  | `carrier_release` | ubuntu-latest | 30 | 587 | core |
  | `treehouse_android_preview` | ubuntu-latest | 60 | 613 | Treehouse |
  | `android_pilot_contract` | ubuntu-latest | 15 | 704 | Township (`working-directory: clients/township-tauri-shell`) |
  | `android_pilot_verify` | ubuntu-latest | 90 | 731 | Township (`needs: android_pilot_contract`) |
  | `android_pilot` | ubuntu-latest | 90 | 867 | Township, `if: github.ref == 'refs/heads/main' && (push || dispatch)` |
  | `android_pilot_required` | ubuntu-latest | 2 | 1072 | fan-in for `android_pilot` only |

- `unit` job step groups (step names with their `- name:` line numbers): core setup 103–138;
  TS client 141–144; Treehouse offline preview 147–153 (these run **before** `mix test` because the
  reciprocal suite executes the real client and shell, so they are core prerequisites, not Treehouse-only);
  `Run full test suite` 156; vector regeneration 158–171 (excerpt below); TS client checks 173–215;
  mobile core 218–221; **Township shell group 224–299** (`Install Tauri shell dependencies` through
  `TS Township revocation fixture contract`, all `working-directory: clients/township-tauri-shell`);
  Tauri Linux prerequisites 302; `Tauri native command core` 315 (Township `src-tauri`); mobile core
  native 318; Treehouse native 323–326; `TS Township witness fixture preflight` 330 and
  `Tauri development trace contract` 333 (Township); carrier checks 336–345; Treehouse enrollment gate
  348; Credo 354; Sobelow 356–358.
- Vector regeneration excerpt, `flagship.yml:158-171`:

  ```yaml
        - name: Regenerate TS oracle vectors
          run: |
            MIX_ENV=test mix lattice.export_vectors --out clients/lattice-client/test/vectors
            MIX_ENV=test mix run -e 'Lattice.ContinuationVectors.write("clients/lattice-client/test/vectors")'
            MIX_ENV=test mix run -e 'Treehouse.EnrollmentVectors.write("clients/lattice-client/test/vectors")'
        - name: Regenerate and verify TS-authored continuation operations
          run: |
            npm --prefix clients/lattice-client run continuation:vectors
            MIX_ENV=test mix test apps/lattice_core/test/treehouse/bounded_continuation_reciprocal_test.exs
  ```
  No `git diff --exit-code` follows.
- Fan-in pattern to copy, `flagship.yml:1072-1095`: `android_pilot_required` uses
  `if: always() && (...)`, `needs: android_pilot`, and a shell step that reads
  `${{ needs.android_pilot.result }}` and exits non-zero on failure.
- All actions are pinned by commit SHA with a version comment (for example
  `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4`). Add no new third-party action.
- Six tests parse `flagship.yml` textually and must be re-run after any edit:
  `clients/township-tauri-shell/test/runtime_wiring_contract.mjs`,
  `.../mobile_core_native_ci_contract.mjs`, `.../android_pilot_signing_contract.mjs`,
  `.../frontend_shell.mjs`, `clients/treehouse-tauri-shell/test/enrollment_ci_contract.mjs`
  (structural job/step parser with mutation fixtures and a committed digest; read its header for how a
  digest is refreshed), and `apps/lattice_core/test/township/export_vectors_test.exs`.
- `apps/lattice_carrier_spike`: 12 files (lib: `lattice_carrier_spike.ex`, `browser_gateway.ex`,
  `echo_target.ex`, `filter.ex`, `message.ex`, `runtime.ex`, two mix tasks; one test file). Its
  `mix.exs` declares `{:tcp_filter_dist, git: ..., ref: "d6b9b27c…", override: true}` and
  `{:web_socket_dist, git: ..., ref: "a1223178…"}`. `mix.lock` carries `tcp_filter_dist`,
  `web_socket_dist`, `mint`, `mint_web_socket` only for it (no other app references `Mint`,
  `Bandit`'s websock adapter or those git deps; `bandit`/`websock_adapter` are Phoenix's and stay).
  References outside the app: `scripts/lattice_browser_carrier_spike.sh` (runs its tests and
  `mix lattice.browser_carrier.proof`), root `package.json:10` script `browser:carrier:proof`,
  `AGENTS.md:76` layout row, and historical mentions in `docs/` and `plans/` (leave those).
  `config/*.exs` has no reference. No workflow runs the script.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| YAML parses | `ruby -ryaml -e 'YAML.load_file(ARGV[0]); puts "ok"' .github/workflows/flagship.yml` | `ok` |
| Workflow contract tests (Township) | `cd clients/township-tauri-shell && npm ci && node test/runtime_wiring_contract.mjs && node test/mobile_core_native_ci_contract.mjs && node test/android_pilot_signing_contract.mjs && node test/frontend_shell.mjs` | all pass |
| Workflow contract test (Treehouse) | `cd clients/treehouse-tauri-shell && npm ci && node test/enrollment_ci_contract.mjs` | pass |
| Exporter contract | `~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs` | 0 failures |
| Umbrella compiles without the spike | `~/.asdf/shims/mix deps.get && ~/.asdf/shims/mix compile --warnings-as-errors` | exit 0 |
| Full gate | `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix check` | 0 failures, Credo clean |
| Vector drift (local) | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && MIX_ENV=test ~/.asdf/shims/mix run -e 'Lattice.ContinuationVectors.write("clients/lattice-client/test/vectors")' && MIX_ENV=test ~/.asdf/shims/mix run -e 'Treehouse.EnrollmentVectors.write("clients/lattice-client/test/vectors")' && git diff --exit-code -- clients/lattice-client/test/vectors` | exit 0 |

Fresh-checkout prerequisite (from `AGENTS.md`): `npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci`.

## Scope

**In scope**:
- `.github/workflows/flagship.yml`
- `apps/lattice_carrier_spike/` (delete), `scripts/lattice_browser_carrier_spike.sh` (delete),
  `package.json` (remove one script), `AGENTS.md` (remove one table row), `mix.lock` (pruned by Mix)
- The six workflow-parsing tests, only to refresh a committed digest or a job/step inventory that
  this plan intentionally changes
- `plans/README.md` status row 183

**Out of scope** (do NOT touch):
- `.github/workflows/popcorn-spike.yml` (already path-scoped)
- Any smoke script under `clients/township-tauri-shell/test/` except as step 8 names
- `clients/township-tauri-shell/src/App.vue` and its probe modules (lazy-loading them was considered
  for this plan and deferred behind plan 187, because `test/frontend_shell.mjs` pins `App.vue` source text)
- Physically moving v1 code (plan 189)
- Branch protection settings (operator action; see Maintenance notes)

## Git workflow

- Branch: `advisor/183-product-scoped-ci` from `origin/main` after plan 182 merged.
- Commit per step; style like `ci(flagship): classify changed paths and gate product jobs`,
  `chore(umbrella): retire apps/lattice_carrier_spike`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline

Run the six workflow-parsing tests and the full gate from the commands table before changing anything.
Record the results. Also run the local vector drift command: if `git diff --exit-code` fails here, the
committed corpus is already stale on `main`; inspect the diff. If it is regeneration noise (identical
semantics, e.g. ordering) commit it as its own first commit; if any `authorityQuarantine`, state or
op id changes, STOP (see STOP conditions).

**Verify**: all baseline commands pass; vector diff is empty or committed as a separate commit.

### Step 2: Add the `changes` job

Insert this job as the first entry under `jobs:` (before `verify`). It uses no third-party action.

```yaml
  changes:
    name: Classify changed paths
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
    outputs:
      core: ${{ steps.classify.outputs.core }}
      township: ${{ steps.classify.outputs.township }}
      treehouse: ${{ steps.classify.outputs.treehouse }}
      legacy: ${{ steps.classify.outputs.legacy }}
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: Classify
        id: classify
        env:
          EVENT: ${{ github.event_name }}
          BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
          HEAD: ${{ github.sha }}
        run: |
          set -euo pipefail
          core=false; township=false; treehouse=false; legacy=false
          if [ "$EVENT" = "workflow_dispatch" ] || [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
            core=true; township=true; treehouse=true; legacy=true
          else
            while IFS= read -r path; do
              case "$path" in
                clients/township-tauri-shell/*|apps/township_web/*|apps/township_bench/*|scripts/township_*|scripts/android-pilot/*|playwright.township*.config.mjs) township=true ;;
                clients/treehouse-tauri-shell/*|tools/android-witness-validator/*|scripts/treehouse_*) treehouse=true ;;
                apps/lattice_server/*|apps/lattice_demo/*|apps/lattice_stress/*|scripts/lattice_*|playwright.config.mjs|tests/*) legacy=true ;;
                *) core=true ;;
              esac
            done < <(git diff --name-only "$BASE" "$HEAD")
          fi
          # Any path outside the product-only prefixes runs everything (fail closed).
          if [ "$core" = true ]; then township=true; treehouse=true; legacy=true; fi
          for k in core township treehouse legacy; do echo "$k=${!k}" >> "$GITHUB_OUTPUT"; done
          echo "core=$core township=$township treehouse=$treehouse legacy=$legacy"
```

Rules of the classifier, which the plan fixes: `apps/lattice_core/**`, `apps/lattice_carrier_server/**`,
`clients/lattice-client/**`, `clients/lattice-mobile-core/**`, `apps/lattice_web_socket/**`,
`apps/lattice_node_spike/**`, `config/**`, `mix.*`, `.github/**` and anything unlisted are **core** and
run everything. `apps/lattice_core` contains v1 modules too; refining that split is plan 189's job.

**Verify**: YAML parses (`ruby` command).

### Step 3: Move the Treehouse ordinary-preview steps out of `packaged_macos`

Create a new job `treehouse_packaged_macos` ("Packaged macOS Treehouse preview", `macos-15-intel`,
`timeout-minutes: 60`) directly after `packaged_macos`. Copy into it, verbatim and in order, the
setup steps of `packaged_macos` that the moved steps need (Checkout, Set up BEAM, Set up Node, Cache
Cargo dependencies and build, Install Elixir dependencies, Compile BEAM support, and the Treehouse half
of "Install client and shell dependencies"), then move steps `Build ordinary offline Treehouse app`,
`Classify ordinary Treehouse bundle`, `Real empty Treehouse UI and retained restart`,
`Independently replay exact packaged Treehouse frames` and `Upload public Treehouse preview evidence`
(lines 476–496) from `packaged_macos` into it. `packaged_macos` keeps the Township smokes only.

**Verify**: `grep -n "Build ordinary offline Treehouse app" .github/workflows/flagship.yml` prints one
line, inside the new job; YAML parses.

### Step 4: Gate jobs

Add `needs: changes` (append to existing `needs:` lists where present) and the `if:` shown:

| job | `if:` |
|---|---|
| `verify` | `needs.changes.outputs.legacy == 'true'` |
| `unit` | none (always runs; its Township step group is gated in step 5) |
| `packaged_macos` | `needs.changes.outputs.township == 'true'` |
| `treehouse_packaged_macos` (new) | `needs.changes.outputs.treehouse == 'true'` |
| `treehouse_packaged_macos_enrollment` | `needs.changes.outputs.treehouse == 'true'` |
| `carrier_release` | `needs.changes.outputs.core == 'true'` |
| `treehouse_android_preview` | `needs.changes.outputs.treehouse == 'true'` |
| `android_pilot_contract` | `needs.changes.outputs.township == 'true'` |
| `android_pilot_verify` | `needs.changes.outputs.township == 'true'` (keep `needs: [android_pilot_contract, changes]`) |
| `android_pilot` | keep its existing `if:`, add `&& needs.changes.outputs.township == 'true'` |

Because `core=true` forces every output true, a core change still runs everything.

**Verify**: YAML parses; `grep -c "needs.changes.outputs" .github/workflows/flagship.yml` → at least 9.

### Step 5: Gate the Township step group inside `unit`

Add `needs: changes` to `unit`, and add
`if: needs.changes.outputs.township == 'true'` to each of these steps and only these: every step
from `Install Tauri shell dependencies` through `TS Township revocation fixture contract`
(lines 224–299), `Tauri native command core` (315), `TS Township witness fixture preflight` (330),
`Tauri development trace contract` (333). Do not gate the Treehouse preview steps 147–153 (they are
prerequisites of `mix test`).

**Verify**: `awk '/^  unit:/,/^  packaged_macos:/' .github/workflows/flagship.yml | grep -c "if: needs.changes.outputs.township"` → the number of steps you gated (expect 29 at the planned-at commit).

### Step 6: Add the `required` fan-in job

Append as the last job:

```yaml
  required:
    name: Required checks
    if: always()
    needs: [changes, verify, unit, packaged_macos, treehouse_packaged_macos, treehouse_packaged_macos_enrollment, carrier_release, treehouse_android_preview, android_pilot_contract, android_pilot_verify]
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions:
      contents: read
    steps:
      - name: Fail on any failed or cancelled job
        env:
          RESULTS: ${{ toJSON(needs) }}
        run: |
          echo "$RESULTS" | grep -E '"result": *"(failure|cancelled)"' && { echo "a required job failed or was cancelled" >&2; exit 1; } || true
          echo "all required jobs succeeded or were skipped"
```

`skipped` passes by design: a skipped product job means the classifier found that product untouched.

**Verify**: YAML parses.

### Step 7: Add the vector drift guard

Directly after the step `Regenerate and verify TS-authored continuation operations` in `unit`, add:

```yaml
      - name: Committed oracle vectors match regeneration
        run: git diff --exit-code --stat -- clients/lattice-client/test/vectors
```

**Verify**: the local drift command exits 0.

### Step 8: Retire `apps/lattice_carrier_spike`

1. `git rm -r apps/lattice_carrier_spike scripts/lattice_browser_carrier_spike.sh`
2. Remove the line `"browser:carrier:proof": "scripts/lattice_browser_carrier_spike.sh",` from the root
   `package.json` `scripts` block (check the trailing comma of the previous line).
3. Delete the `AGENTS.md` layout table row that begins `| \`apps/lattice_carrier_spike\` |`.
4. `~/.asdf/shims/mix deps.unlock tcp_filter_dist web_socket_dist mint mint_web_socket && ~/.asdf/shims/mix deps.get`
5. Confirm no runtime reference remains: `grep -rn "carrier_spike\|web_socket_dist\|tcp_filter_dist" --include='*.ex' --include='*.exs' --include='*.yml' --include='*.sh' --include='*.json' . | grep -v "node_modules\|/deps/\|_build\|/plans/\|/docs/"` prints nothing.

**Verify**: `grep -c "tcp_filter_dist\|web_socket_dist\|\"mint\"\|mint_web_socket" mix.lock` → `0`;
`~/.asdf/shims/mix compile --warnings-as-errors` exits 0; `~/.asdf/shims/mix test` has 0 failures.

### Step 9: Re-run the workflow-parsing tests and refresh what they pin

Run the six tests. Expected: `enrollment_ci_contract.mjs` and possibly `mobile_core_native_ci_contract.mjs`
/ `runtime_wiring_contract.mjs` fail because a job or step inventory or a committed digest changed. For
each failure, read the test's header comment for its refresh procedure and apply exactly that (a digest
refresh or an inventory update). Do not weaken an assertion.

**Verify**: all six pass; `git diff --stat` shows only in-scope files.

### Step 10: Hosted verification on a throwaway branch

Push this branch and open no PR yet; instead create a second throwaway branch from it that adds one
comment line to `clients/township-tauri-shell/test/android_contract.mjs` (Township-only path) and
open a draft PR for it. In its run, `treehouse_*` jobs, `verify` and `carrier_release` must show
`skipped`, `packaged_macos` and `android_pilot_contract` must run, and `Required checks` must pass.
Close the draft PR without merging. Then open the real PR for this branch; its run (a `.github/**`
change, so core) must run every job green.

**Verify**: both run pages show the expected statuses; record both run ids in the PR description.

## Test plan

- No new unit tests. The structural workflow tests are the test layer; keep them passing.
- Manual: the throwaway-PR check in step 10 is the behavioral test of the classifier.

## Done criteria

- [ ] `ruby -ryaml -e 'YAML.load_file(ARGV[0]); puts "ok"' .github/workflows/flagship.yml` → `ok`
- [ ] the six workflow-parsing tests pass
- [ ] `~/.asdf/shims/mix check` → 0 failures
- [ ] `test -d apps/lattice_carrier_spike` fails; the four lock entries are gone
- [ ] `git diff --exit-code -- clients/lattice-client/test/vectors` exits 0 after local regeneration
- [ ] a Township-only throwaway PR skips every Treehouse job, `verify` and `carrier_release`, and `Required checks` passes
- [ ] a core PR runs every job green
- [ ] `plans/README.md` row 183 updated in one line

## STOP conditions

- Step 1's vector diff changes any `authorityQuarantine`, state or op id: the oracle moved since the
  corpus was committed; report the diff, do not commit it.
- A workflow-parsing test asserts something this plan intentionally removes (for example that the
  Treehouse preview steps live in `packaged_macos`) and its header gives no refresh procedure.
- `mix deps.get` after unlocking pulls `mint` back in for another app.
- Step 10 shows `Required checks` passing while a needed job reported `failure` (the fan-in grep
  missed a result shape); fix the grep against the actual `toJSON(needs)` output, retry once, else stop.

## Maintenance notes

- Operator action after merge: enable branch protection on `main` requiring only `Required checks`
  (and `Android pilot distribution result` if desired). Without protection the fan-in is advisory.
- Adding a new product directory means adding its prefix to the classifier; an unlisted prefix is
  treated as core (safe, slower).
- `packaged_macos` still runs five full Tauri builds for the Township smokes; now that it only runs
  on Township changes, the per-PR cost is gone and the three unflagged smokes
  (`tauri_stable_relay_onboarding_smoke.ts:198`, `tauri_action_handoff_smoke.ts:291`,
  `tauri_carrier_feed_smoke.ts:292`) are left alone.
- Plan 189 may later narrow the `core` prefix by splitting v1 out of `apps/lattice_core`.

## Execution record (2026-10-08)

- Executed by a Sonnet executor in an isolated worktree (steps 1–9); the reviewer re-ran the YAML
  parse, the drift guard, the six workflow-parsing tests and the client gate on the integrated branch
  and integrated ten commits onto `claude/round6-plans-182-185`. Step 10 (hosted) is the reviewer's.
- Deviations, each approved before it was made:
  1. Step 1 found the committed `continuation/authority.json` differed from regeneration in key order
     only (57 entries, zero differing values). Cause: `Lattice.ContinuationVectors.write/1` encoded plain
     atom-keyed maps, whose iteration order follows atom creation order and so varies by VM. Instead of
     committing the noise, the writer now deep-sorts keys (same helper shape as
     `enrollment_vectors.ex`), the file was regenerated once, and a second regeneration is byte-stable.
     `continuation_vectors.ex` was added to scope for that change only.
  2. The executor found that `android_pilot` needs `verify` and `packaged_macos`, both now skippable, so
     GitHub's implicit `success()` would have skipped distribution on a Township-only push to `main` and
     `android_pilot_required` would have passed silently. Its `if:` is now
     `${{ !cancelled() && ... && needs.unit.result == 'success' && needs.android_pilot_verify.result == 'success' && needs.packaged_macos.result == 'success' && (needs.verify.result == 'success' || needs.verify.result == 'skipped') }}`
     (wrapped because a plain scalar cannot start with `!`). No other job has a skippable dependency.
  3. `enrollment_ci_contract.mjs` and `android_pilot_signing_contract.mjs` pinned the pre-183 structure
     (digest over `packaged_macos`, "no job-level if", "no other referrer", exact four needs). They were
     re-pinned, not loosened: exact gate expressions, exact needs lists, a second digest
     (`TREEHOUSE_PREVIEW_DIGEST`) over the moved bodies so nothing previously pinned is unpinned,
     `required` as the single permitted referrer, and eleven new mutation fixtures (61 subtests, was 48).
- `actionlint` reports five pre-existing `SC2209` warnings on `MIX_ENV=test mix run` lines; none new.
- Hosted verification (step 10) and the operator's branch-protection change remain; see the row.

