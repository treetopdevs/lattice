# Plan 282: saved catalog-fork witness integrity

## Status

TODO; SOURCE STOP for native retained adoption. A fresh saved historical catalog
fork with a singleton blocked.catalogs index is rejected by TypeScript as
trust_recovery_required, but BEAM retains catalog_fork. The underlying signed
catalog graph still contains a fork; that does not prove the corrupted saved
witness index is valid. Keep the native original-only regression RED until the
protected source contract is independently corrected and hosted-gated.

## Decision and scope

Saved block indexes are authenticated-history witnesses, not a cached winner or
a license to substitute any current graph fork. Require each saved catalog ID to
have a conflicting partner in the saved catalog witness index; require recorded
binding witnesses to be mutually independent when they establish a fork or a
three-head control limit. Preserve the existing historical bootstrap-slice and
authority-refusal replay, canonical distinct indexes, pending-ID membership and
unadmitted overflow-trigger validation.

Tighten BEAM to the existing TypeScript witness contract; do not loosen TypeScript
or compensate in native. A historical fork remains valid when its named records
acquire descendants, so compare retained relations rather than current-head-list
equality. Changes affect corrupted saved metadata only and keep routes closed.
No canonical encoding, signature, artifact shape, wire admission, reason enum,
authority, incoming admission, storage or installed-trust change is intended.

This source disagreement is independent of plan281 JSON numeric interpretation.
Use a separate protected source gate rather than bundle witness-policy changes
into that normalization correction or a generic native compatibility layer.

## Implementation and proof

1. Preserve the fresh singleton witness disagreement as a public-owner RED
   assertion using exactly the same signed graph and saved input in both owners.
2. Validate saved catalog conflict partners and binding independence against the
   retained graph, following the current TypeScript rules. Keep bootstrap and
   authority witnesses and whole-page overflow trigger handling unchanged.
3. Compare complete fresh decisions in both delivery/index orders: valid catalog
   and binding forks, historical descendant growth, three-head control witnesses,
   overflow triggers, bootstrap forks and reopen. Corrupt singleton, unrelated,
   ancestor-related, duplicate/noncanonical and unknown indexes must require
   recovery before any incoming repair. Preserve accepted watermarks and no routes.
4. Run source trust regressions, SDK build, full mix check and both boundary scans.
   Obtain requested Argon4High / authorized Sonnet5.5High adversarial review plus
   independent source review, resolve findings, publish dependent PR and pass one
   exact-tip hosted gate before native adoption.
5. Replay the native original-only mutation matrix unchanged after adoption.
   Complete incoming decisions/resource/hosted gates remain plan267 work.

## Evidence placement

The running HTML decision log and source PR carry exact requests, SHAs, review
results and CI ids. This plan is the bounded implementation contract, not proof
that the source correction or native incoming evaluator is already complete.
