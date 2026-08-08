# Branch Reconciliation & Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge every branch/worktree with worthwhile work into `main` via PRs, then delete every branch except `dev` and `main` and remove all extra worktrees.

**Architecture:** Three feature branches carry unmerged work (`codex/round4-security-reliability`, `codex/beta-android-distribution`, `codex/beta-product-isolation`); one branch carries WIP + uncommitted planning docs (`codex/plan077-ios-hardware`, the main checkout). All four merge cleanly against `origin/main` *individually*, but round4 and plan077 both add `plans/162`, `plans/165`, and `plans/README.md` — the single real conflict, resolved by merging round4 first and reconciling plan077's docs afterward. Three branches are already fully merged and just need deletion. `dev` does not exist yet and is created from final `main` at the end.

**Tech Stack:** git, `gh` CLI, `~/.asdf/shims/mix` (format/test loop), GitHub Actions flagship CI.

---

## Survey results (as of 2026-08-08, `origin/main` = `b1e6b88a`)

| Branch | Where | vs origin/main | Verdict |
|---|---|---|---|
| `codex/round4-security-reliability` | wt `lattice-round4` | **55 ahead** / 7 behind, **no remote** | Merge first (PR). Reviewed security/reliability work incl. Plan 165 completion. |
| `codex/beta-android-distribution` | wt `lattice-beta-android` | 6 ahead / 34 behind | Merge (PR). Android pilot signing + harness. |
| `codex/beta-product-isolation` | wt `lattice-beta-isolation` | 8 ahead / 34 behind | Merge (PR). lattice-mobile-core seam extraction. |
| `codex/plan077-ios-hardware` | main checkout (current) | 3 ahead / 7 behind + **uncommitted plan docs** | Merge last (PR) after docs reconciliation. |
| `codex/beta-carrier-runtime` | local + remote | 0 ahead (PR #35 merged) | Delete only. |
| `codex/beta-carrier-runtime-followup` | wt `lattice-beta-carrier` | 0 ahead (PR #36 merged) | Delete only. |
| `plan165-partb-work` | wt `.claude/worktrees/plan165-partb-work` | 0 ahead, but **dirty** config draft | Discard draft (superseded by round4), delete. |

Merge-tree checks: all four unmerged branches merge cleanly against `origin/main` today. The known post-round4 conflict is plan077's `plans/162-authority-root-binding.md`, `plans/165-boundary-hardening.md`, `plans/README.md` (both branches add/extend the same files).

**No open PRs exist. No other Claude sessions are running in this repo.**

### Decision points (defaults chosen; override before executing)

1. **Plan-number collision at 168** — two untracked files both claim 168 (`168-embedded-delegation-lease-commitment.md`, `168-fail-closed-input-validation.md`), and the second implicitly reserves 169–170, colliding with the existing 169/170 files. The uncommitted `plans/README.md` documents this and asks for a human decision. **Default:** keep `168-embedded-delegation-lease-commitment.md` as 168; renumber `168-fail-closed-input-validation.md` → **176**, updating its frontmatter deps and the README table, and fold its AUTHZ-02 item into plan 162 step 2b(e) (already noted there).
2. **`dev` branch does not exist** (locally or on origin). **Default:** create it from final `main` and push, since the request says keep `dev` and `main`.
3. **plan165-partb-work dirty config draft** (`config/config.exs`, `config/runtime.exs`) — a competing draft of the secret-key hardening that round4 already carries in reviewed, committed form (round4's version validates key sizes and covers PHX_SERVER; the draft's dev/test ephemeral-mint idea is unnecessary given round4's per-env `import_config`). **Default:** discard.
4. **Untracked `clients/township-tauri-shell/tsconfig.test.json` in `lattice-round4`** — referenced by nothing in the tree; looks like a stub for still-TODO plan 166. **Default:** discard (trivially recreatable; noted in plan 166).
5. **iOS WIP commit `764a1945`** on plan077 — already in `origin/main` (verified: `git merge-base --is-ancestor 764a1945 origin/main` succeeds); the plan077 diff vs `origin/main` contains only plan documents. **Default:** no probe scaffolding needs merging — the branch carries only the Wave A1 / Round 5 plan docs, so it merges last after docs reconciliation.

---

### Task 1: Push round4 to origin and open its PR

The branch has no upstream — it exists only on this machine. Push before anything else.

**Step 1: Verify the branch state**

```bash
git -C /Users/nicholas/develop/lattice-round4 status --short
```

Expected: only `?? clients/township-tauri-shell/tsconfig.test.json` (discard per Decision 4):

```bash
rm /Users/nicholas/develop/lattice-round4/clients/township-tauri-shell/tsconfig.test.json
```

**Step 2: Run the standard loop in the round4 worktree**

```bash
cd /Users/nicholas/develop/lattice-round4 && ~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test
```

Expected: clean format, green tests. (Run `mix compile` first if `_build` is stale — known quirk.)

**Step 3: Push and open the PR**

```bash
git -C /Users/nicholas/develop/lattice-round4 push -u origin codex/round4-security-reliability
```

```bash
gh pr create --head codex/round4-security-reliability --title "Round 4: security & reliability hardening (Plans 159–165)" --body "55 commits: client term validation/quarantine, CSP + signing-oracle constraints, relay rate bounding + throttle progress, committed-dev-secret removal (Plan 165), plan records. Supersedes the plan165-partb-work draft."
```

**Step 4: Wait for flagship CI, then merge**

```bash
gh pr checks codex/round4-security-reliability --watch
```

Expected: all checks pass. Then merge (merge commit, matching repo history style):

```bash
gh pr merge codex/round4-security-reliability --merge --delete-branch
```

`--delete-branch` removes the remote branch; local deletion happens in Task 6.

---

### Task 2: PR and merge `codex/beta-android-distribution`

**Step 1: Refresh against the new main and re-check for conflicts**

```bash
git fetch origin && git merge-tree --write-tree origin/main codex/beta-android-distribution
```

Expected: exits 0 (clean). If conflicts appeared (round4 touched the shell client too), merge main into the branch in its worktree and resolve:

```bash
cd /Users/nicholas/develop/lattice-beta-android && git merge origin/main
```

**Step 2: Run the loop**

```bash
cd /Users/nicholas/develop/lattice-beta-android && ~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test
```

**Step 3: Push (if merged main), open PR, watch CI, merge**

```bash
git -C /Users/nicholas/develop/lattice-beta-android push origin codex/beta-android-distribution
```

```bash
gh pr create --head codex/beta-android-distribution --title "Android pilot: fail-closed release signing + non-destructive Device A harness" --body "6 commits: RED contracts then pilot signing hardening, hosted pilot distribution job in flagship.yml, adb-behavior hardening."
```

```bash
gh pr checks codex/beta-android-distribution --watch && gh pr merge codex/beta-android-distribution --merge --delete-branch
```

---

### Task 3: PR and merge `codex/beta-product-isolation`

Same shape as Task 2. This branch and android both touch `clients/` — re-check after android lands.

**Step 1: Refresh and conflict-check**

```bash
git fetch origin && git merge-tree --write-tree origin/main codex/beta-product-isolation
```

If dirty, `cd /Users/nicholas/develop/lattice-beta-isolation && git merge origin/main` and resolve (prefer the branch's seam moves; the android branch shouldn't touch the moved signer/codec files, but verify with `git log origin/main -- clients/lattice-mobile-core`).

**Step 2: Loop**

```bash
cd /Users/nicholas/develop/lattice-beta-isolation && ~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test
```

**Step 3: Push, PR, CI, merge**

```bash
git -C /Users/nicholas/develop/lattice-beta-isolation push origin codex/beta-product-isolation
```

```bash
gh pr create --head codex/beta-product-isolation --title "Township: extract product-isolation seams into lattice-mobile-core" --body "8 commits: RED isolation/migration contracts, fail-closed SQLite product storage + manifest, native/pairing/deep-link/QR and signer/discovery-codec seams moved to lattice-mobile-core."
```

```bash
gh pr checks codex/beta-product-isolation --watch && gh pr merge codex/beta-product-isolation --merge --delete-branch
```

---

### Task 4: Reconcile and commit the Wave A1 plan docs on plan077 (main checkout)

This checkout (`/Users/nicholas/develop/lattice`, branch `codex/plan077-ios-hardware`) holds uncommitted work: modified `plans/162`/`plans/165`/`plans/README.md` plus 10 untracked plan files (168–175, with the 168 collision).

**Step 1: Resolve the 168 collision (Decision 1)**

```bash
git mv --force plans/168-fail-closed-input-validation.md plans/176-fail-closed-input-validation.md 2>/dev/null || mv plans/168-fail-closed-input-validation.md plans/176-fail-closed-input-validation.md
```

Then edit `plans/176-fail-closed-input-validation.md` frontmatter: retitle to 176, fix `depends_on` (it no longer precedes 169/170), and remove its AUTHZ-02 item if plan 162 step 2b(e) already owns it. Edit `plans/README.md`: delete the "🔴 UNRESOLVED: plan-number collision" section, add a 176 row to the table.

**Step 2: Merge the post-Task-3 main and reconcile the plan-doc conflict**

```bash
git fetch origin && git merge origin/main
```

Expected: conflicts in `plans/162-authority-root-binding.md`, `plans/165-boundary-hardening.md`, `plans/README.md` (round4 recorded Plan 163/165 completion; this side adds Round-5 mapping). Resolution rule: **union** — keep round4's completion/status records AND this side's Round-5/Wave-A1 additions. Resolve statuses per plan and step, not blanketly: round4's `DONE (Round 4)` wins for plans 161, 163, and 165 where it recorded completion, but preserve Plan 162's `DONE (Round 4; step 2b amendments PENDING re-execution)` status and its Round-5 `cap_ok/8` replica-binding / malformed-tick mapping, and leave 159 (DRAFT), 160 (PROPOSED), and 164 (TODO) at their non-DONE statuses.

**Step 3: Loop, then commit**

```bash
~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test
```

```bash
git add plans/ && git commit -m "docs(plans): map Round 5 hardening work and reconcile Round 4 records"
```

---

### Task 5: PR and merge `codex/plan077-ios-hardware`

**Step 1: Push and open the PR**

```bash
git push origin codex/plan077-ios-hardware
```

```bash
gh pr create --head codex/plan077-ios-hardware --title "Park plan 077 iOS probe work; map Round 5 hardening plans" --body "Parked device key-reuse probe scaffolding (iOS resumes after the Android candidate per plan 158) plus the Wave A1 / Round 5 plan docs (168–176), with the 168 numbering collision resolved."
```

**Step 2: CI, merge**

```bash
gh pr checks codex/plan077-ios-hardware --watch && gh pr merge codex/plan077-ios-hardware --merge --delete-branch
```

---

### Task 6: Remove worktrees and delete all local branches

**Step 1: Discard the superseded plan165 draft (Decision 3) and remove worktrees**

```bash
git -C /Users/nicholas/develop/lattice/.claude/worktrees/plan165-partb-work checkout -- config/config.exs config/runtime.exs
```

```bash
git worktree remove /Users/nicholas/develop/lattice/.claude/worktrees/plan165-partb-work && git worktree remove /Users/nicholas/develop/lattice-beta-carrier && git worktree remove /Users/nicholas/develop/lattice-beta-android && git worktree remove /Users/nicholas/develop/lattice-beta-isolation && git worktree remove /Users/nicholas/develop/lattice-round4
```

If a removal complains about untracked files, inspect (`git -C <wt> status --short`); only escalate to `--force` for files already covered by Decisions 3–4.

**Step 2: Switch the main checkout to main and prune**

```bash
git checkout main && git pull --ff-only && git fetch --prune
```

**Step 3: Delete local branches (verify merged first)**

```bash
for b in codex/plan077-ios-hardware codex/beta-android-distribution codex/beta-carrier-runtime codex/beta-carrier-runtime-followup codex/beta-product-isolation codex/round4-security-reliability plan165-partb-work; do git branch -d "$b"; done
```

Expected: every deletion succeeds with `-d` (all merged). A `-d` refusal means something didn't actually land — **stop and investigate, do not use `-D`.**

**Step 4: Delete any surviving remote branches**

`gh pr merge --delete-branch` should have removed them; sweep the stragglers:

```bash
matching=$(git branch -r | grep 'origin/codex/' | sed 's|^[[:space:]]*origin/||')
if [ -n "$matching" ]; then
  git push origin --delete $matching
else
  echo "no remote codex branches left"
fi
```

If `git push origin --delete` fails, the script exits nonzero — do not mask a deletion failure with the no-branches message. That message is printed only when no matching remote branches exist.

---

### Task 7: Create `dev` and final verification

**Step 1: Create `dev` from main (Decision 2)**

```bash
git checkout -b dev main && git push -u origin dev && git checkout main
```

**Step 2: Verify end state**

```bash
git worktree list && git branch -a -vv
```

Expected: one worktree (`/Users/nicholas/develop/lattice` on `main`), local branches exactly `main` + `dev`, remotes exactly `origin/main` + `origin/dev`.

**Step 3 (optional hygiene): review the 4 stale stashes**

```bash
git stash list
```

All four predate 2026-07-12 and reference dead branches (`claude/beautiful-gould-6b25d2`, `codex/m2-real-carrier-hardening`). Show each (`git stash show -p stash@{N}`); drop what's superseded. Leave them if in doubt — stashes don't block anything.

**Step 4: Final loop on main**

```bash
~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test
```

Expected: green — main now carries all four merged branches.
