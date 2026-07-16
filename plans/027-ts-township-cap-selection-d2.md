# Plan 027: TS Township cap selection from local delegations (D2)

## Status

DONE.

## Objective

Remove the hard-coded W1 delegation id from TypeScript command authoring. Given locally known
delegations and the author's public key, TypeScript must select the same kind of command cap that
`Lattice.Sim.command/5` would cite: a delegation for this audience, containing the command op, and
containing the required authority role for clerk-guarded commands.

## Scope

- Add `selectTownshipCapId(command, delegations, audiencePubkey)` to `src/township.ts`.
- Match delegations by:
  - `audience` equals the local author's public key;
  - `ops` contains the command name; and
  - `roles` contains `clerk` for `close_matter` / `reopen_matter`.
- Extend `npm run township:authoring` to prove:
  - resident `post` selects the resident grant;
  - resident `close_matter` selects no cap; and
  - clerk `close_matter` selects the clerk/root delegation.
- Update the live TS↔BEAM carrier check so the resident W1 `post` frame is authored with a cap id
  selected from the vector delegations before BEAM accepts it.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `selectTownshipCapId`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `selectTownshipCapId` added audience/op/role checks in `src/township.ts`.
3. GREEN: `npm run township:authoring` passes the resident/clerk selection cases.
4. GREEN: `npm run carrier:township:live` selects the resident post cap id, authors the frame with
   `authorTownshipCommand`, and the BEAM peer accepts it over WebSocket.

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

- Derive frontier deps from local ops rather than receiving fixture deps (**completed by plan 028**).
- Connect shell key custody and storage so user actions can author durable ops without fixture data.
- Expand authoring beyond the W1 resident `post` scenario once additional shell flows exist.
