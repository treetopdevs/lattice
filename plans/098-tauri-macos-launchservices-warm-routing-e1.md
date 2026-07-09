# Plan 098: Tauri macOS LaunchServices warm routing (E1)

## Status

DONE

## Objective

Strengthen the packaged macOS pairing-link smoke from "the harness can hand a
URL to `Township.app` by path" to "macOS LaunchServices resolves `township://`
to the freshly built packaged app, and bare `open township://...` reaches that
already-running app."

This is a warm-routing proof. The app is launched first with the dev-trace
environment, then bare URL delivery is exercised. It is not a cold-start URL
delivery proof, browser/chooser proof, Android release armed-delivery proof,
cryptographic nonce/state binding, or full onboarding proof.

## Scope

- Register the freshly built `Township.app` bundle with LaunchServices in the
  macOS-only packaged smoke.
- Assert via `NSWorkspace` that `township://` resolves to that exact app bundle
  before the first bare URL delivery.
- Deliver the unarmed, armed, and post-consume pairing links with bare `open township://`
  URL delivery,
  not `open -a <bundle> township://...`.
- Keep `open -a <bundle>` for app launch/window activation only; activation is
  not the URL-delivery behavior under test.
- Document that `lsregister -f` updates the local LaunchServices registration
  for this scheme; handler cleanup/restoration is outside this slice.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming cold-start delivery, browser/chooser behavior, Android release armed
  delivery, cryptographic nonce/state binding, or full onboarding.

## Non-Goals

- No Safari/Chrome/browser chooser automation.
- No cold-start LaunchServices proof; the trace file path still arrives through
  the harness-launched process environment.
- No Android release armed-delivery, physical-device, QR camera release, LAN
  discovery release, or full onboarding proof.
- No cryptographic state/nonce protocol between devices.

## STOP Conditions

- Stop if bare URL delivery is used without first proving LaunchServices resolves
  `township://` to the freshly built app bundle.
- Stop if `open -a <bundle>` is removed from the app activation shortcut path.
- Stop if docs call this browser/chooser coverage, cold-start delivery, Android
  release armed delivery, cryptographic nonce/state binding, or full onboarding.

## TDD Evidence

- RED: `frontend:contract` failed until the packaged smoke registered the fresh
  bundle, asserted `NSWorkspace` routing for `township://`, and removed
  app-targeted URL delivery from `deliverDeepLink`.
- GREEN: `tauri:deep-link:smoke` now registers the freshly built bundle, asserts
  `NSWorkspace.shared.urlForApplication(toOpen:)` resolves to that bundle, and
  sends all three pairing URLs with bare `open township://...`.
- GREEN: in the warm smoke, the trace file path polled by the harness is
  supplied only to the harness-launched process, so observing the pairing-link
  trace in that file after bare URL delivery proves the link reached the
  already-running traced app rather than a cold-spawned untraced app.

## Second Opinion

Claude Code reviewed the planned slice before implementation and the implemented
diff after verification. The planning review approved the direction only if the
smoke asserted LaunchServices handler resolution first, kept `open -a` for
activation, and documented that this proves warm routing rather than cold-start
or browser/chooser behavior. The implementation review returned NO BLOCKERS and
confirmed the smoke force-registers the fresh bundle, asserts `NSWorkspace`
scheme resolution before delivery, sends all three pairing URLs through bare
`open township://` delivery, preserves `open -a` for activation only, and keeps
the docs from overclaiming cold-start, browser/chooser, Android release armed
delivery, nonce/state, or full onboarding. It also called out the persistent
LaunchServices registration as a non-blocking cleanup/follow-up.

## Verification

- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:deep-link:smoke`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `git diff --check`

## Remaining Work

- Add a cold-start URL delivery proof. That likely requires a trace path that a
  LaunchServices-cold-started app can discover without harness-injected env.
- Add LaunchServices handler cleanup/restoration if this smoke should avoid
  leaving the developer machine registered to the generated bundle path.
- Add browser/chooser coverage if product requirements demand it.
- Add Android release real-app armed OS delivery, cryptographic state/nonce
  binding, QR camera, LAN discovery, physical-device, iOS/Expo, app-originated
  grant, authority-origination, and full onboarding proofs as separate plans.
