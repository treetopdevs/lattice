# Plan 267: native catalog authority and retained trust

## Status and dependency

IN PROGRESS: implements plan 245 build PR 3. The worktree starts at the latest
committed codec PR #170 tip, which contains the current main. This is an explicit
pending dependency, not merged implementation or a native trust claim. Keep later
PRs based on the codec branch until its required external review and merge finish;
then rebase onto the verified main and run the exact-tip gate.

The first implementation checkpoint is an authenticated DAG for the later fold;
it is implemented, locally checked and independently reviewed.
It supplies signature/hash verification, causal closure, deterministic order and
read-only ancestor queries. It deliberately cannot report authority, membership,
a catalog decision or a route. Completing that checkpoint does not complete this
plan. Portable cutoff observation is also implemented as a second checkpoint:
real BEAM/TS owners agree on exact canonical bytes and refusal precedence, including
retained structural rejections. Full local final gates and checkpoint review are
still pending. The full authority/evaluator and parity matrix below remain mandatory.

## Outcome and immutable contracts

Rust independently evaluates the complete raw evidence and retained catalog state
with the same decisions, reasons, routes, blocked records and retained snapshots as
BEAM and TS. Reuse plan 265's canonical/frame/catalog verification; never trust a
webview-supplied honor flag, decoded authority result or saved route. No IPC,
storage, custody, route installation or carrier dial is introduced here.

Read AGENTS.md, plans/README.md, plan 245 Designs A-D and build PR 3, the retained
trust research contract, both current CatalogTrust implementations and their
actual authority/continuation/cutoff owners. Existing canonical bytes, wire terms,
trust reasons and authority semantics are parity oracles, not editable targets.

## Implementation order

1. Authenticate every frame before returning a missing-dependency result. Require
   exact replica, unique ids and complete DAG closure. Normalize dependencies only
   as the existing canonical frame codec does. Kahn order uses ascending signed id
   among ready frames. Use iterative ancestor walks; do not allocate an unbounded
   transitive-closure matrix. Preserve author/kind/deps from verified payloads.
2. Port closed raw history and portable cutoff observation, including structural
   bad-signature evidence. Good signatures cannot be relabeled as rejected, and
   unknown signed vocabulary remains retained but refuses portable judgment.
   Distinguish incoming pending/invalid/unsupported from stored recovery failures.
3. Port the authority fold: root commitment, genesis/delegation validation and
   attenuation, causal revoke rules, roles/admin succession, continuation pins,
   witnessed leases/beacons/certificates, acquisition, transfer and expiry. Reuse
   the full current predicates; a root-only or selected-fixture approximation is
   not an acceptable final evaluator.
4. Port Treehouse Space/Thread semantic normalization needed for the current
   projection: creation, reference, catalog bootstrap/replacement, membership,
   grants and post/moderation effects. Preserve quarantine and causal precedence.
5. Port catalog entries and graph trust: explicit bootstrap review, exact inventory,
   route/service reservation, linear/forked chains, rotation/cutoff proofs, pending
   dependencies, rollback, historical authority witnesses and sticky blocked state.
   Preserve accepted watermarks on incomplete evidence and emit no blocked routes.
6. Add executable reciprocal peers: fresh BEAM/TS inputs consumed by Rust, fresh
   Rust inputs consumed by both actual runtimes. Replay the complete current trust
   fixture matrix and compare full decisions, reasons, routes and retained state.
   Missing prerequisites fail; no saved verdict or fixture fallback substitutes.
7. Run exact resource boundaries, full ordinary/dev-trace Rust, client build,
   shell typecheck/tests, full mix check and both boundary scans. Obtain requested
   Argon/Sonnet adversarial and independent native reviews, resolve findings, open
   the dependent PR and pass one final exact-tip hosted gate before completion.

## Resources and acceptance

Retain 128 KiB artifact, 1,024/16 MiB artifact-store, 64,000-byte push-frame,
64 MiB transport and 32 MiB retained snapshot limits. Canonical terms retain the
existing depth/node limits. Bound complete-input parsing before allocation without
clipping evaluator-valid maximum-size history. Frame-set authentication accounts
for encoded frame bytes and array separators before allocating verified state.
Whole-page parsing and persisted snapshot checks remain separate later seams.
Raw-observation JSON has fixed 64 MiB input/node and wrapper-depth-136 bounds;
it can retain malformed scalar types only to classify a refusal. A separate internal
canonical observation context permits 128 MiB of temporary output and 64 MiB nodes.
This accommodates aggregate cutoff records without widening public artifact bounds.
Operation payload encoding permits one wrapper level above its depth-64 domain terms.
Fresh depth-limit and large signed-observation peers must prove byte parity. Empty
delegation text is representable data in both existing codecs; retain it for later
authority refusal instead of confusing shape with a semantic grant.

Tests must include fork delivery in both orders, rollback, blocked/pending states,
authorized and refused rotations, revoked and beacon-lapsed references, reserved
route/service drift and inventory growth. Malformed, duplicate, forged partial,
wrong-replica and absent-dependency histories need distinct exact refusals. Reopen
and mutation cases must compare actual runtime results, not merely JSON shape.

STOP and record the discrepancy if correct parity would require changing core
canonical encoding, wire grammar, catalog reasons or authority semantics. A source
bug needs its own reviewed correction, not a compensating Rust shortcut.

This earns pure native evaluator parity only. Native owner/commit tokens and
installed receipts remain plan 245 PR 5; ordinary UI/probe/CSP gates remain PRs 6-7.
Physical custody, operator ceremony and the public two-app field run stay separate.
