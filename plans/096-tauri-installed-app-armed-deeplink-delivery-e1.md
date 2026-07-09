# Plan 096: Tauri installed-app armed deep-link delivery smoke (E1)

## Status

DONE

## Objective

Close the Plan 095 proof gap by exercising the armed one-shot pairing import
inside a packaged macOS Tauri app, not only at the shared listener/source seam.
The installed app must start unarmed, block unsolicited OS delivery, let a user
arm link import in the real app window, accept one LaunchServices-delivered
`township://pairing` URL as a draft, and then block a second URL because the arm
was consumed.

This is a packaged desktop app delivery proof for the app-controlled ceremony.
It is not a browser chooser proof, Android release armed-delivery proof,
cryptographic nonce/state binding, or full mobile onboarding proof.

## Scope

- Extend the installed `.app` deep-link smoke to cover both unarmed and armed
  delivery in one LaunchServices run.
- Keep the app launch on the packaged macOS bundle through `open -n -W -j` so
  OS URL events are delivered by LaunchServices.
- Deliver OS URLs through `open -a <built Township.app> township://...` so the
  smoke targets the freshly built app bundle instead of any stale bundle-id
  registration.
- Add a keyboard-accessible real-window arm gesture that calls the same
  `armPairingDeepLinkImport` function as the visible button.
- Trace the app-controlled arm event through the feature- and env-gated
  development trace command so the smoke can observe it without WebView
  internals.
- Deliver one OS pairing URL while unarmed and require
  `pairing-link-blocked:not-armed`.
- Arm the app, deliver one OS pairing URL, and require
  `pairing-link-loaded:<peer-fingerprint>`.
- Deliver the same OS pairing URL again and require a second
  `pairing-link-blocked:not-armed`, proving one-shot consumption.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming browser/chooser coverage, Android release armed delivery,
  cryptographic nonce/state binding, or full onboarding.

## Non-Goals

- No browser chooser, Chrome navigation, Android release armed-delivery, physical
  device, QR camera release, or LAN discovery release smoke.
- No cryptographic state/nonce protocol between devices.
- No app-originated grants, authority origination, or full onboarding proof.
- No automatic save, sync, connect, or trust marking when a link is loaded.
- No change to public pairing handoff contents.

## STOP Conditions

- Stop if an unarmed installed-app OS deep link can load a pairing draft.
- Stop if a user-armed installed-app OS deep link cannot load a valid draft.
- Stop if accepting one valid installed-app OS deep link leaves the app armed for
  another URL.
- Stop if the smoke proves loading by direct storage mutation, WebView internals,
  or an out-of-band test-only import path instead of OS URL delivery.
- Stop if a loaded pairing link can save, sync, connect, or mark trust without
  the existing explicit save/sync actions.
- Stop if docs call this browser/chooser coverage, Android release armed
  delivery, cryptographic nonce/state binding, or full mobile onboarding.

## TDD Evidence

- RED: `tauri:deep-link:smoke` failed after the smoke was extended to click the
  visible "Enable link import" control because macOS Accessibility does not
  expose the WebView DOM button as a named window button in the packaged app.
- GREEN: the app now exposes a keyboard-accessible real-window arm gesture that
  calls the same `armPairingDeepLinkImport` function as the visible button and
  traces `pairing-link-import-armed`.
- RED: Claude review found that synthetic WebView events could arm the gate and
  that release bundles exposed the env-gated trace command by default.
- GREEN: arming now rejects untrusted DOM events, and the trace IPC/file append
  path is compiled only with the explicit `township-dev-trace` Cargo feature
  used by the installed-app smoke build.
- GREEN: `tauri:deep-link:smoke` now launches the packaged `.app`, verifies the
  listener is mounted, delivers an unarmed `township://pairing` URL and observes
  `pairing-link-blocked:not-armed`, arms the app window, delivers the same OS
  URL and observes `pairing-link-loaded:<peer-fingerprint>`, then delivers it
  again and observes a second `pairing-link-blocked:not-armed`.
- GREEN: `frontend:contract` now requires the installed-app smoke to prove the
  armed path and requires the Vue app to expose the keyboard arm gesture and arm
  trace.

## Second Opinion

Claude Code found three blocking issues after the first local green pass:
synthetic WebView events could arm the import gate, the macOS proof was
accidentally listed inside Android release APK done-gate bullets, and the
release binary exposed the env-gated dev trace file appender by default. It also
noted that the trace-file absence assertion for save/sync/connect was vacuous
and that the packaged proof exercises a keyboard arm gesture rather than the
visible button click path. The blocking issues are fixed here: trusted events
are required, the macOS proof is documented separately from Android release
status, and `lattice_trace_dev_event` is available only in builds compiled with
the explicit `township-dev-trace` feature.

## Verification

- `cd clients/township-tauri-shell && npm run tauri:deep-link:smoke`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo test --features township-dev-trace`
- `git diff --check`
- `~/.asdf/shims/mix check`

## Remaining Work

- Add browser/chooser coverage beyond macOS `open` and adb OS delivery.
- Add Android release real-app armed OS delivery if the release app needs the
  same UI-level proof outside the probe namespace.
- Add a packaged-app proof for the visible "Enable link import" button click
  path; Plan 096 arms through a trusted keyboard gesture because macOS
  Accessibility did not expose the WebView button as a named button.
- Add cryptographic nonce/state binding if product requirements demand a
  stronger ceremony than app-controlled arming plus explicit confirmation.
- Add QR camera, LAN discovery, physical-device, iOS/Expo, app-originated grant,
  authority-origination, and full onboarding proofs as separate plans.
