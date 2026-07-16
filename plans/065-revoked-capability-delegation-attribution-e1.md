# Plan 065: Revoked-capability delegation attribution (E1)

## Status

DONE.

## Objective

Attribute carrier `revoked_capability` blocks to the delegation id cited by the blocked command
when that command frame is present in known shell evidence, while preserving the carrier-wide
unattributed signal from Plan 064.

## Scope

- Keep `stateReport()` optional, failure-tolerant, and outside `CarrierSyncClient`.
- Fetch the carrier state report once and derive all revoked-capability fields from that result.
- Preserve `authorityRevokedCapabilityCount` and `authorityRevokedCapabilityIds` as the complete
  carrier-wide set of blocked command ids.
- Add attributed and unattributed refinements:
  - `authorityRevokedCapabilityAttributionCount`
  - `authorityRevokedCapabilityAttributions`
  - `authorityRevokedCapabilityUnattributedCount`
  - `authorityRevokedCapabilityUnattributedIds`
- Attribute only when a blocked command frame is known through retained delegation evidence,
  pending local outbox evidence, or pulled frames, and its `cap` term decodes to a delegation id.
- Treat unknown command ids, non-command frames, nil/non-bin caps, malformed base64, and
  non-UTF8 cap payloads as unattributed rather than failing sync.
- Surface cautious Vue copy that says blocked commands cited delegations the carrier reports as
  revoked, without claiming access removal or that a local user's revocation worked.

## STOP Conditions

- If attribution replaces or shrinks the carrier-wide `authorityRevokedCapabilityIds`, stop.
- If an unavailable or malformed state report/cap term turns a successful sync into `ok: false`,
  stop.
- If the UI says "your revocation", "revocation worked", "access removed", "revocation
  confirmed", "confirmed by carrier sync", "effective removal", or "effective for all future",
  stop.
- If `stateReport()` is called twice or added to `CarrierSyncClient`, stop.
- If a blocked command id can appear both attributed and unattributed, stop.

## TDD Evidence

- RED: `npm run sync:contract` failed because
  `authorityRevokedCapabilityAttributionCount` was missing from sync success.
- RED: `npm run frontend:contract` failed because the sync source and Vue shell did not expose
  attribution fields or cautious "cited delegation" copy.
- GREEN: sync tests now cover an attributed blocked command, an unknown blocked command, a known
  non-bin-cap revoke frame falling back to unattributed, and state-report failure returning empty
  attribution/unattributed refinements.
- GREEN: frontend source tests now prove attributed copy takes priority over the carrier-wide
  fallback and carrier-accepted pending-authority copy, keeps leftover unattributed blocked
  commands visible in the attributed message, and preserves overclaim guards.

## Second Opinion

Claude Code pre-reviewed the slice and gave GO. It confirmed the vector's blocked command cap
decodes to the expected delegation id, but warned that attribution proves only "command C cited
delegation D and the carrier quarantined C as `revoked_capability`." It does not prove the local
user's revocation caused the block, nor universal future effectiveness. Claude required one
state-report read, deterministic attribution/unattributed partitioning, and failure-tolerant cap
decoding.

## Verification

- `cd clients/township-tauri-shell && npm run sync:contract && npm run frontend:contract && npm run typecheck`

## Remaining Work

- Verification ladder and Claude post-review are complete for this slice.
- Live camera QR capture, OS deep-link scheme registration, and peer discovery remain open.
- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
