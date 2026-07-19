# Plan 154: Generate a self-contained HTML auditor report from a Township audit bundle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c9a05b40..HEAD -- apps/lattice_core/lib/township/ apps/lattice_core/lib/mix/tasks/ apps/lattice_core/test/township/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `c9a05b40`, 2026-07-18

## Why this matters

The Township audit bundle (`artifacts/township/`) is the project's "outsider-replayable"
evidence: `matter.log` plus deterministic JSON/DOT/Mermaid projections, verified by
`mix lattice.township.verify_bundle`. But its only human-readable rendering is the Phoenix
LiveView instrument — an actual outside auditor holding a bundle directory gets terminal
text and raw JSON. Meanwhile the operator demonstrably values polished, self-contained HTML
deliverables (`plans/toolshed_one_pager.html`, `plans/treehouse_one_pager.html`,
`docs/compute_to_data_review.html` are all hand-authored static HTML). This plan adds
`mix lattice.township.report`: verify a bundle, then emit **one static, dependency-free
HTML file** an auditor can open in any browser — verification verdict, materialized state,
current holders, the authority quarantine ledger with human explanations, and the
delegation/op-DAG evidence. It productizes the audit story the code already computes.

## Current state

Relevant files:

- `apps/lattice_core/lib/township/audit_bundle.ex` — writes/verifies the 7-file bundle.
  `verify/1` (line 60) restores `matter.log`, re-derives every projection, and returns
  `:ok | {:error, [String.t()]}`. The bundle file set is fixed (lines 16–25):
  `matter.log`, `state.json`, `audit.json`, `op_dag.json`, `trust_graph.dot`,
  `trust_graph.mermaid`, `manifest.json`.
- `apps/lattice_core/lib/township/read_model.ex` — `observe/2` (line 42) derives the
  instrument model from a log: `threads` (title/summary/posts/clerk_locked?), `roles`
  (`holders`, `quarantine`, `reasons`, `audit`), `members` (current + denied mutations),
  `attest`, `trust_graph` (`%{nodes: [...], edges: [...]}` of fingerprints), `op_dag`.
- `apps/lattice_core/lib/mix/tasks/lattice.township.verify_bundle.ex` — the existing
  verify task; the pattern to follow for option parsing and Mix.shell usage:

  ```elixir
  # lattice.township.verify_bundle.ex:15-31
  def run(argv) do
    {opts, rest, invalid} = OptionParser.parse(argv, strict: [dir: :string])

    case {opts[:dir], rest, invalid} do
      {dir, [], []} when is_binary(dir) and dir != "" -> verify(dir)
      _other -> Mix.raise("usage: mix lattice.township.verify_bundle --dir PATH")
    end
  end

  defp verify(dir) do
    case AuditBundle.verify(dir) do
      :ok ->
        Mix.shell().info("Township audit bundle verified: #{Path.expand(dir)}")

      {:error, errors} ->
        Mix.raise("Township audit bundle verification failed:\n- #{Enum.join(errors, "\n- ")}")
    end
  end
  ```

- `apps/lattice_core/lib/township/audit_bundle.ex:102-146` shows how projections are
  assembled from the read model (`state_json/1`, `audit_json/1`); `audit_json` emits
  `quarantine`, `reasons`, `audit` (ordered entries with `reason/op/event/role`), and
  `holders`.
- The LiveView refuses to render state from an unverified bundle
  (`apps/township_web/lib/township_web/instrument_live.ex:511` — "The audit bundle did
  not verify. No Township state … has been rendered."). The report must honor the same
  fail-closed rule.
- A demo bundle exists on disk at `artifacts/township/` (regenerate with
  `~/.asdf/shims/mix run scripts/township_demo.exs` if absent).
- Test pattern: `apps/lattice_core/test/township/audit_bundle_test.exs` — builds logs
  via `Lattice.Sim`, writes bundles to `tmp` dirs, asserts on `verify/1` results. Model
  the new tests after it.

Repo conventions that apply:

- All Elixir code is `mix format`-clean; `mix verify` enforces formatting + full tests.
- Quarantine reason atoms rendered to humans today are shown verbatim (e.g.
  `not_holder` at `instrument_live.html.heex:416`); this plan adds a plain-English
  gloss beside — never instead of — the exact atom.
- Modules under `apps/lattice_core/lib/township/` use plain functional style with
  `@moduledoc`/`@doc`/`@spec` on public functions. Match `audit_bundle.ex`.

## Commands you will need

Local toolchain rule (from `AGENTS.md`): `mix` on `PATH` is a broken mise shim — always
invoke `~/.asdf/shims/mix`, with the OTP 28 bins prepended for spawned tools:

```
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix <task>
```

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `~/.asdf/shims/mix format` | exit 0 |
| Focused tests | `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_report_test.exs` | all pass |
| Full gate | `~/.asdf/shims/mix verify` | format check + full suite green |
| Strict lint | `~/.asdf/shims/mix check` | verify + credo --strict green |
| Demo bundle | `~/.asdf/shims/mix run scripts/township_demo.exs` | narration ends, bundle written to `artifacts/township/` |

## Scope

**In scope** (the only files you should modify/create):

- `apps/lattice_core/lib/township/audit_report.ex` (create)
- `apps/lattice_core/lib/mix/tasks/lattice.township.report.ex` (create)
- `apps/lattice_core/test/township/audit_report_test.exs` (create)

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_core/lib/township/audit_bundle.ex` — the bundle format and verifier are
  frozen evidence contracts; the report is a downstream consumer only.
- `apps/lattice_core/lib/township/read_model.ex` and `apps/lattice_core/lib/lattice/authority.ex`
  — no new analysis surface in this plan (plan 157 owns that).
- `apps/township_web/**` — the LiveView instrument is unchanged (plan 155 owns it).
- `scripts/township_demo.exs` — do not auto-generate the report from the demo here;
  noted as follow-up in Maintenance.
- Anything under `apps/lattice_core/lib/township/election*` (plan 156 owns election
  reporting).

## Git workflow

- Branch: `advisor/154-township-audit-report-html` off the current branch.
- Commit style (from `git log`): conventional-ish, e.g.
  `feat(township): add HTML auditor report over the audit bundle`.
- Do NOT push or open a PR unless the operator instructed it.

## Design constraints (load-bearing)

1. **Fail closed.** The report renders state only after `AuditBundle.verify/1` returns
   `:ok`. On `{:error, errors}` the task must still succeed at writing a report, but that
   report contains ONLY a prominent failure banner and the verbatim error list — no state,
   holders, or graphs (mirrors `instrument_live.ex:511` behavior).
2. **Fully self-contained output.** One HTML file. No `<script>` tags, no external
   requests (no CDN mermaid, no fonts, no images). Inline `<style>` only. Graph evidence
   is rendered as semantic HTML (tables/lists of nodes and edges built from
   `ReadModel.observe/2`'s `trust_graph`) plus the verbatim `trust_graph.mermaid` and
   `trust_graph.dot` sources inside `<details><pre>` blocks so an auditor can paste them
   into any renderer.
3. **Deterministic.** Same bundle in → byte-identical HTML out (sort everything you
   iterate; no timestamps, no randomness). This lets tests assert stability and lets the
   report itself be re-derived by a skeptical auditor.
4. **Escape everything.** All log-derived strings (titles, posts, labels, fingerprints)
   pass through HTML-escaping before interpolation. Use a small private `escape/1`
   (replace `&`, `<`, `>`, `"`, `'`). Posts and labels are attacker-influenceable content.
5. **Honest labels.** Reason atoms appear verbatim, with a plain-English gloss from a
   module-attribute map for the reasons that exist today (see `Lattice.Authority`'s
   reject sites; unknown atoms fall back to the atom alone). The attestation panel must
   carry the existing caveat: `receipt_free? == false`, status `:stubbed` — never imply
   receipt-freeness.

## Steps

### Step 1: `Township.AuditReport` — verified-report data assembly

Create `apps/lattice_core/lib/township/audit_report.ex` with:

- `@spec render(String.t(), keyword()) :: {:ok, String.t()} | {:error, term()}` —
  `render(bundle_dir, opts)`:
  1. Run `Township.AuditBundle.verify(bundle_dir)`.
  2. On `{:error, errors}` → build the failure-only HTML (Step 2) and return
     `{:ok, html}` tagged internally as failed (the task in Step 3 uses the verdict for
     its exit message; simplest shape: return `{:ok, html, :verified | {:failed, errors}}`
     or expose a second function — pick one and document it).
  3. On `:ok` → `Lattice.Log.restore(Path.join(bundle_dir, "matter.log"))`, read labels
     from `manifest.json` (`Jason.decode!` then `Map.get(doc, "labels", %{})`), call
     `Township.ReadModel.observe(log, labels: labels)`, read the `trust_graph.mermaid`
     and `trust_graph.dot` files verbatim, and build the full HTML.
- Keep HTML assembly in private functions returning iodata, joined once at the end.

Sections of the verified report, in order:

1. Header: title "Township audit report", bundle path, `matter.log` SHA-256
   (`:crypto.hash(:sha256, File.read!(...)) |> Base.encode16(case: :lower)`), schema id
   `township-audit-bundle-v1`, and a green "VERIFIED — every projection re-derived from
   matter.log" banner.
2. Matter state: title, summary, clerk-locked flag, posts list, members list (from
   `read_model.threads` / `read_model.members.current`).
3. Roles: current holders table (`read_model.roles.holders`, sorted by role).
4. Authority quarantine ledger: one row per entry of `read_model.roles.audit`
   (fields `event`, `op`, `reason`, and `role` when present — `command_quarantine`
   entries have no `role` key), with the reason gloss. Also render
   `read_model.members.denied` as "denied member mutations".
5. Attestation: tally outcome, `receipt_free?` (always render the boolean), status,
   with the caveat sentence "The legacy attestation stub is not receipt-free and makes
   no coercion-resistance claim."
6. Trust graph: nodes table (fingerprint, label) and edges table (from → to, kind
   string) from `read_model.trust_graph`; then `<details>` blocks with the verbatim
   `.mermaid` and `.dot` file contents.
7. Op-DAG summary: counts of total ops, quarantined (`read_model.roles.quarantine`
   length), and the frontier ids (`Lattice.Log.frontier(log)`).

**Verify**: `~/.asdf/shims/mix compile` → exits 0, no warnings from the new module.

### Step 2: failure-only rendering

In the same module: when verification fails, the HTML contains the red banner
"NOT VERIFIED — this bundle failed replay verification", the verbatim error strings as a
list, and nothing else (assert no `<table>` and no state strings in the test).

**Verify**: `~/.asdf/shims/mix compile` → exits 0.

### Step 3: `mix lattice.township.report` task

Create `apps/lattice_core/lib/mix/tasks/lattice.township.report.ex` modeled directly on
`lattice.township.verify_bundle.ex` (same `OptionParser` shape):

- Options: `--dir PATH` (required), `--out PATH` (optional; default
  `Path.join(dir, "report.html")`).
- Behavior: call `Township.AuditReport.render(dir, [])`; write the HTML to `--out`;
  `Mix.shell().info` the output path and the verdict line. If verification failed,
  still write the failure report, then `Mix.raise` with the error list (exit non-zero,
  matching `verify_bundle`'s failure behavior) — the failure report on disk plus a
  non-zero exit is the intended contract.
- `@shortdoc "Render a Township audit bundle as a self-contained HTML report"`.

**Verify**:
`~/.asdf/shims/mix lattice.township.report --dir artifacts/township` →
prints the report path; `test -f artifacts/township/report.html` → exists;
`grep -c "<script" artifacts/township/report.html` → `0`.
(If `artifacts/township/` is missing, first run
`~/.asdf/shims/mix run scripts/township_demo.exs`.)
Note: `report.html` is not part of the frozen 7-file bundle set, so
`mix lattice.township.verify_bundle --dir artifacts/township` will now report an
extra file for that directory — this is why the default lands in the bundle dir but
tests must use a separate `--out`; see STOP condition 4 and the Maintenance note.

### Step 4: tests

Create `apps/lattice_core/test/township/audit_report_test.exs`, modeled on
`audit_bundle_test.exs` (build a Sim log, `AuditBundle.write/3` to a tmp dir):

1. **Verified report renders state**: bundle from a small Sim scenario (reuse the
   scenario shape from `audit_bundle_test.exs`); render; assert the HTML contains the
   VERIFIED banner, the matter title, each current holder fingerprint, and each
   quarantine reason atom present in the model.
2. **Failure report is state-free**: corrupt one projection file (e.g. append a byte to
   `state.json`); render; assert NOT VERIFIED banner, the mismatch error string, and
   that the matter title string does NOT appear.
3. **Determinism**: render the same bundle twice → byte-identical strings.
4. **Escaping**: drive a Sim command that writes a post containing
   `<img src=x onerror=alert(1)>`; assert the raw `<img` sequence does not appear in
   the HTML (the escaped form does).
5. **No scripts / no external refs**: assert the HTML contains no `<script` and no
   `http://` / `https://` substrings.
6. **Task integration**: run the report over a tmp bundle with `--out` pointing
   outside the bundle dir; assert the file exists; then assert
   `AuditBundle.verify(tmp_dir) == :ok` still holds (report generation must not
   perturb the bundle when `--out` is external).

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_report_test.exs`
→ all pass.

### Step 5: full gates

**Verify**: `~/.asdf/shims/mix verify` → green (format + full suite), then
`~/.asdf/shims/mix check` → green (adds credo --strict). Fix only issues introduced by
this plan's files.

## Test plan

Covered by Step 4 (six named cases). Structural pattern:
`apps/lattice_core/test/township/audit_bundle_test.exs`. Full-suite regression via
`mix verify`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_report_test.exs` exits 0 with the 6 cases above
- [ ] `~/.asdf/shims/mix verify` exits 0
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `~/.asdf/shims/mix lattice.township.report --dir artifacts/township` writes `artifacts/township/report.html`; `grep -c "<script" artifacts/township/report.html` prints `0`
- [ ] `git status` shows no modified files outside the in-scope list (untracked `artifacts/township/report.html` is acceptable; do not commit it)
- [ ] `plans/README.md` status row for 154 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `AuditBundle.verify/1`'s return shape or the 7-file set at
  `audit_bundle.ex:16-25` differs from the excerpts (bundle format drifted).
- `ReadModel.observe/2`'s result map lacks any of `threads`, `roles.audit`,
  `members.denied`, `trust_graph` (read-model drifted; plan 155/157 work may have
  landed first — reconcile before proceeding).
- You find yourself wanting to add fields to `Authority.analyze/2` or
  `ReadModel.observe/2` to make the report richer — that is plan 157's scope.
- `mix lattice.township.verify_bundle` on a bundle directory containing `report.html`
  is asserted anywhere in the existing test suite in a way the new default output
  breaks — if the full suite fails on bundle file-set checks, stop and report rather
  than changing `validate_file_set`.

## Maintenance notes

- **Report vs. bundle file-set**: the bundle verifier enforces an exact 7-file set, so a
  report written into a bundle dir makes that dir fail `verify_bundle` until the report
  is removed. If the operator wants `report.html` to live inside bundles permanently,
  that is a deliberate bundle-schema v2 change (touches `@artifact_entries` and the
  schema string) — a separate plan, not a drive-by.
- Follow-ups deliberately deferred: hooking report generation into
  `scripts/township_demo.exs`; an election-evidence section (plan 156); lease/beacon
  and role-chronology sections (plan 157 — once `Authority` exposes them, this report
  is their natural second consumer).
- Reviewer scrutiny: the escaping function (every interpolation site goes through it)
  and the fail-closed branch (no state leakage into failure reports).
