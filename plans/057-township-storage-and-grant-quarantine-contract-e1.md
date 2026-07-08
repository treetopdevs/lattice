# Plan 057: Township storage and grant quarantine contract (E1)

## Status

DONE.

## Objective

Turn the two caveats from the 056 review into executable desktop-shell contracts without claiming
phone-grade mobile convergence: app KV stores must not contain concrete carrier seed bytes, and a
reported authority quarantine for a grant frame must remain visible and pending in the shell sync
result.

Planned at commit `ee6f56c`.

## Scope

- Add a storage scanner for Township app KV snapshots that rejects concrete secret needles and
  suspicious secret-bearing JSON field names.
- Exercise that scanner against the grant ceremony, rejected escalation, command authoring, normal
  sync, cold-start replay, and grant quarantine paths using the exact test identity seed bytes.
- Add a Rust native-state boundary test proving debug/native seed bytes do not enter the native
  key-value state.
- Add typed sync-result fields for authority-quarantined grant frame IDs.
- Keep live BEAM authority-unsound grant proof, mobile builds, phone-grade secure persistence, and
  quarantine UX changes out of scope.

## STOP Conditions

- If the storage test can only check field names and not concrete seed bytes, stop; that would guard
  too little.
- If the grant quarantine test starts claiming BEAM authority-soundness, stop; a scripted carrier
  only proves client surfacing of a reported quarantine.
- If fixing the quarantine path requires removing a grant from `delegation_frames`, stop; monotonic
  delegation evidence semantics need their own design review.
- If the UI begins consuming quarantine reasons for warning banners or availability rollback, stop
  and make that a separate UX plan.

## TDD Evidence

- RED: `npm run action:contract` and `npm run sync:contract` failed because
  `../src/storage_contract` did not exist.
- RED: `npm run frontend:contract` failed when the test expected grant quarantine fields before the
  sync result had them; the UI assertion was then removed per Claude's STOP guidance.
- RED: `cargo test --test native_commands native_key_seed_bytes_do_not_enter_key_value_state`
  failed because `TownshipNativeState::kv_snapshot` did not exist.
- GREEN: `assertTownshipKvStoresNoSecrets` scans stored values for exact seed base64/hex needles and
  suspicious secret-bearing JSON field names.
- GREEN: `syncTownshipOutbox` reports `authorityQuarantinedGrantIds` and
  `authorityQuarantinedGrantCount` while leaving the reported grant frame in the pending outbox.
- GREEN: the Rust native test proves the debug seed string, seed digest base64, and seed digest hex
  do not appear in native key-value state.

## Second Opinion

- Claude Code gave a GO for this slice as long as it remains test-hardening, not a mobile or BEAM
  authority-proof claim.
- Claude required concrete seed-byte assertions across JS and Rust boundaries and warned not to
  re-architect `delegation_frames` or consume quarantine reasons in the UI.

## Verification

- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell/src-tauri && cargo test --test native_commands native_key_seed_bytes_do_not_enter_key_value_state`

## Remaining Work

- A future live-path authority test should submit an actually unsound grant to a live BEAM peer and
  verify the peer's authority quarantine.
- A future UX plan can consume grant quarantine results for user-facing recovery/warning flows.
- Phone-grade Tauri-mobile or Expo convergence smoke remains the gate for mobile persistence claims.
