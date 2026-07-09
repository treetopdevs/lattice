# Plan 097: Tauri pairing link no-side-effect trace guard (E1)

## Status

IN PROGRESS

## Objective

Make the Plan 096 "load a pairing link as a draft only" guarantee measurable.
The packaged app deep-link smoke must be able to prove that loading a
`township://pairing` URL does not also submit the Save Pairing form, start Sync
Outbox, or start the carrier health probe.

This is a real-app side-effect guard for imported pairing links. It is not a
browser chooser proof, Android release armed-delivery proof, cryptographic
nonce/state binding, or full mobile onboarding proof.

## Scope

- Add explicit dev-trace events at the start of the three user-controlled
  side-effect handlers:
  - `pairing-config-save-submitted`
  - `sync-outbox-started`
  - `carrier-health-started`
- Keep those traces best-effort so normal release builds without the
  `township-dev-trace` feature still ignore missing trace IPC.
- Extend the packaged installed-app deep-link smoke to assert that none of those
  side-effect trace events appear while an armed OS-delivered pairing link is
  loaded as a draft.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming browser/chooser coverage, Android release armed delivery,
  cryptographic nonce/state binding, or full onboarding.

## Non-Goals

- No automatic save, sync, connect, or trust marking when a link is loaded.
- No browser chooser, Chrome navigation, Android release armed-delivery,
  physical-device, QR camera release, or LAN discovery release smoke.
- No cryptographic state/nonce protocol between devices.
- No app-originated grants, authority origination, or full onboarding proof.
- No change to public pairing handoff contents.

## STOP Conditions

- Stop if loading an armed pairing link emits `pairing-config-save-submitted`,
  `sync-outbox-started`, or `carrier-health-started`.
- Stop if the absence assertion is only checking UI copy or trace strings that
  no real app action can emit.
- Stop if the side-effect traces are required in normal release builds without
  the explicit `township-dev-trace` feature.
- Stop if docs call this browser/chooser coverage, Android release armed
  delivery, cryptographic nonce/state binding, or full mobile onboarding.

## TDD Evidence

- RED: `frontend:contract` failed because the Vue source did not emit
  traceable side-effect events for Save Pairing, Sync Outbox, or Check Carrier.
- GREEN: the real app handlers now emit best-effort
  `pairing-config-save-submitted`, `sync-outbox-started`, and
  `carrier-health-started` traces when those user actions start.
- GREEN: `tauri:deep-link:smoke` now launches the packaged `.app`, performs the
  unarmed/armed/one-shot OS deep-link flow, and asserts none of the side-effect
  trace events appears while the pairing link is merely loaded as a draft.

## Second Opinion

Claude Code must review this slice before it is treated as complete. Review
should confirm that the new absence checks are no longer vacuous, that the trace
events do not change shipping behavior without `township-dev-trace`, and that
the docs do not overclaim browser, Android release, nonce/state, or full
onboarding coverage.

## Verification

- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:deep-link:smoke`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `git diff --check`
- `~/.asdf/shims/mix check`

## Remaining Work

- Add browser/chooser coverage beyond macOS `open` and adb OS delivery.
- Add Android release real-app armed OS delivery if the release app needs the
  same UI-level proof outside the probe namespace.
- Add a packaged-app proof for the visible "Enable link import" button click
  path; Plans 096-097 arm through a trusted keyboard gesture because macOS
  Accessibility did not expose the WebView button as a named button.
- Add cryptographic nonce/state binding if product requirements demand a
  stronger ceremony than app-controlled arming plus explicit confirmation.
- Add QR camera, LAN discovery, physical-device, iOS/Expo, app-originated grant,
  authority-origination, and full onboarding proofs as separate plans.
