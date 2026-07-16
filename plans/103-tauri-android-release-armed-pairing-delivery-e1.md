# Plan 103: Tauri Android release armed pairing delivery (E1)

## Status

DONE

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
- RED: Claude Code found that the first green contract masked a real bypass:
  the callback path was gated, but the `current()` polling path could settle a
  no-state URL directly. Tightening the contract to keep returning the no-state
  URL through the next poll reproduced the failure.
- GREEN: the polling path now routes through the same gate-aware settle function
  and keeps polling after blocked current URLs.
- GREEN: `npm run tauri:android:build:release:pairing-probe` rebuilt the
  non-debuggable Android release APK with the probe arm-state config.
- GREEN: `npm run tauri:android:release:pairing:smoke` passed after observing
  `phase=arming`, `blocked_reason=state_mismatch` for the no-state OS intent, no
  premature `phase=pairing outcome=saved` before armed delivery, saved pairing
  from the state-bearing OS intent, paired cold reload, and sync from the
  persisted peer config.

## Second Opinion

Claude Code reviewed the first green draft and found a critical gate bypass in
the polling path. That finding was reproduced with a stricter contract and fixed
before the Android release smoke was rerun. Claude also noted that the baked arm
state is a fixed probe-only constant, so this plan proves release OS-delivery
gate wiring, not browser/chooser-backed state exchange or an unforgeable
production challenge.

## Verification

- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:pairing-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:pairing:smoke`

## Remaining Work

- Browser/chooser-backed state exchange remains unproven.
- Cross-device challenge ceremony, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS proof, authority origination, and full mobile
  onboarding remain separate bounded plans.
