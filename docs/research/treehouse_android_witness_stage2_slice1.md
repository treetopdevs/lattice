# R36 Stage 2, slice 1: Android bootstrap and binding bytes

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
