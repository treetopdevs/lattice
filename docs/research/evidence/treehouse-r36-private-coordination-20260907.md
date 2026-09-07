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

## Private dispatch and reciprocal checkpoint

Kotlin dispatch `7514d533` integrated as `20f79ae35` after independent Sol PASS.
Its immutable per-invocation ownership suppresses duplicate Stored/Refused/Missing
callbacks and old proof callbacks arriving during a later signing operation.
Root Android tests passed 134 total, 133 executed, one existing skip, zero failures,
and lint (`/tmp/treehouse-r36-dispatch-integrated-android.log`).

Registration `c244ab60` installs the exact private Android class once and retains
the universal Rust webview rejection handler. Independent Sol PASS; actual Android
Rust compilation passed. The broadened-ACL IPC test includes dispatch and
sign_prepared; deliberately replacing rejection with success makes it RED.
Logs: `/tmp/treehouse-r36-registration-boundary-green.log`,
`/tmp/treehouse-r36-registration-boundary-red.log`,
`/tmp/treehouse-r36-registration-android-check.log`.

Reciprocal test packet `18e512818` reproduces six Rust requests and Kotlin
snapshot/proof/terminal outputs with their actual serializers. It exposed three
omitted nullable snapshot fields accepted by Rust. Repair `8fd60967` requires
explicit metadata, generationChallenge and enrollment fields while allowing
contractual nulls. All six Rust reciprocal tests pass after repair; the two
Kotlin producer/consumer tests passed. These are host codec and software-signature
checks, not JNI, platform signing, attestation or physical custody evidence.
Independent Sol review of the final reciprocal packet and required-nullable repair passed.

## Owner, projection and operation checkpoint

At `f6afeaf229b8962bb12fb74ab59c57f07daf7e96`, native registration,
required-nullable reciprocal snapshots, runtime exception completion, public
command spelling, sealed public result projection, ephemeral operation registry,
and actual plugin document/lifecycle hooks have passed independent Sol review.
The five public witness commands remain inactive.

Root review found a UI-thread deadlock despite the initial owner tests: a worker
could hold the owner mutex while waiting for the native URL query, while a UI hook
waited for that mutex. The reviewed repair uses nonblocking acquisition and a
permanent refusal latch. Its regression holds the URL query while navigation,
page-load, lifecycle and destruction hooks return promptly; resumed work refuses.

Root checks at this checkpoint passed 84 Rust tests plus three compile-fail
documentation checks, 138 Android tests (137 executed, one existing skip), Android
lint, and actual Android Rust cross-compilation. Logs:
`/tmp/treehouse-r36-owner-result-full-rust.log`,
`/tmp/treehouse-r36-owner-result-full-android.log`, and
`/tmp/treehouse-r36-owner-result-android-rust.log`.

The pinned independent validator tooling passed Sol review and root offline clean
verification: 156 JVM tests and vendor-integrity tamper checks. This proves the
retained tooling can be reproduced; it does not prove an Android witness eligible.
Log: `/tmp/treehouse-r36-validator-root-check.log`.

## Disconnected frontend and validator profile

Frontend packet `67a71ddba64348be4070e6e7e96ab9cd3dc39965` integrated as
`8c3c0bc3e3433bf6b7ce8cc2b086d6551d8382d4` after independent Sol PASS.
It exposes the five closed typed routes, subscribes before invocation, verifies
fixed proof bytes and identity consistency, and keeps cancellation tied to the
native ephemeral event identifier. The opt-in panel remains unimported by App.
A delayed prior event can cause fail-closed cancellation of an obsolete ID; the
native operation/session gate remains authoritative. No actual event delivery or
physical proof follows from fake-transport tests.

Root preview tests, 13 bridge tests, typecheck and build passed. The initial root
run exposed the obsolete Android test assertion that biometric permission must
be absent, although reviewed native review already requires it. Repair
`830f95c5d2705f578ee6e71b9f033e19c55aab6b` asserts its exact single declaration
and preserves false eligibility and the closed public command surface. Sol PASS.
Log: `/tmp/treehouse-r36-frontend-root-check.log`.

Validator profile `aff3c3ee3d99b9622ccf04687d130e59d53e9c2d` passed independent
Sol review and integrated as `e2a9d40a5`. It adds the exact generation-time TEE,
Ed25519, generated-origin, per-use authentication, application and locked-boot
constraint, including raw authorization tag rejection. Root offline strict
verification passed (`/tmp/treehouse-r36-validator-policy-root.log`). This is an
additional constraint, not an issuance, trusted snapshot, possession, report or
eligibility implementation.

## Architectural consolidation before activation

A bounded architectural audit identified operation lifetime ownership spread
across too many layers as the common cause of repeated cancellation and callback
repairs. Consolidation will place execution, cancellation, owner invalidation,
prepared continuation and completion-after-drain behind one native flow interface.
The closed Rust/Kotlin protocol, durable journal, provider, review UI and strict
signature verifier retain their contracts. An outer task destructor is not proof
that an inner native callback has drained; slot release must follow the actual
transport acknowledgement.

This consolidation and its external flow regressions are open work. Neither the
new frontend panel nor the public native command surface is activated.

## Remaining gates

End-to-end orchestration, public command and UI integration, independent validator
policy review and validation reporting remain unfinished. No end-to-end Rust →
Kotlin → journal → biometric operation → Rust proof is asserted.

Actual native hooks are wired and host refusal-tested. Pinned Wry source invokes
the navigation hook before app-initiated page loads. Physical Android ordering,
background cancellation and restart still require device evidence.

The host Android tests use Robolectric SDK33. API24 compatibility is lint evidence,
not a physical API24 run. No local build or test establishes device custody,
same-UID atomic KeyStore compare/create, enrollment readiness, production signing,
release eligibility or pilot completion.

The September 7 device inventory (`adb devices -l`) listed no attached device.
Physical biometric/custody proof therefore remains unavailable in this session.
