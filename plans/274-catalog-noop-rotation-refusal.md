# Plan 274: common no-op catalog rotation refusal

## Status

IN PROGRESS. The source correction passes its reviewed local and original hosted
gates and is adopted in native structural chain observations. The fully gated
witness completion repair and signing-helper observer correction are integrated
locally. All refreshed source/native local checks pass. Publish this integration
and pass its new exact-tip hosted gate before final refreshed-branch signoff.

The resolved-parent key guard preserves authorized ancestor-key return while
classifying same-current-key rotations consistently. Native structural proof is
separate from full graph/retained authority, installed routes and the real-relay
ordinary-app prototype; no native compensation or expanded permission is added.

## Decision and scope

Match the existing BEAM transition predicate in the TypeScript binding resolver:
the proposed new catalog key must differ from the resolved parent binding key.
Classify a no-op as invalid_catalog_transition before checking detached signatures.
Compare with the resolved parent, not just the bootstrap key. Keep standalone
rotation-verifier boolean behavior, signature policy, domains, IDs, record shapes,
wire parsing, generation/lease rules, retained recovery and routes unchanged.
A bad old signature under a distinct new key must still be invalid_catalog_signature;
a bad possession signature under a distinct new key must stay invalid_possession.

## Implementation and proof

Use a managed worktree from the final green source178 checkpoint. Preserve the native
chain WIP and primary checkout. Read AGENTS.md and plans/README.md; pinned asdf
OTP28/Elixir1.19 and Node22 remain mandatory.

1. Reproduce actual public-owner decisions with fresh independent BEAM/TS signatures.
   Keep genuine distinct-key rotation as a positive control.
2. Add public bidirectional tests for genuine, bad-old and bad-possession no-op
   rotations at the bootstrap and after a real key change. Require the same
   invalid_catalog_transition in every no-op case. Preserve distinct-key signature
   reasons and compare complete decisions, retained bytes, watermarks and routes.
   Verify installed and incoming-page snapshots stay unchanged. Pin saved recovery
   before incoming repair with a successful intact-state repair-page control.
   Include a valid A-to-B-to-A transition to distinguish parent from any ancestor,
   plus a rotation-only no-op page. Successful decisions compare full retained
   bytes/watermarks/routes; refusals compare kind/reason/detail and preserve input.
3. Add the parent-key inequality to the existing TypeScript transition condition.
   Do not change the native reason or relax verification to hide the discrepancy.
4. Run client build/typecheck/catalog regressions, required full mix check, both
   boundary scans and affected desktop/native checks. Obtain actual Argon4High or
   Sonnet5.5High fallback review and independent specification/standards review.
   Commit and open a separate dependent PR, pass its final exact-tip hosted gate,
   then adopt it into plan267 and rerun the original native chain corpus.

## Limits

This earns common source refusal classification only. It does not complete native
catalog graph authority, retained trust, incoming/resource integration, installed
trust or the ordinary two-app real-relay session.
