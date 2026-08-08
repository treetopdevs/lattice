# Plan 161: Close the three silent verification gaps (Sobelow, orphaned suites, format scope)

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- .github/workflows/flagship.yml clients/township-tauri-shell/package.json clients/lattice-client/package.json .formatter.exs apps/township_web config/config.exs config/runtime.exs
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **DONE.** Executed and merged to main via `codex/round4-security-reliability` (with the
  authorized scope amendment below). A parallel advisor-branch run — six commits
  `cc56d133..2b2ae207` on `advisor/161-close-verification-gaps` (worktree based on `origin/main`
  @ `b1e6b88a`) — is **superseded by that landing and not an ancestor of main; reconcile or
  discard it, do not merge it blind**. That run's reviewer record: scope is exactly the 8
  in-scope files; `mix check` exit 0 (595 tests, 27 properties, 0 failures); both Sobelow scans exit
  0; all thirteen device-free suites wired into CI and sequenced after `mix test`; the widened format
  gate demonstrably fails on an unformatted file in `apps/lattice_web_socket`. Two follow-ups recorded
  in `plans/README.md`: the Sobelow `--skip` flag drift (two suppression mechanisms now coexist, one
  inert under CI's invocation), and `tauri:witness-ceremony:smoke` being wired but unverified until
  the next hosted macOS run.
- **Priority**: P1 — this is the verification baseline. Plans 162 and 163 change security-critical
  code; they should land on top of a CI that actually runs the suites that would catch a mistake.
- **Effort**: S–M (the code change is small; triaging the first Sobelow run and the rotted suites is the work)
- **Risk**: MED — enabling a scanner and ten never-executed suites will likely surface pre-existing
  failures. That is the point, but it means this plan can turn red before it turns green.
- **Depends on**: none, strictly. (An earlier draft said plan 165 Part B had to land first, on the
  assumption that Sobelow would flag the committed secrets. It cannot — see the correction in
  step 3. 165 Part B landed 2026-08-08 regardless, at `8ab09e9e`.)
- **Execution note**: the Round 4 sequence still ran plan 165 Part B before this plan. The tracked
  endpoint secret is therefore expected to be absent when the Township Sobelow baseline is
  established; that is the planned removal of a genuine finding, not unexplained drift.
- **Category**: tests / dx / security
- **Planned at**: commit `764a1945`, 2026-07-29
- **Reconciled at**: commit `91bb6ca6`, 2026-07-29

## Authorized execution amendment (2026-07-29)

The first implementation review exposed three incorrect planning assumptions. The operator
authorized this scope amendment before execution resumed:

1. `witness:preflight:contract` is not a pure Node contract. It launches a feature-gated Rust
   `cargo test` probe and two BEAM support processes. Keep it in the `unit` job, but run it only
   after the Linux Tauri prerequisites and the existing native Rust gate.
2. The no-build witness ceremony requires a bundle built with both `township-dev-trace` and
   `township-governance-test-presence`. In `packaged_macos`, build that paired variant and run the
   ceremony before the existing stable-relay smoke rebuilds the ordinary dev-trace-only bundle for
   the remaining packaged chain. Never run the ceremony against whichever bundle happens to be
   left by an earlier smoke.
3. Per-app Sobelow roots cannot see the umbrella `config/`, and Sobelow itself intentionally skips
   exact `secret_key_base` checks in `config.exs`. Add a focused Township test that uses Sobelow's
   config parser to reject hard-coded `secret_key_base`, password-like, and secret-like values in
   every shared non-dev/test config. Prove the guard against a temporary hard-coded fixture. Also
   enable the existing function-scoped `sobelow_skip` in `bundle.ex` instead of excluding that
   entire source file.
4. The first completed-plan review proved `test/packaged_bundle_variant.ts` was an unregistered
   contract runner for `test/support/packaged_bundle_variant.ts`, not a duplicate implementation.
   Preserve it, add `bundle:variant:contract`, and gate it in the `unit` job.

These instructions supersede the original device-free classification, packaged-smoke placement,
whole-file Sobelow suppression, and "no new tests" statements below.

## Why this matters

Three gates that the repo *documents* as mandatory are not actually enforced, and nothing surfaces
the discrepancy:

1. **Sobelow never scans `apps/township_web`** — the only app in the umbrella with a Phoenix router,
   endpoint, and HEEx templates. CI runs it only on `apps/lattice_server`, which is raw Cowboy and
   has no router for Sobelow to inspect. `AGENTS.md:41-43` says to run both. The dependency is
   declared in `apps/township_web/mix.exs:40` and used by nothing.
2. **Ten device-free contract suites and four test files run nowhere** — not in CI, not in the
   `app:convergence` aggregate, not in any documented local gate. They cover pairing handoff, QR
   encode/decode, deep-link parsing, LAN advert discovery, carrier peer health, and the entire
   witnessed-succession ceremony (~72 KB of governance/custody tests). A regression in those paths
   ships green today.
3. **`mix format --check-formatted` silently skips 3 of 10 apps.** Mix only descends into an
   `apps/*` subdirectory that has its own `.formatter.exs`; `lattice_carrier_server`,
   `lattice_web_socket`, and `township_bench` don't have one. `AGENTS.md:98` asserts the invariant
   holds repo-wide. It does not, locally or in CI.

After this plan: the documented gates and the enforced gates are the same set, and the suites that
exist actually run.

## Current state

### Gap 1 — Sobelow

`.github/workflows/flagship.yml:218-219` is the only Sobelow invocation in the repo:

```yaml
      - name: Sobelow (lattice_server)
        run: cd apps/lattice_server && mix sobelow --exit
```

`AGENTS.md:38-49` documents the policy:

```
Sobelow is **per-app** (it targets each HTTP boundary app, not the umbrella), so it is not part of
`mix check`. Run it in both boundary apps:

    cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit --skip
    cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip

`apps/lattice_carrier_server` is a raw Cowboy boundary, not a Phoenix endpoint. ... Sobelow has no
router/controller surface to inspect there.
```

`apps/township_web/mix.exs:40` declares the dep: `{:sobelow, "~> 0.14", only: [:dev, :test], runtime: false}`.
Note the constraint differs from `mix.exs:33` and `apps/lattice_server/mix.exs:35`, which both say
`~> 0.13`; `mix.lock` resolves `0.14.1`. `apps/township_web` has no `.sobelow-conf`.

The existing config file to model the new one on is `apps/lattice_server/.sobelow-conf`:

```elixir
# Sobelow config for apps/lattice_server (plan 003).
#
# ignore_files: static_handler.ex triggers Traversal.FileModule (low confidence),
# a confirmed false positive — the filename passed to File.read comes from a
# hardcoded allowlist (file_for/1 maps six exact routes to fixed names) and is
# additionally guarded by safe_file?/1; no user-controlled path reaches File.read.
[
  exit: false,
  format: "txt",
  ignore_files: ["lib/lattice_server/static_handler.ex"],
  ignore: [],
  out: nil,
  private: false,
  router: nil,
  skip: false,
  threshold: :low,
  verbose: false,
  version: false
]
```

Note the convention: every ignore carries a written justification in a comment above the list.

### Gap 2 — suites that run nowhere

Verified by diffing every script in both `package.json` files against `.github/workflows/flagship.yml`
and against the `app:convergence` aggregate (`clients/township-tauri-shell/package.json:71`).

**Scripts that exist but are invoked by no CI job and no aggregate** — all of these are pure Node
(no `spawn`/`adb`/`xcrun`/`tauri build`), so they can run in the existing `unit` job unchanged:

| Script | File | Package |
|---|---|---|
| `peer:contract` | `test/township_carrier_peer.ts` | township-tauri-shell:98 |
| `deeplink:contract` | `test/township_pairing_deeplink.ts` | township-tauri-shell:99 |
| `deeplink:source:contract` | `test/township_pairing_deeplink_source.ts` | township-tauri-shell:100 |
| `qr:contract` | `test/township_pairing_qr.ts` | township-tauri-shell:102 |
| `qr:camera:contract` | `test/township_pairing_qr_camera.ts` | township-tauri-shell:103 |
| `discovery:contract` | `test/township_pairing_discovery.ts` | township-tauri-shell:104 |
| `canonical:probe:contract` | `test/township_canonical_probe.ts` | township-tauri-shell:27 |
| `mobile:strategy` | `test/mobile_secure_store_strategy.mjs` | township-tauri-shell:35 |
| `succession:review` | `test/witnessed_succession_review.ts` | lattice-client:22 |
| `succession:artifact` | `test/witnessed_succession_artifact.ts` | lattice-client:23 |

Note `deeplink:dispatcher:contract` (line 101) **is** in CI — do not confuse it with
`deeplink:contract` (line 99), which is not.

**Test files with no npm script at all** (`git log -S<basename> -- package.json` returns nothing —
a script never existed for any of them):

| File | Size | Nature |
|---|---|---|
| `clients/township-tauri-shell/test/tauri_witness_ceremony_smoke.ts` | ~30 KB | packaged macOS smoke — builds against `src-tauri/target/release/bundle/macos/Township.app` |
| `clients/township-tauri-shell/test/township_witness_artifact.ts` | ~29 KB | device-free |
| `clients/township-tauri-shell/test/township_witness_fixture_preflight.ts` | ~8.8 KB | device-free |
| `clients/township-tauri-shell/test/township_revocation_handoff_fixture.ts` | ~4.0 KB | device-free; its sibling `township_grant_handoff_fixture.ts` **is** gated as `grant:fixture:contract` (line 26) |

`clients/township-tauri-shell/test/packaged_bundle_variant.ts` (~7.0 KB) is the contract runner
for the smaller `test/support/packaged_bundle_variant.ts` implementation. It is intentionally an
entry point rather than an importer, so preserve it and register it in step 5.

The existing script style to copy (`clients/township-tauri-shell/package.json`):

```json
    "grant:fixture:contract": "tsx test/township_grant_handoff_fixture.ts",
    "canonical:probe:contract": "tsx test/township_canonical_probe.ts",
```

The existing CI step style to copy (`.github/workflows/flagship.yml`):

```yaml
      - name: TS Township delegation-grant fixture
        working-directory: clients/township-tauri-shell
        run: npm run grant:fixture:contract
```

### Gap 3 — formatter scope

`.formatter.exs` at the repo root:

```elixir
# Used by "mix format"
[
  inputs: ["mix.exs", "config/*.exs"],
  subdirectories: ["apps/*"]
]
```

Mix's `Mix.Tasks.Format.eval_subs_opts/4` only descends into a subdirectory that has its **own**
`.formatter.exs`; otherwise it drops the directory silently, with no warning. Confirmed on disk —
these three have none:

- `apps/lattice_carrier_server/` (~3.0k LOC)
- `apps/lattice_web_socket/` (~1.6k LOC)
- `apps/township_bench/` (~1.0k LOC)

The exemplar to copy is `apps/lattice_core/.formatter.exs`:

```elixir
# Used by "mix format"
[
  inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]
]
```

(`apps/township_web/.formatter.exs` additionally carries `plugins: [Phoenix.LiveView.HTMLFormatter]`
and `.heex` — none of the three apps in scope have HEEx templates, so use the `lattice_core` shape.)

All three apps are *currently* formatted (verified during the audit by running the check with
explicit inputs), so this is drift-prevention, not a cleanup.

## Commands you will need

**Toolchain**: `mix` on `PATH` is a broken mise shim on the primary dev machine. Always invoke mix as
`~/.asdf/shims/mix`. For commands that spawn BEAM child processes, prefix the explicit PATH as
`AGENTS.md:19-21` shows. In GitHub Actions plain `mix` works — do not add the asdf prefix to the
workflow file.

| Purpose | Command | Expected on success |
|---|---|---|
| Format check | `~/.asdf/shims/mix format --check-formatted` | exit 0 |
| Format check, one app | `cd apps/lattice_web_socket && ~/.asdf/shims/mix format --check-formatted` | exit 0 |
| Full local gate | `~/.asdf/shims/mix check` | exit 0 (format + test + credo --strict) |
| Sobelow, lattice_server | `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` | exit 0 |
| Sobelow, township_web | `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit` | **unknown — step 3 establishes this** |
| One shell contract | `npm --prefix clients/township-tauri-shell run <script>` | exit 0 |
| One client contract | `npm --prefix clients/lattice-client run <script>` | exit 0 |
| Build the client (needed by shell contracts) | `npm --prefix clients/lattice-client run build` | exit 0 |

## Scope

**In scope** (the only files you may modify or create):

- `apps/lattice_carrier_server/.formatter.exs` (create)
- `apps/lattice_web_socket/.formatter.exs` (create)
- `apps/township_bench/.formatter.exs` (create)
- `apps/township_web/.sobelow-conf` (create — only if step 3 requires it)
- `apps/township_web/test/township_web/shared_config_security_test.exs` (authorized amendment)
- `apps/township_web/mix.exs` (only the sobelow version constraint, only if step 3 requires it)
- `clients/township-tauri-shell/package.json` (add scripts only)
- `.github/workflows/flagship.yml` (add steps only)
- `clients/township-tauri-shell/test/packaged_bundle_variant.ts` (preserve and gate as a contract)
- `AGENTS.md` (the two doc corrections in step 7)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- **Any `.ex`, `.ts`, or `.vue` source file.** If a newly-enabled suite fails because production code
  is wrong, that is a STOP condition — report it, do not fix it here. Fixing a real bug inside a
  CI-wiring plan makes the diff unreviewable and hides the regression signal.
- **The content of any existing test file.** The authorized shared-config regression test is the
  only new test in scope. If an existing suite is red, report it.
- `clients/lattice-client/package.json` — `succession:review` and `succession:artifact` already
  exist as scripts; only the workflow needs to call them.
- `apps/lattice_server/.sobelow-conf` — its existing false-positive suppression is confirmed correct
  and out of scope.
- `mix.exs` root aliases — do not fold Sobelow into `mix check`; `AGENTS.md:38-39` explains why it is
  deliberately per-app.
- The `packaged_macos` job's existing eight smokes and their `TOWNSHIP_SKIP_*_APP_BUILD` flags.
- Plan 166 owns `tauri_mobile_readiness.mjs` and the shell test tsconfig. Do not wire
  `mobile:tauri-readiness` into CI here.

## Git workflow

- Branch: `advisor/161-close-verification-gaps`
- Commit per step. Message style follows the repo's conventional-commit convention — see
  `git log --oneline`, e.g. `test(township_web): gate sobelow in CI`, `build(ci): run device-free shell contracts`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the three missing `.formatter.exs` files

Create each of the following with exactly this content:

- `apps/lattice_carrier_server/.formatter.exs`
- `apps/lattice_web_socket/.formatter.exs`
- `apps/township_bench/.formatter.exs`

```elixir
# Used by "mix format"
[
  inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]
]
```

**Verify**:

```sh
~/.asdf/shims/mix format --check-formatted
```

→ exit 0. If it now reports unformatted files in those three apps, run
`~/.asdf/shims/mix format` and commit the reformatting as a **separate** commit
(`style: format apps newly covered by mix format`) so the mechanical churn is reviewable apart from
the config change.

### Step 2: Prove the format gate actually widened

Confirm the new files change behavior rather than being inert:

```sh
cd apps/lattice_web_socket && ~/.asdf/shims/mix format --check-formatted && cd ../..
```

→ exit 0.

Then deliberately break formatting in one file to prove the root gate now sees it:

```sh
printf '\n\n' >> apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex
~/.asdf/shims/mix format --check-formatted
```

→ must exit **non-zero** and name that file. Then restore:

```sh
git checkout apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex
~/.asdf/shims/mix format --check-formatted
```

→ exit 0.

If the deliberate break does **not** fail the check, the `.formatter.exs` is not being picked up —
STOP and report.

### Step 3: Establish the `township_web` Sobelow baseline

Run it and capture the full output:

```sh
cd apps/township_web && ~/.asdf/shims/mix sobelow --exit ; echo "exit=$?" ; cd ../..
```

> **Corrected 2026-08-08, after executing plan 165 Part B.** An earlier draft of this step said to
> expect a `Config.Secrets` finding on the committed secrets in `config/config.exs`, and that plan
> 165 had to land first. **Both were wrong**, and the reason is a standing gap worth understanding:
>
> **Sobelow's config checks are structurally dead in this repo.** Sobelow scans one Mix project.
> Neither `apps/township_web/` nor `apps/lattice_server/` has a `config/` directory of its own — all
> configuration lives at the umbrella root. A scan invoked from inside either app never sees
> `config/config.exs` or `config/runtime.exs`, so the whole `Config.*` family (`Config.Secrets`,
> `Config.CSRF`, `Config.CSP`, `Config.HTTPS`) can never fire from either invocation. Verified
> 2026-08-08: neither app directory contains `config/`, and the scan output was identical before and
> after the committed secrets were removed.
>
> So **this step is not blocked on plan 165**, and the findings you should actually expect are the
> `Traversal.FileModule` pair below.

**Expected as of 2026-08-08** (verified on `91bb6ca6` and again after 165 Part B): `exit=1`, with
exactly two low-confidence findings, both in
`apps/township_web/lib/township_web/instrument_source/bundle.ex`:

```text
Traversal.FileModule: Directory Traversal in `File.read` - Low Confidence
File: lib/township_web/instrument_source/bundle.ex
Line: 31   Function: load_verified:25   Variable: matter_path

Traversal.FileModule: Directory Traversal in `File.read` - Low Confidence
File: lib/township_web/instrument_source/bundle.ex
Line: 29   Function: load_verified:25   Variable: manifest_path
```

Triage those two. Read `load_verified/1` in that file and establish where `manifest_path` and
`matter_path` come from. If they derive from an operator-supplied bundle directory rather than from
peer or request input, that is the same shape as the confirmed false positive already suppressed in
`apps/lattice_server/.sobelow-conf` — create `apps/township_web/.sobelow-conf` modeled exactly on it,
with a comment block giving the **specific reason** the suppression is correct, naming the guard that
makes it safe.

**If either path can be influenced by untrusted input, STOP and report it.** That is a real finding
and fixing it is not this plan's job.

Generally, three outcomes:

- **exit 0** — nothing to suppress. Skip creating `.sobelow-conf` and go to step 4.
- **exit non-zero, findings justifiable as false positives** — suppress with written reasoning, as
  above (create `apps/township_web/.sobelow-conf` modeled exactly on
  `apps/lattice_server/.sobelow-conf`, with a comment block giving the **specific reason each
  suppression is correct**, naming the file and the guard that makes it safe).
- **exit non-zero with a plausible real vulnerability** — STOP and report it. Do not suppress it and
  do not fix it in this plan. Never suppress a finding you cannot justify in one sentence of
  concrete reasoning about the code.

Do not claim this per-app scan covers the umbrella `config/`; the authorized shared-config
regression test supplies that missing gate. It must reject the retired Part B literal if
reintroduced into `config/config.exs`.

**Verify**: whichever outcome, record the exact command output in your final report.

**Also record for the operator, but do not fix here** (it needs a scoping decision): the `Config.*`
blind spot above means `AGENTS.md:38-49` prescribes a security gate that cannot inspect any
configuration in this repo. The likely fix is an additional Sobelow invocation from the umbrella
root (or `--root`) so the config family actually runs. Note it in your report; it is a follow-up
plan, not a step here.

### Step 4: Wire the `township_web` Sobelow scan into CI

In `.github/workflows/flagship.yml`, immediately after the existing step at line 218-219:

```yaml
      - name: Sobelow (lattice_server)
        run: cd apps/lattice_server && mix sobelow --exit
```

add:

```yaml
      - name: Sobelow (township_web)
        run: cd apps/township_web && mix sobelow --exit
```

Do **not** add the asdf PATH prefix — CI uses `erlef/setup-beam`.

**Verify**:

```sh
grep -c 'mix sobelow --exit' .github/workflows/flagship.yml
```

→ `2`.

### Step 5: Triage the fourteen unexecuted suites, one at a time

First build the client, since several shell contracts resolve `@treetopdevs/lattice-client` through
its compiled `dist/`:

```sh
npm --prefix clients/lattice-client run build
```

Then run each of the ten existing scripts individually and record pass/fail:

```sh
for s in peer:contract deeplink:contract deeplink:source:contract qr:contract qr:camera:contract discovery:contract canonical:probe:contract mobile:strategy; do
  echo "=== $s ==="
  npm --prefix clients/township-tauri-shell run "$s" >/dev/null 2>&1 && echo "PASS $s" || echo "FAIL $s"
done
for s in succession:review succession:artifact; do
  echo "=== $s ==="
  npm --prefix clients/lattice-client run "$s" >/dev/null 2>&1 && echo "PASS $s" || echo "FAIL $s"
done
```

Then add scripts for the four files that have none. In
`clients/township-tauri-shell/package.json`, insert alongside the existing contract scripts, keeping
the file's existing alphabetical-ish grouping and its `tsx test/<file>.ts` shape:

```json
    "witness:artifact:contract": "tsx test/township_witness_artifact.ts",
    "witness:preflight:contract": "tsx test/township_witness_fixture_preflight.ts",
    "revocation:fixture:contract": "tsx test/township_revocation_handoff_fixture.ts",
    "tauri:witness-ceremony:smoke": "tsx test/tauri_witness_ceremony_smoke.ts",
```

Run all three and record pass/fail. `witness:preflight:contract` is locally runnable but is a native
Rust/BEAM integration, not a pure Node contract:

```sh
for s in witness:artifact:contract witness:preflight:contract revocation:fixture:contract; do
  npm --prefix clients/township-tauri-shell run "$s" >/dev/null 2>&1 && echo "PASS $s" || echo "FAIL $s"
done
```

Do **not** run `tauri:witness-ceremony:smoke` locally unless you have a built
`src-tauri/target/release/bundle/macos/Township.app` — it is a packaged macOS smoke and will fail
for environmental reasons that are not a code signal.

Finally, register the packaged bundle classifier contract:

```json
"bundle:variant:contract": "tsx test/packaged_bundle_variant.ts"
```

Run it individually and add it to the `unit` job beside the other device-free Township contracts.
It is an entry-point test for `test/support/packaged_bundle_variant.ts`; zero importers is expected
and is not evidence that the runner is stale.

**Verify**: you have a written PASS/FAIL line for all fourteen device-free suites, and a decision on
`packaged_bundle_variant.ts` (the expected decision is preserve, register, and gate).

**If any suite is FAIL**: STOP and report which ones, with their output. Do not fix them and do not
wire a red suite into CI. A red suite is a genuine finding this plan exists to surface — the
operator decides whether to fix it, quarantine it, or delete it.

### Step 6: Wire the green suites into CI

For every pure Node suite that PASSED in step 5, add a step to the `unit` job in
`.github/workflows/flagship.yml`. Place the shell ones immediately after the existing
`- name: TS live stable carrier availability feed` step (which runs `npm run feed:contract`,
`working-directory: clients/township-tauri-shell`), and the two client ones immediately after
`- name: TS carrier availability feed contract`.

Use the established shape, one step per script, with a human-readable name:

```yaml
      - name: TS Township carrier peer contract
        working-directory: clients/township-tauri-shell
        run: npm run peer:contract

      - name: TS Township pairing deep-link contract
        working-directory: clients/township-tauri-shell
        run: npm run deeplink:contract
```

…and so on for each green script. For the client package use
`working-directory: clients/lattice-client`.

Place `witness:preflight:contract` after the Linux prerequisites and the existing
`Tauri native command core` step. It must not run in the earlier pure-Node block.

Add a paired-feature package script and place its build plus
`tauri:witness-ceremony:smoke` in **`packaged_macos`** before
`Verify packaged stable-relay onboarding`:

```yaml
      - name: Build packaged governance test-presence variant
        working-directory: clients/township-tauri-shell
        run: npm run tauri:build:governance-test-presence

      - name: Verify packaged witness ceremony
        working-directory: clients/township-tauri-shell
        run: npm run tauri:witness-ceremony:smoke
```

The following stable-relay smoke rebuilds a dev-trace-only app before the existing no-build
packaged chain consumes it. Preserve that ordering.

**Verify**:

```sh
python3 -c "
import json,re,sys
wf=open('.github/workflows/flagship.yml').read()
scripts=['peer:contract','deeplink:contract','deeplink:source:contract','qr:contract','qr:camera:contract','discovery:contract','canonical:probe:contract','mobile:strategy','succession:review','succession:artifact','witness:artifact:contract','witness:preflight:contract','revocation:fixture:contract']
missing=[s for s in scripts if ('run '+s) not in wf]
print('MISSING FROM CI:', missing if missing else 'none')
"
```

→ `MISSING FROM CI: none`, except for any suite you reported as FAIL in step 5 (list those
explicitly in your report as deliberately withheld).

### Step 7: Correct the two documentation claims this plan makes true

In `AGENTS.md`:

1. The Layout table (`AGENTS.md:52-64`) has 9 rows for 10 apps — `apps/township_bench` is missing.
   Add a row for it. Keep the table's existing two-column shape and one-line-description style:

   ```
   | `apps/township_bench` | M4/G13 election cost-model benchmark harness; builds a Rustler NIF, so `cargo` must be on `PATH` |
   ```

2. In the "Safe vs. heavy commands" section (`AGENTS.md:78-84`), the heading claims
   "**Safe / local-only** (no network, no extra tooling)" and lists `mix compile` and `mix test`.
   That is false: `apps/township_bench/lib/township_bench/group_ops/native.ex:12` does
   `use Rustler, otp_app: :township_bench, crate: "townshipbench_groupops"`, which shells out to
   `cargo` at module-compile time. Amend the heading to name the requirement, e.g.
   "**Safe / local-only** (no network; requires `cargo` on `PATH` for the `township_bench` NIF)".

Do not make any other documentation edits — plan 164 owns the broader `AGENTS.md` work.

**Verify**:

```sh
grep -c '^| `apps/' AGENTS.md
```

→ `10`.

## Test plan

This plan adds one regression test for the umbrella-config gap and otherwise makes existing tests
execute. Verification is:

- The format gate demonstrably widens (step 2's deliberate-break check).
- Sobelow runs on both boundary apps (step 4's grep returns 2).
- The shared-config regression test proves a hard-coded fixture is detected and the real umbrella
  config is clean.
- Every previously-orphaned green suite appears in the workflow (step 6's check).
- The full local gate still passes:

```sh
~/.asdf/shims/mix check
```

→ exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix format --check-formatted` exits 0
- [ ] All three of `apps/lattice_carrier_server/.formatter.exs`, `apps/lattice_web_socket/.formatter.exs`, `apps/township_bench/.formatter.exs` exist
- [ ] The step-2 deliberate-break check fails the root format gate, and passes again after restore
- [ ] `grep -c 'mix sobelow --exit' .github/workflows/flagship.yml` → `2`
- [ ] `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit` exits 0 (with `.sobelow-conf` justifications if any)
- [ ] The Township Sobelow config enables the existing function-scoped skip and excludes no whole source file
- [ ] The shared-config security test detects a hard-coded fixture and passes against the real umbrella config
- [ ] `witness:preflight:contract` runs after Linux/native prerequisites, not in the pure-Node block
- [ ] The paired test-presence bundle is built immediately before the packaged witness ceremony, and the ordinary dev-trace rebuild remains before the remaining no-build smoke chain
- [ ] Step 6's Python check reports no missing scripts, except any explicitly reported as FAIL
- [ ] `grep -c '^| `apps/' AGENTS.md` → `10`
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 161 updated
- [ ] Your report lists, for every one of the fourteen suites, whether it passed and whether it was wired in

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts — in particular if
  `.github/workflows/flagship.yml` already contains a `township_web` Sobelow step, or if any of the
  three apps already has a `.formatter.exs`.
- **Any newly-enabled suite fails.** This is the most likely outcome and it is a real finding, not
  an obstacle to route around. Report the suite, the output, and your read on whether it is suite
  rot or a production bug. Do not fix production code in this plan.
- **Sobelow on `township_web` reports a finding you cannot justify suppressing in one concrete
  sentence** — especially anything in the `XSS`, `Traversal`, or `CSRF` families. Report it.
- Sobelow reports a `Config.*`-family finding at all. It structurally cannot (see the correction in
  step 3) — if one appears, the premise of that correction is wrong and the operator needs to know
  before you suppress anything.
- Adding a `.formatter.exs` reformats more than ~20 files in any single app — that suggests the app
  was never formatted and the churn deserves the operator's attention before it lands.
- You discover that a "device-free" suite actually spawns a device, an emulator, or a Tauri build
  (check for `spawn`, `execFile`, `adb`, `xcrun`, `tauri build` in the file). Report it and leave it
  out of the `unit` job.

## Maintenance notes

- **Reviewer focus**: the `.sobelow-conf` justifications (if any). A suppression without concrete
  reasoning about the specific guard that makes the code safe is how a scanner becomes decorative —
  which is precisely the failure this plan is fixing.
- **The `unit` job is now ~50 sequential steps** and has `timeout-minutes: 20`. If it starts timing
  out, the fix is to split the job into a matrix (Elixir / TS client / Tauri shell / lint), not to
  drop steps. Note the constraint: the "Regenerate TS oracle vectors" step depends on `mix test`
  having just forced a `:test`-env recompile in the same job (see the comment at
  `flagship.yml:118-125`), so the vector-producing stage and its consumers must stay together or
  exchange vectors as an artifact.
- **Deliberately deferred out of this plan**: normalizing the three different `sobelow` version
  constraints (`~> 0.13` in root `mix.exs:33` and `apps/lattice_server/mix.exs:35`, `~> 0.14` in
  `apps/township_web/mix.exs:40`); wiring `mobile:tauri-readiness` into CI (plan 166 splits that file
  first — wiring the current 5,322-line prose-pinning version into CI would be actively harmful);
  and adding a repo-root `.gitignore` entry for `.DS_Store` (currently ignored only via the
  developer's global gitignore).
- **When app #11 is added to the umbrella**, it will silently fall outside `mix format` again unless
  it ships a `.formatter.exs`. A cheap guard — a test asserting every `apps/*/` contains one — was
  considered and left out to keep this plan mechanical; add it if the gap recurs.
