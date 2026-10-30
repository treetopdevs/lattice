# 286 — TS encode depth cap (and a row 208 recheck)

Status: DONE for row 286. Row 208 stays an operator decision; this plan narrows it.

## Row 286

**Problem.** PR #194 capped every TS decode walker at 64 nested containers (BEAM
`Lattice.Carrier.Wire` `@max_decode_depth`), but the encoder had no cap. `encodeCarrierTerm`
recursed without a budget, so `canonicalBytesForCarrierOp`, `verifyCarrierOp` and
`verifyCarrierOpHash` on a hand-built frame that was never decoded could throw a stack
`RangeError`.

**Change.** `encodeCarrierTerm` and `encodeMap` (`clients/lattice-client/src/codec.ts`) now spend
one level when they enter a list, tuple, map or mapset, and refuse on descent with
`malformed carrier term depth`. That is the same rule as the decoders. Delegation terms and scalar
leaves spend nothing. In `canonicalBytesForCarrierOp`, the body and the cap each get their own
budget of 64, as in `Wire.decode_op/1`. `canonicalBytesForCarrierTerm` gets the same cap.

- Canonical bytes for every admitted term are unchanged. `npm run canonical` and all committed
  vectors stay green.
- The authoring path already refused over-deep bodies through `assertWireVocabularyTerm`, so the
  new cap only matters when a caller verifies a frame that it built by hand and never decoded.
- `canonicalBytesForCarrierOp(frame, depthBudget)` takes an optional second argument for callers
  that authenticate frames beyond wire admission on purpose. Catalog raw observation
  (`treehouse_catalog_raw_bounds.ts`, `MAX_DEPTH = 65`) authenticates a signed depth-65 frame, so
  that it is reported as `unsupported_cutoff` (complete history) or `trust_pending` (missing
  dependencies) rather than `invalid_verified_history`. `treehouse_catalog_trust.ts` therefore
  passes the exported `catalogRawObservationMaxDepth` in `authenticatedRawHeader` and
  `fingerprint`. The Codex second review found that regression in the first cut. Test fixtures
  (`test/support/unchecked_author.ts`) pass an unbounded budget to sign over-deep frames. Wire paths
  must not pass it. The cutoff path (`treehouse_catalog_cutoff.ts`) already refuses past 64 before
  it encodes, and every other `verifyCarrierOp` caller decodes first, so neither changes.

**Collector decision.** `carrierDelegationsFromTerm` keeps stopping at depth 64 without
throwing. `createJsonCarrierFrameStore.load` reloads frames with a bare `JSON.parse`, and
`township.ts` and `township_actions.ts` then collect delegations across all of them. A throw would
let one corrupt stored frame block cap selection for every other frame, which is the row 208
failure class on the client. A delegation buried more than 64 containers deep is not one the BEAM
would ever admit, so it is never worth collecting.

**Tests** (`test/carrier.ts`):
- For every container kind, body and cap: depth 64 encodes and depth 65 refuses, through both
  `canonicalBytesForCarrierOp` and `canonicalBytesForCarrierTerm`.
- A 10,000-deep and a 200,000-deep body and cap give a typed refusal from
  `canonicalBytesForCarrierOp`, `verifyCarrierOp` and `verifyCarrierOpHash`, never a `RangeError`.
- The collector finds a delegation 64 containers deep beside a 200,000-deep sibling frame, and
  does not find one 65 containers deep.
- `test/treehouse_catalog_trust.ts` pins catalog installation outcomes for signed frames at depths
  64, 65 and 66. It fails if the trust path loses its depth-65 budget.

## Row 208 recheck

Row 208: `Holder.read_page` refuses a whole pull page when it reaches one persisted op that
`Wire.encode_op_checked/1` will not serve, so one legacy op stalls every pull past it.

A follow-up note proposed widening the row to cover relayed ops that were stored with a
non-canonical integer (for example `["int", "007"]`), which the BEAM decoder refuses since PR #194.
**That case cannot stall the holder:**

1. Before PR #194, relay ingress decoded `"007"` with `Integer.parse` to the integer `7`.
2. The holder persists a log of `term_to_binary` Erlang terms (`Lattice.Log.dump_bytes/1`). It
   stores the integer `7`, not the wire text.
3. `Wire.encode_op/1` re-encodes from the term, so the op is served as canonical `7`. Its id and
   signature were checked against canonical bytes at relay time, and those bytes are the same for
   `"007"` and `"7"`.

The stores that keep raw frames and re-check `Wire.encode_op(op) == frame`
(`public_history.ex`, `release_listing.ex`, `reference_mode.ex`, `release_catalog.ex`) hold only
operator-authored artifacts encoded by `Wire`, which are canonical by construction.

Other facts checked:

- Relay ingress (`Wire.decode_op/1`, `:op` mode) already refuses off-list atoms with
  `:unknown_atom`, so no new relay can store an op that `encode_op_checked` would refuse.
- A refused pull already reaches the client as the typed frame
  `{"type": "error", "reason": "unknown_atom"}`.

So row 208 is purely about **legacy data**: ops persisted before plan 190's closed vocabulary.

**Operator options** (not implemented here):

- **A. Offline migration.** A mix task lists unservable op ids in a path-backed log. The operator
  then either removes them together with their descendants and re-signs nothing, or keeps them
  out of the served snapshot. This rewrites history, so it needs a decision on replica identity.
- **B. Serve up to the bad op.** The page returns the good ops before the bad op, and then a typed
  refusal that names the blocking op id. Nothing is stranded silently, and clients know exactly
  where they are blocked. This changes the pagination contract on both runtimes.
- **C. Fail at boot.** `Holder` refuses to start on a log that holds an unservable op. The stall
  becomes an operator-visible startup error.
- **D. Keep it by design.** The status quo, with a runbook note.
