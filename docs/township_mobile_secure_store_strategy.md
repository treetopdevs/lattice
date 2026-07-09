# Township Mobile Secure-Store Strategy

This strategy fixes the storage boundary for phone-grade Township shells before the repo claims
mobile persistence. Plan 076 adds generated Tauri iOS and Android target scaffolds as mobile-build
readiness, plan 077 pins the repo-side iOS simulator readiness contracts for deployment target
15.0, the generated Xcode Rust build entrypoint, and protected Keychain support, and plan 078 proves
the generated Android target can assemble a debug APK from the real Tauri mobile build. Plan 079
proves an Android emulator native-key smoke: the installed app signs a W1 carrier transcript through
the native command boundary, reuses the same public key after force-stop/relaunch, and produces a
different key after app data clear. Plan 080 proves Android debug APK host-authored,
pre-signed-frame BEAM
convergence: the installed debug APK reloads persisted native KV after restart, clicks the real
`Sync outbox` UI, syncs the W1 pre-signed carrier frames with a BEAM Township peer, and verifies
both local KV convergence and the peer `stateReport`. It does not exercise any cap-gated
authoring button or persisted-cap onboarding ceremony. Those contracts are still not a phone-grade persistence or BEAM
convergence proof; they also are not a release persistence or release mobile BEAM convergence
proof. The boundary still makes the next app work harder to accidentally put private signing
material in a replayable JSON store.

## Boundary

### Secret material

Secret material is anything that can sign as a device:

- the carrier signing seed or private key
- a bootstrap secret used to recover or migrate that key
- platform credentials that can extract, unwrap, or migrate that key

Secret material must stay behind a native signer. In the current Tauri shell, that means the Rust
side owns `CarrierKeySeedStore`, `KeyringCarrierKeySeedStore`, `TownshipNativeState::platform_secure`,
and the `lattice_sign_carrier` command. TypeScript receives public keys and signatures, never raw
seed bytes.

A native key alias is not treated as secret material by itself: the shell may persist a key id in
pairing config, but possession of that id without native IPC access must not expose seed bytes or
produce a signature.

For Tauri mobile, keep the same command boundary. The Android path now configures the native
keyring default store through `keyring-core` and `android-native-keyring-store`, initializes the NDK
context from the generated Android activity, and disables Android backup for the application so
carrier identity is not restored implicitly across installs. The iOS source path also configures the
protected Keychain store through `keyring-core`, but the local iOS archive remains blocked before a
simulator smoke can prove it. These platform-specific stores must not change the TypeScript bridge
contract.

For Expo, the app may still consume `@treetopdevs/lattice-client`, but production signing must be a
native module or native-backed `CarrierSigner`. `expo-secure-store` is allowed for small bootstrap
secrets or opaque key references only. Do not store the production raw carrier seed in JavaScript
state or a shell `LocalKeyValueStore`.

References checked while writing this plan:

- Expo SecureStore documents encrypted local key-value storage, native configuration needs, payload
  caveats, and the warning that it should not be the only source of truth for irreplaceable data:
  https://docs.expo.dev/versions/latest/sdk/securestore/
- Tauri Store is persistent application state, not the secret-store boundary:
  https://v2.tauri.app/plugin/store/
- Rust `keyring` 4 recommends applications that need controlled stores use `keyring-core` and
  specific credential stores rather than the broad wrapper:
  https://docs.rs/keyring/latest/keyring/
- Android Keystore can keep key material non-extractable and enforce key-use restrictions when the
  platform/key type supports it:
  https://developer.android.com/privacy-and-security/keystore
- The keyring ecosystem's Android store uses Android SharedPreferences plus Keystore for sensitive
  values:
  https://docs.rs/android-native-keyring-store/latest/src/android_native_keyring_store/lib.rs.html

### Replayable state

Replayable state is signed or reducible data that can be rebuilt from the carrier:

- `local_ops`
- `carrier_frames`
- `delegation_frames`

These are not secrets. They need integrity checks, deterministic replay, idempotent merge, carrier
sync, and optional app-storage encryption if a product policy wants it. They do not need secure
secret storage, and putting growing op/frame logs into a secure key-value API is the wrong default.

The current `LocalKeyValueStore` seam is therefore for replayable state. It can be backed by Tauri
Store, IndexedDB, SQLite, AsyncStorage, or another app database, but it must not become the carrier
seed store. Carrier signatures and delegation ids are the integrity boundary.

## Shell Choices

### Tauri Desktop And Mobile

Tauri remains the recommended shared shell because it already has a native Rust command core:

- `lattice_ensure_carrier_key` creates or loads the key and returns only the public key.
- `lattice_public_key` returns the public key for an already-created key.
- `lattice_sign_carrier` signs bytes without exposing the key to Vue/TypeScript.
- `TownshipNativeState::platform_secure` wires those commands to a platform key store.

The mobile strategy is to keep this exact IPC contract and swap only the Rust
`CarrierKeySeedStore` implementation if platform-specific stores are needed. A mobile build must
prove key reuse across app restarts without exposing seed bytes to TypeScript.

The generated Tauri iOS and Android projects are build targets only. Plan 077 also proves the iOS
project is configured for an Xcode-supported deployment target, the generated Xcode script has its
package entrypoint, and the iOS Keychain backend enables the `protected` feature required by
`apple-native-keyring-store`. Plan 078 proves the Android target assembles a debug APK through the
real Tauri/Gradle mobile path when rustup is pinned ahead of Homebrew Rust, the Rust crate emits the
expected mobile library types, and the Tauri entrypoint exports the required mobile symbols. Plan
079 proves the Android emulator can invoke the native carrier signer, verify an Ed25519 signature
over a W1-shaped carrier transcript, retain the same public key across force-stop/relaunch, and
change keys after `pm clear`. Plan 080 proves the Android debug APK can reload persisted replayable
state after restart and converge host-authored, pre-signed carrier frames with a BEAM peer over the debug-only
`ws://10.0.2.2` route. Android emulator now proves native carrier key reuse and a bounded debug APK
BEAM convergence smoke, but it does not prove release mobile BEAM convergence, iOS key reuse, Expo,
on-device mobile op authoring, persisted-cap onboarding, or phone-grade equivalence. The local iOS simulator archive remains blocked by the selected Xcode
27 beta Swift package failure in Tauri's upstream mobile build.

### Expo

Expo remains a viable phone-only consumer after the storage contract is implemented. The required
shape is:

- `CarrierSigner.publicKey` comes from a native-backed key alias.
- `CarrierSigner.sign(bytes)` crosses a native boundary and returns only a signature.
- `expo-secure-store` may hold small bootstrap secrets or an opaque native key alias.
- normal `local_ops`, `carrier_frames`, and `delegation_frames` use ordinary async app storage and
  carrier sync replay.

If Expo cannot provide a native-backed Ed25519 signer for production, the Expo shell is not
phone-grade yet. A pure-JS signer with an exportable seed is acceptable only for development
fixtures and must be labelled that way.

## Done Gates

No phone-grade persistence claim is allowed until all of these are true:

1. A mobile build has a native-backed carrier signer test that proves public-key reuse across app
   restarts and signatures over the W1 carrier transcript.
   - Android Tauri emulator: met by plan 079.
   - iOS Tauri and Expo: still unproven.
2. The app-storage implementation reloads `local_ops`, `carrier_frames`, and `delegation_frames`
   without touching the native key store.
   - Android Tauri debug APK: met for the W1 pre-signed-frame smoke by plan 080.
   - Release mobile, iOS Tauri, and Expo: still unproven.
3. A mobile smoke syncs a Township matter with a BEAM realm using persisted caps from the onboarding
   ceremony.
   - Android Tauri debug APK: not met. Plan 080 converges host-authored, pre-signed W1 frames only;
     on-device cap selection, command authoring, and persisted-cap onboarding remain unproven.
   - Release mobile, iOS Tauri, and Expo: still unproven.
4. The UI distinguishes local grant saved/pending sync from carrier-converged grant acceptance.

## Stop Conditions

- Stop if raw carrier seeds move into `LocalKeyValueStore`, Vue state, AsyncStorage, or ordinary
  app files.
- Stop if `local_ops`, `carrier_frames`, or `delegation_frames` are described as secrets rather than
  replayable signed state.
- Stop if a secure-store API is used as the long-term store for growing op/frame logs.
- Stop if the app claims phone-grade persistence before native signer reuse and mobile BEAM
  convergence smokes both exist.
