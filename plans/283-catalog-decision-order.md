# Plan 283: catalog decision ordering

## Status

The source ordering implementation is published. The current follow-up integrates
the operator-approved independent saved-witness-list correction. Integrated
review and a new exact-tip hosted gate remain before native adoption. The parent
saved-witness source gate is clear.
Run and review evidence lives in the source PR and running decision log.
The correction resolves observable collection-preflight, route-collision blame
and saved-fork witness precedence disagreements between the public owners.

## Decision and scope

Use the existing BEAM and native-chain stage order: parse and scope each catalog
in the complete saved-plus-incoming catalog collection before reducing duplicate
signed identities and detecting conflicting signatures. Preserve encounter order
within preflight, first raw JSON retention, signature verification before missing
parents, catalog-before-rotation collection handling, and original-only recovery
before candidate fallback. Preserve early authenticated security freezes.

Use canonical catalog-id order for historical route-reservation validation in
both owners, including maps above the small-map threshold. Preserve the first
validated saved fork witness when a later honored bootstrap also establishes a
fork, unless an existing stronger authority or control-limit rule supersedes it.
This matches the TypeScript/native first-witness rule and keeps routes closed.

Change the TypeScript catalog collection stage, with one parser/scope helper and
one subsequent merge, to match the existing BEAM contract. Do not move rotation
parsing ahead of catalog conflict handling or alter canonical bytes, signatures,
scopes, authority policy, reason enums, budgets, persistence or installation.
Tighten BEAM security-block merging to preserve the existing plain fork witness;
share the route-order rule explicitly rather than relying on runtime map order.

This is a separate protected source correction under plan267, independent of
numeric values (281) and saved-witness integrity (282). A generic native adapter
cannot make two conflicting complete source decisions equal.

## Implementation and proof

1. Preserve the exact two-order conflicting-signature/out-of-scope disagreement
   as an executable fresh public-owner RED. Use authentic retained history and a
   correctly signed foreign-scope record; only the duplicate signature is forged.
2. Preflight the complete catalog collection before duplicate insertion in the
   TypeScript owner. Reuse the same record/schema/scope and signature predicates;
   preserve the first raw representation and all original-only validation.
3. Compare full actual public decisions in both orders for duplicate signature
   plus later scope, malformed catalog and artifact-byte-limit faults. Add valid
   duplicates/whitespace aliases, saved permutations, invalid signatures plus
   missing parents, and malformed rotations to pin the stage boundary. Include
   authenticated authority freeze and graph-fork fallback controls. Independently
   BEAM-authored inputs must exercise the same full public owners. Add fully proven
   cross-history route conflicts whose new catalog sorts before old owners, and
   valid graph-fork then bootstrap-fork transitions in both delivery orders.
   Include more than32 catalogs so BEAM map layout cannot choose blame.
4. Run SDK build, focused trust vectors, full mix check and both boundary scans.
   Obtain requested Argon4High or authorized Sonnet5.5High adversarial review and
   independent source reviews; resolve findings and publish a dependent source PR.
   Pass one exact-tip hosted gate before native adoption.
5. Adopt the gated source in the native incoming worktree and use the same
   catalog-preflight/merge stage order. Replay the unchanged ordering RED and the
   existing complete-decision matrix. Preserve the native-only bounded
   page-shape/family priority correction from plan267; it is not a source change. Numeric adoption and aggregate
   resource/final gates still belong to their existing plans.

## Evidence placement

Keep request files, exact source outcomes, review dispositions and CI ids in the
running HTML log and source PR. This plan records the correction contract; it is
not evidence of completed source/native parity or installed app behavior.
