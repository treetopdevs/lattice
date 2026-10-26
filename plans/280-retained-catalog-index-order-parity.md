# Plan 280: retained catalog index order parity

## Status

IN PROGRESS. The protected source correction is implemented locally. Fresh
public-owner comparisons now match for accepted and blocked index permutations;
independent and adversarial review are clear. Pertinent ordinary/tracing native
checks pass. The full repository check and hosted gate remain.
The initial full-resolver probe found TypeScript reopening a saved
accepted state with reordered unique history rows while BEAM required recovery.
This blocks native full-resolver adoption; no Rust compatibility rule is allowed.
This source correction does not complete plan 267 or establish installed trust.

## Problem and decision

BEAM `CatalogTrust.validate_state_shape!/1` requires history replica indexes to be
sorted as well as unique, and `validate_records!/1` does the same for saved catalog
and rotation IDs. TypeScript `stateValid` requires unique record IDs but allows
arbitrary row order. Both owners already reconstruct deterministic derived indexes.
Rows carrying the same authentic evidence in another order do not create a fork,
a different watermark, or a different authority fact.

Treat retained history/catalog/rotation rows as unique keyed sets in both owners.
Permit row reordering, retain original raw frame values, and let the normal fold
produce canonical indexes. Preserve input immutability and compare complete
public decisions, details, retained state, heads and routes. Reordering may require
an ordinary canonicalizing proposal; it never grants new evidence or authority.

Do not relax the canonical distinct indexes used by reviewed bootstrap inventory,
cutoff proofs, blocked witness indexes, witness frontiers, operation IDs or trigger
metadata. Those remain their existing proof/consistency obligations. Duplicate
replicas/record IDs, corrupt signatures and contradictory saved indexes still
require recovery before any incoming repair.

## Scope and implementation

- Protected source-only correction: BEAM `Treehouse.CatalogTrust`, fresh runtime
  peers/tests and this plan/index/decision evidence. No native evaluator changes.
- Replace sorted-equality checks for the three keyed row families with explicit
  uniqueness validation. Preserve closed shapes, per-record and aggregate limits,
  full saved-only authentication/closure, watermark and witness replay.
- Build fresh accepted, rotated and blocked states through actual public owners.
  Reorder each saved index family independently; also change raw frame delivery
  order without rewriting signed bytes. Compare full BEAM/TS outputs in both
  source producer directions, including canonicalizing proposal versus unchanged.
- Include duplicate rows/IDs, malformed history rows, corrupt saved signatures
  plus repairing incoming evidence, missing support, and noncanonical proof or
  witness indexes as refusal controls. Keep caller inputs unchanged.
- Replay the existing full source trust family and native retained/snapshot
  component tests after reviewed adoption. Do not silently tighten TypeScript or
  Rust to conceal the disagreement.

## Verification and closure

First reproduce the public source mismatch at its intended decision assertion.
A setup/translation failure does not count as RED. Then require the same fresh
requests to match completely after the source correction. Run focused source
and SDK tests, SDK build, full `mix check`, both boundary scans, and pertinent
ordinary/tracing native checks. Obtain requested Argon 4 High (or authorized
Sonnet 5.5 High fallback) adversarial review and independent specification and
standards reviews. Resolve findings and pass one exact-tip hosted gate on the
source PR before adopting into the native resolver.

STOP if correct parity requires changing signatures, canonical bytes, wire
frames, authority, route eligibility or relaxing actual proof/witness indexes.
Record any further source discrepancy separately; do not compensate in Rust.

## Evidence placement

Evidence SHAs, run IDs and review dispositions belong to the PR description,
the single plan-index status line and the running HTML decision log.
