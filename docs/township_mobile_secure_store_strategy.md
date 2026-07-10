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
the outbox to zero, and then cold-reloads the drained persisted ids with `outbox_frame_count=0`.
Plan 102 extends that same release author probe: after pulling the post-only bootstrap grant, the
app authors a child post-only grant to a fixed public probe audience, persists it through the
pre-push cold reload with `outbox_frame_count=3`, pushes grant/post/unauthorized-summary frames, and
gets peer `grant_authority_accepted=true`.
Plan 093 proves release APK OS deep-link pairing ingress in the dedicated
`township:release-pairing-probe` storage namespace: the non-debuggable normal release app receives
a public `township://pairing` handoff through an adb-delivered Android `VIEW`/`BROWSABLE` intent,
persists only the public peer config, force-stops/relaunches with `paired=true`, and then pulls from
the trusted BEAM peer using the persisted deep-link endpoint rather than a build-time peer URL.
The Android bridge extracts the public pairing handoff from the raw OS intent natively and returns it
as base64 to TypeScript, avoiding Tauri/WebView custom-scheme URL normalization while keeping the
handoff out of logs. The handoff is public because it carries only carrier URL, expected peer
realm/pubkey, and replica; local realm, local key id, native signing seed, and private key material
are intentionally excluded.
This is still a delivery-and-persistence proof, not a production authorization ceremony. Plan 094
adds the real Tauri app confirmation policy: imported handoff/deep-link/QR/discovery drafts cannot
first-save or replace a different saved peer config without an explicit unchecked-by-default user
confirmation, same-config saves are idempotent, invalid drafts do not mutate storage, and link
parameters such as `confirm=1` do not unlock saving. Plan 095 adds the app-controlled anti-hijack
gate for real-app OS deep-link import: link import starts unarmed, installed unarmed OS links are
traced as blocked instead of loading pairing drafts, and one valid armed pairing link consumes the
arm in the shared listener contract. Plan 096 proves packaged macOS real-app armed delivery in an
explicit `township-dev-trace` release-mode smoke build; Plan 101 repairs that proof so the smoke
arms through a dev-trace-only control link and waits for native hydration before delivering the
LaunchServices `township://pairing` URL. One armed link loads a draft, and the next link is blocked
after one-shot consumption. Plan 097 adds a
packaged no-side-effect trace guard for that same link-load path: Save Pairing, Sync Outbox, and
Check Carrier now emit explicit dev-trace events when started, and the installed-app smoke asserts
those traced side effects plus native KV writes are absent in a settled/allowlisted trace window
while the link is only loaded as a draft. Plan 098 proves warm macOS LaunchServices scheme resolution:
the smoke registers the freshly built app, asserts `township://` resolves to that bundle, and then
uses bare `open township://...` delivery against the already-running traced app. Plan 099 proves the
packaged macOS cold-start path separately: with no Township process running, bare `open township://...`
starts the registered app and the pairing URL is traced as a draft-only blocked pairing link.
Plan 105 separately proves Android release cold-start pairing delivery: after
`force-stop`/assert-not-running, a no-state cold-start `VIEW`/`BROWSABLE` intent starts the app but is
blocked with `blocked_reason=state_mismatch`, while a state-bearing cold-start intent saves pairing,
survives relaunch as `paired=true`, and syncs. This does not prove browser/chooser UX or iOS
cold-start URL delivery. Plan 107 adds Android release browser-backed pairing delivery: an installed
Android browser loads a local browser-loaded HTML page, a tap activates an Android
package/component-pinned intent URL carrying a `township://pairing` handoff, the no-state handoff is
blocked with `blocked_reason=state_mismatch`, and the state-bearing handoff saves pairing, survives
relaunch as `paired=true`, and syncs. This does not prove chooser UI,
cross-device cryptographic state exchange, or iOS cold-start URL delivery. Plan 108 adds Android
release browser-backed onboarding convergence: the browser page request is observed before the
onboarding namespace saves pairing, then that same release APK pulls the bootstrap post-only cap,
authors a post plus unauthorized summary, survives the pending-outbox cold reload, pushes to a
drained outbox, and reports `post_materialized=true` plus
`bad_authority_reason=operation_not_granted`. This does not prove chooser UI and does not prove
browser/chooser-backed or cross-device pairing state exchange or full mobile onboarding. Plan 109 adds
Android release browser-backed onboarding child-grant composition: the same browser-page-before-pairing
save evidence leads into a paired onboarding namespace that pulls the bootstrap post-only cap, emits
`phase=grant` plus `grant_ops=post` for an app-authored child grant, cold-reloads three pending frames, pushes them,
and reports `grant_authority_accepted=true` with the existing post materialization and unauthorized
summary rejection checks. The native bridge
consumes a valid stored intent handoff once and requires `VIEW` plus
`BROWSABLE`, but this does not remove every local-malicious-app threat or prove cryptographic
nonce/state binding.
Plan 110 adds Android release browser-backed pairing state exchange: the release app mints a runtime
state through the crypto-backed one-shot gate, publishes it to a probe-only loopback exchange
endpoint, the browser-loaded page echoes that runtime state in its `township://pairing` intent URL,
a no-state link is blocked with `blocked_reason=state_mismatch`, and the runtime state is absent
from probe logs. This still does not prove chooser UI or cross-device state exchange.
Plan 111 adds Android release browser-backed onboarding state exchange: the release app uses that
runtime state-exchange shape in a dedicated onboarding-state namespace, blocks the browser no-state
handoff with `blocked_reason=state_mismatch`, accepts the runtime state-bearing browser link, and
that runtime state-bearing browser link drives the same onboarding pull-author-reload-push-report flow
with `post_materialized=true`, `bad_authority_reason=operation_not_granted`, and a drained outbox.
Plan 112 adds Android release browser-backed onboarding child-grant runtime state exchange: the release
app uses that same runtime state-exchange shape in a dedicated onboarding-grant-state namespace, blocks
the browser no-state handoff with `blocked_reason=state_mismatch`, accepts the runtime state-bearing
browser link, and that link drives the child-grant pull-grant-author-reload-push-report flow with
`grant_ops=post`, `accepted_count=3`, `grant_authority_accepted=true`, `post_materialized=true`,
`bad_authority_reason=operation_not_granted`, and a drained outbox.
This does not prove chooser UI, cross-device exchange, authority origination, or full mobile onboarding.
Plan 114 adds Android release chooser-eligible onboarding state exchange: the same onboarding-state
probe runs from a browser-loaded page whose Android intent URL is unpinned
(`intent://...#Intent;scheme=township;end`), asserts the page contains no `package=` or `component=`
pin, asserts Android can resolve an unpinned `VIEW`/`BROWSABLE` `township://pairing` intent to the
Township app or resolver, and then drives the runtime-state onboarding pull-author-reload-push-report
flow. This proves the unpinned Android resolver-eligible browser handoff can feed the cap
persistence ceremony, but it does not prove visible chooser UI or cross-device pairing state
exchange.
Plan 115 adds bounded authority origination at the shared TS/live-BEAM seam:
`authorTownshipGenesis` emits the BEAM W1 root-bound genesis frame byte-for-byte, and the live
BEAM peer structurally accepts but authority-quarantines a forged self-issued genesis under the
honest bound replica as `impostor_genesis`. This proves the reusable substrate boundary, not an
Android release root-originating onboarding ceremony.
Plan 116 adds Android release root/authority origination: the release APK uses its native carrier
key to derive a root-bound replica, authors `authorTownshipGenesis`, cold-reloads the pending root
frame from ordinary app storage, pushes it to BEAM, and reports
`root_authority_accepted=true` plus a forged native-key genesis as
`forged_authority_reason=impostor_genesis`.
This also does not prove Chrome/browser navigation in general, chooser behavior, QR camera onboarding,
LAN discovery, physical-device behavior, production
remote TLS, or full mobile onboarding.
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
drains the outbox to zero, and then cold-reloads the drained persisted ids with
`outbox_frame_count=0`. Plan 102 extends that release author probe with an app-originated child
post-only grant, pre-push cold reload at `outbox_frame_count=3`, three pushed frames, and peer
`grant_authority_accepted=true`.
Plan 093 proves release APK OS deep-link pairing ingress in the dedicated
`township:release-pairing-probe` storage namespace: the app receives a public `township://pairing`
handoff through an adb-delivered Android `VIEW`/`BROWSABLE` intent, persists only the public peer config,
force-stops/relaunches with `paired=true`, and pulls from the trusted BEAM peer using the persisted
deep-link endpoint rather than a build-time peer URL.
The bridge extracts that public handoff from the raw Android intent and transports it as base64, not
as a custom-scheme URL string, before reconstructing the pairing URL for the shared parser. It is
public because the handoff excludes local identity, key ids, seeds, and private signing material.
This proves the release ingress path can persist and reuse a public peer config, not that a public
`VIEW`/`BROWSABLE` intent is authorization; Plan 094 adds the real app confirmation and
overwrite/reject policy for imported first-save and replacement writes, Plan 095 adds a
user-armed one-shot OS deep-link import gate so unsolicited links do not load drafts in the real
app, and Plan 096 proves the armed path in a packaged macOS app through an explicit
`township-dev-trace` release-mode smoke build.
Plan 097 adds the packaged no-side-effect trace guard for that link-load path, bounded by
ordered loaded/settled trace sentinels and a draft-load allowlist. Plan 098 adds warm macOS
LaunchServices scheme-resolution proof for the same packaged app path. Plan 099 adds packaged
macOS cold-start URL delivery through a dev-trace-only bundle defaults trace path. Plan 100 adds
app-local state binding for armed OS pairing-link import: a valid link must carry the current
crypto-generated state token before the draft loads. Plan 101 repairs the packaged macOS proof so
the release-mode dev seed is honored, the smoke waits for native hydration to settle, and the smoke
uses dev-trace-only control links instead of macOS window automation.
Plan 103 adds Android release armed OS pairing delivery in the release pairing probe: a no-state
Android `VIEW`/`BROWSABLE` pairing intent is blocked with `blocked_reason=state_mismatch`, no
premature pairing save is emitted before armed delivery, a later state-bearing intent saves, and
force-stop/relaunch syncs from the persisted peer config. The state is a fixed probe-only constant
baked into that release probe build, so this proves gate wiring in the release OS-delivery path, not
browser/chooser-backed state exchange or an unforgeable production challenge.
Plan 104 adds the named Android release convergence gate,
`tauri:android:release:convergence`: it builds each probe APK before running its corresponding
smoke, composing release pull/reload persistence, app-originated author/grant persistence, and
armed OS pairing delivery into one executable release gate. The gate still uses separate probe
builds and namespaces, so it is not one continuous production onboarding session.
Plan 105 extends that release pairing smoke to prove Android cold-start pairing delivery: the smoke
force-stops the app, asserts `pidof` is empty, delivers no-state and state-bearing adb
`VIEW`/`BROWSABLE` intents, blocks the no-state cold-start with `blocked_reason=state_mismatch`,
saves the state-bearing cold-start, relaunches with `paired=true`, and syncs from the persisted
peer config.
Plan 106 adds a single-APK Android release onboarding convergence probe in
`township:release-onboarding-probe`: the peer config comes from the OS-delivered pairing handoff,
the same release APK/session pulls the bootstrap post-only cap, authors a post with that pulled
cap, cold-reloads the paired config plus the pending valid post and unauthorized summary frames,
pushes those frames, observes `post_materialized=true` and
`bad_authority_reason=operation_not_granted`, and relaunches again with a drained outbox. This is
not a browser/chooser-backed exchange and does not prove app-originated child grant composition in
that same single-APK flow.
Plan 107 adds Android release browser-backed pairing delivery: an installed Android browser opens a
browser-loaded HTML page, a tap activates no-state and state-bearing Android intent URLs carrying
`township://pairing` handoffs, the no-state handoff is blocked with
`blocked_reason=state_mismatch`, and the state-bearing handoff saves the paired config and syncs
after relaunch. This does not prove chooser UI, browser/chooser-backed or cross-device pairing state
exchange, or an unforgeable production challenge.
Plan 108 adds Android release browser-backed onboarding convergence: the browser page request is
observed before the onboarding namespace saves pairing, then the same release APK pulls the bootstrap
post-only cap, authors a valid post plus unauthorized summary, cold-reloads the pending outbox,
pushes to a drained outbox, and reports `post_materialized=true` with
`bad_authority_reason=operation_not_granted`. This does not prove chooser UI and does not prove
browser/chooser-backed or cross-device pairing state exchange or an unforgeable production challenge.
Plan 109 adds Android release browser-backed onboarding child-grant composition: in a dedicated
`township:release-onboarding-grant-probe` namespace, the browser page request is observed before
pairing save, then the paired release APK pulls the bootstrap post-only cap, emits `phase=grant`
plus `grant_ops=post` for an app-authored child grant under that pulled cap, cold-reloads the grant, valid post, and
unauthorized summary as three pending frames, pushes all three, and reports
`grant_authority_accepted=true` with `post_materialized=true` and
`bad_authority_reason=operation_not_granted`. This does not prove chooser UI, authority origination,
browser/chooser-backed or cross-device pairing state exchange, or an unforgeable production
challenge.
Plan 113 adds a named Android release browser/onboarding regression gate: it rebuilds and runs the
Plan 107-112 browser-backed release proofs back-to-back through
`tauri:android:release:browser-onboarding-regression`. This is back-to-back rebuild/install/browser/port hygiene over plans 107-112,
not new runtime behavior or full mobile onboarding evidence.
Plan 114 adds Android release chooser-eligible onboarding state exchange through an unpinned Android
intent URL, using `tauri:android:release:chooser-onboarding-state-exchange`. This keeps the Plan 111
runtime-state onboarding flow and cap-persistence checks while removing the browser page's
package/component pin from the Android intent handoff. Production pairing still needs visible chooser
UI coverage, iOS cold-start URL delivery, and cross-device pairing state exchange. The native command consumes a valid stored
handoff once and rejects non-BROWSABLE, non-VIEW, oversized, foreign-host, and port-bearing custom
scheme intents, but a malicious local app can still send a syntactically valid public intent.
Plan 115 adds bounded authority origination at the shared TS/live-BEAM seam:
`authorTownshipGenesis` emits the BEAM W1 root-bound genesis frame byte-for-byte, and the live
BEAM peer structurally accepts but authority-quarantines a forged self-issued genesis under the
honest bound replica as `impostor_genesis`. This does not prove Android release root/authority
origination or a user-facing mobile root-creation ceremony.
Plan 116 adds Android release root/authority origination: the release APK uses its native carrier
key to derive a root-bound replica, authors `authorTownshipGenesis`, cold-reloads the pending root
frame from ordinary app storage, pushes it to BEAM, and reports
`root_authority_accepted=true` plus a forged native-key genesis as
`forged_authority_reason=impostor_genesis`.
This does not prove QR camera onboarding, LAN
discovery, physical-device behavior, production remote TLS, or full mobile onboarding. Plan 086 proves the same env-gated probe can
connect and complete a WebSocket frame roundtrip in a debug APK, so it proves the harness can produce
a positive on-device result but still does not prove release Sync/outbox/KV convergence. Plan 087 proves
the release-route reverse tunnel from Android's shell UID, but not app/WebView reachability. Android emulator now proves native carrier key reuse, bounded debug
APK BEAM convergence, bounded debug APK on-device post authoring, and bounded debug APK pull-based
cap onboarding; Android release APK builds, installs, and preserves canonical/wire fidelity for the
W1 fixture, and it now proves release-mode carrier handshake/status/report, release pull/reload,
release device-local authoring, app-originated post-only attenuated grants, push/outbox drain, and release OS deep-link peer-config
persistence over scoped loopback, release armed OS pairing delivery with a fixed probe-only
state, Android release cold-start pairing delivery, a single-APK Android release pairing-to-post convergence proof, Android release browser-backed pairing delivery, Android release browser-backed onboarding convergence, Android release browser-backed onboarding child-grant composition, Android release browser-backed runtime state exchange, Android release browser-backed onboarding runtime state exchange, Android release browser-backed onboarding child-grant runtime state exchange, a named Android release browser/onboarding regression gate over those browser-backed release proofs, Android release chooser-eligible onboarding state exchange through an unpinned Android intent URL, bounded shared TS/live-BEAM authority origination with forged genesis `impostor_genesis` quarantine, and Android release root/authority origination; the real app now blocks unarmed OS deep-link draft import, has
a packaged macOS real-app armed one-shot accept/block proof, proves that link loading does not
emit traced Save Pairing, Sync Outbox, Check Carrier, or native KV-write side effects in the packaged
smoke, proves warm macOS LaunchServices routing to the running packaged app, proves packaged
macOS cold-start URL delivery into the draft-only blocked path, and proves app-local state binding
for armed OS pairing-link import. It does not prove iOS cold-start URL delivery,
QR camera onboarding,
LAN discovery, iOS key reuse, Expo, visible chooser UI, cross-device pairing state exchange,
full mobile onboarding beyond pull-based cap acquisition, or phone-grade equivalence. The local iOS simulator archive remains
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
   - Android Tauri release APK: bounded release pull/reload, device-local authoring, app-originated post-only attenuated grants, release root/authority origination, push/outbox drain, OS deep-link peer-config persistence, release armed OS pairing delivery with a fixed probe-only state, Android release cold-start pairing delivery, single-APK pairing-to-post convergence, browser-backed pairing delivery, browser-backed onboarding convergence, browser-backed onboarding child-grant composition, browser-backed runtime pairing state exchange, browser-backed onboarding runtime state exchange, browser-backed onboarding child-grant runtime state exchange, browser/onboarding regression gate, chooser-eligible onboarding state exchange, real-app imported pairing confirmation policy, installed unarmed OS deep-link blocking, and source-level user-armed state-bound one-shot import gating are met by plans 091-095, 100, 102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, and 116 in dedicated probe namespaces or the shared Tauri app path; QR camera onboarding, LAN discovery, visible chooser UI, cross-device pairing state exchange, and full mobile onboarding remain unproven in release mode. Plan 090 is tracked separately as carrier reachability.
   - Packaged macOS Tauri app: real-app armed one-shot OS delivery is met by plan 096 in an explicit `township-dev-trace` release-mode smoke build; the traced no-side-effect link-load guard is met by plan 097; warm LaunchServices scheme resolution is met by plan 098; cold-start URL delivery is met by plan 099; app-local state binding is met by plan 100; release dev-trace hydration and control-link repair is met by plan 101.
   - iOS Tauri and Expo: still unproven.
3. A mobile smoke syncs a Township matter with a BEAM realm using persisted caps from the onboarding
   ceremony.
   - Android Tauri debug APK: partially met. Plan 082 proves pull-based cap acquisition through the
     real pairing-save and `Sync outbox` UI, cold-start persistence of that pulled evidence,
     on-device `post` authoring against the pulled cap, BEAM materialization, and BEAM rejection for
     a same-device operation outside the grant. Full mobile onboarding remains unproven beyond
     pull-based cap acquisition.
   - Android Tauri release APK: bounded carrier pull/reload, OS deep-link peer-config persistence, release armed OS pairing delivery with a fixed probe-only state, Android release cold-start pairing delivery, single-APK pairing-to-post convergence, browser-backed pairing delivery, browser-backed onboarding convergence, browser-backed onboarding child-grant composition, browser-backed runtime pairing state exchange, browser-backed onboarding runtime state exchange, browser-backed onboarding child-grant runtime state exchange, browser/onboarding regression gate, chooser-eligible onboarding state exchange, device-local post authoring, app-originated post-only attenuated grants, release root/authority origination, persisted pending-outbox reload, push/outbox drain, peer-side authority enforcement, real-app imported pairing confirmation policy, installed unarmed OS deep-link blocking, and source-level user-armed state-bound one-shot import gating are met by plans 091-095, 100, 102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, and 116 in dedicated probe namespaces or the shared Tauri app path; QR camera onboarding, LAN discovery, visible chooser UI, cross-device pairing state exchange, and full onboarding remain unproven.
   - Packaged macOS Tauri app: real-app armed one-shot OS delivery is met by plan 096 in an explicit `township-dev-trace` release-mode smoke build; the traced no-side-effect link-load guard is met by plan 097; warm LaunchServices scheme resolution is met by plan 098; cold-start URL delivery is met by plan 099; app-local state binding is met by plan 100; release dev-trace hydration and control-link repair is met by plan 101.
   - iOS Tauri and Expo: still unproven.
4. The UI distinguishes local grant saved/pending sync from carrier-converged grant acceptance.

## Stop Conditions

- Stop if raw carrier seeds move into `LocalKeyValueStore`, Vue state, AsyncStorage, or ordinary
  app files.
- Stop if `local_ops`, `carrier_frames`, or `delegation_frames` are described as secrets rather than
  replayable signed state.
- Stop if a secure-store API is used as the long-term store for growing op/frame logs.
- Stop if the app claims phone-grade persistence before native signer reuse and mobile BEAM
  convergence smokes both exist.
