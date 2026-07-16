# Plan 055: Mobile secure-store strategy (E1)

## Status

DONE.

## Objective

Make the phone-grade storage boundary explicit and testable before claiming mobile persistence:
carrier signing material stays behind a native secure-store/signer seam, while Township local ops,
carrier outbox frames, and delegation evidence remain replayable sync state that can be rebuilt
from the carrier.

Planned at commit `ee6f56c`.

## Scope

- Add a mobile secure-store strategy document that separates secrets from replayable state.
- Pin the current Tauri path: Rust owns carrier signing keys through `CarrierKeySeedStore`,
  `KeyringCarrierKeySeedStore`, `TownshipNativeState::platform_secure`, and `lattice_sign_carrier`.
- Pin the future Expo path: `expo-secure-store` is allowed only for small bootstrap secrets or
  opaque native-key references; normal `local_ops`, `carrier_frames`, and `delegation_frames` must
  live in ordinary async app storage plus carrier sync replay.
- Add a source contract test that fails if the strategy document disappears or claims phone-grade
  convergence before a mobile smoke exists.
- Add a cold-start replay guard proving `local_ops`, `carrier_frames`, and `delegation_frames` can
  be rebuilt from carrier frames without carrier signing.
- Keep a real Tauri mobile build, Expo project scaffold, QR/device pairing UX, and live mobile
  convergence out of scope.

## STOP Conditions

- If the strategy requires storing raw carrier seeds in `LocalKeyValueStore`, stop; that seam is for
  replayable state, not secrets.
- If an Expo implementation needs to sign carrier bytes in JS with an exportable seed to proceed,
  stop and add a native module/key-store signing seam instead.
- If the Tauri mobile path cannot use platform stores under the existing Rust command boundary,
  do not mark mobile secure persistence done; leave it as a strategy decision.
- If a document starts calling `local_ops`, `carrier_frames`, or `delegation_frames` secret storage,
  stop and correct the boundary.

## TDD Plan

1. RED: add `npm run mobile:strategy` in `clients/township-tauri-shell` and a Node contract test
   that expects `docs/township_mobile_secure_store_strategy.md` plus concrete storage-boundary
   claims.
2. GREEN: write the strategy document and make the contract pass against current Tauri/Rust and
   shared TypeScript seams.
3. GREEN: extend the sync contract with a cold-start pull/replay path that signs nothing and rebuilds
   replayable state from carrier frames.
4. VERIFY: run `npm run mobile:strategy`, the Tauri native contract, shell typecheck/build, and the
   broader repo gates.

## Second Opinion

- Claude Code gave a GO for a docs-plus-contract slice and explicitly warned not to overclaim
  platform non-extractability for the current keyring-backed seed path.
- Claude required a seed-boundary contract and a cold-start replay guard; both are now covered.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`

## Remaining Work

- Completed follow-up: plan 056 proves the current desktop app convergence gate against the BEAM
  realm path.
- Completed follow-up: plan 076 adds generated Tauri iOS/Android target scaffolds as readiness.
- Completed follow-up: plan 077 pins iOS deployment target, generated Xcode script entrypoint, and
  protected Keychain feature readiness before the simulator smoke.
- Completed follow-up: plan 079 proves Android emulator native signer key reuse and W1-transcript
  signing, including a `pm clear` negative guard.
- Completed follow-up: plan 080 proves Android debug APK pre-signed-frame BEAM convergence after
  restart through persisted native KV and a real BEAM Township peer.
- Still future: release mobile BEAM convergence and iOS native-key reuse must be proven before this
  becomes phone-grade evidence.
