# Plan284 decision: metadata that changes input during capture

## Status and dependency

APPROVED on 2026-11-07. The operator chose stable input during synchronous capture
and explicitly preserved support for changes after the call returns. This decision
adds to the earlier engine-ceiling and early-resource-priority approvals.
The counterexamples below were measured against source draft
`769df3f8edb238b5cf1bc1b460e371b5f879d13c`.

## Executable conflict

A hidden metadata callback shrinks a shared2MiB payload and then creates40 aliases
to the now-empty object. The raw evidence fits both before and after the call:
encoded JSON2,103,454 bytes before and6,887 after; both actual raw-bound predicates
return true. The legacy owner returns the expected retained authority freeze.
The draft counts the old cached size at the later aliases and rejects overflow.
The callback executes once in both versions.

The previous-source production files were verified byte-for-byte against the
parent34465779cf253e908d22f5c74e2d741256cad377. The complete public decisions and
reproducer are retained as diagnostic evidence, not a substituted maximum fixture.
This is a new draft regression, separate from the older intermittent valid-MAX
source refusal.

A descriptor-only second pass fixes that example, but is observable. A second
control uses a visible Proxy that replaces itself with plain signed history on
its second metadata read. The legacy owner reads once and rejects malformed input.
The unpublished second-pass prototype reads twice and returns a retained-blocked
decision. This demonstrates changed capture behavior, not an authentication bypass
or installed trust: both retained-blocked decisions have closed eligibility.
The prototype was archived and all its helper/generated edits restored to769df3f8.
A subsequent run on that restored draft confirms one history probe and a
conservative invalid_verified_history rejection; the extra-read prototype alone
changes that control into a retained-blocked decision.

| Control | Legacy owner | Source draft | Extra-read prototype |
|---|---|---|---|
| Shrinking hidden alias | retain_blocked | reject/invalid_verified_history | retain_blocked |
| History changes on second probe | reject/malformed_catalog | reject/invalid_verified_history | retain_blocked |

The local `/tmp/lattice-preclone-mutated-alias-*` and
`/tmp/lattice-preclone-extra-probe-*` controls retain complete decisions, code
hashes and read counts. Their durable manifest is recorded in the running HTML.
The rejected prototype patch is preserved for review; it must not be published.

## Approved rule: stable synchronous capture input

Require captured values and their reported metadata structure to remain unchanged
while the synchronous ownership walk runs. Ordinary JSON data satisfies this.
Metadata callbacks that change that input are outside the supported profile and
may be conservatively refused even when the graph fits before and after the call.
This does not promise detection or rejection of every such mutation.

Keep the single metadata walk and current resource/error-priority implementation.
Do not add a confirmation read, freeze caller objects, ignore ordinary decorations,
change a limit/reason, or weaken any signature/authority predicate. Stable hidden
metadata still receives strict validation. Static accessors, symbols, cycles and
nonplain values retain their existing refusals.

Caller mutation after the function returns its Promise stays supported: both
origins are already captured before the first await, so later caller changes
cannot alter authentication or decisions. The proposed restriction is only on
callbacks changing the input while it is being inspected.

This rule addresses callback compatibility. Requirement 4 still covers ignored
data, copied array decorations, initialization and expected-token clones,
engine allocations and total owner cost.

## Alternative: preserve arbitrary legacy callback behavior

Keep this source component unpublished and redesign the capture boundary.
A callback can observe each metadata read, so an extra pass is not a transparent
repair. The current portable capture implementation discovers these Proxies at
structuredClone, while performing the large copy; no transparent replacement has
been demonstrated in this packet.
Do not solve that conflict with an unreviewed manual clone or a native exception.
A new compatible design must be demonstrated before changing production behavior.

## Source verification

Document the precondition at the public ownership boundary. Keep the regression
for changes after the call returns and exercise the reproduced conservative
refusal with one metadata inspection. Preserve the legacy and prototype
receipts as history. Run the source gates and refresh review before opening the
isolated source PR. Record hosted results on that PR.
