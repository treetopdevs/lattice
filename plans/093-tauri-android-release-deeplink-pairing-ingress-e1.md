# Plan 093: Android release deep-link pairing ingress (Tauri Android E1)

## Status

DONE

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
- No claim that a public Android `VIEW`/`BROWSABLE` intent is an authorization
  ceremony. This env-gated probe proves ingress and persistence only; production
  pairing still needs a user confirmation, nonce/state binding or equivalent
  anti-hijack ceremony, and explicit overwrite policy.

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
- RED: `deeplink:source:contract` required the Android native bridge to expose a
  base64 public handoff rather than a Tauri-normalized custom-scheme URL.
- RED: `deeplink:contract` required hostless custom-scheme parsing
  (`township:////pairing?...`) after Android WebView parsed `township://pairing`
  differently from Node's URL implementation.
- RED: Claude's follow-up review flagged the native Android extractor as the
  real boundary once it returns only a handoff. Android instrumentation now
  covers one-shot handoff consumption, foreign-host/nohost/userinfo/port/
  uppercase/opaque rejection, non-`VIEW`/non-`BROWSABLE` rejection, and oversized
  URI rejection in `TownshipIntentStore`.
- GREEN: `tauri:android:release:pairing:smoke` proves the rebuilt release APK
  accepts the adb-delivered Android `VIEW`/`BROWSABLE` intent, saves the pairing, reloads paired after
  force-stop/relaunch, and syncs from the persisted peer config.

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

Final release smoke passed against
`clients/township-tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
on Android API 34. Evidence:

- initial launch logged `phase=reload outcome=loaded paired=false`;
- adb-delivered Android `VIEW`/`BROWSABLE` delivery logged
  `phase=pairing outcome=saved` with `host_class=loopback url_port=43193`;
- after force-stop/relaunch, the app logged `phase=reload outcome=loaded
  paired=true` with the same peer fingerprint and no host KV inspection;
- the persisted peer config then synced with `phase=sync outcome=synced`,
  nonempty pulled/local/delegation ids, and
  `outbox_frame_count=0 pushed_frame_count=0 accepted_count=0`.

Implementation note: Android stores the raw intent before Tauri's deep-link
plugin normalizes it, extracts only the public pairing handoff natively, returns
that handoff as base64 through `lattice_android_current_pairing_handoff_b64`,
and reconstructs a normal pairing URL in TypeScript. The native extractor
requires `VIEW` plus `BROWSABLE`, rejects oversized, foreign-host, and
port-bearing custom-scheme intents, and consumes a valid stored handoff once.
The shared parser now also handles hostless custom-scheme shapes so Android
WebView URL parsing quirks do not block the release proof.

Security boundary note: the proof intentionally accepts one public pairing
handoff in a dedicated probe namespace to exercise release ingress and storage.
It does not authorize arbitrary future pairing writes, prove user intent, or
define production behavior for a second pairing intent after a device is already
paired. It also does not prove Chrome/browser navigation or chooser behavior;
the smoke drives the Android `VIEW`/`BROWSABLE` intent through adb. A malicious
local app can still send a syntactically valid public handoff intent, so the
future production ceremony needs confirmation and nonce/state binding even
though this probe's handoff excludes local identity, key ids, seeds, and private
signing material.

## Verification

- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:pairing-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:pairing:smoke`

## Remaining Work

- Add a later release onboarding proof that includes QR camera or complete
  product ceremony.
- Add a later production pairing ceremony with user confirmation, state/nonce
  binding or equivalent anti-hijack protection, and an explicit already-paired
  overwrite/reject policy.
- Add later app-originated grant/revoke release proofs if the product needs
  authority issuance from mobile.
- Keep iOS, Expo, physical-device LAN discovery, and production TLS transport
  proofs separate.
