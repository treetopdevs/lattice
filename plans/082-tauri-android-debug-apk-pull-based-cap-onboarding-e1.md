# Plan 082: Tauri Android debug APK pull-based cap onboarding (E1)

## Status

DONE

## Objective

Turn Android mobile cap acquisition from a side-loaded test setup into a bounded debug-APK proof:
the installed Android app must start with no local delegation evidence, save public carrier pairing
metadata through the real UI, click the real `Sync outbox` UI to pull a clerk-authored post-only
delegation from a BEAM Township peer, persist that pulled delegation evidence across restart, then
click the real `Post update` UI and prove BEAM materializes the Android-authored post while
rejecting a same-device operation outside the pulled grant.

## Scope

- Add a package-level `tauri:android:onboarding:smoke` command.
- Drive the installed debug APK over Android WebView CDP, not a desktop shell or Vite-only harness.
- Save public pairing metadata through the app UI (`Pairing handoff` -> `Load handoff` -> `Save
  pairing`).
- Author the onboarding grant with the deterministic clerk identity and push it to the BEAM peer;
  the app may only acquire that grant by clicking `Sync outbox`.
- Assert pulled delegation evidence in native KV only after the real sync path writes it.
- Restart the app and prove both the device key and pulled delegation evidence survive cold start.
- Author a post with the native Android signer using the pulled cap id, then assert BEAM
  materialization and BEAM authority quarantine for an out-of-grant command.
- Keep release mobile BEAM convergence, iOS key reuse, key backup/recovery, quorum onboarding,
  Expo, and physical multi-device LAN discovery out of scope.

## STOP Conditions

- If the smoke writes `local_ops`, `carrier_frames`, or `delegation_frames` directly to give the app
  the onboarding cap, stop.
- If pairing import/save transfers device-local identity, private keys, seeds, or key ids as secret
  material, stop.
- If the positive post is signed by a host fallback signer instead of the installed app's native key,
  stop.
- If pulled delegation persistence is asserted only in memory and not across a real app restart,
  stop.
- If the smoke bypasses the real `Sync outbox` or `Post update` UI buttons for the positive path,
  stop.
- If BEAM accepts the same-device `set_summary` negative control outside the pulled post-only grant,
  stop.
- If docs claim unqualified full mobile onboarding, release mobile convergence, iOS proof, or
  phone-grade equivalence from this debug APK/emulator proof, stop.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED/GREEN: `mobile:tauri-readiness` asserts the `tauri:android:onboarding:smoke` package script,
  the Android onboarding smoke file, the real pairing/sync/post UI labels, pulled grant evidence,
  cap-id reuse, BEAM `stateReport` materialization, BEAM `authority_quarantine` negative control,
  and bounded build-map claim.
- GREEN: `test/tauri_android_onboarding_smoke.ts` clears app data, proves no delegation evidence is
  present, obtains the Android public key through `lattice_ensure_carrier_key`, starts a BEAM
  Township peer that trusts that key for carrier sessions, pushes a clerk-authored post-only grant
  to the peer, saves public pairing metadata through the installed app UI, clicks `Sync outbox`,
  asserts the pulled grant is persisted in `delegation_frames`, restarts the app, proves key and
  evidence persistence, clicks `Post update`, verifies the Android-authored frame cites the pulled
  cap id, syncs that frame to BEAM, checks materialized `stateReport` posts, and requires
  `operation_not_granted` for a same-device `set_summary` using the post-only cap.

## Second Opinion

Claude Code reviewed the remaining build-map gaps and recommended this slice over release APK, LAN
discovery, or iOS work because it directly removes the side-loaded-cap limitation left by Plan081
while staying small and repeatable. The review required:

- Public seams only: Android CDP UI, BEAM peer, pairing handoff UI, `Sync outbox`, persisted local
  evidence, real `Post update`, and BEAM `stateReport`.
- A fresh app with no delegation evidence before onboarding.
- A clerk-authored grant addressed to the Android device public key, pushed through BEAM.
- Pull-based delegation acquisition through the installed app's sync UI, not KV injection.
- Cold-start persistence of pulled evidence.
- A post frame whose cap id matches the pulled delegation id.
- BEAM materialization plus an out-of-grant negative control.
- Wording that keeps full mobile onboarding broader than this pull-based cap-acquisition proof.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npx esbuild test/tauri_android_onboarding_smoke.ts --bundle --platform=node --format=esm --external:@tauri-apps/api --external:@treetopdevs/lattice-client --outfile=/tmp/tauri_android_onboarding_smoke.mjs`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug`
- `cd clients/township-tauri-shell && npm run tauri:android:onboarding:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Notes

- Android debug APK pull-based cap onboarding is proven for: public pairing metadata saved through
  UI, delegation acquisition by sync pull, cold-start persistence of that pulled evidence, and
  on-device post authoring against the pulled cap.
- Full mobile onboarding remains unproven beyond pull-based cap acquisition: pairing metadata is
  still human-mediated/out-of-band, there is no first-run key backup/recovery ceremony, no quorum
  or multi-clerk ceremony, and this is still the debug APK/emulator route.
- The replayable KV file stores signed ops and carrier/delegation frames only. Carrier seeds remain
  behind the platform keyring-backed native signer.

## Remaining Work

- Build a user-facing first-run onboarding ceremony beyond human-mediated public pairing metadata.
- Prove release mobile BEAM convergence beyond the debug APK cleartext route.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Run a physical multi-device LAN discovery smoke.
