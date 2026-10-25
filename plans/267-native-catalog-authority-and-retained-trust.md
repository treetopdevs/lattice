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
retained structural rejections. All local checkpoint gates and independent review pass. The branch is refreshed
onto the codec's minimal parity correction with its cutoff implementation unchanged.
Earlier checkpoint hosted checks, including bounded roles, are green; requested
external review remains open. Full authority,
incoming/stored history integration and retained-trust logic are still unfinished. The full authority/evaluator and parity matrix below remain mandatory.

A third checkpoint adds the static delegation component: signature/id consistency,
root commitments, iterative chain attenuation, introduction-specific refusals,
conditional succession roots and causal revocation. Its private state is built only
from an authenticated DAG. It exposes neither active capabilities nor command or
route verdicts. Raw tuple collection follows the BEAM component; the final incoming
semantic normalization and portability gate remain mandatory, including TypeScript's
existing refusal of nonportable high logical ticks. No source oracle is changed.
Fresh BEAM/TS histories and Rust-authored chain/revoke cases exercise the actual
runtime owners. Expanded ordinary/dev-trace native, client build, shell typecheck/tests, full mix
check and both boundary scans pass. Standards review has no actionable finding;
the spec finding on authentic malformed tuples is fixed and independently confirmed.
Requested external review remains unavailable; the full evaluator remains unfinished.

A fourth checkpoint ports bounded role acquisition/transfer, heartbeats, root and
witnessed beacons, finite continuation profile selection, independently derived
witness claims, continuation scope/quorum/current-predecessor checks and causal
lease expiry. It is tested against freshly generated current BEAM/TS continuation
corpora, both delivery orders, and fresh Rust-authored renewals, witness refusals
and expiry-boundary histories consumed by both runtimes. Full ordinary/dev-trace native, client build, shell typecheck/tests, full mix
check and both boundary scans pass after the alias correction. Independent reviews
and focused alias confirmation have no remaining findings. Refreshed hosted and
requested external review remain open. The result remains raw authority evidence;
semantic normalization, command/application policy and retained catalog trust are
still unfinished. Raw BEAM classification of a witnessed epoch above JS's exact
horizon does not make that history portable: the final strict incoming boundary
must preserve the existing TypeScript refusal without changing either oracle.
A real-peer red regression also proved that normalized DAG dependencies alone lose
continuation evidence: both owners refuse a duplicate supplied dependency even
though its canonical op signature is valid. Retain the supplied list separately
from the signed normalized set, and use its sorted form only for expected-claim
comparison. Preserve that distinction through later raw-history persistence.

The alias experiment also proved an existing-owner consistency defect: the same
signed operation and cutoff can select different holders under unsigned header
multiplicity. Plan 268 owns its separate BEAM/TS correction and protected reviews.
Do not silently fix either oracle inside this port. Native expected-claim parity
must follow the corrected baseline only after that correction is reviewed/adopted;
the current checkpoint deliberately matches the current owners.

A fifth checkpoint adds all current Space/Thread command effect-field/role grammar
and the pre-application-policy gate: capability scope/validity/audience/grant scope,
introduction visibility, role grants, revocation, expiry and causal holder freshness.
Its opaque result explicitly reports `ApplicationPolicyRequired`, never final honor.
Fresh actual runtime cases exercise all refusal branches and effect metadata, with
reversed delivery and Rust-authored input consumed by both owners. Ordinary native
177/0, tracing 188/0, client build, desktop checks, full Mix check and both boundary
scans pass. Independent spec review found no mismatch; standards review confirmed
the shared runtime-launch helper correction. Incoming TS structural normalization, application
policy, CRDT projection and retained catalog trust remain mandatory unfinished work.
Plan 268's candidate correction is in separate draft PR 173; this port continues
using its current reviewed-source baseline until that correction is adopted.

A sixth checkpoint adds an authenticated product-reader portability proof. It
preserves raw number/text and absent/null distinctions, checks the full carrier vocabulary,
and mirrors strict integers plus legacy beacon, genesis beacon metadata and
witnessed certificate/claim contexts. Fresh BEAM/TS products and Rust-authored
boundary frames are checked by the actual TS strict reader. It reports readability
only; semantic normalization, application policy and catalog decisions remain
unfinished. Initial focused execution passes. Spec review found and corrected a narrower
cutoff-vocabulary reuse; all current wire names now exercise both readers.
Both reviewers confirm the correction. Client build, desktop checks, full Mix
check and both boundary scans pass. Final ordinary native 178/0 and tracing 189/0
pass after the review corrections.

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
