# Frozen comparison inputs

These byte-for-byte snapshots preserve the working files used for the September 6 comparison.
They are archival source material, not additional executable plans. The authoritative execution
ledger is [the unified plan](../treehouse-unified-2026-09-06.md).

`SHA256SUMS` records every snapshot. Verify locally with `shasum -a 256 -c SHA256SUMS` from this
directory. The two roadmap hashes match those recorded when the comparison was first prepared.
The Opus review is historical; it did not review the unified proposal or its implementation.

Relative links, status statements and executor instructions inside these snapshots retain their
original source-directory context to preserve exact bytes. They are not current repository
instructions. Use the comparison's crosswalk and the unified ledger to find current source plans.
Original worktree provenance remains recorded in the comparison; no original file was changed.

## Catalog contract adoption

The [reviewed catalog contract](treehouse-catalog-reviewed-2026-09-06.md) is an
exact byte snapshot of `docs/research/treehouse_catalog_lifecycle.md` at local
review commit `789ab2353f8250a983573c33f600202b0b36b7c0`. The
[adoption patch](treehouse-catalog-adoption-2026-09-06.patch) preserves the complete
Git change at `0db817fa84d30808e3a6305e7b7f53c8866e7db4`: the adopted lifecycle
contract and dated Plan 158, Plan 178 and R02 founder-policy amendments. Both are
committed artifacts with hashes in `SHA256SUMS`; their contents remain readable
without access to either local source commit or an unpublished worktree.

These snapshots retain historical proposed/status wording. They document the
review and local adoption cited in the execution ledger, including exact default
values and C01–C15. They do not close those acceptance cases, make ongoing R11
implementation a landed prerequisite, or enable a route or profile. The eventual
R11 implementation packet must publish its final integrated contract and tests.
