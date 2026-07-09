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
`Sync outbox` UI, syncs the host-authored W1 pre-signed carrier frames with a BEAM Township peer, and verifies
both local KV convergence and the peer `stateReport`. Plan 081 proves a narrower Android debug APK
on-device authoring path: the installed app reuses its native carrier key after restart, consumes a
host-authored post-only cap side-loaded into native KV, clicks the real `Post update` UI, syncs the
Android-authored frame to a BEAM Township peer, checks materialized `stateReport` posts, and
requires BEAM `authority_quarantine` for a same-device `set_summary` outside the grant. Plan 082
proves Android debug APK pull-based cap onboarding: the installed app starts with no delegation
evidence, saves public pairing metadata through the real UI, clicks `Sync outbox` to pull a
clerk-authored post-only cap from the BEAM peer, persists that pulled evidence across restart, and
authors a post against the pulled cap. Plan 083 proves Android release APK build readiness: the
release Tauri/Gradle path keeps release minification enabled, signs locally with the Android debug
keystore for emulator installability only, and the release APK installs and launches without using
debug-only WebView CDP. Plan 084 proves Android release APK canonical/wire fidelity: the installed
app computes the TS canonical digest for the BEAM W1 vector on Android startup in both debug and
release APKs and emits only a tagged `LATTICE_PROBE` logcat line without WebView CDP or carrier
networking. The `township://probe/canonical` route remains as a non-secret diagnostic ingress, but
the release proof does not depend on Android deep-link delivery timing. Plan 085 characterizes
release APK WebView WebSocket transport on loopback through an env-gated logcat probe; the observed
release outcome is `outcome=error` after a successful host control handshake and registered
`adb reverse` mapping. Plan 087 adds a release-route shell-UID reverse-tunnel control on the same
port and still records zero server-side WebView accepts/upgrades/echoed frames after controls, so the
release transport policy ADR requires an app/WebView transport-policy follow-up before any release
convergence attempt. Plan 088 proves that a separately identified release-shaped cleartext
diagnostic APK can complete the loopback WebView frame roundtrip, so cleartext policy is sufficient
to explain the observed release WebView failure on this emulator/WebView version; it is not an
approved release default and still does not prove release Sync/outbox/KV convergence. Plan 089 proves a
normal-app-id release APK with loopback-scoped Android network security config can complete the
loopback frame roundtrip on Android API 34 WebView inside the Android API 26+ WebView policy
boundary while keeping non-loopback cleartext blocked with no extra server accept, upgrade, or echoed
frame after host, loopback shell, and `10.0.2.2` shell controls. Plan 090 proves a release BEAM
carrier handshake/status/state-report path through the same scoped loopback policy: the
non-debuggable normal release app announces `public_key_b64url`, connects to a BEAM Township peer
trusted to that key, and logs carrier status/report counts without WebView CDP, Sync, outbox, or
native KV inspection. Plan 091 proves a release APK pull-and-reload path: the non-debuggable normal
release app pulls existing Township frames from a trusted BEAM peer into the dedicated
`township:release-sync-probe` storage namespace, logs only pulled/local/delegation ids, and reloads
those same ids after force-stop/relaunch with the BEAM peer offline. Plan 092 proves release APK
device-local post authoring, push, and outbox drain in the dedicated
`township:release-author-probe` storage namespace: fresh-install runtime keys differ, the app pulls
a host-minted post-only bootstrap grant, logs `post_materialized=true` for the valid post, logs
`bad_authority_reason=operation_not_granted` for the deliberately unauthorized summary edit, drains
the outbox to zero, proves a pre-push cold reload with `outbox_frame_count=2`, and then cold-reloads
the drained persisted ids with `outbox_frame_count=0`.
Plan 093 proves release APK OS deep-link pairing ingress in the dedicated
`township:release-pairing-probe` storage namespace: the non-debuggable normal release app receives
a public `township://pairing` handoff through Android's `VIEW`/`BROWSABLE` intent path, persists only
the public peer config, force-stops/relaunches with `paired=true`, and then pulls from the trusted
BEAM peer using the persisted deep-link endpoint rather than a build-time peer URL.
This does not prove QR camera onboarding, app-originated grants, authority origination, LAN
discovery, physical-device behavior, production remote TLS, or full mobile onboarding.
Plan 086 proves a debug APK positive transport control on a separate loopback port: the env-gated
probe emits `outcome=connected` only after a WebSocket frame roundtrip, and the host observes a
debug WebView upgrade and echoed frame. That proves the instrument works in the debug surface, but
does not isolate the release failure cause or prove release Sync/outbox/KV convergence. Plan 087 proves
the release-route `adb reverse` tunnel on port 43185 can carry a device-originated non-WebView
handshake from Android's shell UID, but that still does not prove release WebView transport,
app-sandbox reachability, or release Sync/outbox/KV convergence.
These
contracts are still not a phone-grade persistence or BEAM convergence proof; they also are not a
release persistence, unqualified full mobile onboarding, or release Sync/outbox/KV convergence proof.
The boundary still makes the next app work harder to accidentally put private signing material in a
replayable JSON store.

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
state after restart and converge host-authored, pre-signed carrier frames with a BEAM peer over the
debug-only `ws://10.0.2.2` route. Plan 081 proves the Android debug APK can author a `post` frame
on-device through the real UI using a host-authored post-only cap side-loaded into native KV, and
that BEAM materializes the post while rejecting a same-device command outside that grant. Plan 082
proves the Android debug APK can acquire that post-only cap by pulling it from the BEAM peer through
the real `Sync outbox` UI after saving public pairing metadata through the app UI, and can reuse the
pulled evidence after restart. Plan 083 proves the Android release APK can build through the real
Tauri/Gradle release path, install, launch, and stay alive on an emulator without debug-only WebView
CDP. Plan 084 proves the Android release APK preserves canonical/wire fidelity for the BEAM W1
vector using a startup non-CDP logcat probe through the release Rust profile and R8'd Android host
shell around the unchanged WebView bundle. Plan 085 characterizes release APK WebView WebSocket
transport on loopback through an env-gated logcat probe and a release transport policy ADR; the
observed release outcome is `outcome=error` after host-control and registered reverse-mapping checks.
Plan 087 adds a release-route shell-UID reverse-tunnel control and still records zero server-side
WebView accepts/upgrades/echoed frames after controls. Plan 088 proves a non-shippable
release-shaped cleartext diagnostic APK can complete the loopback WebView frame roundtrip, isolating
cleartext policy as sufficient for this emulator/WebView failure. Plan 089 proves the normal release
app id can use a loopback-scoped network-security config for the same frame roundtrip while
non-loopback cleartext remains blocked on Android API 34 WebView inside the Android API 26+ WebView
policy boundary with no extra server accept, upgrade, or echoed frame after host, loopback shell, and
`10.0.2.2` shell controls. Plan 090 proves the normal release app id can complete an authenticated
BEAM carrier handshake and read carrier status/report counts over that scoped loopback policy, but
does not inspect Sync, outbox, native KV, or materialized Township state. Plan 091 proves a release
APK pull-and-reload path in the dedicated `township:release-sync-probe` storage namespace: the app
pulls Township frames from a trusted BEAM peer over scoped loopback, persists local op and
delegation frame ids through app KV, then reloads those ids after force-stop/relaunch with the BEAM
peer offline. Plan 092 proves release APK device-local post authoring, push, and outbox drain in the
dedicated `township:release-author-probe` storage namespace: fresh-install runtime keys differ, the
app pulls a host-minted post-only bootstrap grant, logs `post_materialized=true` for the valid post,
logs `bad_authority_reason=operation_not_granted` for the deliberately unauthorized summary edit,
drains the outbox to zero, proves a pre-push cold reload with `outbox_frame_count=2`, and then
cold-reloads the drained persisted ids with `outbox_frame_count=0`.
Plan 093 proves release APK OS deep-link pairing ingress in the dedicated
`township:release-pairing-probe` storage namespace: the app receives a public `township://pairing`
handoff through Android's `VIEW`/`BROWSABLE` intent path, persists only the public peer config,
force-stops/relaunches with `paired=true`, and pulls from the trusted BEAM peer using the persisted
deep-link endpoint rather than a build-time peer URL.
This does not prove QR camera onboarding, app-originated grants, authority origination, LAN
discovery, physical-device behavior, production remote TLS, or full mobile onboarding. Plan 086 proves the same env-gated probe can
connect and complete a WebSocket frame roundtrip in a debug APK, so it proves the harness can produce
a positive on-device result but still does not prove release Sync/outbox/KV convergence. Plan 087 proves
the release-route reverse tunnel from Android's shell UID, but not app/WebView reachability. Android emulator now proves native carrier key reuse, bounded debug
APK BEAM convergence, bounded debug APK on-device post authoring, and bounded debug APK pull-based
cap onboarding; Android release APK builds, installs, and preserves canonical/wire fidelity for the
W1 fixture, and it now proves release-mode carrier handshake/status/report, release pull/reload,
release device-local authoring and push/outbox drain, and release OS deep-link peer-config
persistence over scoped loopback. It does not prove app-originated grants, authority origination, QR
camera onboarding, LAN discovery, iOS key reuse, Expo, full mobile onboarding beyond pull-based cap
acquisition, or phone-grade equivalence. The local iOS simulator archive remains
blocked by the selected Xcode 27 beta Swift package failure in Tauri's upstream mobile build.

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
   - Android Tauri release APK: bounded release pull/reload, device-local authoring, push/outbox drain, and OS deep-link peer-config persistence are met by plans 091-093 in dedicated probe namespaces; app-originated grants, authority origination, QR camera onboarding, LAN discovery, and full mobile onboarding remain unproven in release mode. Plan 090 is tracked separately as carrier reachability.
   - iOS Tauri and Expo: still unproven.
3. A mobile smoke syncs a Township matter with a BEAM realm using persisted caps from the onboarding
   ceremony.
   - Android Tauri debug APK: partially met. Plan 082 proves pull-based cap acquisition through the
     real pairing-save and `Sync outbox` UI, cold-start persistence of that pulled evidence,
     on-device `post` authoring against the pulled cap, BEAM materialization, and BEAM rejection for
     a same-device operation outside the grant. Full mobile onboarding remains unproven beyond
     pull-based cap acquisition.
   - Android Tauri release APK: bounded carrier pull/reload, OS deep-link peer-config persistence, device-local post authoring, persisted pending-outbox reload, push/outbox drain, and peer-side authority enforcement are met by plans 091-093 in dedicated probe namespaces; app-originated grants, authority origination, QR camera onboarding, LAN discovery, and full onboarding remain unproven. iOS Tauri and Expo are still unproven.
4. The UI distinguishes local grant saved/pending sync from carrier-converged grant acceptance.

## Stop Conditions

- Stop if raw carrier seeds move into `LocalKeyValueStore`, Vue state, AsyncStorage, or ordinary
  app files.
- Stop if `local_ops`, `carrier_frames`, or `delegation_frames` are described as secrets rather than
  replayable signed state.
- Stop if a secure-store API is used as the long-term store for growing op/frame logs.
- Stop if the app claims phone-grade persistence before native signer reuse and mobile BEAM
  convergence smokes both exist.
