# Plan 030: TS carrier frame outbox persistence for pushable authored frames (D2)

## Status

DONE.

## Objective

Persist the signed carrier frames that a browser/phone realm must push after offline authoring.
Plan 029 persisted the semantic op log used to derive authoring state; this slice adds the
companion outbox for pushable `CarrierOpFrame`s so an authored frame can survive reload and still
be accepted by the BEAM carrier.

## Scope

- Add `CarrierFrameStore` and `createJsonCarrierFrameStore(storage, key)` to `src/local_log.ts`.
- Use the same shell-provided `LocalKeyValueStore` seam as the semantic op log.
- Persist frames as JSON and append idempotently by carrier frame id.
- Extend `npm run township:authoring` to prove carrier frame save/load and duplicate append.
- Update the live TS↔BEAM carrier check to load push frames from the persisted outbox before
  calling `syncCarrierOnce`.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `createJsonCarrierFrameStore`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `createJsonCarrierFrameStore` added to `src/local_log.ts` with `load`, `save`, and
   idempotent `append`.
3. DEBUG: the live test initially declared its in-memory test store below a top-level await use,
   triggering a temporal-dead-zone `ReferenceError`; moving the helper above first use fixed test
   setup.
4. GREEN: `npm run township:authoring` proves the persisted carrier frame outbox roundtrips and
   duplicate append is idempotent.
5. GREEN: `npm run carrier:township:live` proves the BEAM peer accepts a W1 resident `post` frame
   loaded from the persisted outbox.

## Verification

- `npm run township:authoring`
- `npm run carrier:township:live`
- `npm run typecheck`
- `npm run conformance`
- `npm run canonical`
- `npm run carrier:township`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `git diff --check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Connect real shell key custody so user actions can sign without fixture seed keys.
- Wire Tauri/Expo storage implementations to the `LocalKeyValueStore` seam.
- Expand authoring beyond the W1 resident `post` scenario once additional shell flows exist.
