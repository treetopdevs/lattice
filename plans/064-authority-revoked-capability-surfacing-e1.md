# Plan 064: Authority revoked-capability surfacing (E1)

## Status

DONE.

## Objective

Surface the carrier authority signal that a command attempted to use a revoked capability and was
blocked as `revoked_capability`, without claiming that a specific local revocation has been
universally confirmed or that access has been removed.

## Scope

- Extend the Tauri shell sync result with `authorityRevokedCapabilityCount` and
  `authorityRevokedCapabilityIds`.
- Treat `stateReport()` as an optional carrier capability, not part of the `CarrierSyncClient`
  contract.
- After a successful sync, read `stateReport().authority_quarantine` when available and collect
  only entries whose reason is `revoked_capability`.
- Treat the resulting count/ids as carrier authority-state observations, not local-delegation
  attribution; the carrier state report is global to the peer's current authority quarantine.
- Keep sync successful if the state report is unavailable, absent, or throws; this probe is
  supplemental to push/pull/merge/persist.
- Surface a Vue sync message for blocked revoked-cap commands before the carrier-accepted revoke
  pending-authority message.
- Keep carrier-accepted revoke-frame acknowledgement and authority-quarantined revoke-frame
  surfacing intact.
- Do not attribute a blocked command to a particular local delegation or user revocation in this
  slice.

## STOP Conditions

- If `stateReport()` becomes required on `CarrierSyncClient`, stop.
- If a failed or unavailable state report turns an otherwise successful sync into `ok: false`,
  stop.
- If zero blocked revoked-cap commands is rendered as revocation failure or success, stop.
- If blocked command ids are labelled as revoked delegations, stop.
- If the UI says "access revoked", "access removed", "revocation confirmed", "confirmed by
  carrier sync", "effective removal", or "effective for all future commands", stop.
- If the carrier-accepted revoke-frame pending-authority copy is removed or weakened, stop.

## TDD Evidence

- RED: `npm run sync:contract` failed because `authorityRevokedCapabilityCount` was undefined on
  sync success.
- RED: `npm run frontend:contract` failed because `township_sync.ts` did not call `stateReport()`
  and the Vue shell had no blocked revoked-cap message branch.
- GREEN: sync tests now cover legacy clients without `stateReport()`, clients whose state report
  contains both `revoked_capability` and unrelated authority quarantine reasons, and clients whose
  `stateReport()` throws after sync.
- GREEN: frontend source tests now prove the blocked revoked-cap message exists, takes priority
  over carrier-accepted pending-authority copy, and avoids effective-revocation overclaims.
- RED: `npm run app:convergence` exposed a brittle launch smoke: the Tauri window could delay
  smoke-only autosync behind action-availability hydration, and the smoke read peer divergence
  with a single status check.
- GREEN: the Vue boot sequence now loads pairing config, runs smoke-only autosync, then hydrates
  action availability; the launch smoke waits for returned sync work, polls the peer's async
  divergence phase, uses a realistic 60s Tauri launch window, and cleans up the peer first on
  failure.

## Second Opinion

Claude Code gave GO before implementation, with the condition that this slice be framed as
revoked-capability quarantine surfacing rather than full authority-confirmed effective revocation.
It noted that `revoked_capability` appears on the later command that cites the revoked delegation,
not on the revoke op or delegation itself, so the truthful UI claim is "commands using revoked
caps were blocked by carrier authority." It also required `stateReport()` to remain optional and
failure-tolerant.

Claude Code post-reviewed the final diff and gave GO with no blocking findings. It confirmed the
STOP conditions are satisfied, the `stateReport()` probe remains optional/failure-tolerant and
off `CarrierSyncClient`, the UI copy avoids effective-revocation overclaims, and the smoke/timeout
changes stabilize gates without weakening behavior. It called out one non-blocking caveat captured
above: `authorityRevokedCapabilityCount` is a carrier-wide authority-quarantine observation, not
per-delegation attribution.

## Verification

- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell && npm run peer:contract && npm run frontend:contract && npm run typecheck && npm run build`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/township/matter_property_test.exs apps/lattice_core/test/lattice2/convergence_property_test.exs`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix test apps/lattice_server/test/flagship_http_test.exs:90 --timeout 120000`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Per-delegation effective-revocation attribution remains open: map a blocked command back to the
  locally revoked delegation it cited before claiming a specific revocation's effect.
- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
