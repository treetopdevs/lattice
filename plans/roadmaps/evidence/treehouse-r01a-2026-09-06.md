# R01a core contract adoption evidence

Status: local verification and Claude Fable review passed; hosted tip and merge-result gates pending.

- Worktree: `/Users/nicholas/develop/lattice-treehouse-unified-20260906`.
- Proposal/base: `641cbbd78bf1338a4a245e5a670ad425aa79be1b`.
- Implementation: `7610cc9b2fab3acf21bf0b1b02db04a6b9a497c6`.
- PR: [59](https://github.com/treetopdevs/lattice/pull/59).
- Changed contracts: Plan 178 archive vocabulary, final denial precedence, causal archive semantics and root-only preview exception; dated Plan 158 order/dependency amendment; historical Plan 151/152/177 disposition; one-pager footnote; focused contract assertions and execution ledger.
- RED: contract suite 11 tests, two expected failures for the new ordered command and denial entries before their contract adoption. This transient RED state is recorded in the local run log, not as a separate commit.
- GREEN: `mix check`, 663 tests and 27 properties, zero failures, three existing exclusions, seed 28913. Final protected suites: 15 tests, zero failures, seed 753932. Local command uses the repository-prescribed asdf shims and OTP 28 path.
- Review: Claude Fable (`claude-fable-5`) reviewed the immutable base-to-implementation diff and returned PASS with no P0/P1. Its two P2 notes were documentation precision and cross-worktree ledger provenance. The wording now explicitly identifies the test-pinned Plan 158 paragraph about Plan 178. IN PROGRESS remains a preparation claim; sibling commits become integrated evidence only after their own gates.
- Review limitations: source review is not test execution. Hosted CI results are tracked separately. CodeRabbit initially skipped the draft; its success status does not constitute a review.
- Local raw evidence: `/tmp/lattice-treehouse-execution-20260906/r01a-red.log`, `r01a-check.log`, `r01a-pins.log`, and `fable-r01a-r05-review.json`. These paths are local convenience records; the reproducible commands, immutable changes and hosted run are the durable verification references.

This packet adopts contracts only. It proves no Treehouse implementation, Android custody, physical ceremony, founder recovery or community pilot.
