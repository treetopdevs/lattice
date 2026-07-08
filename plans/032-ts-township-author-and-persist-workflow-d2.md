# Plan 032: TS Township author-and-persist workflow (D2)

## Status

DONE.

## Objective

Give Tauri/Expo shells one storage- and signer-injected workflow for a Township user command. The
library should load local state, recover delegations from persisted carrier frames, choose the
authorizing cap, sign the command frame, and persist both the semantic op and pushable carrier
frame.

## Scope

- Add `authorAndPersistTownshipCommand(input)` to `src/township.ts`.
- Use existing seams only: `LocalOpLogStore`, `CarrierFrameStore`, and injected carrier signer.
- Reject commands when no loaded delegation authorizes the signer for the requested Township
  command.
- Convert the authored carrier frame into a semantic op with `carrierOpsToSemanticOps` before
  appending it to the local op-log store.
- Keep platform storage and key custody out of scope; shells still provide store implementations
  and signer implementations.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `authorAndPersistTownshipCommand`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `authorAndPersistTownshipCommand` composes loaded local ops, loaded carrier frames,
   extracted delegations, cap selection, signing, semantic-op conversion, and both persistent
   appends.
3. GREEN: the authoring test proves the W1 resident post frame, semantic op append, carrier frame
   append, and resident `close_matter` missing-cap rejection.
4. GREEN: the live carrier test now routes the W1 resident post through the workflow before BEAM
   accepts the pushed frame.

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

- Wire this workflow to real Tauri/Expo storage implementations.
- Connect real shell key custody so the injected signer is backed by platform-held keys.
