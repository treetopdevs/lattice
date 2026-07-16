# Plan 058: Live BEAM authority-unsound grant proof (C3/D2)

## Status

DONE.

## Objective

Close the build-map gap between scripted client quarantine surfacing and a real BEAM authority
proof: a TS-authored, validly signed but non-attenuated Township grant must be structurally accepted
over the live WebSocket carrier and then authority-quarantined by the BEAM peer with Sim-generated
oracle evidence.

## Scope

- Extend the Sim-generated `township_carrier_w1` vector with an `authorityUnsoundGrant` fixture.
- Build that fixture from the oracle log by signing a resident grant that tries to widen the
  resident parent cap to `close_matter`/`clerk`.
- Refuse to export the vector unless Sim reports `[bad_grant_id, "not_attenuated"]`.
- Extend the TS live carrier harness to author the same bad grant, push it to the real BEAM peer,
  and assert both layers: structural push acceptance and semantic authority quarantine.
- Do not claim mobile convergence, production pairing/revocation UX, or receipt-freeness.

## STOP Conditions

- If the proof only checks `pushReport.quarantined`, stop; semantic authority quarantine is exposed
  by the peer state report, while a validly signed bad grant should be structurally accepted.
- If the expected reason is hand-authored instead of derived from Sim, stop; Sim remains the oracle.
- If the test requires changing BEAM authority semantics, stop; this plan characterizes the existing
  authority model over the live carrier.

## TDD Evidence

- RED: `mix test apps/lattice_core/test/township/export_vectors_test.exs` failed because
  `vector["authorityUnsoundGrant"]` was missing.
- RED: `npm run carrier:township:live` failed reading
  `vector.authorityUnsoundGrant.parentDelegationId` from the old vector.
- GREEN: the exporter now derives the bad grant from the Sim oracle log and raises unless Sim
  authority reports `not_attenuated`.
- GREEN: the live TS carrier harness proves the same authored frame is pushed and accepted
  structurally, leaves materialized state bytes unchanged, and appears in the live BEAM peer's
  authority quarantine.

## Second Opinion

Claude Code gave a GO and asked that the implementation preserve the two-layer proof:
`signature-valid/structurally accepted` is not the same as `authority-honored`. Claude also asked
that the expected quarantine remain Sim-anchored and that the core proof live in the shared client
carrier harness rather than being coupled to Tauri shell UI behavior. Post-review Claude gave GO
with non-blocking caveats about order-sensitive quarantine equality and the pre-existing W1
`not_holder` entry; the harness now sorts quarantine-pair comparisons and separately asserts the
bad grant's `[id, "not_attenuated"]` membership before checking the full Sim-exported set.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `cd clients/lattice-client && npm run carrier:township:live`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Production pairing/revocation UX remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
