# Plan 281: catalog raw JSON number-value parity

## Status

Source correction implemented and independently gated. The private native
observation-only numeric view is implemented; independent/adversarial review,
full ordinary/tracing and repository checks remain. Preserve the independent
saved-witness and source-ordering stops and the unfinished aggregate resource,
installation and ordinary relay work under plan267.

## Decision and scope

Raw catalog histories and their unsigned wrapper counters are JSON values, and JavaScript represents an integral
number such as1.0 or1e0 as the same number as1. In the catalog observation owner,
interpret finite nonnegative integral numeric values up to Number.MAX_SAFE_INTEGER
as those integer values. Preserve fractions, negative values and unsafe numbers
for their existing refusal classification; canonical high integer text remains
subject to the existing bounded uint64 profile. Numeric strings are untouched.

Use a bounded catalog-scoped numeric view for authentication, portable decoding,
product reading, signed-identity comparison and serialized push-size observation.
Retain the original parsed raw frame in the snapshot. Reuse the same checked
safe-number predicate for catalog wrapper watermarks and tokens. A caller token
must remain strictly below Number.MAX_SAFE_INTEGER in both fields, matching the
TypeScript requirement that the adapter can advance the next generation. Do not reinterpret artifact
JSON strings: their strict lexical integer profile stays unchanged. Ordinary
Wire.decode_op / wire admission, canonical encoding and signatures are unchanged.
The view supplies no authority, eligibility, freshness or installation receipt.

First bound the original raw value with the existing observation budget before
walking or allocating a numeric view. Convert only checked safe integral floats;
never allocate a large integer from an unchecked float, string or exponent.
Do not normalize unrelated metadata strings, unsigned dependency representation,
map/list order, signatures, binary values or artifact JSON text.

This is a separate source correction because the observed source disagreement
cannot be repaired by a generic native compatibility layer. It is not another
platform permutation/probe: plan267 explicitly requires an independent protected
source gate before adopting a changed source contract.

## Implementation and proof

1. Preserve the fresh version1.0 public-owner disagreement as an executable RED
   assertion. Include canonical integer1 as the positive control and show actual
   unchanged signed payload bytes and authentic signatures.
2. Add one catalog-scoped bounded numeric view and use it consistently in every
   CatalogTrust raw-frame reader. Keep ordinary wire APIs and artifact parsers
   unchanged; actual ordinary-wire refusal and lexical artifact controls prove it.
3. Compare full public decisions with fresh independently signed raw histories:
   saved reopen, incoming union, duplicate signed-identity aliases, rejected
   bad-signature evidence, cutoff-proof membership and available-invalid before
   missing evidence. Include version, tagged int and delegation integer metadata,
   safe edges, zero/negative-zero, fractions, negative and unsafe numbers,
   wrapper version/watermark/token values and exhausted token boundaries, and
   otherwise repairing incoming evidence after original corruption.
4. Preserve original raw values and input immutability. Numeric JSON values are
   compared semantically (1 and1.0 are the same value), while strings, term tags,
   signatures, ids, arrays and every other decision field remain exact.
5. Run source trust-family regressions, SDK build, full mix check and both boundary
   scans. Obtain requested Argon4High / authorized Sonnet5.5High adversarial review
   and independent source reviews; resolve findings and pass one exact-tip hosted
   gate on the dependent source PR before native adoption.
6. Then port the reviewed observation-only number semantics into native raw input,
   preserving the ordinary native artifact/wire parser profile. Re-run the actual
   numeric requests and the complete saved-state/entry/graph/witness regressions.

## Remaining boundaries

This closes source JSON-value interpretation only. Full native incoming decisions,
aggregate temporary resource accounting, storage/installation and the ordinary
real-relay field run remain their existing plans. Stop and record a new discrepancy
if correctness would require widening ordinary wire admission, changing canonical
bytes, catalog reasons, signatures or authority semantics; do not hide it in Rust.
