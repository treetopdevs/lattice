# Plan 028: TS Township frontier deps from the local op log (D2)

## Status

DONE.

## Objective

Remove fixture-passed dependency ids from Township command authoring. Given a local TS op set, the
authoring path must derive the command's causal deps from the local frontier, matching
`Lattice.Sim.append/5` / `Lattice.Log.frontier/1` behavior closely enough to reproduce the W1
resident offline `post` frame.

## Scope

- Add `authorTownshipCommandFromLog(input)` to `src/township.ts`.
- Reuse the existing TS `frontier(ops)` helper rather than introducing a parallel log model.
- Extend `npm run township:authoring` to:
  - remove the W1 resident `post` frame from the local log;
  - decode the remaining carrier frames to semantic ops;
  - derive frontier deps from that local op set; and
  - author the exact Sim-exported resident `post` frame.
- Update the live TS↔BEAM carrier check so the pushed resident `post` frame is authored from local
  ops rather than fixture deps.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `authorTownshipCommandFromLog`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `authorTownshipCommandFromLog` added in `src/township.ts`, delegating deps to
   `frontier(localOps)`.
3. GREEN: `npm run township:authoring` proves the local pre-post op set derives the same deps and
   exact resident W1 `post` frame as the Sim-exported fixture.
4. GREEN: `npm run carrier:township:live` now derives deps from local ops, authors the frame, and
   the BEAM peer accepts it over WebSocket.

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

- Persist the browser/phone local op log across restarts instead of passing an in-memory op array
  (**seam completed by plan 029; platform wiring remains shell work**).
- Connect real shell key custody/storage so user actions can author durable ops without fixture
  seed keys.
- Expand authoring beyond the W1 resident `post` scenario once additional shell flows exist.
