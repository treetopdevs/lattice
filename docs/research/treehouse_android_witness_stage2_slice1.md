# R36 Stage 2, slice 1: Android bootstrap and binding bytes

Status: **locally implemented and verified; independent implementation review
and hosted closure pending. R36 Stage 2 remains in progress.**

Prepared before implementation on 2026-09-06 under the adopted Stage 2 boundary
at `833cbccad89fdedd67a6d73418c2736af3be72bc`. This packet remains incomplete
until its recorded source and build gates pass. R36 Stage 2 remains in progress.

## Exact implementation scope

- Generate the new Treehouse Android scaffold with locked Tauri CLI 2.11.4;
  retain Tauri 2.11.5, AGP 8.11.0, Kotlin 1.9.25, Gradle 8.14.3, SDK 36,
  min SDK 24 and NDK 27.1.12297006. No device command is part of this slice.
- Add the mobile entry point and separate existing carrier-store bootstrap.
  The only new production dependency pair is Android-only
  `android-native-keyring-store = 1.0.0` and `keyring-core = 1.0.0`, matching the
  existing Township bootstrap. Carrier custody remains seed-backed with its
  unchanged Treehouse service and alias; no witness backend is constructed.
- Derive Android application/package constants and the permitted pilot alias
  from the literal Treehouse row of `clients/lattice-mobile-core/products.json`.
  Preserve the table, existing six IPC commands and product-contract test.
  Default debug builds are explicitly ineligible for witness/device closure;
  release packaging requires exact Treehouse pilot configuration and refuses
  absent, ambiguous or cross-product settings. No dev-smoke release fallback.
- Implement the adopted fixed 13-field claim as a pure Rust/TypeScript/Kotlin
  canonical byte interface. Validate exact fixed product/domain, field widths,
  replica UTF-8 and 512-byte bound. Cross-runtime fixtures use public synthetic
  material and BEAM's existing canonical encoder. Encoding proposed public
  facts does not grant permission to sign them.
- Define a Rust signing-request type with private owned fields and no public
  constructor/deserializer or mutable-byte accessor. No production constructor
  exists until a later slice provides actual native enrollment/session state.
  No signing function, successful provider stub or witness IPC is exposed.

## File clarification before edits

In addition to the adopted table, edit the shell's existing `.gitignore` for
generated Android build/cache paths. Add `src/witness_binding.ts` and
`test/witness_binding.ts` for this pure byte seam rather than prematurely adding
the later `witness_adapter.ts` bridge. Add `test/android_contract.mjs` for
scaffold/product/refusal assertions. Wire these tests through the existing
package test script without changing the six-command product test.

The adopted new `src-tauri/src/witness_binding.rs`, Rust binding tests, Kotlin
`witness/BindingCodec.kt` and unit tests, fixture
`test/fixtures/witness_binding_v1.json`, and BEAM byte-oracle test own byte parity.
Generated Android build configuration and source/tests may include small pure
product/signing-configuration helpers under the new project's `buildSrc`.
The default template's unimplemented Android TV/Leanback launch advertisement is
removed: this slice targets the reviewed handset profile and supplies no TV
banner or remote-control interface. Lint remains enabled without a baseline or
suppression. Generated webview and dependency-version warnings remain visible.
No shared client/Core implementation, Township source, workflow, source plan,
README or unified ledger is edited.

## Gates and remaining work

Capture meaningful public byte/shape RED before implementation, then run the
BEAM oracle, Rust pure/compile-fail tests, TypeScript byte and existing shell
tests/typecheck/build, Android unit/lint and debug APK build. Preserve build
failures and exact tool versions. A checksum-verified JDK 17 may be installed
under this task's temporary tooling directory; no global tool configuration
changes. Full Mix requires the shared slot and is outside this initial gate.

Protected generation, enrollment journal, presence/CryptoObject signing, private
mobile plugin, exact five IPC commands, setup UI, independent attestation
validator, physical eligibility and final R17c ceremony remain later slices.
No build or test result substitutes for any of those gates.

## Local implementation evidence, 2026-09-06

Source checkpoint: `42338ed8984eab2c17d4b7edcdf5a678763ff293`, following the
scope commit `a2be629a`, TypeScript behavioral RED `6c0b761e`, its GREEN
`0cc9e2b3`, and Rust behavioral RED `4b505f20`. Both REDs compared a callable
empty encoder against independently signed BEAM fixed-array bytes and failed
for the expected byte mismatch. Shape controls already passing were retained.
The final source implements both encoders, and the Kotlin implementation
matches the same independently generated public fixture.

| Gate | Actual local result |
| --- | --- |
| BEAM canonical oracle | `mix test apps/lattice_core/test/treehouse/witness_binding_bytes_test.exs`: 1 test, 0 failures. Three public fixtures cover ASCII, exact Unicode/BOM/combining characters, and the 512-byte UTF-8 boundary; all 13 signed-field substitutions refuse. |
| Rust native shell | `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 12 integration tests plus 2 compile-fail documentation tests, 0 failures. Existing preview commands/storage and new binding bytes pass; sealed requests cannot be constructed or deserialized by callers. |
| TypeScript shell | `npm test`, `npm run typecheck`, `npm run build`: exit 0. Existing workflow/storage and unchanged exact-six-command product contract pass. New three-fixture byte/signature gate includes 27 field substitutions, Buffer-free operation, returned-copy isolation and closed shape/Base64/UTF-8 refusals. |
| Kotlin binding | `:app:testUniversalDebugUnitTest`: 2 JVM tests, 0 failures. Exact BEAM bytes, independently checked Ed25519 signatures, mutable-input/output isolation and invalid shapes pass. This uses JVM public signature verification, not Android private-key custody. |
| Build-time product/signing rules | `./gradlew -p buildSrc test`: 2 JVM tests, 0 failures. Fixed manifest/tauri identity, cross-product refusal, exact alias, missing credentials, invalid versions and forbidden release modes tested without accessing a keystore. |
| Android lint | `:app:lintUniversalDebug`: exit 0, **0 errors, 37 warnings, 1 hint**. Existing generated webview, version and resource warnings remain; no lint baseline/suppression was added. |
| Final Android APK | Locked Tauri `android build --debug --apk --ci --target aarch64`: exit 0 at the source checkpoint above. Includes only `arm64-v8a`, fixed package `dev.treetop.lattice.treehouse`, version `0.1.0`/1000, min SDK 24, target/compile SDK 36. |
| Actual release refusal | `:app:preUniversalReleaseBuild` exits 1 at `verifyTreehouseReleaseIdentity` with `Treehouse release requires explicit pilot signing`. This is the intended negative control, not an unclosed build failure. No release artifact was produced. |
| Preservation and formatting | Rust formatting, focused BEAM formatting, `git diff --check` pass. Entire shared client, shared mobile core/product table, Township shell and existing Treehouse product-contract test are byte-unchanged from `833cbcca`; no old vector was regenerated or edited. |

The final debug APK SHA256 is
`e0992bfb7aa9dda296ccfaf0c48a2c8294df1ce386accbaa0da5d46c08d043d3`
(278,452,969 bytes including debug symbols). `apksigner verify` passes with one
Android Debug signer; its public certificate SHA256 is
`5c5ee033b521ff3977d95df8f9d866377e3d364f8cdb4dbe84527d5fd670c342`.
This is an explicitly debug-signed compile artifact, not a pilot candidate,
witness key, attestation result, size/performance profile or physical proof.
The generated build config keeps witness eligibility unimplemented/false.

Reproduction needs the actual installed Rust toolchain path: local Homebrew
`cargo`/`rustc` 1.98 lacks the Android target; `~/.cargo/bin` symlinks point to a
missing rustup executable. The successful Android gate uses the already installed
Rust/Cargo 1.93.1 directly, without repairing global configuration:

```sh
PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" \
RUSTC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc" \
JAVA_HOME='/tmp/lattice-treehouse-execution-20260906/tooling/jdk-17.0.20.1+1/Contents/Home' \
ANDROID_HOME="$HOME/Library/Android/sdk" \
NDK_HOME="$HOME/Library/Android/sdk/ndk/27.1.12297006" \
CARGO_BUILD_JOBS=4 npm run tauri -- android build --debug --apk --ci --target aarch64
```

The task-local official Eclipse Temurin JDK archive is pinned to
`OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz`, verified before extraction
against its official SHA256
`196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8`.
Its upstream release metadata is retained with the logs. The Adoptium metadata
endpoint returned HTTP 403; the official `adoptium/temurin17-binaries` GitHub
release and checksum were used instead. No global Java, Rust, Gradle or SDK
configuration was changed. BEAM gates used asdf OTP 28/Elixir 1.19.5 and `+S 4:4`.

Logs and artifact metadata are retained under
`/tmp/lattice-treehouse-execution-20260906/`: `r36-binding-{ts-red,ts-green,rust-red,rust-green,beam-test}.log`,
`r36-{rust-native,shell-test,shell-build}-final.log`,
`r36-android-{debug-final,product-test,unit-lint-final,release-refusal,apk-signature,apk-badging}.log`
and `r36-android-slice1-artifact.json`. Initial failed harness attempts used the
wrong private BEAM encoder name or fixture-relative path; those and the two
Rust-target selection failures are retained separately, not called behavioral
RED. The generated-template TV lint failure is retained too; the manifest was
corrected to the actual handset scope, then lint and APK builds were rerun.

No full Mix suite, physical device/adb/emulator, governance-key generation,
biometric prompt, attestation, pilot signing, network provisioning, push or
hosted mutation ran in this slice. Standard SDK debug APK signing occurred only
as part of the authorized local build. The remaining Stage 2 slices above are
still required; local byte parity does not prove opaque custody or safe native
review/session handling.
