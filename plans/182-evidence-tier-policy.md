# Plan 182: Replace per-packet ceremony with a one-page evidence-tier policy in `plans/README.md`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c57c826ad..HEAD -- plans/README.md plans/roadmaps/treehouse-unified-2026-09-06.md`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live text before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (process policy; no source code)
- **Planned at**: commit `c57c826ad`, 2026-10-08 (Round 6 architecture audit)

## Why this matters

The Round 6 audit measured the evidence apparatus against the product it protects: `plans/` is
46,891 tracked lines, more than `apps/lattice_core/lib` (26,569); the Township shell carries 41,831
lines of tests for 12,190 of source; PR #104 landed about 3,000 product lines inside a +21,881
diff; 121 of 557 commits since August exist to answer review threads; 406 commits landed on
2026-09-06 and 20 in the following thirty days. Plan 179 went four review rounds (thread counts
7, 4, 2, 6) and grew from 1,151 to about 1,700 lines. Two Round 5c authority findings were marked
"fold into plan 162" on 2026-08-07 and plan 162 was never edited; they are still open in the code
(now plan 184). Every later plan in Round 6 produces less of this only if the rules change first,
which is why this plan is P0 and runs before plans 183–189.

This plan writes one policy section into the plan index. It changes no code and no test. It
supersedes, by reference, the per-packet closure ceremony in the unified roadmap and the
2026-09-07 handoff; those documents stay as history.

## Current state

- `plans/README.md` — the advisor index. Lines 1–11 are the header; lines 8–11 the toolchain
  reminder; lines 13–31 a long "Parked areas" paragraph ending `and W4 also remain.`; line 33
  begins `**Landing 001–009 as one effort?**`; the status table runs from line 40 (`| Plan | Title …`)
  to the row for plan 181 (line 223 at the planned-at commit); line 224 is the status legend
  `Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED (one-line rationale)`;
  line 226 begins `## ⚠️ Promotion blocker — \`apps/lattice_server\``.
- Four README rows are pinned byte-for-byte by tests and must survive this plan unchanged, each
  as exactly one line:
  - row 121: `| 121 | Township outsider-replay audit bundle | P1 | M | 012, 017 | DONE |`
    (pinned by `apps/lattice_core/test/township/audit_bundle_test.exs`, test "Plan 121 records the
    named outsider-replay gate without claiming UI completion", around line 200)
  - row 122: `| 122 | Township instrument read model | P1 | M | 121 | DONE |`
    (pinned by `apps/lattice_core/test/township/read_model_test.exs`, test "Plan 122 records the
    instrument read model without claiming rendered UI", around line 103)
  - row 178, beginning `| 178 | Treehouse Contract Correction: frozen text-only beta contract,`
    (pinned verbatim as `@readme_row` in `apps/lattice_core/test/treehouse/contract_test.exs:157-160`;
    the test also requires exactly one line starting with `| 178 |`)
  - row 181, beginning `| 181 | R13-lite Treehouse enrollment and sync over one hand-configured relay route`
    (`apps/lattice_core/test/treehouse/r13_lite_contract_test.exs`, test "the plan index appends
    exactly one row 181 and leaves row 178 alone": exactly one `| 181 |` line, six table cells,
    and it must be the line immediately after the `| 180 |` row)
- The ceremony being replaced is written in two places:
  - `plans/roadmaps/treehouse-unified-2026-09-06.md:163-173`, subsection "Work order and merge
    discipline", including: "Every packet closes with exact base/PR/merge SHAs, changed files, named
    tests and results, review findings and disposition, required PR-tip and merge-result checks,
    achieved evidence tier and remaining limitations. Each implementation packet receives an
    adversarial review of its exact diff; semantic fixes receive another review."
  - `TREEHOUSE_HANDOFF_2026-09-07.md:26-30`: "Each packet: immutable base, meaningful behavioral RED,
    implementation, focused GREEN, independent Sol review, root full checks, hosted tip and exact
    merge-result checks, honest remaining blockers."
- Repo conventions that apply: Markdown is not formatted by `mix format`; the index is
  append-only for rows; prose tests exist (see pins above), so edits are verified by running them.

## Commands you will need

| Purpose | Command (run from the repo root, after the `PATH` export in the toolchain note below) | Expected on success |
|---|---|---|
| Row 121 pin | `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_bundle_test.exs` | 0 failures (if the only failure mentions `township_bench` or `cargo`, see STOP conditions) |
| Row 122 pin | `~/.asdf/shims/mix test apps/lattice_core/test/township/read_model_test.exs` | 0 failures |
| Row 178 pin | `~/.asdf/shims/mix test apps/lattice_core/test/treehouse/contract_test.exs` | 0 failures |
| Row 181 pin | `~/.asdf/shims/mix test apps/lattice_core/test/treehouse/r13_lite_contract_test.exs` | 0 failures |
| Scope check | `git status --porcelain` | only `plans/README.md` (and, after step 3, `plans/roadmaps/treehouse-unified-2026-09-06.md`) |

Toolchain note from `AGENTS.md`: before any command in the table run
`export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"`
so the OTP 28 / Elixir 1.19 binaries win over Homebrew Erlang in spawned VMs, and invoke mix as
`~/.asdf/shims/mix`; `mix` on `PATH` is a broken mise shim on the primary machine. The four tests need the TypeScript client built once on a fresh
checkout (`npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build`).

## Scope

**In scope** (the only files you may modify):
- `plans/README.md` — insert one new section (step 1) and update this plan's status row (step 4).
- `plans/roadmaps/treehouse-unified-2026-09-06.md` — append one amendment paragraph (step 3).

**Out of scope** (do NOT touch):
- Any test file. The policy forbids new prose pins; it does not remove existing ones (plan 187 does).
- Any row of the status table other than row 182. In particular rows 121, 122, 178, 181.
- `TREEHOUSE_HANDOFF_2026-09-07.md` (a dated stop record; history).
- `AGENTS.md`, `CLAUDE.md`, `README.md`.

## Git workflow

- Branch: `advisor/182-evidence-tier-policy` from `origin/main`.
- One commit, message in the repo's conventional style, for example
  `docs(plans): adopt the Round 6 evidence-tier working policy`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Insert the policy section into `plans/README.md`

Insert the block below as new lines immediately after the paragraph that ends
`and W4 also remain.` (line 31 at the planned-at commit) and before the line beginning
`**Landing 001–009 as one effort?**`. Keep one blank line on each side. Insert it verbatim.

```markdown
## Working policy (Round 6, adopted 2026-10-08)

This section is the operating rule set for every plan, packet and PR from Round 6 on. It supersedes
the per-packet closure ceremony in `plans/roadmaps/treehouse-unified-2026-09-06.md` §3 ("Work order
and merge discipline") and the "Working rules" in `TREEHOUSE_HANDOFF_2026-09-07.md`; both stay as
history. Where an older plan's STOP conditions conflict with a rule here, the rule here wins and the
conflict is noted in that plan's status cell.

1. **Evidence tier equals claim tier.** Core claims need the unit/property suite plus vectors.
   Packaged claims need one hosted packaged job. Physical claims need a device evidence record. A PR
   claims exactly the tier its CI ran, in one sentence, and nothing above it.
2. **One hosted gate per PR.** The exact-tip run is the gate. A merge-result run is required only when
   the merge is not a fast-forward of a green tip, meaning `git merge-base --is-ancestor <tip> main`
   fails or the merge commit's tree differs from the tip's tree.
3. **Review proportional to blast radius.** Every implementation PR gets one adversarial review. A
   second independent review is required only for diffs under `apps/lattice_core/lib/lattice/authority.ex`,
   `apps/lattice_core/lib/lattice/authority/`, `canonical.ex`, `apps/lattice_core/lib/lattice/carrier/`,
   `clients/lattice-client/src/{authority,codec,carrier}.ts`, any `src-tauri/src` custody code, or
   `.github/workflows`. A review thread is fixed or rejected with one line. A third round on the same
   class of finding is a design question for the operator, not a fourth round of repairs.
4. **Plan files stop at 400 lines.** Evidence (SHAs, run ids, review dispositions) lives in the PR
   description and in one line of the index status cell, not in the plan.
5. **Status cells are one line.** At most 200 characters. Detail belongs in the plan's Status section.
6. **No new prose pins.** No new test may assert on sentences in a plan, README, roadmap, one-pager or
   on source text of another file. One exception until the claims registry (plan 187) exists: a new
   claim sentence may be pinned at most once, in the owning plan's own contract test, never in
   `plans/README.md`.
7. **"Folded into plan X" edits plan X in the same commit.** Otherwise the finding gets its own row.
8. **No plan whose exit needs an absent external input.** If done criteria require a physical device,
   a signing identity, a host or an operator approval that does not yet exist, the plan is written as a
   design plan with the named input in its Depends-on column and is parked until the input arrives.
9. **Ladders stop at three.** A fourth plan of the same shape (one more platform permutation, one more
   action rung, one more probe) needs an index note explaining why the generic form is impossible.
10. **Deprioritized products get no new work.** Township and Toolshed (until R26) receive no new plans;
    their rows are frozen and their CI is path-scoped (plan 183).
11. **No audit round over unplanned findings.** A new audit may not start while a prior round holds
    "record only" findings without a plan, ticket or dated rejection. Round 5c's SEC-01 and CRYPTO-01
    are now plan 184.
12. **One ledger.** The unified roadmap is the only execution ledger. A new roadmap supersedes its
    predecessors and marks them read-only in the same commit; it never stacks on them.
```

**Verify**: `grep -c "^## Working policy (Round 6, adopted 2026-10-08)$" plans/README.md` → `1`, and
`grep -n "^\*\*Landing 001–009 as one effort" plans/README.md` prints exactly one line whose number is
greater than the policy heading's line number.

### Step 2: Run the four pin tests

Run the four test commands from the table. All four must report 0 failures.

**Verify**: each command's final summary line reads `0 failures`.

### Step 3: Append the amendment note to the unified roadmap

Append the following paragraph at the end of subsection "Work order and merge discipline" in
`plans/roadmaps/treehouse-unified-2026-09-06.md`, that is, immediately after the paragraph that ends
`is recorded as a blocker, not a passing check.` (line 173 at the planned-at commit) and before the
heading `## 4. Product behavior that must survive the synthesis`. Insert it verbatim, with a blank
line before and after.

```markdown
Amendment 2026-10-08 (Plan 182): the closure, review and hosted-run requirements in this subsection
are superseded by the "Working policy (Round 6)" section of `plans/README.md`. One exact-tip hosted
run gates a PR; a merge-result run is required only for a non-fast-forward merge; a second
independent review is required only for the files that policy names. Packet status vocabulary
(PLANNED, IN PROGRESS, LOCAL VERIFIED, DONE) and the evidence tiers (Core, Packaged, Physical)
are unchanged.
```

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/treehouse/r13_lite_contract_test.exs` →
0 failures (that test reads the roadmap; an appended paragraph must not disturb its R13-lite rows).

### Step 4: Update this plan's row

Change the status cell of row 182 in the table to `DONE (2026-10-08; policy section at the top of the
index)`. Do not touch any other row.

**Verify**: `grep -c "^| 182 |" plans/README.md` → `1`; `git status --porcelain` lists exactly the two
in-scope files.

## Test plan

No new tests (rule 6). Verification is the four existing pin tests plus the grep checks above.

## Done criteria

ALL must hold:

- [ ] `grep -c "^## Working policy (Round 6, adopted 2026-10-08)$" plans/README.md` prints `1`
- [ ] the four pin tests exit with 0 failures
- [ ] `grep -c "^| 178 |" plans/README.md` prints `1` and `grep -c "^| 181 |" plans/README.md` prints `1`
- [ ] `git diff --stat` touches only `plans/README.md` and `plans/roadmaps/treehouse-unified-2026-09-06.md`
- [ ] `plans/README.md` row 182 reads DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Any of the four pinned rows is no longer present as exactly one line after your edit (you edited
  more than the insertion point; revert and retry once, then stop).
- `audit_bundle_test.exs` fails for a reason other than a missing `cargo`/`township_bench` build
  (that specific failure is a known environment limitation recorded in
  `apps/lattice_popcorn_spike/verification.md`; report it and treat the row-121 assertion as verified
  by `grep -c "^| 121 | Township outsider-replay audit bundle | P1 | M | 012, 017 | DONE |$" plans/README.md` → `1`).
- The roadmap subsection text at lines 163–173 differs from the quoted sentence in "Current state".
- You are asked, by anyone or anything other than this plan, to also edit a test.

## Maintenance notes

- Plan 187 (claims as data) will remove the existing prose pins; rule 6 only stops new ones.
- Plan 183 is the first plan written under this policy; its status cell must fit rule 5.
- If the operator later changes a threshold (400 lines, 200 characters, the second-review file list),
  edit the policy section in place and add a dated line under it; do not create a second policy.
