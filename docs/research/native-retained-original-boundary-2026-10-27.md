# Native retained original-state boundary — 2026-10-27

## Reconciled source evidence

Live GitHub inspection confirms PR 172 merged at 2026-10-27T01:10:35Z into
`codex/treehouse-entry-proof-priority`, not main.

PR 186 remains open at `52d52f85be8e4722a269fad8542621c9c37c876e`.
Its exact-head browser and required Flagship checks succeeded:
- https://github.com/treetopdevs/lattice/actions/runs/40519064490
- https://github.com/treetopdevs/lattice/actions/runs/40519064474

PR 187 remains open, now at `4032b6abb07a039533e7b95a5cf4ad1d9206f3aa`,
superseding the previously reported `91bf02479` documentation head.
Its exact-head browser and required Flagship checks succeeded:
- https://github.com/treetopdevs/lattice/actions/runs/40546345630
- https://github.com/treetopdevs/lattice/actions/runs/40546345656

PR 186's review findings included mislabeled three-head controls and binding
indexes masked by valid catalog evidence. Replies identify the corresponding
source fixes in `ea4a2d7d0` and `db1850551`. The final documentation finding was
corrected in `52d52f85b`. PR 187's status wording finding was acknowledged as
resolved at `91bf02479`. GitHub review states are COMMENTED, not APPROVED;
review disposition, hosted validation, source adoption and native proof remain
different claims.

## Existing native adoption and this increment

The clean `treehouse-native-source-adoption` worktree at `aa758ed15` already
contains local source integration and native guards from `e920993c1`.
No source branch was merged during this investigation. The primary checkout's
iOS work remains untouched.

Existing executable matrices cover 102 saved-witness decisions, 36 ordering
decisions and 67 original-only replay requests. They use fresh signed producers
and both actual public source owners, then compare native results. Corrupt
catalog indexes, ancestor-related bindings, legitimate historical witnesses,
refusal precedence and incoming repairs remain in those producers.

The added `corrupt_saved_witnesses_never_open_incoming_evaluation` test reuses
all 102 saved-witness requests. For corrupt originals it supplies a closure that
panics if incoming evaluation begins, and a malformed expected token that must
not override recovery refusal. For valid historical controls it requires the
closure to execute. This proves ordering and reachability; existing full-decision
comparisons prove actual incoming repair behavior and cross-language parity.

Reproduce from this worktree with OTP 28 and Elixir 1.19 on PATH:

```sh
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
cargo test --locked --manifest-path clients/treehouse-tauri-shell/src-tauri/Cargo.toml --lib corrupt_saved_witnesses_never_open_incoming_evaluation
cargo test --locked --manifest-path clients/treehouse-tauri-shell/src-tauri/Cargo.toml --lib supplied_saved_witness_lists_match_both_actual_public_owners
cargo test --locked --manifest-path clients/treehouse-tauri-shell/src-tauri/Cargo.toml --lib source_catalog_decision_order_requires_agreement
cargo test --locked --manifest-path clients/treehouse-tauri-shell/src-tauri/Cargo.toml --lib complete_original_replay_matches_both_actual_public_owners_before_incoming
```

Prerequisites are installed locally: Cargo, Node/tsx, built test-environment BEAM
modules and the asdf toolchain. Missing prerequisites must fail, never substitute
a fixture verdict. Runtime signature/storage contracts and resource accounting
are unchanged. Parsed snapshots remain unverified. Aggregate resource closure,
native publication, installation readiness and relay/deployment proof are not
established by this increment.

## Validation of this increment

The new ordering regression passes in both ordinary and treehouse-dev-trace
builds. The existing 102-decision saved-witness parity, 67-request original-only
and 36-decision ordering regressions also pass in this session. No native
mismatch was found, so no runtime correction was required.
Rust formatting and diff-whitespace checks pass. An independent adversarial
static review found no actionable issue and explicitly limited the new test's
claim to call ordering; it did not claim to execute the tests.

## Full-suite publication preparation

Fresh complete native runs pass before the test-support-only relocation described
below. Both use normal concurrency and no top-level filters:

| Gate | Result |
| --- | --- |
| Ordinary native | 260 tests across 42 targets; 50 library tests; zero failures, ignores or top-level filters |
| Tracing native | 271 tests across 42 targets; 54 library tests; zero failures, ignores or top-level filters |
| Full `mix check` | 1,773 tests and 27 properties; zero failures; formatting and strict Credo pass |
| Client catalog trust | 57 pass; zero failures or skips |
| Client build and desktop build/typecheck | Pass |
| Full shell `npm test` | Initial product scan failure, then complete retry passes after the test-support relocation |
| Sobelow, both HTTP boundary apps | Both pass with the repository's documented `--exit --skip` invocation |

The separately launched catalog-store reopen child passes its one helper control
while filtering six unrelated child entries. All parent tests run; the child is
not double-counted. Mix retains its configured exclusions: the carrier app reports
190 skipped and two excluded; the stress app reports one excluded. No new skip,
filter, timeout or limit was introduced. Credo's configured nonblocking suggestions
remain suggestions; its strict command exits zero.

The initial shell run fails at `test/product_contract.mjs:67`: the raw-source
product scan prohibits `std::env` outside the gated dev-trace module. Three
fixture-control lookups had been added inside the retained module's `cfg(test)`
section. Move only their exact `var_os` lookup into existing test support and keep
the scan unchanged. The same environment names and `Option<OsString>` behavior
are preserved. Production runtime, wire, signature, storage and resource contracts
are unchanged. Adversarial review finds no issue in this relocation.

After that test-support-only move, both resource process regressions are rerun in
both ordinary and tracing variants, and every target is recompiled in both
variants. The complete native suites above are not represented as rerun after
that move. The full shell retry validates the final product boundary scan.

Full logs and structured summaries are retained under
`/tmp/lattice-original-boundary-full-*`. Preserve the first shell failure in that
record; the successful retry is `/tmp/lattice-original-boundary-shell-retry.log`.
Post-relocation resource and compile evidence is under
`/tmp/lattice-original-boundary-resource-retry-*` and
`/tmp/lattice-original-boundary-compile-final-*`. The two final boundary logs are
`/tmp/lattice-original-boundary-sobelow-lattice.log` and
`/tmp/lattice-original-boundary-sobelow-township.log`.

## Publication scope

Prepare the local `codex/treehouse-native-source-adoption` branch against source
PR 187's `codex/treehouse-catalog-decision-order` head. The dependent diff includes
the private retained fold and numeric/resource groundwork, not only the latest
regression. Local publication text is prepared separately; no push, PR creation,
source-branch merge or deployment is performed here. Source PRs 186 and 187 are
rechecked as OPEN at the same recorded heads.

A final exact-tip hosted native gate is still required after publication. Local
functional suites do not close density/pure-value/historical-view cost accounting,
the previously recorded intermittent maximum-source refusal investigation, or
installation/commit, real-relay and deployment readiness. Neither parsed snapshots
nor private validated evaluator owners become installed trust by this increment.


## First hosted attempt and CI allowance — 2026-10-28

PR 189 is published against PR 187's branch at native head `5bfbe3ade`.
Flagship run 40677839500's native job 122780767247 is cancelled by GitHub's
50-minute job limit; its Required checks aggregate fails. The annotation explicitly
reports maximum execution time;
this is not a passing native gate. All 50 library tests pass with zero failures,
ignores or filters in 2,677.68 seconds before integration testing begins.
Cancellation occurs during entry integration; the tracing command never starts.
All other required application/repository jobs pass, as does browser run
40677839299. The PR merge tree equals the submitted head tree
`519d052e185a53b0d3e722da9bb643da50df287f`.

Increase only the native job's CI allowance from 50 to 120 minutes so both
unfiltered variants can complete after setup. Two roughly 50-minute variants
plus setup cannot fit the old combined allowance. Keep the separate 15-minute
apt cap, test commands, concurrency, fixture producers and product limits
unchanged. This scheduling correction grants no resource-cost acceptance or
installation readiness. Preserve the cancelled attempt and run a fresh gate on
the new exact tip; do not reuse the old green jobs as final-tip evidence.

Two independent adversarial reviews find no actionable issue in this scheduling
change. YAML syntax and diff-whitespace checks pass. Neither review establishes
that the extended hosted run will finish; that verdict remains with the new gate.
