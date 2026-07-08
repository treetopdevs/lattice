# Plan 053: TS Township delegation issuance primitive (D2)

## Status

DONE.

## Objective

Give the TypeScript client the write-side counterpart to carrier delegation extraction: author one
canonical Township grant frame that is byte-identical to the Sim-exported W1 fixture and selectable
as local cap evidence for the granted device.

Planned at commit `ee6f56c`.

## Scope

- Add a canonical delegation payload signer that mirrors `Lattice.Canonical.delegation_bytes/7`.
- Add a Township grant authoring helper that wraps the signed delegation in an `authority` op with
  body `{:grant, delegation}` and `cap: nil`.
- Prove the emitted delegation id/signature and enclosing carrier op match the existing W1
  Sim-exported grant frame.
- Prove the emitted frame feeds `carrierDelegationsFromFrames` + `selectTownshipCapId` and lets the
  granted resident author the already-proven W1 command frame.
- Keep onboarding ceremony/UI, attenuation-policy UX, revocation, succession, mobile secure-store
  strategy, and Tauri/Expo convergence out of scope.

## STOP Conditions

- If the TS-authored delegation bytes do not match `Lattice.Canonical.delegation_bytes/7`, stop and
  regenerate/inspect the Sim vector instead of weakening assertions.
- If matching the fixture requires changing `Township.Matter`, `Lattice.Attestation`, the carrier
  wire format, or BEAM authority semantics, stop; this slice is composition of existing primitives.
- If the fixture lacks a suitable grant frame, add a Sim-exported vector before adding TS behavior.

## TDD Plan

1. RED: extend `clients/lattice-client/test/township_authoring.ts` to call the not-yet-existing
   Township delegation issuance helper and compare the output to the W1 grant fixture.
2. RED: assert the issued frame's delegation is selectable for the resident and authorizes the
   resident W1 post command path.
3. GREEN: implement the canonical delegation payload bytes/hash/signature helper in `codec.ts`.
4. GREEN: implement the Township grant wrapper in `township.ts`.
5. VERIFY: run focused TS client contracts first, then shell contracts affected by delegation
   evidence, `git diff --check`, umbrella Mix checks with `PATH="$HOME/.asdf/shims:$PATH"`, and
   Sobelow.

## TDD Evidence

- RED: `npm run township:authoring` failed because `../src/index` did not export
  `authorCarrierDelegation`.
- GREEN: `authorCarrierDelegation` now mirrors `Lattice.Canonical.delegation_bytes/7` for
  delegation id/signature bytes.
- GREEN: `authorTownshipDelegation` now wraps that signed delegation in a `grant` authority frame
  with `cap: nil`.
- COVERAGE: `township_authoring.ts` proves the authored resident delegation and enclosing grant
  frame match the Sim-exported W1 fixture, then feeds the issued grant through cap selection and
  authors the resident W1 post frame with the issued cap.

## Second Opinion

- Claude Code interactive PTY reviewed `TOWNSHIP_BUILD_MAP.md`, `plans/README.md`, and the actual
  codec/carrier/township seams after Plan 052.
- Recommendation: Plan 053 should be the smallest load-bearing cap-issuance slice: a TS Township
  delegation issuance primitive that authors one BEAM-accepted grant frame.
- Rationale: mobile secure-store and full app convergence both depend on a real cap to persist and
  converge; without issuance, shell actions remain seeded-fixture workflows.

## Verification

All BEAM commands below were run with `PATH="$HOME/.asdf/shims:$PATH"` and explicit
`~/.asdf/shims/mix` where applicable, to avoid the local Homebrew/mise Erlang collision.

- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/lattice-client && npm run carrier:township:live`
- `cd clients/lattice-client && npm run canonical`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/lattice-client && npm run tauri:bridge`
- `cd clients/township-tauri-shell && npm run action:contract`

## Remaining Work

- Add production onboarding/cap persistence ceremony through the Tauri shell.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
