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

## Hosted review remediation

CodeRabbit and the hosted Codex reviewer identified missing archive-rule pins and the one-pager's
omitted author-tombstone refusal. The existing contract arrays now pin repeat authorization,
concurrent posts, moderator tombstones, retained routes/history/slots, no unarchive, finite-capacity
stop and rollover order. A focused RED run failed only on the omitted one-pager sentence (11 tests,
one failure, seed 874760); the copy now states all three refused author actions.

The hosted review also requested portable comparison inputs and unambiguous withdrawn statuses.
The two input roadmaps and historical Opus review are preserved byte-for-byte under `../sources/`,
with a verified hash manifest and an explicit archival-only note. The original two roadmap hashes
still match the original comparison. Plans 151/152 now put their former TODO text under a separate
historical-status heading. No additional LAN/CD1 work is enabled.

Final remediation gate: full local `mix check` exited 0, 663 tests and 27 properties,
zero failures, three existing exclusions; seed 871368. The added archive pins are contract
regressions; they do not claim the future R10 implementation exists. Hash verification passed
for all three archival inputs. Hosted checks must run again at the remediated tip.
