# Plan 277: isolate the growing Treehouse native CI budget

## Status

IN PROGRESS. Both native suites now have an independently prepared required job
with a bounded execution budget. The remaining unit job retains all other checks
and cold-install headroom. Local workflow validation and the aggregate result
matrix pass. Independent reviews are clear after fixing the aggregate runner's
checkout. Independent and adversarial findings are resolved; exact-tip hosted proof remains. Keep the
native checkpoint draft until its complete required workflow succeeds.

## Contract

Move the ordinary and development-trace Treehouse native suites into a separately
required bounded job. Keep both suites, their complete targets/features and real
BEAM/TypeScript peers. Preserve the full unit/property suite, all SDK/shell/vector
checks, enrollment sync, strict Credo and both boundary scans in their existing
job. Preserve the existing product path gates; native suites currently run on every
workflow and must continue to do so. Required checks must reject failure,
cancellation or unexpected skipping of either always-required job.

The new native job needs pinned BEAM/Node, Rust dependencies and authenticated
Linux prerequisites; real client and shell dependencies/build; test-environment
BEAM compilation for peer scripts; and separate Cargo cache ownership. Do not rely
on another runner's filesystem or a successful sibling job's build artifacts.
Keep cache verification and bounded install retries. Do not skip peers, use mock
fixtures, weaken assertions, retry an unchanged timeout or claim a cancelled job
passed. New cache keys must avoid competing writers with the existing unit job.

The committed before/after ownership inventory is
[treehouse-native-ci-step-inventory-2026-10-26.md](../docs/research/treehouse-native-ci-step-inventory-2026-10-26.md).
The first hosted run must establish actual cold-run timing; the explicit budgets
are provisional until that gate succeeds.

## Work order

1. Start from the latest gated shared source in an isolated managed worktree;
   preserve the native and source-correction worktrees and unrelated primary work.
   Inspect the actual timed-out job, annotation, step timings and workflow.
2. Extract only the two Treehouse native test steps. Create one dedicated native
   job with independently sufficient setup and an explicit bounded budget using
   observed warm timings plus provisional cold setup headroom. Keep suite invocations
   unchanged and sequential to share the Cargo build safely.
3. Add the new job to the required aggregate and enforce its success alongside
   unit even on docs-only changes. Keep all existing gated packaged requirements
   and fail-closed behavior. Record the complete before/after step inventory.
4. Validate YAML and workflow expressions with available tooling; exercise the
   aggregate success/failure/cancel/skip matrix without new prose/source-text
   pins. Verify all former checks have exactly one owner and no coverage loss.
5. Obtain independent specification/standards and actual Argon4High or
   Sonnet5.5High adversarial reviews because workflow changes require independent
   review. Commit and publish a focused PR, then pass one exact-tip hosted gate.
6. Adopt the gated workflow into the native checkpoint and obtain its own final
   required gate. This fixes CI execution capacity; it does not complete native
   retained trust or installed/real-relay readiness.
