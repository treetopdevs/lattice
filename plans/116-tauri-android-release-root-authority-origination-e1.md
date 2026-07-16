# Plan 116: Tauri Android release root authority origination (E1)

## Status

DONE

## Objective

Prove Android release root/authority origination in the installed Tauri shell.

Promote the Plan 115 root-bound genesis proof into the installed Android Tauri
release app: the app uses its native carrier key to bind a fresh Township
replica id, author the root `authorTownshipGenesis` frame, persist the pending
outbox through a cold reload, push it to a BEAM carrier peer, and verify a
different key's self-issued genesis under that same bound replica is reported as
`impostor_genesis`.

This is the first release-app root-creation ceremony slice. It connects the
mobile secure-store strategy to real app convergence by proving the root
authority originates from the native carrier key and survives the same local
op/frame stores used by onboarding probes.

## Scope

- Add a release root-origination probe wired through `App.vue` only when its
  env-gated config is present.
- Add `tauri:android:release:root-origination` and its build/smoke/contract
  scripts.
- Add a BEAM root-origination test scenario whose log starts empty at a runtime
  root-bound replica id, so the release APK authors the first valid genesis.
- Prove the release app:
  - creates the native carrier key;
  - derives the bound root replica with `bindTownshipReplica`;
  - authors `authorTownshipGenesis` without a host bootstrap grant;
  - persists the pending genesis outbox across cold reload;
  - pushes and drains the outbox through `syncTownshipOutbox`;
  - reports `root_authority_accepted=true`;
  - reports a forged native-key genesis under the same replica as
    `forged_authority_reason=impostor_genesis`.

## Non-Goals

This does not prove cross-device pairing state exchange.
This does not prove visible chooser UI.
This does not prove QR camera onboarding, LAN discovery, physical-device
behavior, production remote TLS, iOS/Expo parity, or full mobile onboarding.
This does not prove full mobile onboarding.
This does not replace the existing host-grant onboarding proofs; it removes the
host-grant dependency only for root creation.

## STOP Conditions

- Stop if the root-origination probe depends on a
  `VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY`, pulled
  `grant_delegation_id`, or host-minted bootstrap cap.
- Stop if the release probe logs private key material, raw signatures, carrier
  bodies, caps, seeds, or secrets.
- Stop if a forged self-issued genesis changes peer state or is not reported as
  `impostor_genesis`.
- Stop if docs imply cross-device, chooser UI, QR camera, LAN, physical-device,
  iOS/Expo, production TLS, or full mobile onboarding completion from this
  slice.

## TDD Evidence

- RED: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  failed because `township_release_root_origination_probe.ts` did not exist.
- GREEN: `npm --prefix clients/township-tauri-shell run release:root-origination:contract`
  passed after adding the env-gated probe, native-workflow storage metadata,
  genesis authoring, push/report, and forged-genesis report paths.
- GREEN: `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
  passed after wiring the package scripts, app startup gating, smoke file, plan
  index entry, and static readiness expectations.
- GREEN: `npm --prefix clients/township-tauri-shell run tauri:android:build:release:root-origination-probe`
  produced the release universal APK.
- GREEN: `npm --prefix clients/township-tauri-shell run tauri:android:release:root-origination:smoke`
  observed `phase=native_key`, `phase=genesis` with `outbox_frame_count=1`, a
  cold `phase=reload` retaining the pending genesis, `phase=push` draining the
  outbox, and `phase=peer` with `root_authority_accepted=true` plus
  `forged_authority_reason=impostor_genesis`.

## Second Opinion

Claude Code recommended keeping this as a bounded Android release
root/authority-origination slice and explicitly tying it to cap persistence and
secure-store ceremony without claiming full onboarding. The agreed boundary is:
native-key root genesis, pending-outbox cold reload, BEAM push/report, and forged
genesis quarantine.

## Verification

- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
- `npm --prefix clients/township-tauri-shell run release:root-origination:contract`
- `npm --prefix clients/township-tauri-shell run tauri:android:build:release:root-origination-probe`
- `npm --prefix clients/township-tauri-shell run tauri:android:release:root-origination:smoke`
- `npm --prefix clients/township-tauri-shell run typecheck`
- pinned OTP 28 `mix verify`

## Remaining Work

- Cross-device pairing state exchange remains separate.
- Visible chooser UI remains separate.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, and full mobile onboarding remain separate bounded
  plans.
