# R36 Stage 1: provider-owned governance custody

Prepared 2026-09-06. **Stage 1 scope adopted; implementation and gates pending;
no profile enablement.** This document makes [Stage 1 of the native witness build](treehouse-native-witness-build-2026-09-06.md#stage-1-opaque-generation-and-signing-seam-r36)
concrete. It does not close R36, R17b, R17c, R12 or their hosted gates.

## Exact preparation base and dependencies

Worktree: `/Users/nicholas/develop/lattice-treehouse-r36-provider-20260906`;
branch: `codex/treehouse-r36-provider-20260906`.

| Input | Exact source and disposition |
| --- | --- |
| R12 implementation/integration | Start at `6439daa3247030572af00ab7d350630832ac4d04`. R12 review corrections are independently owned; this document makes no changes to its shell or storage. |
| R17a final decision | `443c6a131577fe2ea24da608d34bb083f13c47cc`, inherited through the next input. |
| Android eligibility correction | `da519123724b3b70c44c16408846845bc7c584d0`, actual exact-diff Claude Fable PASS. Automatic merge `5f80d83a`; no runtime changes. |
| R01b adopted native scope | `258cb3d0ba7ca3b12b35e808af082db729015e54`, automatic merge `ee888759ea1bbc41ff5abfe39fcc18bc9da463a8`. |
| Stage 1 preparation source | Clean `ee888759ea1bbc41ff5abfe39fcc18bc9da463a8`; the only subsequent proposed change is this document. |

The integrator must supply accepted R12/R01b/R17a dependency closure before
enabling the implementation packet. Their presence in this local branch is not
hosted acceptance. The integrator owns README, unified ledger, workflow changes,
final dependency merges and status claims. R11a and the active R12 corrections
remain frozen or owned by their respective lanes.

Read alongside the [R17a decision](../../docs/research/governance_witness_native_verification.md),
[R01b scope evidence](evidence/treehouse-r01b-2026-09-06.md),
[Plan 146 custody contract](../146-witnessed-succession-witness-artifact-g1.md#dedicated-governance-custody)
and [Plan 158](../158-real-device-beta-poc-program-map.md). The user's adopted
program authorizes this preparation. Implementation starts only after the
integrator adopts this exact interface/file/test amendment; no further generic
user permission is inferred from the older Plan 146 workflow wording.

## Current behavior that must survive

Paths in this section are relative to `clients/township-tauri-shell/src-tauri/`.

`src/lib.rs` currently exposes `GovernanceWitnessKeyStore` and
`GovernanceWitnessPresence`. `TownshipNativeState` generates an Ed25519 seed in
`ensure_governance_witness_key`, passes it to `create_seed`, and obtains it again
through `load_seed` in `sign_governance_witness`. The state, rather than the
provider, owns creation/signing mutexes and public-sidecar reconciliation.

`src/macos_governance.rs` uses create-only `SecItemAdd`, protected data-protection
Keychain queries and separate public metadata. The protected item carries a
presence-free public-key identity attribute. Its current `authorize` merely
queues a reason; actual user authentication happens when the protected seed is
read with a fresh `LAContext`. Authentication reuse duration is zero. Secret
bytes enter macOS native memory; they are not hardware-opaque there.

`src/test_governance.rs` is a deterministic, trace-loud packaged test provider,
compiled only behind the existing test-presence/dev-trace restrictions. It
provides no OS-presence evidence. The ordinary macOS builder binds the protected
provider; other ordinary platforms currently have no governance provider.

Preserve the following public and persisted contracts:

- The three IPC names, argument shapes and result shapes:
  `lattice_ensure_governance_witness_key`,
  `lattice_governance_witness_public_key`, and
  `lattice_sign_governance_witness`. They take no key ID, service, account,
  caller-provided prompt or arbitrary signing bytes.
- `GovernanceWitnessSignature` still serializes exactly `witness`, `signature`
  and `payloadDigest`; the existing strict Base64 and digest encodings survive.
  Existing public error messages and the coarse cancel/unavailable/failed
  authentication mapping remain stable.
- The existing seven-field legacy clerk parser and canonical domain
  `lattice-succession-witness-v1`, including both independent byte oracles.
  Accepted replica strings do not gain new restrictions in this migration.
  The OS reason remains exactly `Sign Township clerk recovery witness`.
- Service `dev.treetop.lattice.township.governance-witness`, accounts
  `governance-witness-v1.seed` and `governance-witness-v1.public`, and identity
  attribute prefix `township-governance-public-key:`. No migration, overwrite,
  alias substitution, export, import, identity rotation or additional key record.
- Existing Keychain flags, device-only unlocked accessibility, fresh protected
  access on every signature, metadata agreement, and carrier/witness alias
  separation. No governance key enters the carrier signing-key cache or KV.
- Public reads do not create, request presence, read secret bytes or repair an
  incomplete identity. An ordinary unsupported platform still refuses.

This is custody ownership and purpose confinement, not native semantic
authorization. The existing clerk command still validates a supplied syntactic
claim. Native authenticated history, role/policy derivation, review tokens and
authorization are R17b work. A validated Stage 1 request must never be named or
reported as an authorized recovery claim.

## Proposed interface

Add `src/governance_provider.rs`. Replace the two public seed/presence traits
with this single trusted native injection seam:

```rust
pub trait GovernanceWitnessProvider: Send + Sync {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind;
    fn load_public_identity(&self) -> Result<Option<[u8; 32]>, String>;
    fn ensure_identity(&self) -> Result<[u8; 32], String>;
    fn sign_legacy_clerk(
        &self,
        request: &LegacyClerkSigningRequest,
    ) -> Result<GovernanceWitnessSignature, String>;
}
```

Only public keys cross the `[u8; 32]` methods. No seed-returning, seed-importing,
caller-selected handle, generic sign, delete or reset method exists on this
trait. `ensure_identity` means strict get-or-create: existing complete identity
returns unchanged, missing identity may be created, incomplete/corrupt identity
refuses. It is not a replacement-key API.

`LegacyClerkSigningRequest` is a public type with private, immutable payload
fields and a fallible constructor from `&serde_json::Value`. Construction calls
the existing `canonical_governance_witness_payload` unchanged. A read-only byte
slice/digest accessor may serve provider implementations; there is no mutable
accessor, public struct-field constructor, `Deserialize`, `Default`, unchecked
constructor, or conversion from arbitrary bytes/canonical-payload objects. Thus
the existing public, mutable `CanonicalGovernanceWitnessPayload` cannot be used
to manufacture a signing request. Exposing already-public canonical bytes for
verification does not add a bytes-signing entry point.

The only request purpose is legacy Township clerk. Do not pre-add generic role
strings, beacon, continuation, final-op or binding-challenge variants. Each later
purpose needs its adopted closed encoder, verifier and tests. The provider
chooses its fixed native identity and fixed reason; a claim cannot choose either.

`TownshipNativeState` holds `Option<Arc<dyn GovernanceWitnessProvider>>` and gains
`with_governance_witness_provider` for trusted native tests/construction. It
parses the request before calling the provider, translates public-key encoding
and missing identity into the unchanged IPC responses, and delegates creation
and signing. Remove the old public injection constructors and traits instead of
retaining a seed adapter in the governance caller. This is an intentional local
Rust injection-API change, not an IPC change; repository reference audit finds
the consumers only in `lib.rs`, `macos_governance.rs`, `test_governance.rs` and
`tests/governance_witness_custody.rs`.

`provider_kind` keeps the existing enum and means configured provider capability,
not actual identity existence, hardware eligibility or readiness. A read-only
injected provider can preserve the absent-presence test by refusing signing with
the existing presence-unavailable error and reporting `Unavailable` for complete
custody binding. Ordinary release construction remains fixed inside the shell;
webview input cannot inject a provider. This trait is not a security sandbox
against arbitrary trusted Rust code implementing a dishonest provider.

## Private macOS implementation and ownership

Inside `governance_provider.rs`, a private/crate-private legacy seed provider
owns the existing get-or-create/reconcile/sign state machine. Its private backend
interface may expose the existing seed operations solely to the macOS adapter
and test implementation. No backend or seed operation is re-exported from the
crate. Generation occurs inside this provider, never in the governance methods
on `TownshipNativeState`.

The backend combines protected access with authentication in one internal
`authorize_and_load_seed` operation. It receives only the fixed native reason.
For macOS it creates the fresh `LAContext` and queries the existing protected
item; there is no caller-visible queued reason, reusable authorization boolean
or two-stage authorize/load protocol. The packaged deterministic provider traces
and increments its existing authorization counter at the equivalent operation.
Its public key, signature bytes and feature restrictions remain unchanged.

Move the two mutexes into the provider. Calls sharing one provider instance
serialize creation and signing separately, as today; distinct provider/process
instances still rely on atomic Keychain duplicate-item behavior, not on a Rust
mutex or cached public identity. Do not add a global serialization/presence cache.
The existing post-authentication comparison derives the actual public key from
the accessed seed and compares both public metadata records before releasing a
signature. Drop temporary seed/key values at the end of each call. This does not
claim memory zeroization or opaque hardware custody for the macOS implementation.

| Observed state or boundary | Required provider behavior |
| --- | --- |
| Both records absent | Explicit ensure may generate/create once. Public read/sign never invokes ensure. |
| Both public identities present and equal | Ensure/public read return the same key without protected access. Signing rechecks actual protected-key agreement after fresh authentication. |
| Protected metadata only, sidecar only, malformed metadata or mismatch | Refuse without overwriting or repairing. Retained evidence of an existing identity prevents replacement. |
| Concurrent first creation | Only the `SecItemAdd` winner owns the new seed write. Duplicate loser returns the same complete winner or the existing bounded reconciliation error; it creates/deletes nothing. |
| Winner has not yet written its sidecar | Preserve the existing duplicate path's 500 ms deadline and 10 ms polling interval. An ordinary ensure that initially observes incomplete metadata remains an explicit refusal. |
| Seed creation fails before insertion | Return the existing error; no sidecar attempt. |
| This call creates seed, then sidecar write fails | Only this call's unpublished first-creation seed may be rolled back through the private backend. Preserve the original creation error and combined rollback error. No public cleanup/reset API. |
| Cleanup fails or process dies between writes | Retain an explicit incomplete state; restart refuses and does not manufacture a replacement identity. Do not call this zero native writes. |
| Process dies after both writes, before response | Restart returns the same complete identity. No extra creation or authentication. |
| Cancel, unavailable, lockout or protected-read failure | Preserve coarse existing errors; no signature/result artifact or artifact-KV write; no creation or retry with another key. |
| Identity metadata changes during protected access | Post-access comparison refuses before releasing a signature. No stale cached public-key fallback. |

Rollback authority depends on the successful create-only insert in the current
attempt; a duplicate response or ambiguous backend error never establishes
ownership. No cleanup of preexisting, pinned or merely observed incomplete keys
is authorized. Failure injection must distinguish failure-before-write from an
ambiguous response after a durable write: the latter remains incomplete or
reconcilable through subsequent explicit read/ensure, never deleted on a guess.

Preserve an existing limitation explicitly: if an external actor removes both
Keychain records, this legacy two-record store cannot distinguish that loss from
first use. A later explicit ensure can create, while public read/sign still
cannot. Stage 1 adds no third pin/tombstone record or rollback-resistant storage
and must not claim detection of complete external deletion or old-store replay.
The later product binding/history contract must refuse a missing key for an
already pinned identity; it must not call ensure as automatic recovery. Expanding
that persistent binding into Stage 1 would require a separate concrete amendment.

## Exact file ownership for the proposed implementation

All paths below start at the repository root. This is the complete Stage 1 write
allowlist; additions require a concrete amendment before editing.

| File | Allowed change |
| --- | --- |
| `clients/township-tauri-shell/src-tauri/src/governance_provider.rs` (new) | Opaque trait, sealed legacy request, private legacy provider/backend and state-machine helpers; compile-fail API examples. |
| `clients/township-tauri-shell/src-tauri/src/lib.rs` | Provider module/re-exports, state field/constructor/builder wiring and delegation; remove caller-owned governance seed/generation/reconciliation and two-phase presence interface. Keep unrelated carrier use of `SigningKey` intact. |
| `clients/township-tauri-shell/src-tauri/src/macos_governance.rs` | Implement private backend/opaque provider assembly; move the fresh-context protected read under the single typed call. Preserve accounts, service, flags, error mapping and real OS behavior. |
| `clients/township-tauri-shell/src-tauri/src/test_governance.rs` | Implement the same opaque interface/private backend under existing feature guards; preserve deterministic key, trace and authorization counter. |
| `clients/township-tauri-shell/src-tauri/src/governance_provider_tests.rs` (new, `cfg(test)` only) | Move private seed fault fixtures and their complete behavior assertions here; exercise the production provider through public state/IPC seams. Add deterministic interleaving and crash-state controls. |
| `clients/township-tauri-shell/src-tauri/tests/governance_witness_custody.rs` | Keep external public IPC, parser, alias, result and opaque-injection checks; port injection constructors. Move only assertions needing private backend access as described below. |
| `clients/township-tauri-shell/src-tauri/tests/governance_release_binding.rs` | Preserve ordinary release binding assertions; adapt only any required provider construction references. |
| `clients/township-tauri-shell/src-tauri/tests/governance_test_presence_probe.rs` | Preserve trace-feature preflight/public-key assertions; add or adapt opaque-provider wiring evidence only. |
| This preparation document | Record adopted interface, RED/GREEN, review, exact source and local/hosted limitations. |

`src/governance_witness.rs`, `tests/governance_witness_payload.rs`, all canonical
fixtures and all TypeScript bridge/serialization files remain byte-identical.
No Cargo dependency, version, lockfile, package-script or feature addition is
expected. Existing hosted `cargo test` executes new private unit tests and
compile-fail doctests. Existing release-binding and packaged witness steps remain
required; root owns any necessary workflow adjustment.

The narrow test-organization amendment is necessary to remove the **public**
seed-store API rather than preserving it just for integration fixtures. Before
moving any test, record its original name, all assertions and destination. Tests
of failure, restart, concurrency and actual signing must run the real private
production state machine through `TownshipNativeState` methods or registered
mock-runtime commands; an opaque mock returning canned results is insufficient
for those assertions. The private backend remains the injection point for
storage/authentication failures, not an alternate implementation of the algorithm.
External opaque mocks may test only caller wiring, shape and non-dispatch.
Preserve all original behavioral assertions, byte constants and protected pins.

## Public RED/GREEN and regression matrix

Capture each RED on a public boundary before its implementation. Existing
behavior controls that already pass are characterized controls, not invented REDs.

| Slice | Meaningful RED / negative control | GREEN evidence and retained control |
| --- | --- | --- |
| Opaque ownership | External compile-fail contract rejects old public seed methods and direct construction/mutation of a typed request; a positive opaque provider compiles and works through the state. First demonstrate the old API is currently reachable. | No seed argument/result on the governance provider/state methods; a provider with no seed-export method can ensure, read and sign. Seed generation/load lives only in the private legacy implementation. Source inspection supplements, rather than replaces, behavioral tests. |
| Closed purpose | Extra `bytes`, `keyId`, prompt or non-clerk claim refuses before provider dispatch; a freely mutable canonical payload cannot become a signing request. | The same valid seven-field claim produces the existing exact payload/digest/signature; malformed request makes zero provider/auth/storage calls. |
| Identity lifecycle | Missing, malformed, both incomplete directions and mismatched public facets; failure before/after each native write; acknowledged response lost; restart and repeated ensure. | One public identity, no silent repair/rotation, stable no-presence discovery, exact write/delete/secret-read counts and preserved first-creation failure errors. |
| Creation races | Barrier-controlled competing providers, delayed winning sidecar, duplicate loser, winner disappearance/rollback and reconciliation exhaustion. | Every successful call returns the single winner; loser never writes/deletes. Test scheduling uses barriers/notifications, not filesystem sleeps. Retain the bounded production timeout. |
| Signing | Two calls, cancellation then retry, unavailable/lockout, missing protected seed, post-auth sidecar/key substitution; simultaneous distinct claims on a shared provider. | One fresh protected authentication per successful attempt; no reason/authorization transfer between calls; both signatures bind their own exact payload and the same stored identity. All refusals produce no signature and leave KV/carrier cache unchanged. |
| Alias isolation | Existing carrier ensure/load/sign cannot select governance alias; governance input cannot select carrier identity, service or account. | Witness signature verifies under the separate fixed witness key; ordinary carrier operations retain their existing behavior and cannot receive a governance signature. |
| Release/test separation | Unsupported platform, absent-presence injected backend, ordinary macOS binding and invalid feature combination. | Ordinary builder reports protected provider without reading Keychain; deterministic provider appears only in the existing allowed test build and keeps its preflight key/counter/trace. |
| Existing product result | Existing TS bridge rejects wrong key, digest, signature and extra result fields; packaged test-presence ceremony reopens the same artifact. | Unchanged BEAM/TS/Rust fixed payload oracles, existing artifact export and packaged choreography. Neither injected nor packaged test presence becomes real OS-presence evidence. |

Compile-fail checks must fail for the intended inaccessible method/constructor,
not a misspelled import or unrelated error. Keep positive public API examples in
the same gate. The old callable API's demonstrated reachability is the ownership
RED; an initially absent new symbol alone is not sufficient behavioral evidence.

## Commands and closure evidence

After adoption and implementation, run focused RED/GREEN from
`clients/township-tauri-shell/src-tauri`:

```sh
cargo test --locked --lib governance_provider
cargo test --locked --test governance_witness_custody --test governance_witness_payload
cargo test --locked --test governance_release_binding
cargo test --locked --doc
cargo test --locked --features township-dev-trace,township-governance-test-presence --test governance_test_presence_probe
cargo fmt --all -- --check
cargo test --locked
```

The release-binding command is meaningful on macOS without the test feature and
does not create/read a real key. Preserve the existing compile-time refusal for
test-presence without dev-trace; capture that expected compile failure separately
from successful test runs. Use independent worktree build output, existing locked
dependencies and serialized native gates as needed; no dependency installation is
part of this preparation.

From `clients/township-tauri-shell`, run existing `npm run runtime:wiring:contract`,
`npm run governance:native:contract`, `npm run witness:artifact:contract` and
`npm run witness:preflight:contract`. Root schedules the existing packaged
test-presence build/`tauri:witness-ceremony:smoke`, integrated OTP 28 `mix check`
and exact-tip hosted flagship gates. The packaged build is synthetic UX/IPC and
signature-parity evidence. Any new claim about real macOS authentication requires
separate user-side OS authorization and an appropriate retained-record probe;
this design and automated tests supply no such new platform evidence.

Before closure: preserve an assertion-migration inventory, exact RED/GREEN logs,
unchanged payload/oracle diff proof, default and test-feature results, source
ownership diff, `git diff --check`, actual exact-diff Fable review and root-owned
hosted status. Preparation validation is limited to source inspection, document
links/whitespace and design review; no runtime tests have been run for this
document, and no implementation result is claimed.

## Android and Treehouse handoff remains Stage 2

The R12 Treehouse shell is at
`clients/treehouse-tauri-shell/src-tauri/src/lib.rs`, with its carrier identity
in `src/key_store.rs`, preview persistence in `src/preview.rs` and UI workflow in
`clients/treehouse-tauri-shell/src/treehouse_workflow.ts`. It currently registers
only offline preview/carrier commands and no governance provider. These files,
shared mobile-core storage, `products.json` and all Android source remain outside
Stage 1's write scope. The Treehouse carrier seed store is not a witness adapter.

Stage 1 keeps provider types local to Township because no second platform uses
them yet. Stage 2 must record its actual Android plugin/Kotlin/Rust bridge and
product-bound shared-type paths before editing, using the existing Township
Android plugin precedent. It may extract the opaque types when required, but may
not reuse the private legacy seed backend. Its generation and signing occur in
AndroidKeyStore/KeyMint; no Android seed is generated, loaded, exported, imported
or passed through Rust. The current synchronous Township trait is not an adopted
Android UI threading contract: a later asynchronous prompt/plugin bridge must
keep operation ownership and key-bound authentication without blocking the UI
thread or turning a prompt result into reusable authorization.

Apply the reviewed [Android eligibility correction](../../docs/research/governance_witness_native_verification.md#android-eligibility-and-evidence-order):
TEE Curve25519/SIGN-only/DIGEST_NONE, actual-key per-operation authentication and
attestation, original generation challenge/chain persistence and fresh possession
on retry. StrongBox Ed25519 and software seeds are not fallbacks. Generation-time
attestation does not prove current OS/app/boot state. No physical-device
eligibility, enrollment, attestation, trusted binding, recovery readiness or R36
completion follows from this Stage 1 interface migration.

## Dated adoption and assertion migration inventory — 2026-09-06

The integrator read and adopted exact proposal `a54995663a932a0e712f386a430cf672eedd61d0`
after actual Claude Fable design PASS (session
`44399fee-f1ed-43d3-a9f5-d459490e65b1`). No P0/P1 were found. The exact interface,
write allowlist and test move above are adopted; private-branch implementation
may proceed while dependency/hosted enablement remains gated. This adoption and
inventory are committed before the first production edit. Full implementation
RED/GREEN and a new exact-diff Fable review remain required.

Original custody test source is the Git object at `a5499566`:
`clients/township-tauri-shell/src-tauri/tests/governance_witness_custody.rs`,
SHA-256 `9376143de36b854156e624f9c40413c830ed0eb624bf1e35fcab5679b2638a09`.
It contains 14 tests and 85 source assertion invocations (loop cases exercise
additional outcomes). Counts are an inventory aid, not proof of equivalent tests.
Every literal byte/digest/error expectation and behavioral check must survive.
`external` below means that same integration-test file; `private` means the new
`src/governance_provider_tests.rs`, with tests still driving the actual production
provider through public state/IPC seams.

| Original test name | Assertions | Destination and preserved behavior |
| --- | --- | --- |
| `governance_commands_are_separate_and_fail_closed_without_a_provider` | 8 | external: all four carrier-alias refusals, all three registered governance IPC refusals and empty KV. |
| `governance_ensure_creates_one_paired_identity_and_reuses_it_after_restart` | 8 | private: 32-byte public identity, repeated ensure/read/restart equality, exactly one seed/sidecar creation, no secret material release. |
| `governance_public_key_read_is_presence_free_and_never_creates_custody` | 3 | private: exact missing-identity error, zero writes and zero secret material release. |
| `governance_ensure_rejects_incomplete_or_mismatched_identity_pairs` | 3 | private: all three fixture cases retain their exact errors, zero writes and zero secret material release. |
| `governance_first_creation_is_rollback_safe` | 11 | private: seed failure, sidecar failure/owned cleanup, cleanup failure and subsequent incomplete refusal; exact errors/items/delete counts. |
| `concurrent_governance_ensure_calls_share_one_creation` | 5 | private: both successful results equal, one pair, zero deletes and zero secret material release. |
| `duplicate_seed_creation_reconciles_to_the_cross_state_winner` | 5 | private: distinct provider/state instances return the same winner, one pair, no loser deletes or secret release. |
| `duplicate_seed_creation_waits_for_the_cross_state_winner_sidecar` | 5 | private: same assertions through controlled pending-sidecar interleaving; use barriers/notifications rather than timing-dependent delays. |
| `governance_signing_requires_fresh_presence_and_seed_access_each_time` | 8 | private: unchanged public key, digest, two identical exact signatures independently verified, two protected material releases, zero writes, two fixed reasons and empty KV. |
| `governance_presence_reason_cannot_be_shaped_by_submitted_replica` | 5 | private: all six hostile strings preserve the constant reason, cancelled error, zero material release/writes and empty KV. |
| `governance_signing_refuses_cancel_unavailable_and_malformed_without_writes` | 10 | private: all three coarse outcomes, exact reason counts, no released seed/signature/writes/KV; malformed claim makes no authentication call. Add external opaque-provider non-dispatch controls. |
| `governance_signing_fails_closed_when_presence_provider_is_not_bound` | 4 | external: read-only opaque provider preserves the public error and zero sign-result/write/secret-release observations. Reclassified as caller wiring, not proof of the removed two-provider production branch. |
| `governance_signing_rejects_seed_identity_or_sidecar_mismatch` | 5 | private: all three mismatch fixtures fail after one auth/material release, exact mismatch error, no writes and empty KV. |
| `governance_signing_names_missing_public_identity_facets_after_seed_access` | 5 | private: all three missing-facet fixtures retain exact errors, one auth/material release, no writes and empty KV. |

Fable's three P2 dispositions are explicit before implementation:

1. The absent-presence external mock checks caller wiring/shape only. Real
   unavailable, cancel and lockout refusal remains covered through the actual
   production provider's private backend and coarse error mapping.
2. Replace the fixture's `secret_read_count` terminology with a counter for
   successful release of seed material to the private provider. Refusal must
   leave that count at zero and must produce no signature. Record authentication
   attempts separately. Real macOS has one protected Keychain query, not two
   independently proven OS phases; no test may claim otherwise.
3. Demonstrate the existing public seed API is callable at the baseline. Its
   subsequent removal deliberately produces an unresolved-symbol diagnostic for
   that exact formerly callable symbol, paired with a positive new opaque API
   compile/run control. Separate compile-fail examples prove private backend and
   request construction/mutation are inaccessible for the expected reason. Do
   not count an unrelated import typo or an absent new symbol alone as the RED.

The complete-external-deletion limitation and prohibition on automatic ensure for
a later pinned missing identity remain unchanged. No new Android purpose, seed
fallback, device claim or additional persistence schema is adopted. Canonical
payload files/fixtures and the TypeScript bridge remain byte-identical.

First ownership RED: `cargo test --locked --offline --doc GovernanceWitnessKeyStore`
exited 101 with the intended failure, **"Test compiled successfully, but it's
marked compile_fail"**. The external example calls both `create_seed` and
`load_seed` on the real public trait; it needs no device or real key. Log:
`/tmp/lattice-treehouse-execution-20260906/r36-public-seed-api-red.log`.
The exact example will remain as a removal regression alongside the new positive
opaque interface and private-construction controls. Existing locked dependency
build output was independently cloned from the native-prompt worktree; an
existing ignored frontend dist was copied only to satisfy Rust's Tauri build
input, not as packaged UX evidence. No dependencies or devices were installed.
