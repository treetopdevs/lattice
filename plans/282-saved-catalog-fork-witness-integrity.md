# Plan 282: saved catalog-trust witness integrity

## Status

IN PROGRESS; the operator-approved source correction is reviewed and hosted-gated.
The original reproduction showed TypeScript rejecting a saved historical catalog
fork with a singleton blocked.catalogs index while BEAM retained catalog_fork.
An underlying signed graph fork does not prove that its saved witness index is
valid. Both source owners now independently validate all supplied witness lists.
Native adoption, the unchanged original-only regression and remaining plan267
proof are still required. The dependent ordering integration retains its own
review and hosted gates. Evidence is recorded in the PR and running decision log.

## Decision and scope

Saved block indexes are authenticated-history witnesses, not a cached winner or
a license to substitute any current graph fork. Require each saved catalog ID to
have a conflicting partner in the saved catalog witness index; require recorded
binding witnesses to be mutually independent whenever multiple are supplied,
even alongside a genuine catalog or bootstrap fork. A catalog fork allows at most
two named bindings; with no catalog or bootstrap witness it requires exactly two.
A three-head control witness mislabeled as a catalog fork requires recovery in both
source owners. Genuine zero- or one-binding catalog forks remain valid. Require each authority
witness to name a nonempty historical frontier and refused-op index; the enclosing op
index must equal the combined named targets. A rotation overflow trigger cannot
name an already installed binding, including the bootstrap. Preserve historical
bootstrap-slice and authority-refusal replay, canonical distinct indexes,
pending-ID membership and unadmitted overflow budget validation.

Tighten BEAM to the TypeScript witness contract and tighten both owners for
independently invalid witness lists or misclassified binding counts; do not loosen TypeScript
or compensate in native. A historical fork remains valid when its named records
acquire descendants, so compare retained relations rather than current-head-list
equality. Changes affect corrupted saved metadata only and keep routes closed.
No canonical encoding, signature, artifact shape, wire admission, reason enum,
authority policy, incoming admission or storage change is intended.
The metadata guards reject unsupported saved witnesses; authentic historical
authority replay is unchanged.

This source disagreement is independent of plan281 JSON numeric interpretation.
Use a separate protected source gate rather than bundle witness-policy changes
into that normalization correction or a generic native compatibility layer.

## Implementation and proof

1. Preserve the fresh singleton witness disagreement as a public-owner RED
   assertion using exactly the same signed graph and saved input in both owners.
2. Validate saved catalog conflict partners and binding independence against the
   retained graph, following the current TypeScript rules. Cache each named catalog
   ancestor set
   and rotation-prior index once; detect a named binding ancestor with one bounded
   walk per binding. Keep valid bootstrap/authority replay and whole-page overflow
   behavior unchanged; reject empty authority witnesses and installed triggers.
3. Compare complete fresh decisions in both delivery/index orders: valid catalog
   and binding forks, historical descendant growth, three-head control witnesses,
   overflow triggers, bootstrap forks and reopen. Corrupt singleton, unrelated,
   ancestor-related, duplicate/noncanonical and unknown indexes must require
   recovery before any incoming repair. Include exact rotation-prior ancestor
   pairs, valid binding witnesses combined with corrupt catalog witnesses,
   genuine catalog/bootstrap witnesses combined with ancestor-related bindings,
   genuine catalog witnesses combined with relabeled three-head controls,
   valid mixed witness lists, zero/one-binding catalog forks, genuine
   authority replay, empty witnesses and installed-bootstrap triggers. A 340-record
   late-rotation witness must reopen within 60 seconds per actual BEAM call. This
   is a generous smoke guard for one bounded case, not a tight performance
   regression threshold or full native peak-cost closure. Preserve
   accepted watermarks and no routes.
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
