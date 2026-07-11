# Plan 119: Tauri packaged onboarding convergence (E1)

## Status

DONE

## Objective

Lift Plan 118's default-namespace TypeScript ceremony into the packaged macOS
Tauri app runtime and prove it against a live BEAM Township peer without
weakening the Sim oracle.

The packaged app must import a public pairing handoff, pull the resident cap,
author the Sim-exported post frame through its native signer, push that frame,
drain the default `TOWNSHIP_STORAGE_NAMESPACE` outbox, and match the peer's
materialized state while resident private seed material stays out of app KV.

## Scope

- Add `tauri:onboarding:smoke` for macOS.
- Launch the real dev-trace release-mode `.app` through `open -n -W`.
- Invoke the existing `onboardTownshipDesktop` public ceremony from an
  env-gated packaged-runtime probe.
- Use `LatticeNodeSpike.TownshipOnboardingScenario` to expose the exact
  Sim-derived W1 prefix immediately before the resident post.
- Use the resident device key as both the native op signer and the carrier
  client identity trusted by the live BEAM peer.
- Assert the app authors the existing Sim-exported post frame, the peer reports
  the exact expected op ids/materialized post, and authority quarantine is
  empty.
- Assert pairing, local ops, delegation frames, and a drained outbox are stored
  under the default namespace.
- Permit `TOWNSHIP_NATIVE_KV_FILE` only in debug or `township-dev-trace`
  builds so the smoke uses an isolated native KV file instead of ordinary app
  state.
- Assert the isolated app KV contains no resident private seed material.
- Add the packaged smoke to `app:convergence`.

## Non-Goals

This does not prove human click-through of the pairing, sync, or post controls.
It does not prove production GUI automation.
It does not prove iOS or Expo.
It does not prove cross-device pairing state exchange.
It does not prove QR camera onboarding, LAN discovery, physical-device
behavior, or production remote TLS.
It does not prove full mobile onboarding.

## STOP Conditions

- Stop if the post is pre-seeded or side-loaded instead of signed by the
  packaged app.
- Stop if the pairing config is pre-seeded instead of imported from a public
  handoff.
- Stop if expected op/frame ids are recomputed by the TypeScript implementation
  instead of read from the Sim-exported vector.
- Stop if the proof uses a dedicated Township storage namespace rather than
  the default `TOWNSHIP_STORAGE_NAMESPACE`.
- Stop if the test can read or modify ordinary app KV instead of its isolated
  native KV file.
- Stop if resident private seed material appears in app KV or trace output.
- Stop if docs call this human click-through, phone-grade, cross-device,
  QR/LAN, iOS/Expo, physical-device, production TLS, or full mobile onboarding
  proof.

## TDD Evidence

- RED: `npm --prefix clients/township-tauri-shell run tauri:onboarding:smoke`
  launched the packaged app but timed out waiting for the
  `township-onboarding-drained` marker because `App.vue` never invoked
  `onboardTownshipDesktop`.
- INTERMEDIATE RED: the first real initial sync reached `post_failed` because
  the smoke had seeded the carrier-session key while the Sim cap correctly
  targeted the separate resident author/device key.
- GREEN: the smoke now seeds the resident device identity, starts a BEAM peer
  that trusts that client key, pulls the Sim-derived onboarding prefix, authors
  the exact Sim-exported post frame through `lattice_sign_carrier`, pushes it,
  and observes a drained outbox plus matching peer state.
- RED: `frontend:contract`, `mobile:strategy`, and
  `mobile:tauri-readiness` failed until the named smoke, convergence-gate
  wiring, Plan 119, and bounded documentation existed.

## Second Opinion

Claude Code independently selected packaged desktop app-runtime onboarding as
the next bounded slice after Plan 118. It found the same gap: the public
ceremony had only an injected TypeScript carrier/signer contract while the
packaged app never invoked it. Claude also required a real BEAM peer, native
signing evidence, a drained outbox, Sim-vector expectations, and explicit
language that this does not prove human click-through.

## Verification

- `npm --prefix clients/township-tauri-shell run tauri:onboarding:smoke`
- `npm --prefix clients/township-tauri-shell run onboarding:contract`
- `npm --prefix clients/township-tauri-shell run frontend:contract`
- `npm --prefix clients/township-tauri-shell run mobile:strategy`
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
- `npm --prefix clients/township-tauri-shell run typecheck`
- `npm --prefix clients/township-tauri-shell run app:convergence`
- `~/.asdf/shims/mix verify`

## Remaining Work

- Human click-through of the packaged pairing/save/sync/post controls remains
  separate.
- Cross-device pairing state exchange remains separate.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo,
  production remote TLS, and full mobile onboarding remain separate bounded
  plans.
