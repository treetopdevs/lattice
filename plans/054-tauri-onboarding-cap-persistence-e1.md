# Plan 054: Tauri onboarding/cap persistence ceremony (E1)

## Status

DONE.

## Objective

Turn the TS delegation issuance primitive from plan 053 into a Tauri-shell onboarding ceremony:
an existing authorized device can grant a resident/member cap, persist the grant as local
delegation evidence, queue it for carrier sync, and make the granted device's close/reopen cycle
derive availability from the persisted cap frame.

Planned at commit `ee6f56c`.

## Scope

- Add a shell-facing Township delegation workflow that loads the local op frontier, selects an
  issuer delegation for the current device, authors a `grant` authority frame, appends the
  semantic grant op to the local log, appends the grant frame to the carrier outbox, and appends the
  same grant frame to the split `delegation_frames` evidence store.
- Expose that workflow through `clients/township-tauri-shell/src/township_actions.ts` with the same
  success/failure style as the existing command/post actions.
- Add a compact Vue ceremony for entering the target device public key and issuing a grant.
- Prove the resulting persisted grant unlocks the recipient's cap-aware action availability after a
  reload-like workflow construction.
- Keep mobile secure-store implementation, revocation/succession policy UX, QR exchange UX, and full
  Expo/Tauri app convergence out of scope.

## STOP Conditions

- If issuing the grant cannot reuse the exact plan 053 canonical `authorTownshipDelegation` path,
  stop instead of adding another delegation encoder.
- If the authored W1 resident grant no longer matches the Sim-exported carrier fixture, stop and
  regenerate/inspect the vector before changing assertions.
- If a parent delegation cannot be selected from persisted local evidence, return an explicit
  missing-delegation failure; do not silently mint root grants.
- If an issuer tries to grant ops/roles outside its parent delegation, refuse before signing and
  leave `local_ops`, `carrier_frames`, and `delegation_frames` unchanged.
- If the Vue ceremony needs real mobile keychain/QR/device-pairing behavior to be honest, stop at
  the tested Tauri shell workflow and defer that to a mobile strategy plan.

## TDD Plan

1. RED: extend `clients/township-tauri-shell/test/township_actions.ts` to call
   `submitTownshipDelegation` before it exists and assert a clerk can issue the W1 resident grant
   from fixture-minus-grant evidence.
2. RED: assert that the shell action persists the grant frame to both `carrier_frames` and
   `delegation_frames`, appends the semantic grant op to `local_ops`, and that a resident workflow
   loaded from the persisted grant reports `post`, `set_title`, `set_summary`, and `admit`
   available.
3. RED: assert empty/invalid audience input fails before native signing and that missing issuer
   evidence returns `missing_delegation`.
4. RED: assert missing issuer evidence and resident escalation attempts do not sign or mutate local
   stores.
5. GREEN: add a shared `authorAndPersistTownshipDelegation` helper in
   `clients/lattice-client/src/township.ts`.
6. GREEN: add the Tauri shell action wrapper and Vue form/status ceremony.
7. VERIFY: run the focused shell action/frontend contracts, TS typechecks/builds, affected carrier
   contracts, `git diff --check`, umbrella `~/.asdf/shims/mix check`, and Sobelow.

## TDD Evidence

- RED: `npm run action:contract` failed because `submitTownshipDelegation` was not exported.
- GREEN: `authorAndPersistTownshipDelegation` selects an issuer parent from persisted delegation
  evidence, authors the plan 053 grant, appends the semantic grant op, queues the grant frame, and
  retains it as split delegation evidence.
- GREEN: `submitTownshipDelegation` validates empty/invalid audience keys before native workflow
  creation and maps missing issuer evidence to `missing_delegation`.
- COVERAGE: `test/township_actions.ts` proves a clerk issues the exact W1 resident grant fixture,
  persists it to `local_ops`, `carrier_frames`, and `delegation_frames`, reloads recipient
  availability from persisted grant evidence, rejects missing issuer evidence without store writes,
  and rejects resident escalation without signing.
- RED/GREEN: `npm run frontend:contract` failed until `App.vue` imported
  `submitTownshipDelegation`, tracked grant audience/status/submission state, and rendered the
  compact `Grant access` ceremony.

## Second Opinion

- Claude Code gave a GO for this slice as the clean continuation of plans 052 and 053.
- Claude required two guardrails that are now covered: refusal must not leave local side effects,
  and an issuer must not widen beyond its parent delegation.

## Verification

- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`

## Remaining Work

- Completed follow-ups: plan 055 records the mobile secure-store strategy, and plan 056 records the
  desktop app convergence gate.
- Still future: QR/device-pairing UX, revocation/succession policy UX, and phone-grade mobile
  convergence smoke.
