# Plan 081: Tauri Android debug APK on-device post authoring (E1)

## Status

DONE

## Objective

Turn Android mobile command authoring from a roadmap gap into a bounded debug-APK proof: the
installed Android app must reuse its native carrier key after restart, consume a host-authored
post-only delegation persisted in native KV, click the real `Post update` UI, author a signed
Township `post` frame on-device, sync it to a BEAM Township peer, and prove the peer materializes
the post while rejecting a same-device operation outside the granted `post` set.

## Scope

- Add a package-level `tauri:android:authoring:smoke` command.
- Drive the installed debug APK over Android WebView CDP, not a desktop shell or Vite-only harness.
- Side-load only replayable state and a host-authored, post-only delegation into native KV.
- Require the Android native signer for the authored post and the negative-control summary frame.
- Check canonical carrier-frame signatures, BEAM `stateReport` materialization, and BEAM authority
  quarantine for the out-of-grant operation.
- Keep release mobile BEAM convergence, iOS key reuse, full persisted-cap onboarding, Expo, and
  physical multi-device LAN discovery out of scope.

## STOP Conditions

- If the smoke exposes or host-reads the Android private key or seed, stop.
- If the positive command is signed by a host fallback signer instead of the installed app's native
  key, stop.
- If the smoke bypasses the real `Post update` UI for the positive path, stop.
- If the BEAM peer accepts the same-device `set_summary` negative control under the post-only
  delegation, stop.
- If the docs claim full mobile onboarding, release mobile convergence, or phone-grade equivalence
  from this debug APK side-loaded-cap proof, stop.
- If the local toolchain tries to run BEAM through Homebrew or mise shims, stop and use the asdf
  rule from `AGENTS.md`.

## TDD Evidence

- RED/GREEN: `mobile:tauri-readiness` asserts the `tauri:android:authoring:smoke` package script,
  the Android authoring smoke file, the real UI labels, canonical-signature assertion, peer
  materialized `stateReport`, BEAM `authority_quarantine` negative control, and bounded build-map
  claim.
- GREEN: `test/tauri_android_authoring_smoke.ts` clears app data, installs the debug APK, obtains
  the Android public key through `lattice_ensure_carrier_key`, starts a BEAM Township peer that
  trusts that public key, warms an authenticated carrier session, persists a host-authored
  post-only grant plus replayable state into native KV, restarts the app, proves the same device
  public key is reused, blocks local summary authoring, clicks `Post update`, verifies the
  Android-authored frame with `canonicalBytesForCarrierOp`, syncs through the real `Sync outbox`
  UI, asserts BEAM materialized posts, then signs an out-of-grant `set_summary` frame with the
  same Android key and requires BEAM `operation_not_granted` quarantine.
- GREEN: `LatticeNodeSpike.Peer.state_report/1` now includes normalized materialized state so the
  mobile smoke can prove semantic materialization instead of trusting op ids alone.

## Second Opinion

Claude Code reviewed the Plan081 boundary before implementation and required these constraints:

- The next slice is valid only as Android debug APK, side-loaded grant, on-device post authoring,
  and BEAM materialization evidence.
- A negative control is mandatory: the same Android key must be unable to use the post-only grant
  for another operation.
- The proof must assert materialized state, not only op ids.
- The smoke must use a run-unique post nonce, prove the key is reused after relaunch, and start from
  clean app data.
- There must be no test-only native signing path, host-readable private key, or silent host signer
  fallback.
- The positive path must click the real UI.

Those constraints are reflected in the implementation and docs.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs`
- `cd clients/township-tauri-shell && npx esbuild test/tauri_android_authoring_smoke.ts --bundle --platform=node --format=esm --external:@tauri-apps/api --external:@treetopdevs/lattice-client --outfile=/tmp/tauri_android_authoring_smoke.mjs`
- `cd clients/township-tauri-shell && npm run tauri:android:build:debug`
- `cd clients/township-tauri-shell && npm run tauri:android:authoring:smoke`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Notes

- This is an Android debug APK proof over the emulator host route `ws://10.0.2.2`; release mobile
  BEAM convergence remains unproven.
- The delegation is host-authored and side-loaded into native KV. Full persisted-cap onboarding,
  pairing trust, and user-facing mobile ceremony remain unproven.
- The replayable KV file stores signed ops and carrier/delegation frames only. Carrier seeds remain
  behind the platform keyring-backed native signer.

## Remaining Work

- Build the full mobile onboarding ceremony where the app acquires and persists its cap through the
  user-facing handoff/sync path rather than side-loaded test setup.
- Prove release mobile BEAM convergence beyond the debug APK cleartext route.
- Re-run the iOS simulator archive with a stable supported Xcode installation or a Tauri/swift-rs
  release that supports the local Xcode 27 beta Swift driver behavior.
- Prove iOS simulator/device native key reuse after the archive blocker clears.
- Run a physical multi-device LAN discovery smoke.
