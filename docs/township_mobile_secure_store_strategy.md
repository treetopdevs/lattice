# Township Mobile Secure-Store Strategy

This strategy fixes the storage boundary for phone-grade Township shells before the repo claims
mobile persistence. It does not add a Tauri mobile or Expo build. It makes the next app work harder
to accidentally put private signing material in a replayable JSON store.

## Boundary

### Secret material

Secret material is anything that can sign as a device:

- the carrier signing seed or private key
- an opaque native key alias that unlocks carrier signing
- a bootstrap secret used to recover or migrate that key

Secret material must stay behind a native signer. In the current Tauri shell, that means the Rust
side owns `CarrierKeySeedStore`, `KeyringCarrierKeySeedStore`, `TownshipNativeState::platform_secure`,
and the `lattice_sign_carrier` command. TypeScript receives public keys and signatures, never raw
seed bytes.

For Tauri mobile, keep the same command boundary. If the broad `keyring = "4"` wrapper is too loose
for a controlled mobile build, move the implementation behind `CarrierKeySeedStore` to
`keyring-core` plus the platform-specific iOS Keychain and Android Keystore stores. That refactor
must not change the TypeScript bridge contract.

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
2. The app-storage implementation reloads `local_ops`, `carrier_frames`, and `delegation_frames`
   without touching the native key store.
3. A mobile smoke syncs a Township matter with a BEAM realm using persisted caps from the onboarding
   ceremony.
4. The UI distinguishes local grant saved/pending sync from carrier-converged grant acceptance.

## Stop Conditions

- Stop if raw carrier seeds move into `LocalKeyValueStore`, Vue state, AsyncStorage, or ordinary
  app files.
- Stop if `local_ops`, `carrier_frames`, or `delegation_frames` are described as secrets rather than
  replayable signed state.
- Stop if a secure-store API is used as the long-term store for growing op/frame logs.
- Stop if the app claims phone-grade persistence before the mobile smoke exists.
