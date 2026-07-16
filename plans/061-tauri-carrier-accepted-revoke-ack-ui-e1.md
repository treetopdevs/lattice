# Plan 061: Tauri carrier-accepted revoke acknowledgement UI (E1)

## Status

DONE.

## Objective

Close the UI half of the revoke ceremony without overclaiming authority state: after a carrier sync
accepts a locally authored Township revoke frame, the Tauri shell surfaces that the carrier accepted
the revoke frame while keeping effective access removal pending authority confirmation.

## Scope

- Extend `syncTownshipOutbox` with revoke-specific sync report fields derived from
  `pushReport.accepted`, not from peer-known outbox compaction.
- Surface authority-quarantined revoke frames separately so rejected revoke authority is visible and
  retained in the pending outbox.
- Keep delegation evidence retained after accepted, peer-known, and authority-quarantined revoke
  sync outcomes.
- Update Vue sync copy to say "carrier accepted" and "pending authority confirmation" for accepted
  revoke frames.
- Remove idle copy that suggested revokes are "confirmed by carrier sync."
- Do not claim "access revoked", "access removed", or "revocation confirmed"; effective revocation
  still requires the authority/materialized-state proof from Plan 059.
- Do not build production pairing UX, phone-grade mobile convergence, or W4 receipt-freeness.

## STOP Conditions

- If the UI derives revocation acknowledgement from `compactedFrameIds` or peer-known-only frames,
  stop; compaction is storage cleanup, not proof that this sync accepted the revoke.
- If copy says access is revoked/removed after carrier acceptance alone, stop; the safe state is
  "carrier accepted the revoke frame, pending authority confirmation."
- If delegation evidence is removed when the revoke outbox frame compacts, stop; later authority
  checks still need replayable evidence.
- If authority-quarantined revoke frames are counted as accepted acknowledgements, stop.

## TDD Evidence

- RED: `npm run sync:contract` failed because accepted revocation counts/ids were absent.
- RED: `npm run frontend:contract` failed because sync/Vue source did not expose safe
  carrier-accepted revoke acknowledgement fields or copy.
- GREEN: focused contracts now distinguish accepted revoke frames from peer-known-only compaction,
  retain delegation evidence, and keep authority-quarantined revoke frames pending.
- GREEN: Vue source exposes carrier-accepted revoke copy with pending authority confirmation and
  rejects "access revoked", "access removed", and "revocation confirmed" language.

## Second Opinion

Claude Code gave GO before implementation with two guardrails. First, derive the acknowledgement only
from `pushReport.accepted` intersecting local revoke frames, never from `compactedFrameIds` or
peer-known frames. Second, cap the UI claim at "carrier accepted revoke frame" because carrier
acceptance is not the same as proving later access use fails as `revoked_capability`.

Post-review Claude Code gave GO after inspecting the implementation and tests. It confirmed the
accepted-revoke, peer-known-not-counted, authority-quarantined-retained, non-revoke-not-counted, and
delegation-retention invariants. The only non-blocking follow-up is mixed sync copy composition when
one sync both accepts one revoke and authority-quarantines another.

## Verification

- `cd clients/township-tauri-shell && npm run sync:contract`
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
- Authority-confirmed effective-revocation UI remains open.
- Mixed accepted-plus-authority-quarantined revoke sync copy can be composed more explicitly.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
