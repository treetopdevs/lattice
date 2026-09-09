# Treehouse roadmap handoff — 2026-09-07

## Stop instruction

The user explicitly requested: **save tokens, wrap up, stop, and make Markdown notes**.
Work stopped. All agents stopped; no local test/build sessions remain active.
Do not resume automatically. Hosted workflows already dispatched may finish on
GitHub, but no monitor or automation was created. No further merge was performed.

## Resume here

1. Read this file and the current repository AGENTS.md. Preserve all dirty work.
2. Treat native PR88 as merged at `495cf3b9c48cb89a6dad4ca7711a455f3c10db78`.
   Its six late review threads were dispositioned: five findings were repaired;
   one unsafe suggestion was rejected. Continue only with physical/custody and
   later release gates.
3. Finish the uncommitted operator PR89 review repair. **Do not merge PR89 just
   because its old tip is green: known P1/P2 inventory findings remain unfixed.**
4. Obtain independent Sol review of the quiesce WIP checkpoint before integrating.
5. Continue the strict merge queue: one pending main workflow at a time, exact
   tip check, merge-tree proof, merge-result workflow, then ledger updates.

## Working rules

- Root owns plans, execution ledger/evidence, workflows, shared integration,
  full checks, merge sequencing. Workers own isolated source slices.
- Each packet: immutable base, meaningful behavioral RED, implementation,
  focused GREEN, independent Sol review, root full checks, hosted tip and exact
  merge-result checks, honest remaining blockers.
- Keep R19b atomic; R36 is a separate native slice. QuickJS is off the critical path.
- User steering: after repeated difficulties, consider architectural redesign.
  Applied to native lifetime ownership, strict validator decoding, the single
  filesystem mutation owner, and release-level quiesce gating.
- Never convert local/hosted/build results into device, custody, production or pilot proof.
- Never overwrite unrelated work or clean/delete branches, worktrees or stashes.

Toolchain:

```sh
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check
```

Use asdf Mix/Elixir, never the broken mise shims. Install/build dependencies in a
fresh worktree before reciprocal tests: `clients/lattice-client` and
`clients/treehouse-tauri-shell`. Serialize full BEAM runs. Root shared build was
`/Users/nicholas/develop/lattice-treehouse-r19b-atomic-20260907/_build` (now free).
Android Rust requires Rustup stable rather than Homebrew Cargo; JDK 21 is at
`/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`.
Android SDK: `/Users/nicholas/Library/Android/sdk`; NDK `27.1.12297006`.
Root shared Cargo target (now free):
`/Users/nicholas/develop/lattice-treehouse-r36-plugin-boundary-20260907/clients/treehouse-tauri-shell/src-tauri/target`.

## Repository and completed merge queue

Repository: https://github.com/treetopdevs/lattice
Remote main at update: **495cf3b9c48cb89a6dad4ca7711a455f3c10db78**.
No main workflow was pending at the last check.

The primary checkout `/Users/nicholas/develop/lattice` is stale at
`9601f146db889f98c36bc3b203b6cb7ade8a4bc4`; do not use it as current main.
It has unrelated untracked `plans/180-group-first-roadmap.md` and `.html`, plus
this new handoff. Preserve all three. Active work is in the worktrees below.

Foundational packets R11/R12/R36 are merged, including journal/provider through
`b9671a5982e37511574432f1d43ad61cd5b149c4`; their main gates passed.
R12's full rebuilt-app local replay remains an external evidence gap despite its
merged foundations and hosted packaged checks.

R19b core BEAM/TS semantic train is CLOSED:
- PR85 merge `7256eb9b2e753f68074a729222488a906b3277c1`.
- Test-only renewal fixture repair PR86 merge
  `03f127f56f28c219439747ea2770778e5fef196e`.
- Exact main run `34149188715` SUCCESS. No production timeout increase.
- Core continuity is complete; enrollment/device/custody/pilot are not.

Catalog candidate store PR87 is CLOSED:
- Tip `69631a58ad91c51d39c6a8fdbb04886b5fec883c`.
- Tip run `34150528756` SUCCESS after failed-job retry. Initial failure was an
  unchanged carrier restart test; retained, not erased or patched speculatively.
- Merge **33af72ab5021233c65ab6767bc9a3dc7ba87ac21**.
- Exact tree `bb8d4122faa05a8fe510d85cd71d2ee26b7be6d3` matched.
- Main run **34153218509 SUCCESS**.
- Candidate whole-record CAS only; no native installed trust or route activation.

## Native PR88 — merged; physical and later gates remain open

PR: https://github.com/treetopdevs/lattice/pull/88
Worktree: `/Users/nicholas/develop/lattice-treehouse-r36-coordinator-20260907`
Branch: `codex/treehouse-r36-coordinator-20260907`
**Current/pushed tip: c96c08d6c196e2ea5af9cc4d21abe2ecd65f3941**.
Tracked clean; untracked `deps` symlink only.
Final repaired hosted run `34155719067` passed all required checks; the PR was
merged as **495cf3b9c48cb89a6dad4ca7711a455f3c10db78**. The exact post-merge
main workflow and tree are now the current main state above.
Previous tip `669c3ae3c92d8bba249771a3c1f958590339641e` run `34153067909` SUCCESS.
Superseded run `34152988136` was deliberately cancelled before that earlier tip.

Implemented: consolidated Rust/Kotlin flow, journal lease/generation fence,
private protocol and universal webview rejection, native review/CryptoObject,
signature/cancel/restart handling, five public witness commands and opt-in UI,
independent JVM validator with installed CLI, durable issuance/possession store,
pinned upstream attestation verifier and official-source trust snapshot repository.
Six preview commands remain alongside five witness commands on this branch.
R36 remains IN PROGRESS; outputs never make themselves eligible.

Six late hosted review threads arrived after the first green tip:
- `PRRT_kwDOSZGqLc6gAdzr`: Prepare/Generate lacked pending cancel IDs — FIXED.
- `PRRT_kwDOSZGqLc6gAdzt`: always acknowledge drain after close exception —
  REJECTED by both Sol reviewers. Clearing Java references does not prove OS
  file lock/channel release; keep admission closed until process/OS teardown.
- `PRRT_kwDOSZGqLc6gAdzv`: digit-bearing biometric error reason — FIXED to
  protocol-safe `biometric_error`.
- `PRRT_kwDOSZGqLc6gAdzw`: substituted retained context mislabeled bad packet — FIXED.
- `PRRT_kwDOSZGqLc6gAdzy`: unknown issuance mislabeled store outage — FIXED.
- `PRRT_kwDOSZGqLc6gAdzz`: cancellation after completion should be missing — FIXED.
**Threads were not resolved before stop.** Recheck source/comments, then resolve
with recorded dispositions after confirming final hosted tip. Full review JSON:
`/tmp/treehouse-r36-hosted-review.json`.

Repair commits:
- Rust `093feb37db9b61e004379db299059edaf0e306fa`: RED five failures, GREEN15
  flow tests; notice failure prevents dispatch; missing vs cancelled/poisoned
  cancellation states remain distinct. Independent Sol PASS.
- Kotlin author `e0df8615338b9306d6b137c301592afb79d98103`, integrated `56c3365d9`.
  RED17/1 failure; focused17 + lint PASS; independent other-Sol PASS.
- Validator author `1dde29ab9a5e39c2c38cd1e65d2f01bd615b1e94`, integrated `859a2933a`.
  Focused7 + full184/tamper PASS; independent other-Sol PASS. Nonce still spent
  durably BEFORE parsing. Store corruption remains distinct from caller errors.
- Merge `d3c9c1f4c3921c3387bf87cc80bc7fe50f6f4640` incorporates catalog main;
  tree equals its FIRST parent `859a2933a` (no source changes).
- Final integration/evidence `c96c08d6` independent Sol PASS, no P0–P2.

Final root checks PASS on repaired combined source:
- 119 Rust tests + 3 compile-fail docs; separate child helper not double-counted.
- Android Rust target compile.
- 150 Android host tests:149 executed,1 existing skip; lint.
- 184 JVM tests, upstream tamper verification, installDist, installed CLI smoke.
- 1,031 BEAM tests +27 properties,0 failures,3 existing exclusions; format/Credo.
Logs: `/tmp/treehouse-r36-hosted-repair-root-{rust,android,kotlin,validator,beam}.log`.
No local sessions remain. Previous unchanged preview/bridge build/tests passed.

PR88 is closed. Its merge proves the reviewed native source and hosted checks;
it does not prove an attached Android device, challenge freshness, protected
custody, production signing, physical witness ceremony, release, recovery or
pilot readiness.

Primary source evidence (in native worktree):
- `docs/research/evidence/treehouse-r36-private-coordination-20260907.md`
- `docs/research/evidence/treehouse-roadmap-integration-20260907.md`
- `plans/roadmaps/treehouse-unified-2026-09-06.md`
- Public/private contract docs under `docs/research/treehouse_witness_*`.
PR body saved at `/tmp/treehouse-r36-native-pr.md`.

## Operator PR89 — old tip green, known review gaps; DO NOT MERGE

PR: https://github.com/treetopdevs/lattice/pull/89
Integration worktree: `/Users/nicholas/develop/lattice-treehouse-operator-integration-20260907`
Branch: `codex/treehouse-operator-integration-20260907`
Tip: **23add70a92451e330d59718e30f6d69a03b00a42**, base catalog main33af72ab.
Tracked clean; untracked deps link. Run **34154410723 SUCCESS** at stop.
Root1051 tests+27 properties PASS,12 Linux skips,3 exclusions,format/Credo.
Hosted Linux1049+27 PASS,136 carrier tests, no Linux skips. Two extra local tests
only exist on non-Linux hosts. Actual mutation-owner/kill tests ran on Linux.

Architecture: same Python3 process owns flock AND every write/fsync/rename/reopen;
BEAM only validates staged signed bytes. No separate writer can survive lock loss.
Candidate-only carrier_pending, no activation. Author cumulative source
`efe2aee537c6ccaac1c3b538128b29fcef989cc1` was Sol reviewed, but late hosted
review exposed six additional inventory gaps. All six threads remain unresolved:
1. `PRRT_kwDOSZGqLc6gAqUy` P1: extra honored active grants omitted from review.
2. `PRRT_kwDOSZGqLc6gAqUz`: multiple children with one signed reference.
3. `PRRT_kwDOSZGqLc6gAqU1`: child root missing from bootstrap transport peers.
4. `PRRT_kwDOSZGqLc6gAqU2`: already-published reference treated as unpublished.
5. `PRRT_kwDOSZGqLc6gAqU4`: existing instance config can change beyond name/path.
6. `PRRT_kwDOSZGqLc6gAqU5`: duplicate active Space histories choose first roster.
Full comments: `/tmp/treehouse-operator-hosted-review.json`.
Evidence: `docs/research/evidence/treehouse-operator-candidate-staging-20260907.md`.

### Uncommitted repair to preserve and resume

Worktree: `/Users/nicholas/develop/lattice-treehouse-operator-hosted-repair-20260907`
Branch: `codex/treehouse-operator-hosted-repair-20260907`
Base/HEAD: **23add70a92451e330d59718e30f6d69a03b00a42**.
**Production staging.ex unchanged; NO fix or GREEN yet.**
Dirty tracked files:
- `apps/lattice_carrier_server/test/operator/semantic_staging_test.exs`
- `apps/lattice_carrier_server/test/support/operator/fixture.ex`
Untracked `_build` and `deps` symlinks point to the PRIMARY checkout. Do not run
concurrently against that shared build; use an isolated build on resumption.

RED `/tmp/treehouse-operator-hosted-repair-red.log`:11 tests/5 failures captured
five findings. Duplicate-Space fixture initially passed for the wrong reason;
fixture revised to put duplicate history into both manifests, NOT rerun after stop.
Next: confirm sixth RED, then coherent closed predicate: exactly one child,
reference and manifest; exact reviewed/all honored active grant equality;
child-root plus exact current-member peers; unpublished reference; full existing
instance configuration equality excluding positional `:ref`; exactly one active
Space history. Preserve signed authority semantics, never manufacture Space-root
membership. Focused/strict checks, commit, independent other-Sol review, root
checks, new hosted tip and merge result are all required.

## Quiesce WIP — local commit, not integrated/reviewed

Worktree: `/Users/nicholas/develop/lattice-treehouse-carrier-quiesce-20260907`
Branch: `codex/treehouse-carrier-quiesce-20260907`
Base: `efe2aee537c6ccaac1c3b538128b29fcef989cc1`
**WIP HEAD: 8720d29301d05eb39d12525105ef4394eb970c20**.
Tracked clean; only deps symlink. No running sessions, push or PR.

Architecture: release-incarnation gate above route children; all controlled
startup/restart paths acquire leases before restore/rehearsal/listener binding.
Application supervisor retains an atomics latch so replacement gate starts closed.
Actual Ranch transport listen callback is gated, including inner acceptor restart.
Controlled listener refs include application incarnation to avoid stale Ranch
transport options. Mixed configured-server boot remains supported but cannot
produce a manifest-complete drain receipt. In-flight relays may finish durably;
then exact log digests/frontiers are output, not guessed caller expectations.
DOWN during quiesce invalidates the attempt, never substitutes for worker drain.
Receipt is private live-incarnation observation, NOT activation authority.

RED actual valid relay accepted after gate close: `/tmp/release-quiesce-red.log`.
Final focused36 tests (16 new+20 compatibility) PASS:
`/tmp/release-quiesce-packet-green-final.log`.
Strict Credo/diff PASS: `/tmp/release-quiesce-packet-credo-final.log`.
**Next: independent Sol review immutable base..8720, then root full checks.**
No full suite, hosted Linux, controlled stop/seal, manifest activation or field proof.
Narrow source ownership includes application/runtime/Holder/Listener and
lattice_carrier_server.ex propagation plus new operator gate/quiesce modules.
Keep separate from the ongoing Staging repair.

## External/contract blockers and untouched work

- No attached Android device. Earlier question requesting two proposed device
  models is unanswered; do not repeatedly ask. Real Rust→Kotlin→journal→biometric
  operation→Rust refusal matrix, custody and R17c physical evidence are open.
- Validator owns durable random issuance and exact association but has no adopted
  challenge lifetime/clock/restart policy. Reports intentionally remain
  CHALLENGE_FRESHNESS_UNESTABLISHED. Do not reuse native120-second UI timeout.
  Fresh possession does not establish current package/device/boot state.
- R12 rebuilt local replay failed; historical successful packaged evidence does
  not resolve it. Worktree `/Users/nicholas/develop/lattice-treehouse-r12-20260906`
  at550193fc, log `/tmp/treehouse-r12-rebuilt-replay-20260907.log`. Computer-use
  inspection of SecurityAgent was refused; do not bypass or infer a prompt existed.
- QuickJS dirty experiment `/Users/nicholas/develop/lattice-treehouse-r11a-runtime-20260907`
  atb9354f45 is unreviewed; preserve Cargo/lock/probe/vendor changes untouched.
  Native R11 install/route activation/replacement remains blocked.
- R13 needs R01b +completed R11c +R12. R14 also needs R36. Protected signing,
  physical proof, recovery, release and pilot gates remain open. Do not mark the
  overall roadmap finished. Real pilot elapsed time cannot be synthesized.
- Do not normalize vendored upstream verifier bytes or gradlew.bat whitespace.
  Root-owned diff checks exclude vendor and that byte-exact wrapper.

Stopped agents: continuity_beam (quiesce author), native_audit (Sol; operator
repair author), review_foundations (Sol; available independent reviewer).
Other local repair worktrees are preserved: native hosted Kotlin e0df8615 and
validator1dde29ab. Do not delete any worktree or symlink blindly.
