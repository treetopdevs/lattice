# Plan 025: TS carrier-op authoring primitive for W1 command frames (D2)

## Status

DONE.

## Objective

Advance Phase D2 from received-op verification to local authoring without overclaiming a full
Township application command layer. Given a real Lattice carrier `body`, `cap`, frontier deps, and
a shell/key-custody signer, TypeScript must produce the same carrier frame the BEAM runtime would
accept.

## Scope

- Add `authorCarrierOp(input)` to `codec.ts`.
- Build the canonical signed carrier core from `replica`, signer public key, deps, kind, body, and
  cap.
- Hash with the `lattice-cbor-v1` op id function.
- Sign those exact canonical bytes through an injected signer.
- Extend the live TS↔BEAM W1 carrier test to substitute a TypeScript-authored resident `post`
  frame into the real WebSocket push path.

## TDD Evidence

1. RED: `test/live_carrier.ts` imported missing `authorCarrierOp`; `npm run carrier:township:live`
   failed on the missing export.
2. GREEN: `codec.ts` added `authorCarrierOp`, returning a complete `{id, sig}` carrier frame.
3. DEBUG: the first equality check compared JSON serialization order, not object equality; the
   authored frame already matched id/signature and was accepted by BEAM. The test helper now uses
   `isDeepStrictEqual`.
4. GREEN: `npm run carrier:township:live` proves the authored resident `post` frame is byte-for-byte
   equal to the Sim-exported W1 fixture and accepted by `LatticeNodeSpike.WsHandler`.

## Verification

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

- Build a higher-level Township command composer that chooses the command body, cap term, and
  frontier deps from app intent instead of receiving them preassembled.
- Integrate that composer with a persistent browser/phone local log and real shell key custody.
- Extend authoring coverage beyond the W1 resident `post` fixture.
