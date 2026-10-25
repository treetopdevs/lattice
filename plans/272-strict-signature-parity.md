# Plan 272: common strict Ed25519 signature verification

## Status

IN PROGRESS. The shared verifier correction, reciprocal proof and requested
reviews are complete. PR177 passed its final exact-tip hosted gates. The source
is adopted here; native integration checks remain required before signoff.
Plan273 separately owns the newly reproduced raw-artifact integer profile gap.
Previously reviewed source PRs stay frozen.

The exact common profile and provider/compatibility assumptions are in
[ADR 0012](../docs/adr/0012-strict-ed25519-verification.md).

## Problem and recommendation

The shared BEAM Identity.verify delegates directly to OpenSSL through OTP crypto.
An identity-point public key and identity R / zero S signature verify for arbitrary
messages on this machine. TypeScript Noble with zip215:false rejects that key;
native ed25519-dalek verify_strict also rejects it. The actual application result
is an extra honored member in BEAM, not merely different diagnostic text.

Adopt one documented strict signature profile across the common verification
owners: exact key/signature lengths, canonical point/scalar representations,
no small-order public key or R, and the strict verification equation. Preserve
valid generated Ed25519 signatures, signed bytes, IDs and purpose domains.
Before implementation, execute the full edge matrix below against actual OTP,
Noble and dalek. Noble zip215:false is not by itself proof of uncofactored strict
verification; inspect the installed library rather than treating the option name
as the contract.

Keep curve arithmetic in maintained crypto implementations. Prefer small explicit
canonical/small-order guards around OTP's verifier only if the complete executable
matrix proves it implements the selected strict profile. Otherwise select a
maintained verifier integration with its build/runtime implications documented.
Do not add hand-written curve arithmetic, silently weaken native verification,
change only invitation handling, or treat a signature-shaped value as consent.

## Isolated source change

Start a managed worktree from the frozen reviewed source dependency of plan 267.
Read AGENTS.md and plans/README.md. Preserve every unrelated worktree. Keep native
Space implementation separate; this source change must stand on its own.

1. Add fresh independent executable primitive tests and ordinary invitation
   reproduction. The identity key must not have an associated signing secret.
   Assert current disagreement before changing the common owners. Cover an
   otherwise valid root-signed outer operation so frame authentication cannot
   hide the detached consent mismatch.
2. Run canonical/noncanonical point encodings, identity and all torsion subgroup
   representatives, malformed lengths, scalar zero/order/one-over, mixed-order
   witnesses, wrong message/key/signature and valid generated signatures through
   all three actual runtimes. Include strict-R controls. Generate malicious
   witnesses in more than one producer; use fixed published vectors where useful,
   with source attribution and exact cryptographic inputs, not saved verdicts.
3. Implement a single shared verifier boundary per runtime. Audit every direct
   crypto verification call, including frame/delegation, invitation, member-key
   possession/vouches/return consent, beacons, succession/continuation, catalog
   artifacts and carrier sessions. Existing callers must receive the same policy.
4. Compare complete application decisions and state in both producer directions,
   with valid controls and reverse delivery. Exercise public authentication and
   detached-signature paths separately. Authentication failures must precede
   authority or application judgments where the current boundary requires it.
5. Document compatibility: old builds may honor deliberately malformed/weak-key
   evidence which corrected builds reject. Do not rewrite retained signed data,
   migrate IDs, or claim mixed-build convergence. Keep wire encodings unchanged.
6. Run full mix check with prepared real Node peers, both boundary Sobelow scans,
   client build/typecheck/conformance/catalog/member-continuity suites and native
   ordinary/tracing regressions. Obtain independent specification/standards review
   plus requested Argon4High or actual Sonnet5.5High fallback. Publish a separate
   PR and pass one final exact-tip hosted gate before native adoption.

## Acceptance and STOP conditions

All actual runtimes agree on strict signature inputs and public consequences.
Valid ordinary enrollment and existing signed-vector outcomes remain unchanged.
Weak/forged evidence never grants admission, authority, catalog trust or routes.
No external relay, private identity, device or operator ceremony is needed.

STOP if matching requires changing canonical bytes, purpose domains, valid
signature policy outside this documented profile, or unrelated authority rules.
Record any additional discrepancy separately. Cost of repeated ancestry/claim
hashing and complete incoming resource/freshness work remain plan 267 obligations.
This correction does not itself complete the native catalog evaluator or two-app
real-relay prototype.
