# Plan 059: Revocation lifecycle proof (C3/D2)

## Status

DONE.

## Objective

Close the semantic revocation gap before building production revoke UI: a clerk-issued Township
delegation must be usable before a valid issuer-authored revoke, a later command citing that same
delegation must be structurally accepted over the live carrier but authority-quarantined by the
BEAM peer as `revoked_capability`, and a non-issuer revoke attempt must be quarantined as
`unauthorized_revoke` without revoking the delegation.

## Scope

- Extend the Sim-generated `township_carrier_w1` vector with an `authorityRevocation` fixture.
- Build that fixture from the oracle log by revoking the resident's clerk-issued W1 delegation from
  the clerk identity, then authoring a later resident post that cites the revoked delegation.
- Refuse to export the vector unless Sim proves the pre-revoke post is authority-honored, the
  clerk revoke is authority-honored, the later post is quarantined as `revoked_capability`, and
  materialized state bytes remain unchanged.
- Extend authority analysis to report invalid revoke ops as `unauthorized_revoke`.
- Add a Sim fixture where the resident tries to revoke the clerk-issued delegation; export raises
  unless the bad revoke is quarantined and a later post under the same delegation remains
  authority-honored and changes materialized state.
- Add TS authoring support for Township revoke authority ops and prove byte-identical parity with
  the Sim-exported fixture.
- Extend the live TS carrier harness with a fresh peer run that pushes the revoke and then the
  revoked-cap command, asserting structural acceptance and semantic BEAM authority quarantine.
- Do not claim production revoke UI, pairing UX, phone-grade mobile convergence, or W4
  receipt-freeness.

## STOP Conditions

- If revocation is only byte-parity-tested and not checked against Sim/BEAM authority quarantine,
  stop; this repeats the authority-proof gap.
- If the resident revokes a clerk-issued grant, stop; the proof must use the grant issuer/root as
  the revocation authority.
- If the expected reason is hand-authored instead of derived from Sim, stop; Sim remains the
  oracle.
- If the UI says access is revoked before BEAM confirmation, stop; that belongs to a later UX plan
  and must distinguish "saved/pending sync" from confirmed authority state.

## TDD Evidence

- RED: `mix test apps/lattice_core/test/township/export_vectors_test.exs` failed because
  `vector["authorityRevocation"]` was missing.
- RED: `npm run township:authoring` failed because `authorTownshipRevocation` was not exported.
- RED: after Claude review, `mix test apps/lattice_core/test/township/export_vectors_test.exs`
  failed because `vector["authorityBadRevocation"]` was missing.
- GREEN: the exporter now derives the revocation lifecycle from Sim and raises unless Sim reports
  the later command as `revoked_capability`.
- GREEN: the exporter now derives the negative revoke-authority lifecycle from Sim and raises
  unless the non-issuer revoke is `unauthorized_revoke` while the later post remains honored.
- GREEN: the TS client authors the revoke and later revoked-cap post byte-identically to the
  Sim-exported fixture.
- GREEN: the TS client authors the non-issuer revoke and later still-authorized post
  byte-identically to the Sim-exported fixture.
- GREEN: the live carrier harness proves the BEAM peer structurally accepts the valid revoke,
  revoked-cap post, bad revoke, and post-after-bad-revoke frames, while state reports match the
  corresponding Sim-exported authority quarantine/op-id/state-byte projections.

## Second Opinion

Claude Code initially gave a GO only after splitting this from production UI work. The review called
out two load-bearing constraints: use the issuer/root path for revocation authority, and prove the
lifecycle semantically instead of stopping at byte parity. Claude's first post-review then STOPped
on the missing negative revoke-authority case. The implementation now includes both sides:
issuer-initiated revocation quarantines later use as `revoked_capability`, while non-issuer
revocation is `unauthorized_revoke` and leaves the delegation usable. Claude's follow-up review
gave GO after seeing the live carrier tail that checks state bytes, op ids, exact authority
quarantine, and the honored post after the bad revoke. A later plan can build resident-facing
revoke UX over locally issued grants with confirmation/pending-sync language.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/export_vectors_test.exs`
- `~/.asdf/shims/mix compile`
- `~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run carrier:township:live`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `~/.asdf/shims/mix format --check-formatted`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Production pairing/revocation UX remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
