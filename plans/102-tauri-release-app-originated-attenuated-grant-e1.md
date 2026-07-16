# Plan 102: Tauri release app-originated attenuated grant (E1)

## Status

DONE

## Objective

Extend the release author probe so the real Tauri Android release path can prove
the app can originate and persist an app-originated post-only attenuated
Township grant from its own native device key, without claiming authority
origination or full onboarding.

## Scope

- Add an explicit public grant-audience env knob to the release author probe
  build.
- After pulling the host-minted post-only bootstrap grant, have the app author a
  child grant with `ops: ["post"]` through the existing Tauri delegation action.
- Persist that app-originated grant in local op, carrier outbox, delegation
  evidence, and resume metadata before the post/unauthorized-summary authoring
  phase.
- Log a dedicated non-secret `phase=grant` probe line and include the grant in
  the pre-push reload, push, and peer authority report expectations.

## Non-Goals

- No root/authority origination from the app device.
- No escalation beyond the pulled post-only parent grant.
- No QR camera onboarding, LAN discovery, browser/chooser proof, Android release
  armed OS delivery, iOS proof, or full mobile onboarding claim.

## STOP Conditions

- Stop if the app-authored grant requests any operation outside `["post"]`.
- Stop if the release probe bakes or logs secret/private key material.
- Stop if docs imply authority origination or full onboarding from this proof.
- Stop if the normal release build, outside the explicit author-probe script,
  receives probe-only env config.

## TDD Evidence

- RED: `npm run release:author:contract` failed because
  `VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY` was ignored.
- GREEN: `npm run release:author:contract` passes with `phase=grant`,
  persisted app-grant metadata, three pushed frames, and peer
  `grant_authority_accepted=true` in the source-level harness.
- GREEN: `npm run typecheck` passes after tightening the grant metadata/error
  discriminant.
- GREEN: `npm run mobile:tauri-readiness` validates the release author probe,
  package script, and Android release smoke are wired for the app-originated
  grant proof.
- GREEN: `npm run tauri:android:build:release:author-probe` rebuilt the
  non-debuggable Android release APK with the public grant-audience probe config.
- GREEN: `npm run tauri:android:release:author:smoke` passed, observing
  `phase=grant`, pre-push `outbox_frame_count=3`, three pushed frames, peer
  `grant_authority_accepted=true`, and offline reload with the app-grant
  evidence retained.

## Second Opinion

Claude Code was requested for a non-interactive second-opinion review of the
Plan 102 diff and evidence, focused on attenuation, overclaiming, log secrecy,
resume behavior, and Android smoke assertions. The CLI produced no review text
after roughly a minute and was interrupted. No Claude approval is claimed.

## Verification

- `cd clients/township-tauri-shell && npm run release:author:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:author-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:author:smoke`

## Remaining Work

- Authority origination remains unproven; this app-authored grant is explicitly
  attenuated under a pulled post-only parent.
- Android release armed OS delivery, browser/chooser-backed pairing state
  exchange, QR camera onboarding, LAN discovery, physical-device behavior, iOS
  key reuse, and full onboarding remain separate bounded plans.
