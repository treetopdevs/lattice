# Plan 278: align Space initialization genesis shape

## Status

IN PROGRESS. A fresh signed three-runtime reproduction shows a malformed
non-delegation genesis dependency completing BEAM/native initialization while
TypeScript reports incomplete. Correct the shared source observation first,
then adopt its rule natively. Focused source tests, adversarial review and native
adoption now pass. Seven fresh cases in both delivery orders compare complete
actual runtime projections. Combined local and hosted gates remain required.

## Contract

Initialization is an observation of an existing authenticated Space log, not a
capability grant. Only an honored genesis carrying a decoded delegation can
serve as a creation's single initialization dependency. A malformed non-delegation
payload must not do so. Keep the valid root's command and projected name intact.
Preserve existing authority reasons and role-free genesis/pin replay behavior;
do not invent an author refusal or require role acquisition in this observer.
A valid role-bearing outsider replay still follows existing quarantine policy.
This is the bounded product initialization observation only; existing conservative
creation-preparation refusals and legacy-family arity behavior are unchanged.

## Scope and order

1. Reproduce the actual TypeScript/BEAM/native complete projection disagreement
   using fresh signed frames, valid creation capability and both input orders.
2. Add independent BEAM regressions for malformed root payloads and neutral
   role-free root/outsider controls. Refine only Space initialization's root
   shape predicate; do not change core authority, canonical or wire semantics.
3. Obtain an adversarial review of that source correction before adopting it
   in the native projection. Keep it as a distinct reviewed source commit.
4. Native projection counts decoded-delegation genesis frames under the same
   existing quarantine filter. Compare complete fresh public projections in all
   three runtimes, including legitimate, malformed, role-bearing outsider and
   role-free replay cases, both input orders. Root-author/role policy stays owned
   by the existing authority judge.
5. Run full repository, security and native ordinary/tracing checks and one
   exact-tip hosted gate. Update the parent plan and unified ledger; retain the
   bounded evaluator's non-claims about installed trust and ordinary relay use.

## Exit

All three runtimes agree on the complete projection for the regression corpus.
Malformed genesis dependencies cannot report ready; legitimate and neutral
controls retain their previous results. No capability or authority behavior is
broadened or narrowed. Plan 267 remains incomplete for retained trust and the
incoming/installation boundary.
