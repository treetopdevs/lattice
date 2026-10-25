# Plan 270: Treehouse text and malformed lineage parity

## Status

IN PROGRESS. The native evaluator's fresh application-policy corpus exposed a
source discrepancy. Keep plan 267's application-policy adoption open until this
separate source correction is reviewed and verified.

## Problem and decision

A signed `author_edit` with a non-text replacement is a malformed command in both
owners. If a later edit names that quarantined edit, BEAM follows its raw previous
target; TypeScript's semantic decoder has already refused those arguments. An
absent previous target therefore produces `application_target_not_visible` in
BEAM but `application_target_quarantined` in TypeScript.

A second fresh regression confirms that TypeScript silently strips leading U+FEFF
from binary product text while BEAM preserves it. Preserve every valid UTF-8 code
point, including this leading character, in product arguments and projection.

Lineage traversal must follow only structurally valid product edit commands.
Malformed commands remain authenticated history and remain quarantined; their
uninterpretable arguments cannot introduce further lineage targets. Keep ordinary
well-formed unauthorized edits traversable, preserving existing causal refusal
precedence. This aligns BEAM with the product semantic boundary without changing
wire encoding, signatures, capability checks or successful commands.

## Implementation and verification

1. Add a fresh signed cross-runtime regression for malformed replacement values,
   absent/concurrent predecessors, descendant edits, and well-formed controls.
2. Preserve leading U+FEFF during TypeScript product text decoding. Compare actual
   materialized posts as well as reason maps. Require UTF-8 text lineage ids in edit/tombstone effects, matching the strict
   product decoder. Before following a raw prior edit, require the existing effects
   grammar via the already final causal malformed-command verdict; avoid rescanning
   each prior body at every hop. Preserve the current seen-set cycle bound.
3. Verify full command reason maps against TypeScript in both delivery orders;
   malformed ancestors must retain `malformed_command` and descendants must refuse.
4. Run the prepared client build, full Mix check and both boundary security scans.
   Obtain independent and requested adversarial review, address findings, open a
   dependent PR, and pass an exact-tip hosted gate before native adoption.

## Scope

This is a source policy correction, not completion of the native evaluator,
retained catalog trust, installation, relay chat, or device proof. Preserve all
unrelated work and the frozen PR 174 head.
