# Plan 166: Typecheck the shell test tree and retire the prose-pinning suite

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 764a1945..HEAD -- clients/township-tauri-shell/tsconfig.json clients/township-tauri-shell/package.json clients/township-tauri-shell/test .github/workflows/flagship.yml
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 — no production defect. This is about the test estate telling the truth about what
  it covers.
- **Effort**: M — Part A's error count across 67 files is unknown until you compile them; Part B is a
  large deletion that needs care about what it takes with it.
- **Risk**: MED — some of the type errors are dead guards whose removal changes what a harness is
  understood to prove, and Part B deletes ~4,900 lines.
- **Depends on**: none. Independent of 161–165.
- **Category**: tests / tech-debt
- **Planned at**: commit `764a1945`, 2026-07-29

## Why this matters

Two problems, both of the same kind — a test suite that looks like coverage and isn't.

**A. The Tauri shell's `test/` tree is never typechecked.** `tsconfig.json` includes only
`src/**/*.ts`, `src/**/*.vue`, and `vite.config.ts`. The 67 `.ts` files under `test/` are outside
every project. `tsx` strips types without checking them and `vitest` typechecks nothing, so a harness
can assert against a field the source union does not have and still "pass" by falling through.

This is not hypothetical. Compiling `test/native_workflow.ts` with the project's own compiler options
gives `TS2339: Property 'error' does not exist on type 'TownshipNativeStatus'`, and
`test/township_actions.ts` has roughly eighteen `TS2339 ... on type 'never'` hits. An error on type
`never` means the guard is on a branch the type system has proven unreachable — an assertion about a
failure mode that **can never fire**. The harness looks like it covers that failure mode. It does not.

The sibling package gets this right: `clients/lattice-client/tsconfig.json:18` is
`"include": ["src", "test"]`, and CI typechecks it. The shell is the asymmetric one. And these are
not incidental files — the shell's `test/` tree holds the byte-exactness oracles and every packaged
smoke driver.

**B. `tauri_mobile_readiness.mjs` is 5,322 lines of markdown-prose pinning that nothing runs.** It
contains 1,502 `assert.match(...)` calls and exactly **5** `test(` blocks. One of those blocks —
"Tauri mobile targets are scaffolded without claiming phone-grade convergence", starting at line 361 —
spans lines 361 through 5322 and holds the overwhelming majority of the assertions. It reads 44
documents (`plans/README.md`, `plans/054` through `plans/118`, `docs/adr/0010-*`,
`TOWNSHIP_BUILD_MAP.md`) and asserts things like `/Plan 087 reran the release smoke/` and
`/Claude Code was asked twice/`. Those pin planning prose, not behavior.

It is also the **highest-churn file in the repo** — 39 commits in 90 days — and
`"mobile:tauri-readiness"` is in neither CI nor the `app:convergence` aggregate. So every plan edit
or ADR rewording breaks (or silently should break) a 5,000-line test that nothing executes. Pure tax,
zero regression detection.

This is the exact habit `plans/143-action-ladder-consolidation.md:37` retired on the Elixir side
("Replace the markdown-prose greps in `apps/*/test/**/plan_contract_test.exs` with a single non-prose
contract" — done; that file no longer exists anywhere at HEAD). Plan 143's scope simply never reached
this `.mjs` file.

The first ~360 lines are genuinely different and genuinely valuable: npm resolution outside the GUI
login shell, iOS launch-evidence process-id binding, development-profile preflight. Those are real
behavioral tests of real toolchain hazards. They should survive and should run.

After this plan: the shell's test tree compiles under the same strictness as its source, the dead
guards are either made live or removed honestly, and the mobile-readiness suite is the ~360 lines
that test behavior — running in CI.

## Current state

### Part A — the untypechecked test tree

`clients/township-tauri-shell/tsconfig.json` in full:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts"]
}
```

Note `"types": ["vite/client"]` — **no `node`**. That is why `test/` cannot simply be added to
`include`: the harnesses use `node:fs`, `node:child_process`, `node:test`, `process`, and so on, and
would produce a wall of missing-global errors unrelated to the real defects.

`clients/township-tauri-shell/package.json:13` — `"typecheck": "vue-tsc --noEmit"`, which resolves
`./tsconfig.json`. CI runs it at the "TS Township shell typecheck" step. It passes today without
compiling a single harness.

The only project that covers any test file is `tsconfig.ios-device-probe.json`, which lists exactly
two files.

Known errors, found by compiling individual files with the project's own options:

- `clients/township-tauri-shell/test/native_workflow.ts:136` —
  `TS2339: Property 'error' does not exist on type 'TownshipNativeStatus'. Property 'error' does not exist on type 'TownshipNativeReadyStatus'.`
- `clients/township-tauri-shell/test/native_workflow.ts:105` — `TS2322` under `exactOptionalPropertyTypes`
- `clients/township-tauri-shell/test/township_actions.ts` — roughly 18 further `TS2339 ... on type 'never'`

The total across all 67 files is **unknown** — step A1 establishes it.

### Part B — the prose-pinning suite

`clients/township-tauri-shell/test/tauri_mobile_readiness.mjs`, 5,322 lines. Measured directly:

| Metric | Value |
|---|---|
| Total lines | 5,322 |
| `assert.match(` calls | 1,502 |
| Top-level `test(` blocks | 5 |

The five test blocks and where they start:

| Line | Name | Keep? |
|---|---|---|
| 77 | `Xcode build phase resolves npm outside the GUI login shell` | **keep** — behavioral |
| 250 | `iOS device launch evidence uses fresh private copies` | **keep** — behavioral |
| 268 | `iOS device launch JSON binds exactly one process id` | **keep** — behavioral |
| 286 | `iOS archive preflight requires an exact installed development profile` | **keep** — behavioral |
| 361 | `Tauri mobile targets are scaffolded without claiming phone-grade convergence` | **delete** — spans 361–5322 |

The file's imports (`:1-36`) pull from six `./support/ios_*.mjs` helpers — `ios_toolchain_evidence`,
`ios_development_profile`, `ios_installed_development_profiles`, `ios_entitlement_scope`,
`ios_signing_output`, `ios_device_probe_output`. Those helpers back the four keeper tests and must
survive.

The block at `:361` starts by reading configuration files and then proceeds into document reads
(`:542-611` reads `plans/README.md`, `plans/054`…`plans/118`, `docs/adr/0010-android-release-carrier-transport-policy.md`,
`TOWNSHIP_BUILD_MAP.md`).

`clients/township-tauri-shell/package.json:36` — `"mobile:tauri-readiness"` exists as a script. It
appears in neither `.github/workflows/flagship.yml` nor the `app:convergence` aggregate
(`package.json:71`).

**Note on the parked-platform context**: `plans/README.md:13` records iOS, QR camera onboarding, LAN
discovery, physical-device behavior, and further `tauri:android:release:*` probe permutations as
parked. This plan does **not** un-park anything — it keeps the four toolchain tests that already
exist and deletes prose assertions. If the operator would rather delete the whole file as parked
work, that is a legitimate alternative; see STOP conditions.

### Repo conventions to follow

- Plan 143's stated procedure for retiring a pinning test: **add the replacement first, prove it
  fails when the behavior is removed, and only then delete the pin.** For a prose assertion there is
  no behavior to replace — deletion is the whole move — but capture a green baseline before and after.
- Contract scripts are `tsx test/<file>.ts` or `node --test test/<file>.mjs`, registered in
  `clients/township-tauri-shell/package.json` and wired as individual CI steps.
- `vitest` + `@vue/test-utils` + `jsdom` are already devDependencies, and
  `clients/township-tauri-shell/test/IntentReviewPanel.test.ts` and `test/use_action_intent.test.ts`
  already mount real components via `npm run intent-ui:contract` — that is the pattern for behavioral
  frontend tests in this repo.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Shell typecheck (src) | `npm --prefix clients/township-tauri-shell run typecheck` | exit 0 |
| Shell typecheck (test) | `npm --prefix clients/township-tauri-shell run typecheck:test` | exit 0 (after step A2) |
| One shell contract | `npm --prefix clients/township-tauri-shell run <script>` | exit 0 |
| Mobile readiness | `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` | exit 0 |
| Build client first | `npm --prefix clients/lattice-client run build` | exit 0 |
| Full shell convergence (heavy, macOS) | `npm --prefix clients/township-tauri-shell run app:convergence` | exit 0 |
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 |

## Scope

**In scope**:

- `clients/township-tauri-shell/tsconfig.test.json` (create)
- `clients/township-tauri-shell/package.json` (add `typecheck:test`; adjust `mobile:tauri-readiness`)
- `clients/township-tauri-shell/test/**/*.ts` — **type-level corrections only** (see the boundary below)
- `clients/township-tauri-shell/test/tauri_mobile_readiness.mjs` (split/delete)
- `clients/township-tauri-shell/test/mobile_toolchain_readiness.mjs` (create)
- `.github/workflows/flagship.yml` (add two steps)
- `plans/README.md` (status row)

**The critical boundary inside `test/**/*.ts`**: you are fixing **type errors**, not rewriting tests.
Two allowed edit shapes:

1. The assertion is about a real field that the harness references by the wrong name or shape → fix
   the reference.
2. The assertion is on a branch the type system proves unreachable (`... on type 'never'`) → the
   guard is dead. **Delete it and record it in a list**, or, if the failure mode it was reaching for
   is real and reachable through a different path, rewrite it to reach that path.

**Never** widen a type in `src/` to make a test compile. **Never** add `any`, `as`, `@ts-ignore`, or
`@ts-expect-error` to silence an error. If a test cannot be made to compile without one of those,
STOP and report that file.

**Out of scope**:

- **Any file under `clients/township-tauri-shell/src/`.** If a type error reveals a genuine source
  bug, report it — do not fix it here.
- **`clients/lattice-client/**`** — its test tree is already typechecked.
- **`test/frontend_shell.mjs`.** It is 1,294 lines with 737 assertions that read `src/App.vue` 35
  times and pin exact source text (test names literally read `Vue source exposes a cap-gated
  author-and-persist post action`). Plan 143 named it and it was not done. It is a real and closely
  related problem — but it is CI-gated today, and converting 35 source-slice sites to mounted-component
  assertions is its own plan. Deliberately deferred; see Maintenance notes.
- **Un-parking any iOS/Android work.** This plan keeps existing tests and deletes prose.
- **Wiring the current 5,322-line `mobile:tauri-readiness` into CI.** Only the post-split version goes
  in.

## Git workflow

- Branch: `advisor/166-shell-test-suite-honesty`
- Two commits, one per part: `test(shell): typecheck the test tree` and
  `test(shell): keep the behavioral mobile-readiness tests, drop the prose pins`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

---

## Part A — typecheck the shell test tree

### Step A1: Establish the error count

Create `clients/township-tauri-shell/tsconfig.test.json` extending the base project, adding node
types and scoping to `test/`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node", "vite/client"],
    "noEmit": true
  },
  "include": ["test/**/*.ts"]
}
```

`@types/node` must be resolvable. Check whether it already is:

```sh
ls clients/township-tauri-shell/node_modules/@types/node 2>/dev/null && echo present || echo missing
```

If missing, add `@types/node` to the shell's `devDependencies` pinned to a version matching CI's Node
22, and note it in your report.

Then compile and count:

```sh
npm --prefix clients/lattice-client run build
cd clients/township-tauri-shell && npx tsc -p tsconfig.test.json --noEmit 2>&1 | tee /tmp/shell-test-typecheck.txt ; cd ../..
grep -c 'error TS' /tmp/shell-test-typecheck.txt
grep -o 'error TS[0-9]*' /tmp/shell-test-typecheck.txt | sort | uniq -c | sort -rn
```

Record the total and the breakdown by error code. This number is the plan's real size — report it
before proceeding.

**If the count exceeds ~150**, STOP and report. A fix pass that large is a different plan (probably
one that lands the tsconfig with a temporary per-file exclude list and burns it down incrementally),
and grinding through it blind is how a mechanical change turns into an unreviewable diff.

### Step A2: Fix the errors, file by file, recording every dead guard

Work one file at a time, smallest first. For each file:

1. Compile just that file's project scope and read every error.
2. Apply the allowed edit shapes from the Scope section.
3. **Maintain a running list** of every deleted guard: file, line, what the assertion claimed, and why
   the type system proved it unreachable. This list is the plan's most important output — it is the
   inventory of coverage that was believed to exist and did not.
4. Re-run that file's contract script to confirm it still passes:
   `npm --prefix clients/township-tauri-shell run <script>`.

Start with the two known cases:

- `test/native_workflow.ts:136` — `Property 'error' does not exist on type 'TownshipNativeStatus'`.
  Read the actual union in `src/` and decide: is the harness reaching for a field that was renamed
  (fix the reference), or for an error variant that no longer exists (delete, and record it)?
- `test/township_actions.ts` — the ~18 `on type 'never'` hits. These are almost certainly failure
  branches for reasons the union no longer carries. Cross-check against
  `clients/township-tauri-shell/src/township_actions.ts:49-75`, which declares four separate failure-reason
  unions (`TownshipPostFailureReason`, `TownshipCommandFailureReason`, `TownshipDelegationFailureReason`,
  `TownshipRevocationFailureReason`). A guard for a reason that is in one union but asserted against a
  value typed as another is exactly how you get `never`.

**Verify** after each file: that file compiles clean and its contract script still exits 0.

### Step A3: Register the typecheck and wire it into CI

Add to `clients/township-tauri-shell/package.json`:

```json
    "typecheck:test": "tsc -p tsconfig.test.json --noEmit",
```

Add a step to the `unit` job in `.github/workflows/flagship.yml`, immediately after the existing
"TS Township shell typecheck" step:

```yaml
      - name: TS Township shell test typecheck
        working-directory: clients/township-tauri-shell
        run: npm run typecheck:test
```

**Verify**:

```sh
npm --prefix clients/township-tauri-shell run typecheck
npm --prefix clients/township-tauri-shell run typecheck:test
grep -c 'typecheck:test' .github/workflows/flagship.yml
```

→ first two exit 0; grep returns at least `1`.

Then prove the gate bites: introduce a deliberate type error in any `test/*.ts` file, confirm
`typecheck:test` fails, and revert.

---

## Part B — split the mobile-readiness suite

### Step B1: Capture the baseline

Per plan 143's procedure, record the current state before deleting anything:

```sh
npm --prefix clients/township-tauri-shell run mobile:tauri-readiness ; echo "exit=$?"
wc -l clients/township-tauri-shell/test/tauri_mobile_readiness.mjs
grep -c 'assert.match' clients/township-tauri-shell/test/tauri_mobile_readiness.mjs
```

Record all three. If the suite is already **failing**, that is itself informative — record the failure
and note that the prose pins have drifted from the documents they pin, which is the predicted
end-state of this pattern.

### Step B2: Extract the four behavioral tests

Create `clients/township-tauri-shell/test/mobile_toolchain_readiness.mjs` containing:

- the import block from `tauri_mobile_readiness.mjs:1-36` (trimmed to what the four tests actually
  use — the six `./support/ios_*.mjs` helpers plus the node builtins),
- any module-level constants and helper functions defined between `:37` and `:76` that the four tests
  reference (`shellRoot`, `readJson`, `readText`, and similar — read the region and take exactly what
  is used),
- the four `test(...)` blocks at `:77`, `:250`, `:268`, and `:286`, verbatim.

Do not rewrite the test bodies. This is an extraction.

**Verify**:

```sh
node --test clients/township-tauri-shell/test/mobile_toolchain_readiness.mjs
```

→ exit 0, 4 tests pass. If any of the four fails once extracted, it depended on state set up by the
prose block — read that dependency, hoist it, and note it.

### Step B3: Delete the prose test and repoint the script

Delete `clients/township-tauri-shell/test/tauri_mobile_readiness.mjs` entirely (its four keepers now
live in the new file).

Repoint the script in `clients/township-tauri-shell/package.json:36`:

```json
    "mobile:tauri-readiness": "node --test test/mobile_toolchain_readiness.mjs",
```

Before deleting, confirm nothing else references the old file:

```sh
grep -rn 'tauri_mobile_readiness' clients/township-tauri-shell .github scripts --include=*.json --include=*.yml --include=*.mjs --include=*.ts --include=*.sh
```

→ after the repoint, only the new name should appear. If any support helper under
`test/support/ios_*.mjs` becomes unreferenced by the extraction, check whether another test uses it
before removing it — and if in doubt, leave it.

**Verify**:

```sh
npm --prefix clients/township-tauri-shell run mobile:tauri-readiness
wc -l clients/township-tauri-shell/test/mobile_toolchain_readiness.mjs
```

→ exit 0; the new file should be on the order of ~400 lines, not ~5,300. If it is much larger, the
extraction pulled in prose — go back to B2.

### Step B4: Wire it into CI

Add a step to the `unit` job, near the other shell contract steps:

```yaml
      - name: TS Township mobile toolchain readiness
        working-directory: clients/township-tauri-shell
        run: npm run mobile:tauri-readiness
```

**Verify**:

```sh
grep -c 'mobile:tauri-readiness' .github/workflows/flagship.yml
```

→ at least `1`.

### Step B5: Full gate

```sh
npm --prefix clients/lattice-client run build
npm --prefix clients/township-tauri-shell run typecheck
npm --prefix clients/township-tauri-shell run typecheck:test
npm --prefix clients/township-tauri-shell run mobile:tauri-readiness
npm --prefix clients/township-tauri-shell run runtime:wiring:contract
npm --prefix clients/township-tauri-shell run native:contract
npm --prefix clients/township-tauri-shell run intent-ui:contract
npm --prefix clients/township-tauri-shell run action:contract
npm --prefix clients/township-tauri-shell run action-intent:contract
npm --prefix clients/township-tauri-shell run frontend:contract
npm --prefix clients/township-tauri-shell run feed:app:contract
~/.asdf/shims/mix check
```

→ all exit 0.

## Test plan

This plan adds one new suite file and no new product tests. Its verification is:

- **The typecheck gate bites** — step A3's deliberate error must fail `typecheck:test` and pass after
  revert.
- **Every contract script still passes** after the type fixes (step A2's per-file re-run, plus B5).
- **The four extracted tests pass standalone** (step B2).
- **The dead-guard inventory exists** — the list from step A2 is a required deliverable, not optional
  commentary.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `clients/township-tauri-shell/tsconfig.test.json` exists and includes `test/**/*.ts`
- [ ] `npm --prefix clients/township-tauri-shell run typecheck:test` exits 0
- [ ] `npm --prefix clients/township-tauri-shell run typecheck` still exits 0
- [ ] `grep -c 'typecheck:test' .github/workflows/flagship.yml` ≥ 1
- [ ] A deliberate type error in a `test/*.ts` file makes `typecheck:test` fail (demonstrated and reverted)
- [ ] `grep -rn 'as any\|@ts-ignore\|@ts-expect-error' clients/township-tauri-shell/test --include=*.ts` returns no **new** occurrences versus the baseline
- [ ] `clients/township-tauri-shell/test/tauri_mobile_readiness.mjs` no longer exists
- [ ] `clients/township-tauri-shell/test/mobile_toolchain_readiness.mjs` exists and `node --test` on it passes 4 tests
- [ ] `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` exits 0
- [ ] `grep -c 'mobile:tauri-readiness' .github/workflows/flagship.yml` ≥ 1
- [ ] Every shell contract script in step B5 exits 0
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] **Your report contains the dead-guard inventory** — every assertion deleted because the type system proved it unreachable, with file, line, and what it claimed
- [ ] Your report contains the step-A1 error count and breakdown
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 166 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **The step-A1 error count exceeds ~150.** That is a different plan — land the tsconfig with a
  documented per-file exclude list and burn it down incrementally, rather than producing an
  unreviewable diff.
- **Any test file cannot be made to compile without `any`, `as`, or `@ts-ignore`.** Report the file
  and the error. A silenced error is exactly the state this plan is fixing.
- **A type error reveals a genuine bug in `clients/township-tauri-shell/src/`.** Report it. Do not fix
  source in a test-hygiene plan.
- **A dead guard turns out to be reaching for a real, reachable failure mode** that the harness simply
  addresses through the wrong type. Rewriting it to actually reach that path is in scope — but if you
  cannot see how to reach it, report it as a genuine coverage gap rather than deleting silently.
- **Any of the four extracted tests fails after extraction** in a way you cannot resolve by hoisting a
  helper. It may depend on state the prose block set up, which changes what "the four tests" means.
- **The operator would rather delete `tauri_mobile_readiness.mjs` outright** as parked-platform work.
  That is a legitimate alternative to Part B and it is the operator's call: the four keepers test iOS
  toolchain hazards, and `plans/README.md:13` lists iOS as parked. If you believe outright deletion is
  right, say so and do Part A only.

## Maintenance notes

- **Reviewer focus**: the dead-guard inventory from step A2. Each entry is a piece of coverage the
  team believed it had. Some of those failure modes may deserve a real test — the inventory is the
  input to that decision, and it is worth more than the diff.
- **The `typecheck:test` gate is the durable part of Part A.** Without it, `test/` drifts back out of
  type coverage in one commit.
- **Part B removes a maintenance tax, not coverage.** Nothing that asserted `/Claude Code was asked
  twice/` against `plans/100` was detecting a regression. Note in the commit message that ~4,900 lines
  were deleted and that the four behavioral tests are preserved and now, for the first time, run in CI.
- **Deferred out of this plan, and the natural next step**: `test/frontend_shell.mjs` — 1,294 lines,
  737 assertions, reads `src/App.vue` 35 times, with tests literally named
  `Vue source exposes a cap-gated author-and-persist post action` and assertions that pin exact source
  lines including identifier names (e.g.
  `assert.match(app, /if \(devTraceShortcutMounted\) window\.removeEventListener\("keydown", handleDevTraceShortcut\)/)`).
  `plans/143-action-ladder-consolidation.md:31-34` explicitly named this file and it was not done. It
  is the one CI-gated frontend suite, `src/App.vue` is #5 by 90-day churn, and the tooling to fix it
  (`vitest` + `@vue/test-utils` + `jsdom`) is already installed and already used by
  `test/IntentReviewPanel.test.ts`. Converting it needs plan 143's procedure — add the mounted-component
  replacement, prove it fails when the behavior is removed, then delete the pin — which makes it its
  own M/L plan.
