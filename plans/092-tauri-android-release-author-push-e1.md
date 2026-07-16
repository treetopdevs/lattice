# Plan 092: Android release author/push/outbox drain (Tauri Android E1)

## Status

DONE

## Objective

Use the Plan 089 loopback-scoped release transport policy and the Plan 091 release
pull/reload storage proof to discharge the next narrow gap: a non-debuggable,
normal-app-id Android release APK can use its runtime native key to receive a
host-minted post-only grant, author a post on device, push both that valid post
and a deliberately unauthorized summary edit through the trusted BEAM carrier,
compact the local outbox to zero, and reload the persisted state after a cold
restart.

This is a release device-local authoring + push/outbox-drain proof in a dedicated
probe namespace.
This does not prove pairing ceremony, app-originated grants, or full mobile onboarding.
It also does not prove authority origination, iOS/Expo parity, physical-device behavior, LAN
discovery, or production remote TLS.

## Scope

- Extend the Township BEAM peer harness so a release app runtime public key can be
  passed as `bootstrapAudiencePubkey`, causing `LatticeNodeSpike.TownshipScenario`
  to append a clerk-authored, post-only delegation for that key.
- Add an env-gated release startup probe that creates the real native workflow,
  announces `public_key_b64url`, reloads app storage, pulls the bootstrap grant,
  authors one post plus one unauthorized `set_summary` frame using that same cap,
  pushes the outbox, asks the BEAM peer for a state report, and logs only ids,
  counts, booleans, and authority reasons.
- Use the dedicated probe key id `township-release-author-resident` and storage
  namespace `township:release-author-probe`.
- Keep the smoke non-CDP: install the release APK, assert the normal package id,
  assert non-debuggable package metadata, assert `usesCleartextTraffic=false`,
  assert the compiled loopback-only network-security config, observe only logcat,
  spawn the trusted BEAM peer from the host, and map the release loopback port
  with `adb reverse`.
- Prove fresh-install keys differ so the proof cannot be a host-fixed key
  or a baked seed.
- Prove the valid post materializes in the BEAM peer report as `post_materialized=true`
  while the deliberately invalid summary edit is authority-quarantined as
  `operation_not_granted`.
- Prove the app outbox has two frames after authoring and zero frames after push
  and cold reload.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming pairing ceremony or full mobile onboarding.

## Non-Goals

- No WebView CDP connection, debug APK fallback, UI command automation, `run-as`,
  native KV inspection, host-side frame injection into release private storage, or
  release command channel outside the probe.
- No app-originated grant issuance, QR/deep-link onboarding, discovery, LAN,
  iOS, Expo, physical-device, or production TLS proof.
- No claim that the host-minted bootstrap grant is a real user onboarding
  ceremony.

## STOP Conditions

- Stop if the smoke needs WebView CDP, a debuggable package, debug APK, `run-as`,
  a host KV read, or direct host injection into release app storage.
- Stop if the probe uses the normal `TOWNSHIP_STORAGE_NAMESPACE` instead of the
  dedicated probe namespace `township:release-author-probe`.
- Stop if fresh installs reuse the same runtime public key.
- Stop if any logcat line includes frame bodies, caps, signatures, seeds, private
  key material, or secrets.
- Stop if the peer accepts all pushed frames without surfacing the unauthorized
  summary edit as `operation_not_granted`.
- Stop if push leaves local outbox frames pending after carrier acknowledgement.
- Stop if docs imply pairing ceremony, app-originated grants, full mobile
  onboarding, iOS/Expo parity, physical-device behavior, or production remote TLS.

## TDD Evidence

- RED: `apps/lattice_node_spike/test/township_carrier_test.exs` initially proved
  that `bootstrap_audience_pubkey` was ignored because the peer returned no
  missing post-only grant for the runtime device key.
- GREEN: `LatticeNodeSpike.Peer`, `priv/peer_node.exs`, and
  `LatticeNodeSpike.TownshipScenario.bootstrap_audience/2` now append a
  clerk-authored post-only grant for the supplied runtime public key.
- RED: `release:author:contract` initially failed because
  `src/township_release_author_probe.ts` did not exist.
- GREEN: the release author probe contract now validates loopback-only config,
  non-secret log formatting, reload/pull/author/push/peer phases, outbox counts,
  and the `operation_not_granted` authority negative.
- RED: `mobile:tauri-readiness` required this Plan 092 file, package scripts,
  app startup wiring, Android smoke assertions, and no-overclaim docs before the
  plan/docs were present.

## Second Opinion

Claude Code reviewed the next-slice plan before implementation and approved the
narrow proof shape: launch the release app, read `public_key_b64url` from logcat,
start a BEAM peer whose scenario contains a post-only grant to that runtime key,
let the release app pull the grant, author a post, push/drain the outbox, and
prove the peer authority negative. Claude's hard stops were device-local keys,
fresh-install key difference, a negative authority frame with
`operation_not_granted`, outbox drain to zero, repeat release non-debuggable
assertions, and no overclaim beyond a host-minted bootstrap grant.

## Observation

On July 9, 2026, the release author-probe APK built at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` with the
normal package id `dev.treetop.lattice.township`, non-debuggable release package metadata,
`usesCleartextTraffic=false`, and the compiled loopback-scoped network-security config from
Plan 089.

The release smoke ran on an Android API 34 emulator, which is inside the Android API 26+ WebView
network-security config support boundary. It first cleared app data twice and proved fresh-install
keys differ.

The success path launched the release app with an empty `township:release-author-probe` namespace,
observed the native runtime key, spawned a trusted `LatticeNodeSpike.TownshipScenario` BEAM peer
whose `bootstrapAudiencePubkey` matched that runtime key, and mapped `adb reverse tcp:43192` to the
peer. The release app pulled the base Township frames plus the host-minted post-only bootstrap grant
and logged the matching `grant_delegation_id`.

The app then authored a valid post and a deliberately unauthorized `set_summary` frame with that
same post-only cap. The first author phase logged `outbox_frame_count=2`; the smoke force-stopped
and relaunched the release app before push, then observed a cold `phase=reload` with the same post
and bad op ids persisted and `outbox_frame_count=2`.

After the resumed push, the app logged both pushed frame ids, `accepted_count=2`,
`pending_count=0`, and `outbox_frame_count=0`. The peer report then logged
`post_materialized=true`, `bad_authority_reason=operation_not_granted`, and
`outbox_frame_count=0`. Finally, the host killed the BEAM peer, removed the reverse mapping,
force-stopped and relaunched the app offline, and observed a cold reload retaining the post/bad ids
with `outbox_frame_count=0`.

This proves release device-local post authoring, persisted pending outbox before push, push/outbox
drain, peer-side capability enforcement, and replayable reload in the dedicated author probe
namespace only. It does not prove pairing ceremony, app-originated grants, authority origination,
full mobile onboarding, iOS/Expo parity, physical-device behavior, LAN discovery, or production
remote TLS.

## Verification

- `cd clients/township-tauri-shell && npm run release:author:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:author-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:author:smoke`

## Remaining Work

- Add a later release onboarding proof that starts from pairing ceremony rather
  than a host-minted probe grant.
- Add later app-originated grant/revoke release proofs if the product needs
  authority issuance from mobile.
- Keep iOS, Expo, physical-device LAN discovery, and production TLS transport
  proofs separate.
