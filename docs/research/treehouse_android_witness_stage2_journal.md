# Adopted Android witness journal foundation

Integrator adoption on 2026-09-07 within the user-authorized unified program.
Actual Claude Fable reviewed the source proposal against frozen `b633fd17` and
returned PASS for slice 2A with no P0/P1/P2. Review artifact:
`/tmp/lattice-treehouse-execution-20260906/fable-r36-android-slice2-result.md`.
The original proposal is preserved below as provenance. **Only slice 2A is
adopted for implementation:** section 3, section 6's 2A file/dependency allowlist,
A01-A05 foundation requirements and applicable build gates. A04's actual provider
invocation checks remain for 2B. Shared plan/ledger/CI edits remain root-owned.
No KeyStore generator, signature, plugin, witness command, sealed-request
constructor, device operation or eligibility change is authorized by this packet.
The full unified program remains in progress.

Section 4/5 and the 2B rows remain unadopted design. Fable found a P2 in its Rust
signing-lifetime calculation: subtracting the whole request duration includes
native review, so a valid 90-second review followed by ten seconds of presence
would fail the adopted separate 120-second review and 60-second signing windows.
Before 2B adoption, amend that rule and add a successful slow-review control.
Kotlin must retain and enforce its consent deadline at every blocking/release
boundary. A Rust independent upper envelope may be captured once on receipt of
the private prepare response plus the remaining duration; it cannot reset or
extend Kotlin's enforced deadline, and must never subtract pre-consent review.
This correction is recorded for subsequent review, not implemented by 2A.

The two non-blocking 2A interface observations are resolved as follows. Keep
`WitnessProcessLock` usable in plain JVM subprocesses without Android classes.
Define immutable/copying storage records with named fields rather than mutable
SQLite cursors or raw arrays exposed to callers:

- `Snapshot` contains the validated identity record (including immutable original
  metadata, phase and revision), ordered original certificate chain, bounded
  enrollment records and spent-nonce records defined by section 3. It conveys
  storage state only. No platform key handle, signature or eligibility field.
- `GenerationFence` contains the committed revision, original creation attempt
  and exact original challenge, bound privately to its issuing journal/product
  owner. It has no public/deserializable constructor. A forged, cross-owner,
  stale or reused fence cannot mutate completion metadata. Restart inspection
  observes the durable phase; it never reconstructs permission to generate.
- `ConsentRecord` contains the committed revision and exact enrollment, validator
  nonce, native operation attempt, native nonce and session digest just inserted.
  It is a storage receipt, with no signing deadline or platform authorization.

A storage-only restart seam is adopted on 2026-09-07 before implementation:
`reconcileOriginalGeneration(expectedRevision, originalAttempt, exactChallenge,
capturedMetadata) -> Snapshot | Refused`. It requires the retained
`generation_started` phase and exact revision/original-attempt/challenge, applies
all ordinary metadata/schema/size invariants, and commits the same completion
record atomically. It returns no generation fence or generator permission. A
completed-record retry may only observe the exact original metadata idempotently;
changed metadata refuses. The later 2B coordinator must independently inspect the
actual fixed key/profile/chain and original challenge before invoking this seam.
No transient fence is reconstructed on restart. This fills the previously absent
storage entry point for the already adopted started-plus-matching-key recovery
case; no provider, IPC, signing or eligibility path is added by 2A.

The record schema and transitions remain those reviewed below. Capture host
file-backed transaction/reopen, bound, contention and failure evidence honestly;
host SQLite success does not establish handset fsync, JNI, biometrics or custody.

---

# R36 Android Stage 2 — journal and protected binding implementation proposal

Prepared 2026-09-06, 23:54 UTC, for integrator adoption. **Proposal only.**
No source was edited, no build/test or device/key operation was run, and nothing
was committed for this preparation. Android source reviewed: slice 1
`42338ed8984eab2c17d4b7edcdf5a678763ff293`, with current clean integration head
`4aba17799039521524b8bf1b52b043487b1056ab`. Before delivery, root's publication
advanced this clean worktree to `b633fd172965fbbd733c0d2a0d71083ab0ebbd40`;
the Rust/Kotlin source and Kotlin test paths inspected here remain byte-identical
across that integration. The controlling contract is adopted
`833cbccad89fdedd67a6d73418c2736af3be72bc`,
`docs/research/treehouse_android_witness_stage2.md`. Actual Claude Fable's slice-1
PASS is `/tmp/lattice-treehouse-execution-20260906/fable-r36-android-slice1-review-result.md`.
It found no P0–P2; its three P3 points are addressed below before real callers.

## 1. Recommended sequence and exact adoption decisions

Implement **2A, the journal foundation**, first. It supplies the actual Android
file-backed store, cooperating-process lock and transition/refusal rules, plus
named Kotlin claim fields and variant-aware tests. It registers no plugin or
witness command, invokes no KeyStore generator/signature and opens no production
sealed-request constructor. A real journal component can be tested before its
native review/provider caller exists; it must not fabricate protected custody.

Then implement **2B, the complete provider and protected bridge**, as a separately
reviewed packet. It supplies the actual fixed AndroidKeyStore backend, native
review and CryptoObject flow, private plugin, session ownership, five commands
and usable opt-in setup panel. The independent validator remains Stage 2's next
packet; physical eligibility, R14 enrollment and R17b/R17c remain open. A compiled
2B APK may report `generated_unvalidated` only after actual platform generation
and durable metadata capture. It cannot report an eligible key.

Adopt these implementation details before code:

1. Android-compatible byte-array transport for the four input-bearing commands,
   followed by strict parsing of their original UTF-8 JSON. Pinned Tauri Android
   does **not** support `InvokeBody::Raw`; do not build an impossible raw-body API.
2. A native-targeted pending-attempt event gives the owner the exact cancellation
   ID without exposing a caller-chosen token or adding a sixth command.
3. Explicit SQLite `DELETE` + `EXTRA`, non-deleting corruption handling, and a
   read path that does not call directory-creating Android helpers. These refine
   the adopted durable fence and create-free read; they add no rollback anchor.
4. The journal schema, transition matrix, finite row limits and existing-key
   reconciliation below. Coordination files may be created by explicit prepare
   before the dialog; no identity/enrollment row is committed before acceptance.
5. Test-only Robolectric `4.16`, API-33 native SQLite host tests under the existing
   JDK17, pinned dependency verification. No app runtime library/AGP/Kotlin upgrade.
6. The exact native session digest and two-step internal proof handoff below.
   The fixed 13-field possession claim and five public command names stay unchanged.
7. Local `KeyInfo` duration handling accounts for the API documentation/provider
   difference; it never substitutes for verified attestation or actual per-use
   CryptoObject behavior. Key absence is never inferred from `containsAlias` alone.

Root continues to own source plans, shared README/ledger, workflows and hosted
publication. This file is the requested temporary packet, not an adopted plan.

## 2. Source-grounded boundaries

| Inspected seam | Implementation consequence |
| --- | --- |
| Treehouse `src-tauri/src/lib.rs:24–90` | Exactly six existing preview/carrier commands. Preserve their names, inputs, product isolation and state behavior. No witness command in 2A. |
| `witness_binding.rs`; Kotlin `witness/BindingCodec.kt:11–25` | Rust sealed signing request has no constructor. Kotlin currently takes eight positional arrays: replace that interface with eight named fields before connecting a native caller. Keep all four runtimes' existing binding bytes identical. |
| Kotlin `BindingCodecTest.kt:24–25` and app Gradle release guard | Make the pilot assertion variant-aware: debug false; an actually configured release true. Eligibility stays false. Missing release credentials still refuse; never create a debug-signed release to run the test. |
| Tauri 2.11.5 `src/ipc/mod.rs:50–61,142–156` | Android always receives `Json`; `Raw` is unsupported. `@tauri-apps/api` 2.11.1 `InvokeArgs` explicitly permits `number[]`. |
| Tauri `src/plugin.rs:458,482`, `src/manager/mod.rs:338–362` | Plugin navigation/page-load hooks cover config-created `main`. Current packaged Android origin is `http://tauri.localhost` (default `useHttpsScheme=false`), distinct from dev URL `http://127.0.0.1:5175`. |
| Tauri `src/webview/mod.rs:1859–1897`, `src/plugin/mobile.rs:292–320` | Unhandled plugin calls can fall through to Kotlin. Reject and consume webview calls to the internal namespace. Async mobile callback uses `take().unwrap().send(...).unwrap()`: retain one receiver through cancellation and deliver one terminal response. |
| API-33 `ContextImpl.java:818–823,2950–2975` | `getNoBackupFilesDir()` creates its directory. A supposedly create-free public read must not call it when absent. `getDataDir()` only resolves the native application directory. |
| API-33 `DefaultDatabaseErrorHandler.java:53–104`; `SQLiteDatabase.java:1057–1075` | Default corruption handling deletes files; a returning handler also permits an open retry. Supply a non-deleting handler that raises an application corruption failure, and never call SQLiteOpenHelper destructive upgrade/recreate paths. |
| API-33 `AndroidKeyStoreSpi.java:106–123,153–161,979–1007`; `AndroidKeyStoreProvider.java:338–386` | `containsAlias`/alias enumeration can turn backend errors into absence. `getKey` preserves non-not-found failures and invalidation; a null may also denote a certificate-only entry, so inspect and refuse that entry. |
| API-33 `KeyInfo.java:300–312`; `AndroidKeyStoreSecretKeyFactorySpi.java:93,178–184,240–264` | Javadoc says per-use duration `-1`, while keystore2 initializes absent AUTH_TIMEOUT to `0` (API35 source agrees). Do not use a `-1`-only test that rejects the current provider. |

SDK source paths above are under the locally installed
`$ANDROID_HOME/sources/android-33`; they are read-only source evidence, not a
device profile. Official references confirm the
[corruption handler's deletion](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/database/DefaultDatabaseErrorHandler.java),
[explicit SQLite open options](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase.OpenParams.Builder.html)
and [EXTRA's directory-sync behavior](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase#SYNC_MODE_EXTRA).

## 3. Slice 2A: real native journal with no reachable witness operation

Use the ordinary credential-protected application context. All paths derive
from native product constants and that context, never IPC. `WitnessPaths` resolves
`context.dataDir/no_backup/treehouse-governance-v1/identity.sqlite3` without
creating it. This matches the pinned platform's `noBackupFilesDir` location;
explicit prepare verifies equality against `context.noBackupFilesDir` before
initialization. An unexpected platform mapping refuses instead of using another
directory. Existing components must be ordinary files/directories, with symlink
substitution refused inside the product-owned subtree. Parent app-private storage
is trusted outside webview/cache mutation, as in the adopted threat boundary.

`WitnessJournal.observeExisting()` opens an existing database with
`OPEN_READONLY | NO_LOCALIZED_COLLATORS`, the non-deleting error handler, no
CREATE flag, no writable PRAGMA, migration, lock-file creation or repair. Missing
database is a storage observation only; the later coordinator combines it with
actual key observations. If a hot rollback journal cannot be read without
recovery writes, report incomplete. Explicit mutating/reconciliation operations
may perform SQLite's normal crash recovery, under the process lock. Normal
transaction-journal cleanup is distinct from deleting/replacing the identity
database or a corrupt store.

For writes: `OpenParams.Builder` explicitly selects `DELETE`, `EXTRA`,
`NO_LOCALIZED_COLLATORS` and the custom error handler; verify effective journal
mode and synchronous value before admitting a mutation. Use short transactions,
with failure from begin/commit/close/sync propagated. Initial directory/database
creation includes synchronization of newly created directory entries before any
generation permit can exist. No WAL, attached database, VACUUM, pruning, reset,
schema migration or destructive error recovery. A corrupt or unknown existing
file is retained and refused, including an interrupted zero-byte initialization.

Use one fixed `identity.lock`, an in-process owner registry, and
`FileChannel.tryLock` on an I/O executor. Return busy on overlap; never unlink or
replace the lock. Reads need not create a lock; existing-store observations can
use an existing shared lock or return busy. Explicit prepare may create the
coordination directory/lock before review. Cancellation can therefore leave
coordination files, while no enrollment/identity mutation or key exists yet.
Hold the process operation lock across a pending native operation, but no
SQLite transaction or UI-thread mutex across a dialog. Cancellation must remain
dispatchable without acquiring that operation lock.

### Closed v1 journal records

Use bound SQLite parameters and typed columns with exact lengths/checks; validate
both schema and all read records. `PRAGMA user_version=1`, exact known tables,
columns and constraints; no automatic upgrade. Product/app/profile constants are
native values. No private key, bearer capability or signature artifact is stored.

| Table | Exact conceptual columns and invariants |
| --- | --- |
| `identity` (one row, id=1) | `product`, `app_id`, `profile_version=1`, `creation_attempt_id` BLOB32, `phase` (`prepared`, `generation_started`, `generated_unvalidated`), nullable `generation_challenge` BLOB32 before first start; nullable `public_key` BLOB32, `spki` exact44-byte Ed25519 DER, `creation_app_signer_sha256` BLOB32, `creation_version_code` canonical decimal text 1..19 digits bounded by positive signed64 before completion; `revision` integer. Started challenge never changes; completed public metadata never changes. |
| `identity_chain` | `ordinal` unique 0..7, `der` nonempty <=16384 bytes. Contiguous, <=65536 bytes total; present only with complete captured public identity. The exact original sequence is retained. |
| `enrollments` | `enrollment_id` unique BLOB32, exact `replica` UTF-8 1..512 bytes, `recipient` BLOB32, original `creation_attempt_id` BLOB32. <=4096 rows. Same tuple is idempotent; differing tuple under same ID refuses. |
| `spent_nonces` | `validator_nonce` unique BLOB32 product-wide, `enrollment_id` BLOB32, ephemeral-operation `attempt_id` BLOB32, `native_nonce` BLOB32, `session_digest` BLOB32. <=4096 rows. Insert atomically at native consent; no deletion, reusable status or persisted signature. |

Every mutation increments a nonnegative SQLite signed-64-bit software revision;
exhaustion refuses instead of wrapping. This detects changes within retained
state, not whole-store rollback. Phase/column combinations, foreign references,
limits and public metadata are checked on every open. Serialize a proposed
public-identity/proof response against the adopted 128KiB bound **before**
committing metadata that would require an oversized response. Capture errors
after platform generation leave the started fence; do not delete/regenerate.
Fixed row/string/chain bounds apply now. R17b must count database/control bytes
alongside all retained history in its total budget; row bounds are not a measured
capacity, and 2A does not promise all future histories fit.
The v1 capture expects one current application signer; multiple signers refuse
pending an explicit profile extension. Creation version is retained provenance,
not a requirement that the app never update. Later observation still requires
the same product/app/signer/profile, while independent attestation checks its
own expected application identity. App-signing rotation is not silently admitted.

Internal journal interface (Kotlin, application module only):

```text
observeExisting() -> Missing | Snapshot | Refused(reason)
prepareAccepted(enrollment, nativeCreationAttempt) -> Snapshot | Refused
commitGenerationStarted(expectedRevision, originalAttempt, exactChallenge)
  -> durable GenerationFence | Refused
finishOriginalGeneration(fence, capturedActualMetadata) -> Snapshot | Refused
commitBindingConsent(expectedRevision, exactEnrollment, validatorNonce,
                     nativeAttempt, nativeNonce, nativeSession) -> ConsentRecord | Refused
```

These are storage transitions, not permissions or possession claims. `GenerationFence`
has no public/deserializable constructor; it can only follow a successful commit.
The later coordinator supplies independently accepted native requests. For 2A,
only tests call these transitions: no reachable production native caller exists.
Private test fixtures model public metadata, not an Android success backend.

## 4. Slice 2B: exact fixed provider and crash fence

`AndroidWitnessProvider` has one fixed alias:
`dev.treetop.lattice.treehouse.governance-witness.v1`. Its backend uses only the
adopted API33+ EC/AndroidKeyStore generator with `ECGenParameterSpec("ed25519")`,
SIGN-only, DIGEST_NONE, strong biometric timeout0, biometric enrollment
invalidation and the original 32-byte attestation challenge. No StrongBox request,
alternative algorithm/provider, credential authentication, imported key or export.

Internal provider interface:

```text
observeFixedIdentity() -> Absent | Present(actual metadata/opaque handle) | Refused
generateOriginal(fence, nativeReviewToken) -> CapturedActualIdentity | Refused
prepareBinding(exactNativeEnrollment, validatorNonce, actualNativeSession)
  -> native reviewed pending handle + actual fixed claim | Refused
signPrepared(pendingHandle) -> exact claim + signature | Refused
cancelOwned(nativeAttempt, nativeOwner) -> Cancelled | Refused
```

Nothing accepts a key alias, arbitrary bytes, prompt, domain or caller-supplied
claim. Backend signing is not a generic public `sign(bytes)` method. Test seams
live under `src/test`; the ordinary APK instantiates only the real backend.
Until that real backend and native review are connected, no new command is
registered. A platform refusal is a refusal, never a successful test substitute.

### Key discovery and local profile checks

Load `KeyStore("AndroidKeyStore")`, then `getKey(FIXED_ALIAS, null)`; any exception,
permanent invalidation or unexpected key type refuses. A present key with missing
journal always refuses. Null is supplemented with fixed-alias certificate/chain/
presence checks: any observed certificate-only or inconsistent entry refuses.
Never treat a failed alias listing or `containsAlias=false` alone as authorization
to generate. The public API cannot make alias lookup and generation atomic; the
native lock protects cooperating processes, not another actor controlling the
same UID. Metadata APIs can hide backend errors; no absence claim extends to a
hostile/corrupt same-UID writer or an unobservable certificate-only alias. Existing
witness private-key lookup errors remain fail-closed.

Extract `KeyInfo` through `KeyFactory.getInstance("EC", "AndroidKeyStore")` and
the actual opaque private-key handle; this is the API33 registered factory for
these keys. Do not guess an AndroidKeyStore `Ed25519` KeyFactory registration.
Require actual Ed25519 SPKI OID `1.3.101.112`, absent parameters, exactly32 public
bytes; TEE security level; generated origin; SIGN-only; DIGEST_NONE; auth required,
strong biometric only, hardware-enforced authentication, enrollment invalidation;
no positive timed authorization, on-body reuse, extra purpose/padding or unrelated
trusted-presence/confirmation requirement. Local duration diagnostics may be `0`
(actual keystore2 absent-tag result) or documented `-1`; other values refuse.
Neither value alone establishes per-use behavior. The independent validator must
still require absent AUTH_TIMEOUT/NO_AUTH_REQUIRED and correct hardware
authorization, and the physical flow must prove per-use CryptoObject operation.

Capture the actual leaf public key/SPKI and exact returned DER chain under the
adopted limits. `KeyStore.getCertificateChain` returns the key certificate first.
For interrupted-generation reconciliation, locally compare that certificate's
actual SPKI and its bounded attestation-extension challenge with the journal's
original challenge. Add a small strict DER reader for only the required X.509
extension wrapper/KeyDescription challenge and Ed25519 SPKI; no hidden Android
ASN.1 API or general CBOR/ASN.1 facility. Reject indefinite/nonminimal lengths,
trailing bytes, duplicate/missing required structure or challenge ambiguity;
all parsing is bounded by the existing certificate cap. The remaining
KeyDescription fields must be structurally traversed within those limits, not
asserted eligible locally. This is metadata reconciliation within trusted native
storage, **not** independent chain/root/revocation/extension-trust validation.
The later validator uses the first trustworthy extension nearest the root under
the already adopted validation contract. A changed recorded key/chain always
refuses. [Certificate-chain ordering](https://developer.android.com/reference/java/security/KeyStore#getCertificateChain(java.lang.String))
and the [attestation schema](https://source.android.com/docs/security/features/keystore/attestation)
define these representations.

### Generation/restart matrix

| Durable state and fixed-alias observation | Only allowed outcome |
| --- | --- |
| No database and no observed key/entry | Public read says missing. Explicit accepted prepare may initialize; it creates no key. |
| Prepared + absent key | Native-confirm exact original attempt/challenge; commit `generation_started`, synchronize, then recheck key state under held lock and invoke the generator once. A failed fence never calls the generator. |
| Prepared + any key/entry | Incomplete/unowned; no adoption, generation or overwrite. |
| Started + absent key | Incomplete. This includes a crash just before generator entry and any generation error without a visible key. Never invoke the generator again. |
| Started + present key | Explicit generate retry can reconcile only the same original attempt/challenge and actual matching profile/chain. Complete the metadata transaction if valid. Public read performs no reconciliation writes. |
| Complete + matching key/chain | Return original public metadata. New accepted enrollment points to the same attempt/key/challenge; <=4096. Repeated exact generate does not generate. |
| Complete + missing/changed/invalidated key; corrupt/missing/unknown store + key | Retain and refuse. No reset, rotation, chain refresh, cleanup or replacement. |
| Generation succeeds, capture/commit/response fails | Original started fence remains authoritative. Retry may reconcile original key; ambiguity remains incomplete. No possession or eligibility claim. |

Directory/SQLite/platform failures and cancellation are tested at each boundary.
If platform generation has already begun when cancellation/navigation occurs,
drain it and preserve any necessary original metadata under the started fence;
suppress the stale response. Cancellation cannot roll back a platform key.
Platform-internal cleanup on generator failure is outside the app's deletion
guarantee. Both key and entire native store lost/rolled back together remain
explicit non-claims; an existing R14 pin must prevent silent replacement.

## 5. Protected flow, transport, ownership and cancellation

For public identity, accept the existing no-input convention as an exactly empty
JSON object. For each of the other four commands, TS sends
`Array.from(new TextEncoder().encode(JSON.stringify(closedRequest)))` as the
top-level `invoke` argument. Rust accepts only `InvokeBody::Json(Array)`, at most
131072 integer elements in 0..255, copies once, validates UTF-8 and strictly
deserializes the original JSON into the exact closed command struct. Reject all
object wrappers, strings, floats, booleans, nested arrays and extra/duplicate
inner keys. No ignored outer argument exists. Android may normalize the numeric
transport representation; it cannot normalize the JSON fields encoded as bytes.
The array expansion is transport overhead, not a raised 128KiB decoded envelope
limit or a preallocation guarantee for malicious in-process IPC.

| Public command | Exact decoded request keys |
| --- | --- |
| `treehouse_witness_prepare_creation` | `replica`, `enrollmentId`, `recipient` |
| `treehouse_witness_generate` | `creationAttemptId`, `generationChallenge` |
| `treehouse_witness_prove_binding` | `replica`, `enrollmentId`, `recipient`, `freshValidatorNonce` |
| `treehouse_witness_cancel` | `attemptId` |

Use owned exact canonical Base64 values and the already adopted sizes. No
caller-controlled `version` selector is needed for these named v1 commands;
exported public records retain version1. Before plugin dispatch, require actual
native `main` window/webview, current URL origin exactly `http://tauri.localhost`
(no userinfo/port substitution), and a live native session. The dev server and
remote URLs refuse witness operations. This does not change preview navigation
or its six commands. Do not change scheme and silently move webview storage.

Derive session digest as SHA256 of the fixed canonical binary array:

```text
["treehouse-native-caller-session-v1", "dev.treetop.lattice.treehouse",
 "main", launchNonce32, navigationNonce32]
```

Both strings/nonces use the same bounded byte-string encoding as slice1. These
native random nonces are not key material and never come from IPC. Advance the
session on native navigation/page-load start, owner destruction and lifecycle
cancellation; establish a usable session only for the current local document.
Each accepted operation snapshots it. Native Kotlin also checks actual activity
ownership/resumed state, cancellation and journal revision. Do not rely on
caller labels, forged DOM events or a webview timer.

Internal plugin name/class stay exactly as adopted. Register its Rust handler
to reject **and return handled** for every webview invocation, in addition to no
plugin permissions. Only Rust's private mobile handle calls Kotlin. Add explicit
app-command permissions for the five commands while retaining all six preview
permissions; capability scope is local `main`, no remote grant. Add only normal
`android.permission.USE_BIOMETRIC` in 2B; no storage, account, phone-ID, camera,
network or new exported-component permission. Existing INTERNET is unchanged.

The owner subscribes before invocation to targeted native event
`treehouse:witness-pending-v1`: closed `{version:1, attemptId, phase}`, with phase
`review` or `presence`. Emit to that actual owner only. The random attempt ID is
ephemeral and distinct from the durable creation attempt. Cancel requires both
exact ID and current native ownership; a late ID cannot cancel a later operation.
The event carries no authority/eligibility assertion. If delivery is lost, native
Cancel and lifecycle timeout still work; no caller-generated token is accepted.

```mermaid
sequenceDiagram
  participant W as Local main webview
  participant R as Rust owner/session gate
  participant K as Private Kotlin coordinator
  participant J as Native journal
  participant O as AndroidKeyStore and BiometricPrompt
  W->>R: prove_binding(closed proposed enrollment and validator nonce)
  R->>K: prepareBinding(owned proposal, native owner/session)
  K->>J: load exact enrollment/original identity
  K->>K: native review, max120s
  K->>J: commit nonce spent + native attempt/nonce/session
  K-->>R: private pending handle + actual named claim
  R->>R: compare request/actual metadata; create sealed request
  R->>K: signPrepared(handle only; no bytes/alias/prompt)
  K->>O: fresh Signature + same-operation CryptoObject
  O-->>K: per-use authenticated operation
  K->>K: recheck owner/revision/TTL, sign, recheck again
  K-->>R: exact public claim and signature once
  R->>R: verify bytes/signature; final session/TTL/one-shot check
  R-->>W: bounded public possession packet
```

Kotlin reconstructs the unchanged 13-field claim from its retained record and
pending native state. `signPrepared` accepts only the opaque native handle;
the public wrapper never forwards supplied bytes. Rust's private reviewed-state
type is created only from the successful private prepare response after all
expected-value/session checks. Only that type constructs `BindingSigningRequest`.
No Deserialize/public/unchecked constructor is added to the sealed type.
Use named Kotlin fields, copy each input, and expose only immutable/copy views.

Native review displays exact proposed replica/enrollment/recipient fingerprints,
actual witness key, original attempt/challenge digest and fresh nonce. Escape
control characters and preserve full values in native details. It explicitly
labels the target as proposed, not native-verified group authority. The OS reason
is the fixed one-line `Prove Treehouse witness key possession` (<200 bytes).

Consent inserts the globally unique validator nonce durably before presence,
including any later cancellation/failure; the 4097th distinct nonce refuses.
Start the 60s monotonic signing lifetime at consent, not IPC arrival or OS success;
native review has its separate 120s lifetime. Retain the Kotlin consent deadline;
Rust's release check must conservatively use the same deadline via a remaining
duration captured before the prepare response is sent (subtract transit time
using its own request-start monotonic bound), never grant a new 60s on receipt.
No wall-clock/persisted deadline restores a pending attempt after process restart.

Create a new `Signature.getInstance("Ed25519")`, initialize it with the fixed
opaque private-key handle and hand **that exact instance** to framework
`BiometricPrompt.CryptoObject`. Require the returned object to be the same
operation. Check session/revision/cancel/lifetime before opening presence, after
blocking presence, after `sign()` and before every release. Fresh proof means new
validator/native nonce and CryptoObject; never authenticate once and sign twice.
Reject a different callback object, stale token or surplus result. Rust verifies
the Ed25519 signature against its sealed bytes/actual public key before release.

One pending attempt per product key is a conservative serialization of the
adopted per-window/product/replica/key/domain bound. Native activity pause/stop/
destroy, webview navigation, explicit cancellation and timeout invalidate it;
platform lifecycle behavior during a biometric prompt must be tested on the
selected profile and cannot be silently exempted. Hold no UI mutex or database
transaction while waiting. Kotlin resolves each invocation exactly once with a
terminal CAS guard; a native-owned Rust task drains the plugin response even
after its webview receiver is gone. Cancellation signals the platform but never
aborts that drain task. No signature/outbox is persisted or replayed after a
lost response; a new proof requires a new independent nonce and authentication.

## 6. File ownership and dependency allowlist

`T=clients/treehouse-tauri-shell`, `A=T/src-tauri/gen/android`,
`K=A/app/src/main/java/dev/treetop/lattice/treehouse/witness`.

| Packet | New files | Edited files |
| --- | --- | --- |
| 2A journal | `K/WitnessPaths.kt`, `WitnessJournal.kt`, `WitnessProcessLock.kt`, `WitnessRecords.kt`; corresponding `src/test/.../witness/{WitnessJournalTest,WitnessProcessLockTest,WitnessRecordsTest}.kt` plus test-only failure/checkpoint fixtures | `K/BindingCodec.kt`, existing `BindingCodecTest.kt`, `A/app/build.gradle.kts` for pinned host-test dependency/config only; task-local Gradle dependency verification/lock artifacts under `A/gradle` if not already present |
| 2B provider | `K/AndroidWitnessProvider.kt`, `WitnessAttestationMetadata.kt`, `WitnessCoordinator.kt`, `WitnessNativeReview.kt`, `TreehouseWitnessPlugin.kt`; Rust `witness_provider.rs`, `witness_android.rs`, `witness_bridge.rs`; `T/src/witness_adapter.ts`, `WitnessSetup.vue`; permission file `T/src-tauri/permissions/witness.toml`; matching Rust/Kotlin/TS bridge/provider tests and compile-only Android instrumentation tests | `lib.rs`, `witness_binding.rs` private constructor seam, `build.rs`, Cargo manifest/lock only if a direct random/async dependency is needed (reuse pinned transitive version, no upgrade); `MainActivity.kt` lifecycle hooks, Android manifest USE_BIOMETRIC, default capabilities, App.vue setup entry, exact product/Android contract tests, package script wiring |

No lattice-client/mobile-core/BEAM production change; no Township changes.
Existing BEAM/Rust/TS/Kotlin byte fixture is reused unchanged. A tiny pure native
session-digest fixture may be added to the same test family with explicit new
cases, not legacy-vector regeneration. No public fixed-purpose generic signer.
No independent validator vendor/dependencies or eligibility enablement in 2A/2B.

Robolectric `org.robolectric:robolectric:4.16` is test-only. Select API33 explicitly;
its [compatibility table](https://robolectric.org/compatibility_table/) supports
that SDK, while later SDK test choices have different JDK requirements. Keep
JDK17/AGP8.11.0/Kotlin1.9.25/Gradle8.14.3/SDK36/NDK27.1.12297006. Record resolved
test dependencies/checksums before execution; do not infer compatibility from
the table's upstream build-tool column or upgrade tools to match it. If the
actual dependency gate fails, retain the failure and review an exact alternative.

## 7. Executable acceptance and honest proof limits

Capture meaningful behavioral RED before each production change; test actual
public boundary/store methods, not a parallel model. No full Mix during design.

| Gate | Required host-feasible evidence |
| --- | --- |
| A01 named claim / variants | Existing BEAM bytes equal Kotlin after named-field migration; mutation isolation/shape refusals. Swap each named binary field and show signature/expected-byte disagreement. Debug false and configured-release true assertions are variant-aware; eligibility remains false. |
| A02 create-free reads | On absent native subtree, snapshot file tree then invoke real `observeExisting`; identical tree afterward. Existing valid/corrupt/hot-journal read, unknown schema, invalid rows, missing parent and no repair; custom corruption callback leaves exact files retained. |
| A03 actual file-backed transactions | Robolectric native SQLite API33, real files, no in-memory fake store. Explicitly assert `DELETE` and `EXTRA` (Robolectric can otherwise choose faster sync). Reopen with a fresh store instance; verify exact immutable original data, revision and limits. This is transaction/restart evidence, not power-loss/device fsync proof. |
| A04 fence/crash matrix | Inject failure before/after begin, started commit, generator boundary, metadata capture/final commit and response; production coordinator later records backend invocation count. No failed commit generates; no started restart generates twice; complete retry reuses original key/challenge. Kill/reopen host process where feasible; syscall failure injection is not a handset power cut. |
| A05 concurrency and retention | Two separate host JVMs contend on the production file-lock class: one owner, other busy. 4096 enrollment/nonce boundaries, same-ID conflict, repeated nonce across enrollments, count/size/ref integrity, revision exhaustion and canceled attempts retained. No replacement/deletion path. |
| B01 key provider contract | Test-only backend adapter exercises null versus exception/wrong type/invalidated alias, changed original key/chain/challenge, exact generator parameters and local metadata duration0/-1/positive controls. Actual production calls compile; fakes never establish Android custody or appear in ordinary APK. |
| B02 bridge / ACL | Actual Rust invoke harness accepts exact numeric-byte transport and rejects malformed/oversized/duplicate/extra JSON; wrong window/origin/session and direct internal plugin invokes refuse. Test intentionally broadened test capability still hits handled rejection, and all six preview commands retain behavior. Android instrumentation source compiles for actual plugin routing; host harness alone is not Android dispatch proof. |
| B03 review / presence | Production coordinator with test-only clock/UI/operation adapters: wrong enrollment, stale revision at every blocking boundary, canceled/replayed IDs, different CryptoObject, duplicate callbacks, callback after receiver loss, timeout/background/restart and signature substitution release nothing. Two successes consume distinct nonces and operations; spend survives later refusal. |
| B04 public packet | Existing canonical bytes and independent signature verification; exact actual-public-key/challenge/request/session binding, bounded export, no extra response fields, no arbitrary-purpose/seed/key-selector input. Native setup is opt-in and cannot mark eligible. |
| Build | Shell test/typecheck/build; Rust fmt/test locked including compile-fail sealed-request tests; Gradle `testUniversalDebugUnitTest`, `lintUniversalDebug`, `buildSrc` tests; actual arm64 debug APK through pinned Tauri CLI. Discover actual instrumentation-assemble task before recording it. Missing-credential release prebuild still refuses. |

Robolectric's SQLite tests and injected callbacks do not test AndroidKeyStore,
TEE, biometrics, Binder failure, real process lifecycle, storage power loss or JNI
linking on a handset. Fable P3's `initializeNdkContext` JNI resolution remains an
explicit selected-device startup gate; symbol inspection is only static evidence.
Release unit tests run only when the approved pilot configuration is actually
available; the absence of that configuration is recorded, not bypassed.

After separate authorization of an explicit unpinned test identity/device and a
reviewed APK, device gates must establish actual TEE Ed25519 generation, exact
original attestation, independent validator/trust/revocation checks, two fresh
protected operations, cancellation/lockout, pause/restart/reboot, JNI startup,
biometric enrollment invalidation and interrupted creation/reconciliation. No
adb/emulator/device/key/reset/global configuration action is part of this proposal
or its host build gates. Both proposed independently operated witnesses need
their own evidence before R14 pinning. StrongBox/software/credential/P256 fallback
remains absent. Stage 2 and unified R36 stay in progress after either slice.

## 8. Review/adoption handoff

The recommended next authorization is **2A only**, with its exact file/dependency
allowlist and A01–A05 foundation gates; A04's real-provider invocation checks
complete in 2B. Review 2B's private handoff, byte-array transport, cancellation
event, local metadata interpretation and honest absence limits before enabling
its commands. No unresolved device fact is represented as a successful result.
The implementation can progress locally without a selected handset, while
physical eligibility remains a real later gate rather than a stub.

Remaining uncertainties are bounded: host dependency admission/native SQLite
configuration must be executed, not inferred; public KeyStore APIs cannot provide
atomic alias creation or expose every certificate-only lookup error; actual
Android dispatch/JNI/lifecycle behavior and the combined TEE/Ed25519/attestation/
strong-biometric profile require selected-device evidence. The latter facts do
not block 2A. A discovered inability to uphold a 2B guard is a recorded refusal
or an exact review amendment, never a hidden fallback.

## Adopted 2A storage-size preflight — 2026-09-07

The integrator adopts the exact private projection below before metadata completion
implementation. Its field descriptions map to the unchanged existing binding codec;
it is not a new public wire response. Check every retained/proposed selected
enrollment independently; do not combine the whole enrollment inventory into a
pretend single response. Placeholder bytes are ephemeral sizing inputs only.

# Android 2A exact private precommit-size projection

No provider response or signature is produced. Proposed private sizing envelope only:
- identity exactly version, product, appId, creationAttemptId, generationChallenge, publicKey, spki, creationAppSignerSha256, creationVersionCode, certificateChain. All values are actual original public metadata.
- binding exactly claim and signature. claim exactly the existing 13 fixed binding fields: domain/version/product/appId/replica plus enrollmentId/recipient/creationAttemptId/actualWitnessPublicKey/generationChallengeDigest/freshValidatorNonce/nativeRandomNonce/nativeCallerSessionDigest. Select each actual retained/proposed enrollment for preflight; derive known fields from original state. The three future ephemeral slots use 32-byte all-255 size placeholders, signature uses64-byte all-255 size placeholder. These are sizing bytes only, never persisted as a proof, returned or signed.
- No unexplained numerical reserve. Serialize using actual API33 org.json.JSONObject then count UTF8 <=131072 before metadata/enrollment admission. Future2B must serialize and independently guard its actual final response again.

API33 JSONStringer escapes every slash (source captured read-only in r36-journal-api33-JSONStringer.java). This means a legal raw64KiB synthetic certificate chain can exceed128KiB JSON and must refuse. Constructed worst-case envelope with8 chains (7x8191 +8199 bytes, all255),512 NUL replica bytes, maximum signed64 creation version, actual SHA256 original-challenge digest, and all255 remaining fixed fields produces 179761 UTF8 bytes; chain Base64 alone totals87400 characters before slash escaping. This is genuine legal storage-input shape and a required oversized precommit negative. Ordinary64KiB all-zero synthetic chain is a valid positive (no slash expansion) subject to actual serializer result. No global assertion that every64KiB chain fits.


## Root adoption: test-only directory synchronization fixture

Adopted 2026-09-07 UTC. The following bounded fixture resolves a verified
Robolectric limitation; production Android syscalls remain unchanged.

# Android 2A test-only directory synchronization adapter

Proposed exact test fixture `WitnessDirectoryOsShadow.kt` under the existing app `src/test/java/dev/treetop/lattice/treehouse/witness` package. No production dependency, method, flag or syscall changes. No instrumentation/APK/device usage. The production journal retains Android `Os.open`, `Os.fstat`, `Os.fsync` and `Os.close`.

The verified Robolectric4.16 `ShadowLinux` implements directory `open` through Java `RandomAccessFile`, causing EIO, and descriptor `fstat` through `stat(null)`. This is independent of API33 NATIVE SQLite, which already passed a real file-backed DELETE/EXTRA transaction and reopen test. Failure evidence remains `r36-journal-io-diagnostic.log`; source is `r36-journal-ShadowLinux.java`. The temporary diagnostic result text has been restored; production exposes stable refusals only.

Use a scoped Robolectric shadow of static `android.system.Os` (not replacement production code). Configure it only on `WitnessJournalTest`/its explicit test-only crash fixture. Tests register their own temporary application directory before any journal operation. The shadow intercepts only directory calls within those registered temporary roots; all unregistered/non-directory `open` calls and operations on non-owned descriptors invoke the original `Os` method through Robolectric's direct-call helper, retaining the existing Linux shadow behavior. Other methods are untouched.

For an intercepted directory open:

1. Require the exact production flags `O_RDONLY | O_NOFOLLOW | O_CLOEXEC`, and mode0. Require every applicable test-owned path component be nonsymlink and the leaf's NOFOLLOW attributes be a directory. Reject altered/create/write/truncate flags and nonordinary targets.
2. Open a real host `FileChannel` using `StandardOpenOption.READ` and `LinkOption.NOFOLLOW_LINKS`. No directory creation, file substitution, deletion or successful fallback.
3. Allocate a fresh `FileDescriptor` identity solely as a test-local opaque handle; do not assign or reuse an OS descriptor integer, reflect into private JDK fields, or collide with stdin/stdout/stderr or a real descriptor. An identity-keyed, synchronized map owns the exact channel/path/attributes. A separate retired-identity set makes repeated operations/close fail explicitly; it is cleared only between tests after asserting all owned channels were closed. No fake descriptor reaches a native syscall.
4. `fstat` on a live owned handle rechecks the opened path's actual host directory attributes and returns a directory-mode StructStat consistent with them. It does not assert Android metadata. Type or path mismatch refuses. Production's directory type check remains active.
5. `fsync` on a live owned handle invokes actual `channel.force(true)`; IOException propagates as ErrnoException. Record the completed operation only after force succeeds.
6. `close` closes that exact host channel, records/retire the handle only after ownership bookkeeping, and propagates any failure. Owned stale/fake handles never fall through to unrelated OS descriptors. Cleanup drains/removes only test-owned channels and reports a leaked handle as a test failure; it cannot make the production operation successful.

Test-only controls may request one deterministic failure at `open`, `fstat`, `fsync` or `close` for an exact registered directory. Fail before claiming success; if a close-failure test must also release its host test resource, it does so in explicit cleanup after the journal refusal. Tests assert no generation fence/metadata/consent receipt escapes the corresponding failure and check durable database state afterward. Controls and operation records reset between tests. No production injection shortcut skips directory synchronization.

Add a direct fixture prerequisite that opens a real temporary directory through the unchanged production Os sequence, observes directory mode, forces/closes it, and verifies expected flags and completed operations. Include a non-directory delegation control to the existing Robolectric implementation and a stale-handle/refusal control. Continue to run actual API33 NATIVE SQLite for all journal mutations and reopen checks.

This is real host FileChannel directory-force evidence plus actual host SQLite transaction/reopen evidence. It is not Android Os/JNI execution, handset directory-fsync, storage power loss, Android process lifecycle, KeyStore, biometrics or custody proof. The ordinary APK still contains only fixed Android Os production calls. Those physical/platform gates remain open. A failure of the proposed host adapter itself is retained and reviewed; never turn it into a no-op success.

Root precision: retain the host NOFOLLOW file identity (`fileKey`) captured at
open and require the same non-null identity on later path checks. Replacement,
missing identity or symlink changes refuse, rather than describing a replacement
path as the opened directory. This remains a test fixture, not a claim that a
path-stat is native fstat. Add a deterministic path-replacement refusal control.


## Orphan rollback journal refusal — 2026-09-07 UTC

Root adopts the reproduced missing-database boundary: when the fixed rollback
journal exists but identity.sqlite3 does not, WitnessPaths validation must return
`incomplete_store` before any creating helper or writable SQLite open. Observation
and explicit prepare both retain the orphan journal and directory bytes unchanged.
It is retained evidence of incomplete storage, not a fresh identity. A lone valid
coordination lock remains compatible with Missing and explicit prepare; no lock
unlink, reset, recovery-generation attempt or provider call is added. Preserve the
public RED and require read/prepare refusal plus byte-for-byte tree retention.


## Verified journal component — 2026-09-07 UTC

Frozen source `07f536ae21499e5867f54216dc2e951f6a9307fe` passed independent
gpt-5.6-sol review after repairing distinct enrollment admission. Exact existing
enrollment retries stay idempotent; a new enrollment requires generated_unvalidated
metadata. Prepared/started refusals preserve database bytes, rows, revision and the
original usable generation fence. Actual RED evidence reproduced both incorrect
admissions before the guard.

The final Android test run discovered37 tests:36 passed, zero failures/errors,
and one parent-only subprocess entry was skipped. That fixture actually executed
in two child JVMs for durable started-fence and hot-journal controls. Lint passed;
buildSrc tests passed. The original full Rust gate passed12 tests and two compile-fail
tests, and the narrow repair's binding/compile-fail/fmt gates passed. Shell tests,
typecheck and build passed. Root's final serialized mix check passed810 tests and
27 properties with zero failures, three exclusions, clean formatting and strict
Credo exit0. Logs and immutable manifests are retained in the execution directory.

The rebuilt arm64 debug APK verifies with SHA256
`ddaed60f6a87022bce4525da0038b0c7f9809dd40fa625c67df47ac1da4c9607`.
Missing-signing-input release prebuild correctly refuses. The prior c851 APK and
source snapshot remain separate recovery evidence. A first build used mismatched
Homebrew/Rustup compilers; its failure remains recorded and the successful build
used only the task-local matching Rust1.93.1 toolchain.

These are host tests and an actual APK build. The Os test fixture uses real host
FileChannel directory forcing and API33 native SQLite; it does not prove Android
JNI/syscall behavior or handset power-loss durability. A hot rollback journal
returns the generic storage_io_error refusal and preserves bytes; no distinct
hot-journal reason or automatic recovery is claimed. No witness IPC/plugin,
KeyStore generation/signature, native review, biometric operation, validator,
device eligibility or R14 pin has been enabled by this component. Stage2A's
provider-invocation gate continues in2B; R36 remains IN PROGRESS.
