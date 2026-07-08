# Plan 026: TS Township command authoring for Matter body/cap terms (D2)

## Status

DONE.

## Objective

Move D2 from a generic carrier-frame signing primitive to a Township-aware command composer.
TypeScript must construct the same command body and cap term shapes that `Township.Matter` and
`Lattice.Sim.command/5` put into BEAM ops, then author a BEAM-accepted W1 command frame through
the plan 025 signing path.

## Scope

- Add `src/township.ts` with:
  - `townshipCommandBody(command)` for every declared `Township.Matter` command:
    `set_title`, `set_summary`, `post`, `admit`, `remove_member`, `close_matter`, `reopen_matter`.
  - `townshipCapTerm(capId)` matching BEAM's binary delegation-id cap term, with `null` as no cap.
  - `authorTownshipCommand(input)` over `authorCarrierOp`.
- Add `npm run township:authoring`.
- Wire the new check into CI.
- Switch the live W1 carrier test to author the resident offline `post` via `authorTownshipCommand`
  before pushing it to the BEAM peer.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `authorTownshipCommand`,
   `townshipCommandBody`, and `townshipCapTerm`; `npm run township:authoring` failed on the
   missing export.
2. GREEN: `src/township.ts` added the command body/cap composers and the semantic authoring helper.
3. GREEN: `npm run township:authoring` verifies all command body shapes, cap-term encoding, and a
   resident W1 `post` frame byte-for-byte against the Sim-exported fixture.
4. GREEN: `npm run carrier:township:live` now uses `authorTownshipCommand` and the BEAM
   `LatticeNodeSpike.WsHandler` accepts the authored frame over the real WebSocket carrier path.

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

- Select an authorized cap id from local delegations rather than receiving it directly
  (**completed by plan 027**).
- Derive frontier deps from a persistent browser/phone local log.
- Connect shell key custody and storage so user actions can author durable ops without fixture data.
- Expand authoring beyond the W1 resident `post` scenario once additional shell flows exist.
