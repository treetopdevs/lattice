# R36 private coordination checkpoint

This packet is an intermediate native source checkpoint. It does not activate
the five proposed public witness commands or close R36.

## Base and ownership

The accepted provider foundation is
`b9671a5982e37511574432f1d43ad61cd5b149c4`; its main workflow
34132702099 passed. Native integration retains that foundation through merge
`9ebd20499235145d0e69389021ae4627279d2066`. The source checkpoint below is
`6695373a6b323615615d07b91f9bca00ea841627`.

## Implemented boundaries

- Retained journal leases and the original generation fence prevent cooperating
  operations from entering while review, generation or reconciliation drains.
- Fixed native review and exact `Signature`/`CryptoObject` identity bind consent
  and biometric success to one operation. Activity pause invalidates review.
- Closed Rust/Kotlin private requests require canonical owned identifiers;
  proof includes a native nonce, and `sign_prepared` carries only native operation,
  session and opaque handle. Public input shapes are unchanged.
- The registered private plugin rejects and handles every webview invocation,
  including tests with a deliberately broadened runtime ACL. Kotlin dispatch is
  not yet registered.
- The binding coordinator consumes validator nonces durably before presence,
  retains the journal through signing, checks the original revision and deadline,
  and exposes an opaque prepared handle. Cancellation cannot win after delivery
  has atomically taken ownership; reentrant signing retains its own ownership.
- Rust accepts only a closed native prepared response and the matching one-shot
  signed response. It checks operation, session, handle, full reconstructed claim,
  expiry and strict Ed25519 verification. Reviewed claim bytes are immutable;
  the signing constructor requires the concrete private sealed type.

## Regression and review evidence

Behavioral RED/GREEN evidence covers protocol refusal, broadened-ACL rejection,
callback/cancellation ownership and early expiry followed by normal delivery.
Independent Sol review accepted the final protocol extension
`f6ec3fa8be16207a8d506eb53190e52ef63e7e20`, sealed gate
`9b1c6b360608b52c9857b3b636f78cb2ff8c59f7`, and final timeout repair
`825453e77eba280a26ffdc0a9bb6e8f01aeb8514`.

The timeout repair matters despite earlier green tests: a timer that fired during
delivery could be consumed without releasing the journal later. Ceiling-rounded
scheduling plus a pending-expiry reschedule fixes that case. Its regression proves
a new nonce can acquire the journal after the deadline.

Root Rust tests passed at `b8e7d5ecf67adb0e8c2c1d8b683819d186c78665`:
37 tests plus three compile-fail documentation checks. The subsequent source
change is Kotlin-only. Root Android tests and lint passed at the source checkpoint
above: 105 tests, 104 executed, one existing skip, zero failures/errors.

Local logs: `/tmp/treehouse-r36-integrated-final-rust.log` and
`/tmp/treehouse-r36-expiry-final-native.log`. Hosted tip, exact merge candidate,
root umbrella checks and merge-result checks remain open for this native packet.

## Subsequent integrated source checkpoint

At `c43982d265989c8738e8c6deef1d8126e78c842a`, the isolated native train
also contains reviewed preparation, document-session, response-drain, opaque
handle-registry and private Rust mobile-dispatch seams. Preparation preserves
journal refusal precedence and cancels a review handle published after
cancellation; its current-state transaction is not a comparison against the
initially observed revision. The document adapter requires an actual initial
native navigation request and immediately refuses later requests and stale load
events. The drain task survives caller loss and rechecks session on delivery.

Root combined Android checks passed at `7bd978854080bd28f6c72a4078699508c6476c31`:
124 tests, 123 executed, one existing skip, zero failures/errors, and lint clean.
Root combined Rust tests passed on that same source: 51 tests and three
compile-fail documentation checks. The later mobile adapter passed six focused
tests; the actual Android Rust compilation passed after the private modules were
included in the crate. Source, repairs and the build-only module declarations
passed independent Sol review.

Logs: `/tmp/treehouse-r36-coordination-combined-android.log`,
`/tmp/treehouse-r36-coordination-combined-rust.log`,
`/tmp/treehouse-r36-mobile-integrated.log`, and
`/tmp/treehouse-r36-private-android-rust-check-rustup.log`.
The initial Android check used Homebrew Rust without Android standard libraries;
the successful check uses the already-installed Rustup stable toolchain and
NDK 27.1. It is compilation evidence, not APK execution or physical proof.

## Remaining gates

Actual Kotlin plugin integration and registration, native identity coordination,
session event wiring, public binding export and independent validation remain
unfinished. No end-to-end Rust → Kotlin → journal → biometric operation → Rust
proof is asserted.

Tauri page-load completion supplies a URL without a document identifier. The
session guard's native tickets must not be paired with a later URL-only completion
by assuming it belongs to the latest navigation. Actual adapter wiring remains a
separate refusal-tested gate.

The host Android tests use Robolectric SDK33. API24 compatibility is lint evidence,
not a physical API24 run. No local build or test establishes device custody,
same-UID atomic KeyStore compare/create, enrollment readiness, production signing,
release eligibility or pilot completion.

The September 7 device inventory (`adb devices -l`) listed no attached device.
Physical biometric/custody proof therefore remains unavailable in this session.
