# Plan 269: incoming catalog observation and refusal order

## Status and scope

IN PROGRESS. Main-history ordering, observation bounds and retained recovery are implemented; complete-proof context, capacity controls and final signoff remain open.

This plan aligns the BEAM and TypeScript catalog owners before the native evaluator
adopts their behavior. Raw authentication returns header metadata, not admitted
operations, authority, installed routes or freshness. The native evaluator remains
a separate implementation under plan 267.

## Implementation checkpoints

- Authenticate accepted raw frames before fetch; keep unknown names inert and ordinary wire admission separate.
- Check whole-page history shape/family before merge, then rejected integrity/portability before missing accepted ancestors.
- Separate domain depth 65 observation from domain depth 64 admission; include all map and delegation JSON wrappers.
- Bound frame, history, page, saved and proposed evidence; preserve accepted watermarks and sticky blocks during recovery.
- Reject lossy strings, noncanonical Base64, oversized integers and coercible delegation primitives before canonical allocation.
- Keep raw frame subtrees JSON-only; translate only explicit typed metadata fields for public-size accounting.

## Incoming main-history contract

1. Validate closed page/history/rejected-record shapes, replica text and bounded
   Treehouse family across the whole page before merging or authenticating it.
2. Validate accepted headers, version, replica, ids and dependency text. Authenticate
   every canonicalizable accepted frame before any missing-ancestor refusal.
   Unadopted names remain binary data or inert canonical wrappers; never intern them.
3. Validate rejected identity, replica, duplicates and signature classification.
   Genuine signed evidence cannot be relabeled as bad signature, and rejected
   records cannot close accepted dependencies. Invalid outranks unsupported across
   histories; both outrank missing accepted ancestors.
4. Report sorted unique missing ids, independently of delivery order. Merge retained
   and incremental incoming frames before calculating missing ancestors.
5. Apply complete cutoff portability and the strict product reader before semantic
   projection. Unsupported or forged evidence cannot become authority or a route.

Canonical ids, signature bytes, closed vocabulary and normal wire decoding remain
unchanged. Observation may refuse noncanonical representations that normal decoding
historically accepts; it must agree between owners before fetch.

## Observation bounds and scalar rules

| Context | Bound |
| --- | --- |
| Ordinary wire domain depth | 64 composites |
| Raw observation domain depth | 65 composites |
| Raw frame JSON container depth | 199: three wrappers per map level, frame and flat delegation leaf |
| Public history JSON container depth | 203: raw frame plus history/rejected wrappers |
| Page or retained-state JSON container depth | 205: raw frame plus proof/history/rejected wrappers |
| Logical nodes and UTF-8 string bytes | 67,108,864 each, shared within the checked envelope |
| Ordinary push frame | 64,000 bytes; observation does not make overflow portable |

Count shared input at every logical occurrence. Cycles must not grow a JS walk.
Frame checks, history-batch checks, whole incoming pages, saved snapshots and
proposed snapshots are distinct boundaries. Proof histories, artifacts and metadata
count toward the envelope budget.

Public accounting uses explicit wrapper spellings and Base64 for the reviewed root
byte field. Frame and rejected-frame subtrees remain JSON-only; metadata translation
must not reinterpret their values. These guards establish neither wire validity nor
bounds before transport parsing or SDK cloning.

Strings must be well-formed before encoding. Integer scalars must be canonical
uint64 values; decimal text is at most 20 digits and is checked before BigInt.
Delegation primitives must retain their declared types. Observation requires
canonical Base64 for decoded byte fields, while ordinary wire behavior is preserved.
Absent/null unleased expiry remains supported.

## Retained recovery and capacity

Validate saved state independently before incoming evidence. Incoming data cannot
repair corrupt saved signatures, unsupported saved terms or inconsistent watermarks.
A blocked installation must not become unblocked. Preserve exact retained frames,
rejected records and accepted watermarks across refusal and serialized reopen.

A rejection is non-advancing and is never evidence of current freshness. Native
adoption must close eligibility for the rejected observation; it cannot reuse an
older route candidate as current. This includes a blocking witness that cannot fit
the retained profile. Define and test the capacity/freeze behavior explicitly rather
than treating a plain reject as a persisted block. Smaller native storage limits do
not prove this adapter obligation or a migration path.

## Open complete-proof contract

Cutoff-proof histories claim a complete immutable point rather than an incremental
main-history page. The owners currently differ for small unsupported, forged and
partial proof histories: BEAM reports `recovery_incomplete`; TS forwards observer
errors. Malformed outer proof/cutoff shape and unreadable nested history also need
explicitly distinguished outcomes.

Regenerate fresh public inputs through both actual APIs before choosing the common
contract. Preserve refusal, signature checking, cutoff identity, history-subset
checks, stored recovery and sticky state. Do not select one owner silently.

The public diagnostic inputs in
`docs/research/evidence/treehouse-proof-context-2026-10-25.json` document the issue;
tests must not consume their saved verdicts.

## Remaining work in order

1. Add independent fresh producer regressions for complete-proof context, including
   valid, unsupported, forged, partial and malformed proof histories; correct the
   common contract without changing authority or canonical bytes.
2. Add discriminating valid saved/proposed envelope controls at the actual cap and
   one over. Use valid authenticated histories and matching proofs, not corruption
   that would already fail without a budget guard. Cover a page and saved state
   individually under the cap whose proposed union exceeds it.
3. Resolve the freeze-capacity obligation and require native rejection/freshness
   tests before route installation. Verify that no retained evidence is silently
   evicted and that rejection never clears a prior block.
4. Finish review feedback, integrate the corrected exporter foundation and current
   main, and preserve both planning workstreams and unrelated checkout changes.
5. Run final required checks and protected/adversarial reviews; resolve findings and
   obtain exact-tip hosted proof before merging. Keep native adoption separate.

## Validation requirements

Prepare the client and shell prerequisites using the root Agent Guide and invoke
local Mix through the asdf shim. Required validation includes client build and
generated-output checks, relevant catalog/canonical/continuation and desktop suites,
full `mix check`, both HTTP-boundary Sobelow scans, and applicable ordinary/tracing
native reciprocal checks after integration.

Both producer directions must use real public APIs and fail if a runtime prerequisite
is missing. Include valid controls, exact reasons/pending ids, delivery reversal,
wrong scope/replica, malformed headers/scalars, unknown nested names, duplicate ids,
rejected-evidence integrity, exact depth/frame/node/string limits, and retained
recovery. Verify imported names remain uninterned after consumption. Budget tests
alone must not be described as authentication or authority proof.
