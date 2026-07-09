# Plan 103: Tauri Android release armed pairing delivery (E1)

## Status

IN PROGRESS

## Objective

Extend the Android release pairing proof so a non-debuggable APK requires an
armed app-local state token before accepting an OS-delivered `township://pairing`
handoff.

## Scope

- Add a probe-only release pairing arm-state config.
- Reuse the existing one-shot Township pairing deep-link gate in the release
  pairing probe.
- Log only that state is required; do not log the state token value.
- Prove a no-state Android `VIEW`/`BROWSABLE` pairing intent is blocked with
  `blocked_reason=state_mismatch`.
- Prove the later state-bearing Android pairing intent is saved, survives
  force-stop/relaunch, and syncs from the BEAM peer through the persisted config.

## Non-Goals

- No browser/chooser-backed state exchange.
- No cross-device challenge ceremony.
- No QR camera onboarding, LAN discovery, physical-device behavior, iOS proof,
  authority origination, or full mobile onboarding claim.

## STOP Conditions

- Stop if the state token appears in probe logs.
- Stop if an Android release pairing link without state can persist a peer config
  while the arm-state config is active.
- Stop if docs call the probe arm state a production browser/chooser ceremony.
- Stop if the normal release build gets release-pairing probe env config.

## TDD Evidence

- RED: `npm run release:pairing:contract` failed because
  `VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE` was ignored.
- GREEN: `npm run release:pairing:contract` passes with `phase=arming`,
  blocked no-state pairing links, no state-token log leak, and later successful
  state-bearing pairing.
- GREEN: `npm run typecheck` passes after adding the release pairing probe gate
  result shapes.

## Second Opinion

Pending Claude Code review. No Claude approval is claimed yet.

## Verification

- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run typecheck`

## Remaining Work

- Rebuild the Android release pairing-probe APK with the probe arm-state config.
- Run `npm run tauri:android:release:pairing:smoke` against the rebuilt APK and
  BEAM peer.
- If the release smoke passes, mark this plan DONE and update the build map and
  mobile secure-store strategy to move Android release armed OS delivery out of
  the unproven list, bounded to the release pairing probe.
