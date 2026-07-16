# Plan 099: Tauri macOS cold-start deep-link delivery (E1)

## Status

DONE

## Objective

Prove the startup URL path that a resident hits when `Township.app` is not
running: LaunchServices starts the freshly built packaged app from a bare
`township://pairing` URL, and the app delivers that pairing link into the
existing draft-only, unarmed gate.

This is a packaged macOS cold-start delivery proof. It is not a browser/chooser
proof, Android/iOS cold-start proof, Android release armed-delivery proof,
cryptographic nonce/state binding, or full onboarding proof.

## Scope

- Add a separate installed-app cold-start smoke so the older warm armed-link
  ceremony remains isolated.
- Register the freshly built `Township.app` bundle with LaunchServices and
  assert `township://` resolves to that bundle through `NSWorkspace`.
- Prove Township is not already running before the bare URL is opened.
- Add a `township-dev-trace`-only macOS trace-file fallback through the
  bundle-scoped `TownshipDevTraceFile` defaults key, because a LaunchServices
  cold-started app does not inherit the harness process environment.
- Clear the defaults key in cleanup so later warm-routing proofs do not silently
  rely on the cold-start trace path.

## Non-Goals

- No browser/chooser automation.
- No Android or iOS cold-start proof.
- No Android release armed-delivery, physical-device, QR camera release, LAN
  discovery release, or full onboarding proof.
- No cryptographic state/nonce protocol between devices.
- No replacement for the existing warm armed-link and no-side-effect smokes.

## STOP Conditions

- Stop if the cold-start smoke passes while a Township process is already
  running.
- Stop if the defaults trace key is not cleared in cleanup.
- Stop if normal builds acquire a trace side channel; the defaults fallback must
  stay behind `township-dev-trace`.
- Stop if docs call this browser/chooser coverage, Android/iOS cold-start
  delivery, Android release armed delivery, cryptographic nonce/state binding,
  or full onboarding.

## TDD Evidence

- RED: extending the installed-app proof to cold-start delivery failed because a
  LaunchServices-started app had no `TOWNSHIP_DEV_TRACE_FILE` environment and
  could not write the startup trace.
- GREEN: `tauri:cold-deep-link:smoke` sets the bundle-scoped defaults trace
  path, verifies Township is not already running, opens the bare
  `township://pairing` URL, and observes `deep-link-listener-mounted`,
  `dev-trace-runtime-ready`,
  `deep-link:township://pairing...`, and `pairing-link-blocked:not-armed`.
- GREEN: the existing warm armed-link smoke remains a separate script so the
  cold-start defaults fallback does not become a hidden precondition for the
  warm proof.

## Second Opinion

Claude Code reviewed the planned slice before implementation and the implemented
diff after verification. The planning review approved proceeding only if the
cold-start proof used a separate trace file/defaults path, proved the app was not
already running, cleaned the defaults key in a failure-safe path, kept the
fallback dev-trace-only, and documented the narrow macOS-only scope. The
implementation review returned NO BLOCKERS. It confirmed the cold-start smoke
proves LaunchServices starts the packaged app and delivers the pairing URL into
the draft-only blocked path, the Rust defaults fallback is feature-gated and
absent from normal builds, the separate script avoids weakening Plan 096-098,
and the docs avoid overclaiming browser/chooser, Android/iOS cold-start,
Android release armed delivery, nonce/state, or full onboarding. It also noted
that the trace does not distinguish `getCurrent()` from `onOpenUrl()`, so this
plan claims cold-start delivery rather than a specific plugin callback branch.

## Verification

- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:cold-deep-link:smoke`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo test --features township-dev-trace`
- `git diff --check`

## Remaining Work

- Add browser/chooser coverage if product requirements demand it.
- Add Android/iOS cold-start delivery proofs separately.
- Decide whether `tauri:cold-deep-link:smoke` should join `app:convergence` or
  remain a separate heavier packaged-app gate.
- Add Android release real-app armed OS delivery, cryptographic state/nonce
  binding, QR camera, LAN discovery, physical-device, iOS/Expo, app-originated
  grant, authority-origination, and full onboarding proofs as separate plans.
