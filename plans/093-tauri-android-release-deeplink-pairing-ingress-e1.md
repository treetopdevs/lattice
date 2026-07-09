# Plan 093: Android release deep-link pairing ingress (Tauri Android E1)

## Status

IN PROGRESS

## Objective

Use the Plan 089 loopback-scoped release transport policy and the Plan 091-092
release storage/sync probes to discharge the next narrow gap: a non-debuggable,
normal-app-id Android release APK can receive a public `township://pairing`
handoff through the Android OS intent path, persist only the public carrier peer
config in a dedicated probe namespace, survive force-stop/relaunch with that
config, and then pull from the trusted BEAM peer using the persisted deep-link
endpoint rather than a build-time peer URL.

This is a release OS deep-link pairing ingress + persisted peer-config + pull
proof in a dedicated probe namespace.
This does not prove QR camera onboarding, LAN discovery, app-originated grants,
authority origination, full onboarding UX, iOS/Expo parity, physical-device
behavior, or production remote TLS.

## Scope

- Add an env-gated release startup probe whose build-time env includes only the
  local realm, key id, storage namespace, timeout, and retry delay.
- Reject pairing-probe env that tries to bake the peer URL, peer realm, peer
  public key, or replica.
- Use Tauri's deep-link plugin source and the shared `township://pairing`
  parser to receive the public handoff.
- Save the received public peer config through `saveTownshipCarrierPeerConfig`
  with the release probe's local realm and key id, then reload it from storage
  with `loadTownshipCarrierPeerConfig(workflow.storage, {})` so env fallback
  cannot satisfy the proof.
- Log only ids, counts, booleans, public-key fingerprints, host class, and port.
- Use the dedicated probe key id `township-release-pairing-resident` and storage
  namespace `township:release-pairing-probe`.
- Add a non-CDP Android release smoke that installs the release APK, asserts the
  normal package id, non-debuggable metadata, `usesCleartextTraffic=false`, and
  loopback-only network-security config, then:
  - launches normally and observes `paired=false`;
  - sends `android.intent.action.VIEW` / `android.intent.category.BROWSABLE`
    with `township://pairing?...` through Android's OS intent path;
  - observes `phase=pairing outcome=saved`;
  - force-stops and relaunches;
  - observes `paired=true`;
  - maps `adb reverse` and observes a successful pull from the persisted peer.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming authority origination or full mobile onboarding.

## Non-Goals

- No WebView CDP connection, debug APK fallback, UI command automation, `run-as`,
  native KV inspection, host-side frame injection into release private storage,
  or release command channel outside the probe.
- No private key, seed, secret key id, local realm, or key id in the public
  pairing handoff.
- No app-originated grant issuance, QR camera proof, LAN discovery, iOS, Expo,
  physical-device, or production TLS proof.
- No claim that this is the final user-facing onboarding ceremony.

## STOP Conditions

- Stop if the smoke needs WebView CDP, a debuggable package, debug APK, `run-as`,
  a host KV read, or direct host injection into release app storage.
- Stop if the connect path uses a build-time env peer URL instead of the
  deep-link-persisted peer config.
- Stop if the public pairing handoff carries private key material, seeds,
  secrets, local key ids, or device-local identity.
- Stop if the persisted peer config is not asserted after force-stop/relaunch.
- Stop if release Android deep-link delivery cannot be observed via logcat
  without CDP; characterize the limitation instead of claiming the proof.
- Stop if docs imply QR camera onboarding, app-originated grants, authority
  origination, full mobile onboarding, iOS/Expo parity, physical-device
  behavior, LAN discovery, or production remote TLS.

## TDD Evidence

- RED: `release:pairing:contract` initially failed because
  `src/township_release_pairing_probe.ts` did not exist.
- GREEN: the release pairing probe contract now validates config parsing, rejects
  env-baked peer URL input, formats non-secret log lines, persists the received
  peer config, reloads with `paired=true`, and calls sync with the deep-link
  supplied endpoint.
- RED: `mobile:tauri-readiness` required this Plan 093 file, package scripts,
  app startup wiring, Android OS-intent smoke assertions, and no-overclaim docs
  before the plan/docs were present.

## Second Opinion

Claude Code rejected a broader "full release pairing/onboarding ceremony +
pull grant + author/push/drain" slice as too large and too hard to prove honestly
without CDP. It recommended this narrower Plan 093 proof: release-APK OS
deep-link pairing ingress, persisted peer config, force-stop/relaunch, and pull
from the trusted BEAM peer using only the deep-link supplied endpoint. Claude's
hard stops were no env peer URL, no private/seed/secret material in the handoff,
assert persisted config after relaunch, no release private-storage writes from
the host, and no authority-origination claim.

## Observation

Pending final release APK smoke. The contract-level proof is implemented; the
release smoke and docs must still pass before this plan is marked DONE.

## Verification

- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:pairing-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:pairing:smoke`

## Remaining Work

- Add a later release onboarding proof that includes QR camera or complete
  product ceremony.
- Add later app-originated grant/revoke release proofs if the product needs
  authority issuance from mobile.
- Keep iOS, Expo, physical-device LAN discovery, and production TLS transport
  proofs separate.
