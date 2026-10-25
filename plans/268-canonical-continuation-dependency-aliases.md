# Plan 268: canonical continuation dependency aliases

## Status and scope

IN PROGRESS. Both expected-claim builders now normalize header dependencies.
Fresh reciprocal Space/Thread alias and refusal tests pass after independent RED
failures in BEAM and TS. Full mix check, all 17 local client CI suites, shell
typecheck/tests and both boundary scans pass. Both independent protected-core
reviews have no actionable findings. Requested provider review, hosted checks
and later native adoption remain open.

A protocol consistency defect was proved while implementing the native
bounded authority fold. This is a separate correction to the existing BEAM/TS
owners, not permission to change an oracle inside the native port. Execute it in
a fresh worktree from current main, preserve unrelated changes, and obtain the
protected-core reviews before adopting the corrected baseline in plan 267.

No host, ceremony, secret or device input is required. Native catalog installation,
carrier deployment, UI and physical custody are outside this correction.

## Concrete problem

The canonical op payload signs a sorted unique dependency set. Repeating a supplied
header dependency therefore preserves the signed op id and signature. Recovery
cutoffs also remain identical. Both current continuation judges nevertheless build
the expected witness claim from the sorted supplied list without deduplication.
A valid continuation becomes `invalid_continuation_certificate`, and its predecessor
becomes the reported current holder, solely because unsigned header multiplicity
changed. The same operation identity and cutoff must not select different authority.

The saved public reproduction is
`docs/research/evidence/treehouse-continuation-dependency-alias-2026-10-25.json`.
It contains disposable signed Treehouse.Thread histories and actual owner outputs;
it contains no private keys. Regenerate live inputs in tests rather than treating
saved verdicts as an oracle or a fallback when a runtime is missing.

## Recommended correction

Normalize only the *expected* continuation claim's header dependencies to a sorted
unique set, using the existing canonical dependency semantics in both owners:

- `apps/lattice_core/lib/lattice/authority/continuation.ex`, `expected_claim/7`.
- `clients/lattice-client/src/authority.ts`, `continuationExpectedClaim`.

Keep canonical bytes, op ids, signatures, wire tags, cutoff format, certificate
shape and reason vocabulary unchanged. Do not normalize a supplied *signed claim*:
its dependency list must still satisfy the existing sorted-unique claim contract.
Do not change generic wire acceptance or weaken witness, epoch, lease, predecessor,
role, scope, revocation or signature checks. Existing stored blocked-state and
recovery contracts keep their semantics; do not reset watermarks or sticky blocks.

The native port currently preserves supplied header dependencies to match the
uncorrected owners. After this correction is independently reviewed and adopted,
update its expected-claim construction and reciprocal alias expectations to the
corrected oracle. Remove representation used only for the old behavior if it no
longer has a real consumer. Do not import the unfinished native evaluator into
this standalone core correction PR.

## Ordered implementation

1. Reproduce in both real runtimes using fresh ordinary Treehouse Space and Thread
   continuation histories, with a different nominee or lease so acceptance is
   observable. Verify the original and aliased frames cryptographically.
2. Add RED metamorphic tests: duplicate and reordered header dependencies preserve
   canonical bytes, id, signature verification, cutoff bytes/digest, authority
   reasons, holder and acquisition. Include at least two independent dependencies
   so reordering is meaningful. Exercise both normal and reversed delivery.
3. Change the two expected-claim builders to sorted unique header dependencies.
   Keep all other predicates and refusal precedence intact.
4. Prove negative boundaries: a duplicate inside a signed certificate claim is
   still malformed; a genuinely new header dependency without re-signing fails
   authenticity; a re-signed new dependency with an unchanged certificate fails
   exact consent; wrong predecessor, epoch, lease, quorum and signatures still
   refuse. A repeated header cannot manufacture an extra causal ancestor.
5. Run executable reciprocal production and consumption through actual BEAM/TS
   owners, including the public product reproduction and the existing complete
   continuation/cutoff/trust matrices. Missing dependencies fail prerequisites.
6. Run client build/full tests, full mix check and both boundary security scans.
   Update the unified ledger and running HTML. Commit and open a separate PR;
   obtain requested Argon/Sonnet adversarial and independent protected-core review,
   resolve findings, and pass its final exact-tip hosted gate before merge.
7. Refresh the dependent native worktree onto the adopted correction, update native
   parity expectations in its own PR, rerun its required gates, and then resume
   full semantic projection and retained trust. This correction does not close 267.

## Exit and STOP

The same canonical op identity and cutoff produce the same continuation decision
for all tested header aliases in both owners. Genuine consent and causal changes
remain distinguishable and fail closed when their witnesses do not match.

STOP if the fix requires changing canonical bytes, wire grammar, valid signed-claim
shape, reason vocabulary, or relaxing a witness/scope/lease/predecessor check.
A different design must be recorded and reviewed rather than hidden in this patch.
