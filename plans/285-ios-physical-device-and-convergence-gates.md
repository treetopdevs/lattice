# Plan 285: iOS physical-device, convergence, and CI gates (after Plan 077)

## Status

TODO

Filed 2026-10-20 for the iOS gates outside Plan 077's simulator scope. Plan 077 (still IN
PROGRESS) proves the Xcode 26.6 simulator archive and two independently named protected Keychain keys
that differ and survive process relaunch. It does not prove reboot, physical-device behavior, iOS
BEAM convergence or CI enforcement.

This plan's first change adds two simulator smokes that have not yet run green:
`tauri:ios:key-reuse:smoke` now also requires both keys to survive a simulator shutdown/boot cycle,
and `tauri:ios:key-erase-control:smoke` erases a throwaway simulator and requires new keys afterwards.
On 2026-10-28 the probe archive did not build on this machine: Xcode 26.6 had been replaced by Xcode
27.0 beta and 27.1, and both fail to resolve UIKit/AppKit/WebKit for Tauri 2.11.5's Swift package
before any Township code compiles. Under Plan 077's stop rule that is a toolchain failure, not an app
result. Run both smokes under Xcode 26.6 before claiming either proof.

## Objective

Carry the iOS protected-key and app-path proofs from the simulator to phone-grade evidence, so that the
mobile secure-store done gates in `docs/township_mobile_secure_store_strategy.md` can be met for iOS.

## Scope

1. **Physical-device key custody.** Run the existing `tauri:ios:device-key-reuse` build and smoke
   (parked in `test/tauri_ios_device_key_reuse_smoke.ts`) on a connected, unlocked, developer-mode
   iPhone with an installed development profile. Require the same two-slot evidence as the simulator
   smoke: distinct 32-byte public keys, 64-byte signature results, and stability across process
   relaunch.
2. **Physical-device reboot.** Extend the device smoke with a device reboot cycle and record the
   Keychain accessibility class the protected store uses, including behavior before first unlock.
3. **iOS persisted-cap onboarding and BEAM convergence.** Add an iOS counterpart of
   `tauri:android:release:browser-onboarding:smoke`: on the connected iPhone, the installed app
   pairs, acquires a persisted cap, authors one op with its protected key and syncs it to a real BEAM
   carrier peer. Pass criteria: the peer's materialized state equals `Lattice.Sim` for the same
   scenario, and after an app relaunch the iPhone reuses the same key and cap. Evidence: the
   device's public key, the op id, and the Sim comparison output.
4. **Hosted CI decision.** The operator decides, for each of the simulator relaunch smoke and items
   1-3, whether it runs in hosted CI (and on which runner) or stays a local opt-in gate. Record the
   decision as a dated line in this plan and in the index row; this item adds no CI job by itself.

## Out of Scope

- Changing the Plan 077 simulator contracts beyond what the device variants share.
- Any claim of phone-grade persistence before items 1–3 are green.
- Physical multi-device LAN discovery; it is parked separately in `TOWNSHIP_BUILD_MAP.md` §4a.

## STOP Conditions

- If a fix moves carrier seeds into TypeScript, Vue state, app files, or replayable app storage, stop.
- If signing would require a checked-in Apple team id or leave generated Xcode project mutations
  behind, stop. The team id stays in `APPLE_DEVELOPMENT_TEAM` only.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf rule
  from `AGENTS.md`.

## Prerequisites

- A physical iPhone that is connected, unlocked, and in developer mode, and a matching installed
  development provisioning profile.
- `APPLE_DEVELOPMENT_TEAM` set in the environment for each build.
