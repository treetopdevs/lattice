# Private witness codec reciprocal fixtures

Base: `20f79ae35a7d9c416d713751081877d5be651601`.

These are new host-only fixtures. They establish actual Rust/Kotlin encoder and
strict decoder compatibility, including the Rust mobile response adapter and
sealed proof acceptance. They do not establish JNI invocation, Android Keystore
custody, biometric presence, physical-device behavior, or release readiness.
The Ed25519 seed/public key is public RFC8032 test vector 1. The certificate-chain
bytes are deliberately synthetic public metadata, not an attestation certificate.

Producer ownership:

- `rust_requests.json`: six strings containing exact bytes emitted by Rust
  `encode_request` for identity, prepare, generate, proof, sign_prepared, cancel.
  The Kotlin test decodes each string and compares every typed field, including
  escaped UTF-8 replica, maximal revision, native nonce and opaque handle.
- `kotlin_*.json`: exact bytes emitted by Kotlin `WitnessPrivateSnapshotResponses`,
  `WitnessPrivateBindingResponses`, and `WitnessPrivateProtocol.encodeTerminal`.
  The Rust tests use `decode_snapshot`, the real mobile response dispatch adapter,
  `accept_prepared`, `accept_signed`, and `decode_terminal_response`.
- `kotlin_claim.bin`: actual Kotlin `BindingCodec` output, independently signed
  using JCA Ed25519. Rust derives the claim bytes itself and verifies the signature.

Normal tests regenerate producer bytes in memory and compare checked-in bytes;
no exports are enabled by default. Negative controls mutate authentic producer
outputs and assert refusal for operation/session/handle substitution, claim nonce
substitution, invalid phase, missing required null fields, unexpected/duplicate
fields, invalid types and malformed/omitted nonce or handle fields. The proof
acceptance also asserts one-shot consumption. These controls are deliberate
invalid inputs. On the named base, the required-null omission control discovered
a production defect: Rust accepts absent `metadata`, `generationChallenge`, and
`enrollment` as if explicit null. The test-only packet intentionally retains that
failing regression for the integrator to repair; no production decoder is changed.

From `clients/treehouse-tauri-shell/src-tauri`:

```sh
cargo test --test witness_native_interop
cd gen/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/Users/nicholas/Library/Android/sdk ./gradlew :app:testUniversalDebugUnitTest --tests '*WitnessNativeInteropTest' --no-daemon
```

Explicit regeneration, only when intentionally reviewing wire changes:

```sh
# From src-tauri; generates Rust-owned fixture only.
TREEHOUSE_INTEROP_EXPORT=1 cargo test --test witness_native_interop rust_producer_reproduces_exact_request_bytes
# From gen/android; generates Kotlin-owned fixtures only. Set an absolute source resource path.
TREEHOUSE_INTEROP_EXPORT_DIR="$PWD/app/src/test/resources/native_interop" JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/Users/nicholas/Library/Android/sdk ./gradlew :app:testUniversalDebugUnitTest --tests '*WitnessNativeInteropTest' --rerun-tasks --no-daemon
```

Run both normal tests without export variables afterward. A generated fixture must
pass its opposite runtime's consumer, not only the producer comparison.
