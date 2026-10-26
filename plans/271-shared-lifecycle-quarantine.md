# Plan 271: shared lifecycle quarantine

## Status

IN PROGRESS. A fresh native Thread-policy review exposed a missing noncommand
quarantine rule in TypeScript as well as native code. Keep plan 267's full policy
claim open until this source correction is reviewed, verified and adopted.

## Contract

Lifecycle operations with kind `tombstone` are distinct from Treehouse post-delete
commands. BEAM honors lifecycle tombstones only from the cryptographically bound
replica root. A delegated role or command capability cannot confer this power.
TypeScript must apply that existing root-only rule in its shared quarantine
predicate for every product, preserving authenticated frame identity and bytes.

When a Thread command names a nonroot lifecycle tombstone as a visible lineage
target, quarantine precedes target type: refuse `application_target_quarantined`.
A root-authored lifecycle tombstone remains an honored wrong-type target and
refuses `application_wrong_target`. Missing targets retain visibility precedence.
With no verified root, no author can supply an honored lifecycle tombstone.

## Work

1. Add fresh root/nonroot/no-root signed histories and descendants. Compare the
   complete actual quarantine maps, not only the descendant command's reason.
   Include root-capability citations and delegated participants as negative cases.
2. Apply the root-only predicate once in shared TypeScript quarantine, using
   verified root/public-key evidence with the existing realm-only fallback.
3. Execute independently produced BEAM histories through TypeScript and fresh
   TypeScript histories through BEAM, in both delivery orders. Preserve successful
   root controls and ordinary post deletion behavior.
4. Run client build and CI suites, full Mix check, both boundary scans, independent
   and requested adversarial reviews, then open the dependent PR and pass its
   exact-tip hosted gate. Adopt the same base predicate in native evidence.

## Scope

This consolidates a missing shared source rule rather than adding a per-product
exception. No new operation, permission, network endpoint or lifecycle UI is
introduced. Keep PR 175's reviewed text/lineage correction frozen. Native catalog
trust, installation, complete application parity and ordinary relay chat remain
unfinished.
