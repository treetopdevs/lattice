# Plan 104: Tauri Android release convergence gate (E1)

## Status

DONE

## Objective

Add one named Android release gate that composes the existing release proof
slices for pull/reload persistence, app-originated author/grant persistence,
and armed OS pairing delivery without claiming full mobile onboarding.

## Scope

- Add `tauri:android:release:convergence` to the Tauri shell package.
- Sequence build-then-smoke for each probe variant so every smoke runs against
  the APK that has its own release probe env baked in.
- Cover the existing release sync/reload probe, release author/app-originated
  grant probe, and release armed pairing probe.
- Update the build map, mobile secure-store strategy, and plan index without
  widening the proof beyond those bounded probe namespaces.

## Non-Goals

- No browser/chooser-backed state exchange.
- No authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, or full
  mobile onboarding.
- No new runtime behavior; this is a named gate over already bounded release
  probes.

## STOP Conditions

- Stop if the gate runs multiple release smokes against one shared APK instead
  of rebuilding each probe APK before running its corresponding smoke.
- Stop if docs call this browser/chooser coverage, production challenge
  exchange, authority origination, phone-grade equivalence, or full onboarding.
- Stop if the gate omits the release armed pairing proof or the
  app-originated grant proof.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because
  `tauri:android:release:convergence` did not exist.
- GREEN: the package script now builds each probe APK before running its
  corresponding smoke.
- RED: `npm run mobile:tauri-readiness` failed because Plan 104 and its docs
  were missing.
- TRANSIENT: the first `npm run tauri:android:release:convergence` run rebuilt
  the sync probe and passed the wrong-peer negative, then timed out waiting for
  the fresh positive run's `phase=native_key` log with an empty logcat slice.
- GREEN: rerunning `npm run tauri:android:release:sync:smoke` against the same
  rebuilt sync APK passed wrong-peer negative, release pull/reload, and offline
  cold reload.
- GREEN: rerunning `npm run tauri:android:release:convergence` passed the full
  sequence: sync-probe build + smoke, author-probe build + smoke, and
  pairing-probe build + smoke.
- GREEN: `npm run mobile:tauri-readiness` passes with Plan 104 and the docs
  present.

## Second Opinion

Claude Code agreed this is aligned with the build-map goal and the user request
when kept as a composition-only release gate. It warned that each probe has
build-time env baked into its APK, so the gate must build and smoke each probe
variant in sequence instead of assuming one shared APK.

## Verification

- `cd clients/township-tauri-shell && npm run tauri:android:release:sync:smoke`
- `cd clients/township-tauri-shell && npm run tauri:android:release:convergence`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`

## Remaining Work

- Browser/chooser-backed state exchange remains unproven.
- Authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, and full
  mobile onboarding remain separate bounded plans.
