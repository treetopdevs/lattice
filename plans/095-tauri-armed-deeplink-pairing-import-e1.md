# Plan 095: Tauri armed deep-link pairing import gate (E1)

## Status

DONE

## Objective

Close the next production-facing caveat after Plan 094: the real Tauri app must
not load OS-delivered `township://pairing` draft metadata merely because another
local app sends a syntactically valid public deep link. A user must first arm
pairing link import inside the app, and that arming must be one-shot for a valid
pairing URL.

This is an equivalent anti-hijack gate for app-controlled deep-link import. It
is not a cryptographic nonce/state exchange, browser chooser proof, or full
mobile onboarding ceremony.

## Scope

- Add a public one-shot pairing deep-link gate to the shared TypeScript listener
  seam.
- Block current and future OS deep-link URLs while the gate is unarmed.
- Bound the Tauri plugin `getCurrent()` and `onOpenUrl()` calls so stalled
  plugin promises cannot prevent the app from mounting the listener.
- Let an armed invalid pairing URL surface its parse error without consuming the
  arm.
- Consume the arm after one valid pairing URL is accepted in the shared
  listener/source contract.
- Disarm the import window when the listener stops.
- Wire the Vue shell to expose explicit arm/cancel controls and pass the gate
  into `createTownshipPairingDeepLinkListener`.
- Trace unarmed installed-app OS delivery as blocked rather than loading a
  draft.
- Keep canonical diagnostic deep-link polling away from the destructive Android
  pairing-intent handoff source.
- Preserve raw handoff paste, QR image/camera import, discovery import, and the
  Plan 093 release probe behavior.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming browser/chooser coverage, cryptographic nonce/state binding, or full
  onboarding.

## Non-Goals

- No cryptographic state/nonce protocol between devices.
- No browser chooser, Chrome navigation, physical-device, QR camera release, or
  LAN discovery release smoke.
- No app-originated grants, authority origination, or full onboarding proof.
- No change to public pairing handoff contents.

## STOP Conditions

- Stop if an unarmed OS deep link can load a pairing draft in the real app.
- Stop if accepting one valid deep link leaves the app armed for another URL.
- Stop if invalid deep links can drain the user-armed import window.
- Stop if raw handoff paste, QR, discovery, or release-probe pairing paths are
  forced through the OS deep-link arming gate.
- Stop if docs call this cryptographic nonce/state binding or full mobile
  onboarding.
- Stop if docs claim real-app armed OS delivery beyond source/contract coverage.

## TDD Evidence

- RED: `deeplink:contract` failed because
  `createOneShotTownshipPairingDeepLinkGate` did not exist.
- GREEN: the listener contract now proves unarmed current/future URLs are
  blocked, an armed valid URL is applied once and disarms the gate, a second URL
  is blocked, and invalid armed URLs surface parse errors without consuming the
  arm.
- RED: the listener contract then failed because stopping a still-armed listener
  left the import gate armed.
- GREEN: listener `stop()` now disarms the gate, and the Vue wrapper clears the
  displayed armed state on unmount.
- RED: `deeplink:source:contract` failed because never-resolving Tauri
  `getCurrent()` and `onOpenUrl()` promises could keep the app from reaching
  listener-mounted status.
- GREEN: the Tauri deep-link source now bounds both plugin calls and falls back
  to future URL events, while still merging Android raw-intent handoffs when
  available.
- RED: `frontend:contract` failed because the Vue shell still mounted pairing
  deep-link import in always-on mode.
- GREEN: the Vue source contract now requires explicit arm/cancel controls, a
  default-unarmed gate, blocked-link handling, and installed-app smoke evidence
  that unarmed OS delivery is refused instead of loading a draft.
- RED: Claude review identified that the canonical probe could poll the same
  Android pairing-intent source and consume a one-shot handoff before the
  pairing listener saw it.
- GREEN: the canonical probe now opts out of Android pairing-intent consumption,
  while the pairing listener source keeps the native raw-intent bridge.
- RED: Claude review identified that subscription timeout fallback could trace
  listener-mounted while dropping the eventual unsubscribe handle.
- GREEN: subscription timeout now rejects, so the app traces listener unavailable
  instead of pretending to be subscribed.
- RED: Claude review identified that the TS parser accepted port-bearing
  `township://pairing:...` URLs and that the release trace command accepted raw
  multi-line events.
- GREEN: the TS parser now rejects port-bearing custom-scheme pairing links, and
  release trace lines are env-gated, newline/null sanitized, and length-capped.

## Second Opinion

Claude Code returned a second-opinion review after the local green pass. It
flagged five issues: canonical-probe polling shared the destructive Android
pairing-intent source, installed smoke only proved unarmed delivery, subscription
timeouts could leak a late listener while tracing mounted, release trace lines
needed sanitization, and TS parsing needed to match Kotlin's port rejection. The
blocking code issues are fixed here. The proof claim is intentionally narrowed:
installed `.app` smoke proves unarmed OS delivery is blocked, while the armed
accept/disarm path is source/contract-proven and still needs a real-app armed UI
delivery smoke.

## Verification

- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run deeplink:source:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `git diff --check`
- `~/.asdf/shims/mix check`

## Remaining Work

- Add browser/chooser coverage beyond adb or macOS `open` delivery.
- Add a real-app armed UI delivery smoke for the one-shot link import path.
- Add cryptographic nonce/state binding if product requirements demand a
  stronger ceremony than app-controlled arming plus explicit confirmation.
- Add QR camera, LAN discovery, physical-device, iOS/Expo, app-originated grant,
  authority-origination, and full onboarding proofs as separate plans.
