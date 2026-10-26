# Plan 273: shared catalog artifact integer profile

## Status

IN PROGRESS. Shared raw JSON and uint64 validation implemented. Fresh bidirectional
complete-decision regression tests, all client CI suites and native ordinary/tracing
all-target suites pass. Full mix check passes (899 core tests/26 properties, carrier
643 tests; zero failures with platform skips explicit). Final exact-tip hosted gate remains.
Before this correction, canonical catalog JSON proposes in both owners. Changing only version int 1 to
text "1" still proposes in TypeScript but rejects malformed_catalog in BEAM.
Raw numeric 1.0 also proposes in TS and rejects in BEAM. Raw -0 is accepted by
both source owners, but the existing native artifact JSON parser rejects it.
Native graph signoff stops until the separate source correction is reviewed and
adopted. PR 177 strict-signature source is frozen and independently gated.

## Decision and scope

Apply the operator-approved shared-validation decision from D70 to artifact
readers rather than adding another field-specific regular-expression repair.
Preserve existing canonical signing bytes, IDs, schemas, crypto checks and route
rules. Distinguish three layers:

- Raw artifact JSON must use unsigned canonical decimal safe-integer number
  tokens. No floating/exponent spellings or -0. This retains the existing native
  refusal of fractional/exponent/-0 tokens and ordinary serializers' safe-number
  representation; generated valid records are unchanged.
- At catalog trust admission/recovery, tagged integer values use the shared strict
  portability representation: safe JSON numbers, canonical decimal text only
  above JS's safe maximum. Current catalog schema integer fields are themselves
  safe, so small text aliases refuse before normalization.
- Legacy standalone typed/CarrierTerm codec adapters retain their existing
  canonical small-text aliases. Reuse bounded uint64 lexical validation before
  Number conversion, without redefining their admitted semantic values.

No frontier-count cap is added. Typed record grammar and the existing 128 KiB
artifact transport cap remain separate: a typed rotation may be too large to
publish as one artifact. Do not weaken native bounds or silently normalize raw
artifacts to make oracles agree.

## Isolated implementation

Start a managed worktree from frozen source PR177's final tip. Preserve the native
rotation work in its existing worktree and all unrelated primary changes. Read
AGENTS.md and plans/README.md and use the pinned asdf/Node toolchain.

1. Reproduce catalog and rotation discrepancies through both actual public owners,
   with independently signed BEAM and TS producers. Send original artifact JSON
   strings between runtimes, preserving numeric lexemes and duplicate fields.
   Baseline valid generated catalog/rotation must advance in both.
2. Add one shared portable uint64 scalar predicate per runtime where needed;
   reuse the existing lexical helpers. Apply it to all artifact trust readers,
   including saved snapshots, before field normalization. Preserve raw-history
   authentication-before-portability rules and ordinary wire compatibility.
3. Add bounded raw-artifact JSON numeric preflight before JSON numeric allocation.
   Scan outside quoted/escaped strings, reject negative/floating/exponent tokens,
   bound decimal length and safe range using shared helpers, then retain the
   existing real JSON parser as grammar owner. Avoid a new general JSON parser,
   dependency or handwritten number conversion. A JSON parser callback alone is
   insufficient: OTP json normalizes -0 to "0" before its integer callback.
4. Share that raw JSON preflight across catalog/rotation and live/saved artifact
   readers. Keep the existing artifact byte cap and error precedence. Use the
   existing source malformed_catalog/control_history_limit and saved recovery
   reasons. Preserve sticky-block fallback and history-authentication ordering.
5. Test numeric text aliases at version/revision/generation, fractional/exponent
   and negative-zero lexemes, long decimals before conversion, unsafe values,
   malformed scalars and valid boundaries. Exercise first load, repeats against
   valid retained evidence, and corrupt saved evidence before incoming repair.
   Keep strings with numeric-looking text and JSON escapes opaque.
6. Compare complete decisions, reasons, watermarks, routes and retained raw bytes
   in both producer directions. Include raw duplicate-field refusal at artifact
   admission without changing the intentionally permissive standalone Wire API.
   Cover exact artifact bytes/one over and both valid JSON ordering variants.
7. Run focused and full mix check, both boundary scans, client build/typecheck and
   all applicable CI suites, native ordinary/tracing regressions and shared shell
   checks. Obtain independent specification/standards and actual requested
   Argon4High or Sonnet5.5High fallback review. Publish a separate dependent PR,
   pass one final exact-tip hosted gate, then adopt in native plan267.

## Compatibility and STOP

Old TS snapshots may retain aliases BEAM never admitted. Corrected readers require
recovery for malformed saved artifacts; never rewrite signed bytes or repair
corrupt retained state with incoming rows. Ordinary generated JSON is unchanged.
Parsed-value APIs do not gain JSON numeric-lexeme claims: these raw-token checks
apply where the API owns an artifact JSON string.

STOP if matching requires changing signing domains, schema integer horizons,
ordinary carrier wire behavior, or semantic authority reasons. This correction
is not installed trust, a full native evaluator or the two-app real-relay proof.
