# Plan 031: TS carrier delegation extraction from persisted frames (D2)

## Status

DONE.

## Objective

Let browser/phone shells recover capability delegations from loaded carrier frames without
duplicating test-only term-walking code. This keeps cap selection shell-neutral: a shell can load
its persisted outbox, extract delegations, select the correct Township cap, and author the next
command.

## Scope

- Add a production `carrierDelegationsFromFrames(frames)` helper to the TS carrier module.
- Extract delegation terms recursively from carrier terms so future authority bodies do not require
  a new parser shape.
- Update `npm run township:authoring` and `npm run carrier:township:live` to use the helper instead
  of local test-only extraction functions.
- Keep the helper pure and storage-agnostic; real platform storage and key custody remain separate
  shell integration work.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `carrierDelegationsFromFrames`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `src/carrier.ts` now recursively extracts delegation terms from loaded carrier frames.
3. REFACTOR: the authoring and live carrier tests use the production helper instead of local
   `delegationsFromFrame` copies.
4. GREEN: `npm run township:authoring` proves W1 clerk/resident delegation ids are extracted and
   feed cap selection.
5. GREEN: `npm run carrier:township:live` proves the live BEAM path still accepts the authored
   frame selected from extracted delegations.

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

- Wire Tauri/Expo storage implementations to the `LocalKeyValueStore` seam.
- Connect real shell key custody so user actions sign with platform-held keys rather than fixture
  seed identities.
