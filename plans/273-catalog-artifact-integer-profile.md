# Plan 273: shared catalog artifact integer profile

## Status

DONE at source tip bab44c97e: browser40255972317 and Flagship40255972302
pass, including the operator-approved generic witness-family cleanup. Native
adoption41406bfc3 passes both15-test witness configurations. PR178 remains open;
no merge or full native-evaluator completion is implied. Shared raw/uint64
validation, bidirectional source decisions, all client CI suites, full mix check,
boundary scans and ordinary/tracing native gates pass.

Before this correction, canonical catalog JSON proposes in both owners. Changing only version int 1 to
text "1" still proposes in TypeScript but rejects malformed_catalog in BEAM.
Raw numeric 1.0 also proposes in TS and rejects in BEAM. Raw -0 is accepted by
both source owners, but the existing native artifact JSON parser rejects it.
This separate source correction is reviewed, gated and adopted; remaining native
graph signoff belongs to plan267. PR 177 strict-signature source is frozen and independently gated.

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

## CI test-family cleanup

The integer correction is implemented. CI also exposed a separate witness-drain
observation problem: public admission probes can refuse an owner independently
of whether the actual operation slot was released. After the first test-only
checkpoint, a two-worker repeat reproduced that pattern in the unchanged
known-unlaunched-cancel test. Repeated per-test timeout repairs are insufficient.

The concrete test-only consolidation is ready locally: all cleanup waits use the
shared passive registry/run/registration observations; success controls still
make one real public request after cleanup; unknown callback failures still hold
the actual lease; terminal-publication tests observe the run phase instead of
sleeping. Production owner/cancellation/custody policy is unchanged. The focused
15-test suite passes twenty consecutive two-worker/four-test-thread runs.

The operator approved finishing the generic test-only cleanup in PR178. Preserve
the passive-observer design, public success/refusal controls and raw-integer
correction. Both native all-target configurations pass. The final cleanup is
published at bab44c97e and both new final-tip hosted workflows pass.

## Compatibility and STOP

Old TS snapshots may retain aliases BEAM never admitted. Corrected readers require
recovery for malformed saved artifacts; never rewrite signed bytes or repair
corrupt retained state with incoming rows. Ordinary generated JSON is unchanged.
Parsed-value APIs do not gain JSON numeric-lexeme claims: these raw-token checks
apply where the API owns an artifact JSON string.

STOP if matching requires changing signing domains, schema integer horizons,
ordinary carrier wire behavior, or semantic authority reasons. This correction
is not installed trust, a full native evaluator or the two-app real-relay proof.
