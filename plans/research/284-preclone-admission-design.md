# Plan284 design decision: resource admission before cloning

## Status and dependency

APPROVED DESIGN. The operator approved early resource rejection for candidates
already outside existing limits; independent saved recovery still takes priority.
The approved engine-ceiling exception remains narrow and unchanged. This proposal
is a separate rule for candidates already outside existing logical resource bounds.
It does not explain or fix the intermittent rejection of a valid full-size input.
Execution remains under plan284; this document is a decision packet, not a new ledger.

## Preserved before-state

A real public-owner control uses an existing signed, valid installed snapshot and
an incoming catalog string of 67,108,865 ASCII bytes. With no decoration the owner
rejects `invalid_verified_history`. Adding a hidden accessor to the catalog array
changes the rejection to `malformed_catalog`; the accessor executes zero times.
The capture helper inspects that descriptor before the owner checks raw bounds.
An early resource refusal would therefore change observable refusal precedence.

Historical local control: /tmp/lattice-preclone-admission-contract-control.mjs
and its JSON receipt. The committed public-owner regression is
[ownership capture tests](../../clients/lattice-client/test/treehouse_catalog_input_capture.ts);
the new shared controls are in
[the reciprocal producer](../../clients/lattice-client/test/support/catalog_preclone_admission_peer.ts).
This is a priority control using an existing fixture, not fresh maximum-size parity
or a proposed implementation. Preserve both outcomes and the zero-getter count.

## Approved operator decision

For a candidate that exceeds the existing raw node, string or depth limits,
allow the resource refusal to take precedence over candidate diagnostics that
require walking beyond that limit, including hidden unsafe metadata or a later
foreign-family history. Use the existing `invalid_verified_history` reason.
Keep bounded outer request-shape checks first. Keep independent saved-state
recovery ahead of every candidate error. Do not introduce a new limit or reason.

Within the resource bounds, retain strict all-own-key/descriptor validation,
no-getter execution, cycle and nonplain-object refusal, and synchronous ownership.
Only the already-approved array engine-ceiling exception changes hidden metadata
handling there. Never read or copy decorations skipped by a resource refusal.
The refused candidate must produce no retained state or eligible routes.

The alternative is to preserve today's complete candidate diagnostic precedence.
That requires inspecting later metadata even after an over-limit condition is
known; a cheap early resource refusal cannot be installed under that contract.
Do not silently choose different behavior in a helper or native adapter.

## Implementation sequence

1. Create a separate managed source worktree from the latest gated source stack,
   keeping private Rust adoption and these diagnostic helper changes out of it.
2. Review the admission design before editing production code. Bind its accounting
   to the actual installed/incoming raw-bound wrappers; do not count unrelated
   expected-token fields against the incoming evidence allowance.
3. Add executable public-owner RED coverage for the approved precedence, alongside
   unchanged under-limit hidden-accessor and descriptor controls. Cover a late
   scope error behind an exhausted candidate budget and saved corruption competing
   with each candidate refusal. Compare complete decisions and getter counters.
4. Capture a bounded admission verdict synchronously, before any await. Over-limit
   saved input retains `trust_recovery_required`. Defer a refused candidate's
   verdict until independent saved authentication succeeds. No post-await caller
   reads, partial caller objects or saved-verdict trust are permitted.
5. Admit logical JSON occurrences, counting repeated aliases as the existing raw
   bound does. Stop over-depth wire JSON before growing an unbounded ancestor
   tracker. Under-limit inputs still undergo strict ownership validation and clone.
   Avoid a fully populated pending worklist and per-element descriptor arrays.
6. Preserve all original/candidate authentication, freeze/fallback, scope and
   complete-proof stages for admitted input. No Rust reason exception, fixture
   substitute, smaller cap or modified canonical/authority predicate is allowed.
7. Rebuild generated SDK output; run focused ownership, mutation, recovery and
   complete source-decision tests, SDK/desktop builds, full Mix checks and both
   HTTP-boundary scans. Obtain Sonnet5.5High or Argon4High adversarial review plus
   independent source review, and pass the exact-tip source PR gate.
8. Adopt only that gated source component privately. Repeat required native
   resource and full checks before publication; do not erase the original failure
   with a later passing run or claim this component repaired its unknown cause.

## Explicit limits and stops

The current control proves a refusal-order conflict, not a complete traversal
algorithm. In particular, hidden metadata whose JSON projection is small can still
require strict inspection; its work is not automatically bounded by JSON limits.
Do not claim requirement4 complete until this case and all large allocation sites
are accounted for. A broader decoration rule or separate inspection budget needs
its own explicit decision; neither is authorized by the recommendation above.

Stop for any changed behavior on admitted input, loss of saved-recovery priority,
new numeric/canonical/authority semantics, hidden getter execution or a new bound.
If the reviewed design cannot meet these conditions, return a concrete conflict
rather than implement a partial capture shortcut. Installation and real-relay
app proof remain under plans267/245.

## Implemented mechanism and remaining proof

The ownership walk now accounts for ordinary JSON data before cloning. One
bucketed weak-map cache stores compact subtree summaries, so repeated visible
aliases count at each occurrence without revisiting caller descriptors. Small
summaries use small integers; larger summaries use bigint, with field widths
computed from the existing bounds. Neither is an acceptance cap. UTF-8 accounting
uses no input-sized byte buffer. The expected token and incoming page keep one
ownership walk, with the budget rooted at incoming alone.

A resource sentinel is interpreted synchronously while capturing candidates.
Only that rejected path reads bounded cheap outer shape facts, without getters;
its final error is deferred until independent saved validation succeeds. Normal
inputs acquire no extra reflective preflight. Earlier descriptor failures still
win, including the existing over-width engine-exception failure. Only a proven
resource overflow outranks later errors.

BEAM distinguishes resource overflow from unreadable values internally, retaining
all existing boolean raw-bound API results. Its catalog owner applies the same
early resource priority after cheap headers and saved validation, then preserves
normal row/scope ordering for input that did not prove an overflow.

Sparse holes and non-enumerable slots still reach ordinary unreadable-input
validation. Ignored hidden metadata and enumerable array decorations are not
charged against JSON limits; the latter can still be copied by structuredClone.
Initialization, expected-token payloads, engine enumeration allocations and whole
owner costs therefore remain explicit requirement4 work. No broader decoration
rule, new quota or completed resource-envelope claim is implied.

Long immutable string byte lengths are cached per capture to avoid rescanning
shared text through distinct hidden objects. Cache buckets are storage only.
Resource exceptions are correlated to the current walk's own measured overflow;
a caller throwing a signal from a different capture retains ordinary refusal.

The [mutating-metadata decision](284-mutating-metadata-admission-decision.md)
now blocks publication: the current draft violates legacy callback behavior on a
fitting input, and an extra-read repair also changes observable outcomes. No
additional input precondition is assumed until the operator approves it.
