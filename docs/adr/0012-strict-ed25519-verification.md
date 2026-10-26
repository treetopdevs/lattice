# ADR 0012: one strict Ed25519 verification profile

Status: adopted for plan 272; source verification and hosted gates precede native adoption.

## Decision

Every built-in Lattice signature verifier uses plain Ed25519 with this exact profile:

1. Public key A is 32 bytes; signature is 64 bytes, split into R and little-endian S.
2. A and R are canonical compressed Edwards encodings: y < 2^255 - 19, and the
   x-sign bit must be zero when x is zero. Both points must decode on the curve.
3. Reject small-order A and R: multiplying either by the cofactor eight gives
   identity. This includes the identity point and both sign spellings of zero x.
4. Require 0 <= S < L, where L = 2^252 + 27742317777372353535851937790883648493.
5. Compute k = LE(SHA512(encoded_R || encoded_A || message)) mod L, using the
   exact admitted bytes and reducing the challenge modulo L.
6. Require the uncofactored equation [S]B = R + [k]A. Multiplying the residual by
   eight before comparing it to identity is insufficient.

This is dalek 2.2.0 `verify_strict`, with an explicit canonical-public-key check.
The reduced challenge is intentional: for mixed-order keys the unreduced
RFC expression is a different verification rule. This does not add Ed25519ctx/ph.
Existing application purpose domains and canonical signed messages remain unchanged.

Mixed-order points that are not small-order remain allowed if the strict equation
holds. Identity is the exact public-key bytes, never a unique private scalar or
an independently operated human. Distinct-witness counts prove distinct admitted
key bytes; operator selection of independent witnesses remains a separate policy.
One operator can already generate multiple independent keys.

## Implementations and supported execution

- BEAM: `Lattice.Identity.verify` bounds lengths, canonical coordinates/scalars and
  all torsion encodings (including sign aliases), then delegates curve decoding
  and the equation to OTP/OpenSSL. The supported OTP 28 toolchain must pass the
  executable strict-equation matrix; the tests report `:crypto.info_lib()`.
- TypeScript: `verifyEd25519` uses pinned Noble 2.2.0 point/scalar operations and
  SHA-512. `zip215:false` alone is insufficient because its equation is cofactored.
- Native: `signature::verify` checks canonical A by round-trip encoding, then uses
  locked dalek 2.2.0 strict verification. Dalek compares computed compressed R
  with the supplied signature R bytes, preserving canonical-R rejection.

WebCrypto adapters enforce the common profile before consulting a platform
provider. Existing provider availability/refusal behavior can still refuse work;
a permissive provider cannot widen the profile. Generic injected verifier APIs
remain explicit trusted-adapter interfaces, not an alternate production policy.

The supported local/hosted platform matrix is the acceptance boundary. Deploying
another OTP/libcrypto provider requires running these same positive/negative
vectors first. No arbitrary-provider, production-image or physical-device claim
follows from local tests; no new boot-time environment gate is introduced.

## Evidence and compatibility

Fresh TypeScript and Rust producers exercise all eight torsion classes, valid and
invalid mixed-order equations, load-bearing weak-A/non-small-R and small-R/strong-A
witnesses, scalar boundaries, noncanonical encodings, and valid generated signatures.
Fresh BEAM and Rust signing producers provide additional independent positive and
malicious inputs. Public frame authentication and ordinary invitation consent are
separate regression paths. Mutation tests must distinguish removed critical guards
and a cofactored equation; guards already implied by a crypto implementation need
not have an artificially independent failure witness.

Corrected builds reject weak/forged evidence older builds may have accepted.
Retained histories are not rewritten, IDs do not change, and mixed-build convergence
is not promised for that evidence. Existing authentication/recovery failures remain
fail-closed; this change does not provide an automatic operator migration or scan.
