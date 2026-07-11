# Plan 118: Tauri desktop onboarding convergence (E1)

## Status

DONE

## Objective

Prove the desktop Tauri Township onboarding/cap persistence ceremony as one
continuous TypeScript shell workflow in the default app namespace.

Earlier slices proved the individual ingredients: pairing handoff import/save,
sync, post authoring, live BEAM sync, and the named desktop `app:convergence`
gate. This plan composes those public seams through `onboardTownshipDesktop` so
the default app storage path can import a pairing handoff, run initial sync,
author a post against the pulled cap, run final sync, and observe a drained
outbox without putting resident private key material in app KV.

## Scope

- Add `onboarding:contract`.
- Add `onboardTownshipDesktop` as the desktop orchestration seam.
- Reuse `importTownshipCarrierPairingHandoff` and
  `saveTownshipCarrierPeerConfig` for the imported pairing handoff.
- Reuse `syncTownshipOutbox` for initial sync and final sync.
- Reuse `submitTownshipPost` to author a post from the pulled cap.
- Use the default `TOWNSHIP_STORAGE_NAMESPACE`; do not hide the proof in a
  special probe namespace.
- Assert the default namespace stores the pairing config, local op ids,
  delegation frame ids, and an empty pending outbox after final sync.
- Assert native KV contains no resident private seed material.
- Add `onboarding:contract` to `app:convergence`.

## Non-Goals

This does not prove QR camera onboarding.
This does not prove LAN discovery.
This does not prove physical-device behavior.
This does not prove production remote TLS.
This does not prove iOS or Expo.
This does not prove cross-device pairing state exchange.
This does not prove a packaged GUI smoke; the seam is a TypeScript orchestration
contract over the Tauri-native storage/signer boundary.
This does not prove full mobile onboarding.

## STOP Conditions

- Stop if the proof uses a dedicated probe namespace instead of the default
  `TOWNSHIP_STORAGE_NAMESPACE`.
- Stop if the pairing config is pre-seeded instead of imported from a handoff.
- Stop if the post cap is side-loaded outside the initial sync.
- Stop if the final sync leaves the authored frame pending in the outbox.
- Stop if any resident private seed material is visible in app KV.
- Stop if docs describe this as phone-grade, iOS/Expo, cross-device, packaged
  GUI, LAN, QR camera, physical-device, production TLS, or full mobile
  onboarding proof.

## TDD Evidence

- RED: `npm --prefix clients/township-tauri-shell run onboarding:contract`
  failed because `onboarding:contract` did not exist.
- RED: `npm --prefix clients/township-tauri-shell run onboarding:contract`
  failed because `src/township_onboarding.ts` did not exist.
- GREEN: `npm --prefix clients/township-tauri-shell run onboarding:contract`
  passed after adding `onboardTownshipDesktop` and the Sim-vector-backed
  default-namespace ceremony contract.
- RED: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  failed because `plans/118-desktop-onboarding-convergence-e1.md` did not
  exist.
- GREEN: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  passed after adding this plan, `app:convergence` wiring, and bounded docs.

## Second Opinion

Claude Code recommended this as the next bounded slice after the visible chooser
work because it exercises the real desktop app convergence path and default
namespace cap persistence ceremony without inventing fake phone, cross-device,
or QR/LAN evidence.

## Verification

- `npm --prefix clients/township-tauri-shell run onboarding:contract`
- `npm --prefix clients/township-tauri-shell run frontend:contract`
- `npm --prefix clients/township-tauri-shell run mobile:strategy`
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
- `npm --prefix clients/township-tauri-shell run typecheck`
- `npm --prefix clients/township-tauri-shell run app:convergence`

## Remaining Work

- Packaged GUI onboarding smoke remains separate.
- Cross-device pairing state exchange remains separate.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, and full mobile onboarding remain separate bounded
  plans.
