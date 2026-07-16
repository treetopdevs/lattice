# Plan 060: Tauri revoke-access pending-sync ceremony (E1)

## Status

DONE.

## Objective

Add the shell-side counterpart to the grant ceremony: a Tauri user can prepare a revoke for a
locally issued Township delegation, save the signed revoke frame to the local outbox, and see honest
pending-sync language without claiming the carrier has confirmed the revocation.

## Scope

- Add `submitTownshipRevocation` to the Tauri shell action layer.
- Validate the delegation id before native work; empty ids fail without signing.
- Load local delegation evidence and require the current device key to match the delegation issuer
  before signing. This is a UX guard only; Plan 059's BEAM authority quarantine remains the security
  boundary for patched or stale clients.
- Author a Township revoke op through the shared client helper, using the current local op frontier.
- Append the semantic revoke op to the local log and the carrier frame to the pending outbox.
- Keep delegation evidence intact until carrier sync/authority confirmation; do not locally pretend
  access is gone.
- Add a Vue `Access revoke` form with a delegation-id input, local status, and pending-sync success
  copy.
- Do not build pairing UX, phone-grade mobile convergence, or confirmed-revocation state UI in this
  slice.

## STOP Conditions

- If the shell removes delegation evidence before sync confirmation, stop; that overclaims local
  authority state.
- If UI copy says access is revoked immediately after saving the frame, stop; the honest state is
  "saved locally, pending carrier sync."
- If the local issuer check is described as the security boundary, stop; it is only an early UX
  guard, and BEAM authority remains authoritative.
- If the byte-identical test does not seed the same oracle frontier used by
  `authorityRevocation.revokeOp`, stop; that assertion would be misleading.

## TDD Evidence

- RED: `npm run action:contract` failed because `submitTownshipRevocation` was not exported.
- RED: `npm run frontend:contract` failed because the Vue source did not expose the pending-sync
  revocation ceremony.
- GREEN: the action contract now seeds the local log with `oracleCarrierOps`, verifies the revoke
  frame is byte-identical to `vector.authorityRevocation.revokeOp`, and asserts local log/outbox
  persistence while delegation evidence remains intact.
- GREEN: empty, unknown, and non-issuer revoke attempts fail without signing or mutating the
  outbox.
- GREEN: the Vue source exposes `Access revoke`, `Delegation id`, `Revoke access`, and pending-sync
  language, while the source contract rejects an immediate "access revoked" claim.

## Second Opinion

Claude Code gave GO before implementation with two guardrails: label the local issuer guard as
UX-only rather than authoritative, and verify byte parity from the same oracle frontier as the
Sim-exported revoke fixture. Post-review Claude gave GO; a follow-up confirmed the unknown-id and
non-issuer negative paths cover the intended no-sign/no-mutation behavior. A non-blocking symmetry
nit was folded in by also asserting the non-issuer path leaves local op ids unchanged.

## Verification

- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell && npm run build`
- `~/.asdf/shims/mix format --check-formatted`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Production pairing UX remains open.
- Confirmed-revocation state UI after carrier/authority acknowledgement remains open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
