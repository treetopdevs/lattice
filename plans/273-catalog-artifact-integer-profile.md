# Plan 273: shared catalog artifact integer profile

## Status

DONE at approved source checkpoint. Shared artifact integer validation and the
operator-approved witness completion/owner-check handshake pass required local
checks and both exact-tip hosted workflows. PR 178 remains open; no merge or
full native evaluator/installed-trust completion is implied. Dependent branches
must verify their own combined integration and final hosted gate.

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

The operator approved finishing the generic test-only cleanup in PR178, and that
checkpoint passed its native and hosted gates. A later run exposed a production
sequencing gap: a physically drained cancellation callback can still have a
receiver performing its final owner check. A new cancellation can also reserve
during finalization's own owner check.

The operator approved completing one generic production barrier in this PR.
Reserve cancellation consumption before dispatch; retain it with a scoped guard
through receiver completion, errors and unwind. Finalization waits for both
physical drains and consumer completion. Mark the final owner-check interval
under the flow mutex; defer new cancellation dispatch until that check returns,
without holding the flow mutex during owner access. Recheck reservations before
publication/release. Known-unlaunched cleanup rolls back; unknown callback failure
retains the failed physical drain. Keep owner lock-contention refusal unchanged.

Prove both directions with explicit actual-flow gates and real public reuse after
release. Serialize only the two deliberate synchronous owner-lock gates so a
two-worker runtime can launch their cancellation tasks. Move fake async callback
channel waits to blocking workers. Keep the existing success, closed-owner,
publication and failed-drain controls. Final full checks, requested adversarial
review and a new hosted exact-tip gate are required before publication/adoption.
