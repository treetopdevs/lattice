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

## Offline verification component

Offline verifier `6287d2188d4fb2ba509e4f37366a851b12023852` and repair
`e22747c755d8f22093aef99446b889f549b1dcb5` passed independent Sol review and
integrated as `da1167a96` and `0a3c0e8f0`. Root strict offline checks passed
165 JVM tests plus upstream tamper checks
(`/tmp/treehouse-r36-validator-offline-root.log`). Real upstream path, revocation,
challenge and profile verification are exercised; exact DER refuses trailing data,
trust digests commit owned certificate and name-constraint bytes, and evidence
arrays are defensively copied.

Even a cryptographically matching result remains
`INCOMPLETE / CHALLENGE_FRESHNESS_UNESTABLISHED`: this component does not implement
validator issuance persistence/consumption, official trust acquisition, possession,
current-state or physical-candidate proof. It cannot establish witness eligibility.
The existing Android workflow now runs strict validator checks with JDK21 and
retains their log in the compile-evidence artifact; workflow delta `0d325e7b`
passed Sol review. Its hosted execution remains a native packet closure gate.

## Architectural consolidation before activation

A bounded architectural audit identified operation lifetime ownership spread
across too many layers as the common cause of repeated cancellation and callback
repairs. Consolidation places execution, cancellation, owner invalidation,
prepared continuation and completion-after-drain behind one native flow interface.
The closed Rust/Kotlin protocol, durable journal, provider, review UI and strict
signature verifier retain their contracts. An outer task destructor is not proof
that an inner native callback has drained; slot release must follow the actual
transport acknowledgement.

Rust consolidated flow through `f980c0b46200ab2072e07aa99e2301b4e7f22db5`
and Kotlin flow through `0d2c5eeedcc4d15f7d1d58c36a4e24e20ac229f2`
passed independent Sol review and are integrated. Rust has one Running/Cancelled/
Committed publication owner across all registered native drains. Kotlin retains
admission through backend, journal and local UI cleanup acknowledgements, and clears
the exact active operation before publishing its staged terminal callback. Entropy
and cancel dispatch setup run off synchronous lifecycle/navigation/drop handlers.

Local UI cleanup acknowledgement proves local main-handler cleanup executed. It
is not proof that Android system UI disappeared or a physical platform callback
completed. Unknown native launch/acknowledgement failures retain admission closed.

Private hook packet `1dcbcd2dba84d1b5ad82581252003ea462a42d56` passed Sol
review and integrated as `ae511ff91`. Android registers one managed Arc<WitnessFlow>
before configured windows are created; navigation, page, lifecycle, destruction
and exit delegate to it. Desktop retains the preview document guard. Universal
private plugin rejection remains handled, including broadened ACL tests.

Public IPC adapter `54c6c616d7de041a95c15b39b2c4f737914266c3` passed Sol
review and integrated as `720ab247c`. JSON object responses stay objects, and
pending events target the actual WebviewWindow listener scope. Application command
registration, ACL and panel activation are recorded in the next checkpoint below.

Root checks at `ae511ff91`: 105 Rust tests plus three compile-fail documentation
tests passed (`/tmp/treehouse-r36-flow-hooks-root-rust.log`); actual Android Rust
target compilation passed (`/tmp/treehouse-r36-flow-hooks-root-android.log`).
Root final Kotlin checks passed 149 total tests, 148 executed, one existing skip,
zero failures, plus Android lint
(`/tmp/treehouse-r36-terminal-publication-root.log`).

Validator persistence/possession packet `759ea28b` and repair `699628bd` passed
independent Sol whole-packet rereview and integrated as `96e31fc7e` / `5cf9fc29d`.
The capacity check occurs before entropy or mutation; persistence fault checkpoints
now follow their named durable actions. Root 173 tests plus upstream tamper checks
passed (`/tmp/treehouse-r36-validator-possession-root.log`). Association requires
actual upstream verification with the retained issuance; possession nonce spend
is durable before packet parsing and actual Ed25519 verification. Current-state
claims remain unresolved. No production trusted snapshot acquisition is implemented.

Application activation packet `b78805e00d67f2baf6bb5903e79a0913af7c2d1c`
passed independent Sol review. Exact five-command dispatch precedes the unchanged
six-command preview fallback. AppManifest enumerates eleven commands and a separate
local-main-webview capability grants only the five witness requests. The opt-in
panel is now imported. Desktop has no Android flow and refuses custody requests.
Meaningful RED reached the old handler and returned command-not-found; three
application boundary tests now pass, including the compiled Android/macOS ACL.
Logs: `/tmp/treehouse-r36-application-red.log`,
`/tmp/treehouse-r36-application-green.log`.

Root integrated checks through merge `59a21ce2333ad19e43e8a5285b49daef48951139`:
108 Rust tests plus three compile-fail docs, Android Rust target compilation,
preview workflow/storage/product/bridge/binding tests and build, and 1,031 BEAM
tests plus 27 properties, zero failures, three existing exclusions, formatting
and Credo passed. Logs: `/tmp/treehouse-r36-application-root-full-rust.log`,
`/tmp/treehouse-r36-application-root-android.log`,
`/tmp/treehouse-r36-application-client-green.log`,
`/tmp/treehouse-r36-application-root-full-beam.log`.
Hosted native tip and merged-result checks remain open.

## Remaining gates

Challenge freshness and current-state/physical validation remain unfinished.
Executable import/export and official trust acquisition are recorded below. No end-to-end Rust →
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


## Executable validator and final integration

Official trust repository `3160ec8af90a2894434a898c9ce3dd9d6fdd51ce` passed
independent Sol review and integrated as `d38d99df1`. CLI packet through
`d508e18a2687cad56575d87fb15d1f8cfbb7c392` passed independent Sol whole-packet
rereview and integrated through `60e1bfa04`. Review repairs bind generated metadata
to the exact DER leaf key, share one bounded lexeme-preserving JSON decoder, bound
both imported revision fields to positive i64, enforce exact command arguments and
empty abandonment bodies, and preserve incomplete challenge-freshness reporting.

Root runner `bb505dcd9de669ba0a6e7a75c9a15d3a9230118a` and workflow/smoke
`31e9aafa35db032d91cb885d55aaed0f796aace7` each passed independent Sol review.
The installed CLI uses the fixed official repository only after retained-bound
generation import; issue/possession/abandon commands do not acquire trust data.
Root `check installDist` passed 183 JVM tests plus upstream tamper verification
(`/tmp/treehouse-r36-validator-executable-root.log`). The actual installed launcher
issued the exact UI request and a new process refused malformed import before
creating a trust directory (`/tmp/treehouse-r36-validator-installed-root.json`).
The same installed-process smoke is now part of the existing Android workflow.

Root invoked the production HTTPS fetcher and reopened its durable result on
September 7 (`/tmp/treehouse-r36-official-source-root.log`):
- Snapshot digest: `ZlHh9PwZAGutEWN1BdMbbr+p9ytCoFLGgBB8599gsj4=`.
- Fetch observation: `2026-09-07T18:26:45.476471Z`.
- Computed expiry: `2026-09-08T01:46:11.476471Z`.
- Reopened snapshot digest was identical.

This proves source acquisition/reopen on this host, not attestation for a selected
phone. Available roots/revocations and associated candidate facts still produce
an incomplete generation report until challenge freshness is established. Fresh
possession does not refresh current package, boot or device state.

The integration includes candidate-store dependency PR87 at exact
`69631a58ad91c51d39c6a8fdbb04886b5fec883c`, merged locally as
`ceb8bba330b6f0ffd62455a4dedaa1b28cf7a595`. PR87's hosted unit failure was in
the unchanged carrier restart test; final hosted closure is still pending. It must
merge before the native packet. Final combined root checks passed 115 Rust tests
plus three compile-fail docs (and a child-process helper), Android Rust target
compilation, and 1,031 BEAM tests plus 27 properties with zero failures, three
existing exclusions, formatting and Credo. Logs:
`/tmp/treehouse-r36-final-root-rust.log`,
`/tmp/treehouse-r36-final-root-android.log`,
`/tmp/treehouse-r36-final-root-beam.log`.

The refreshed device inventory still contains no attached Android device. R36,
R17c, enrollment, production signing, release and pilot gates remain open.

## Hosted review repairs before merge

The first reviewed native tip `669c3ae3c92d8bba249771a3c1f958590339641e`
passed hosted run `34153067909`. Six late review threads were inspected before
merge. The following repairs passed independent Sol review:

- Rust `093feb37db9b61e004379db299059edaf0e306fa` emits the active cancellation
  ID before Prepare/Generate review dispatch and refuses dispatch if notice
  delivery fails. A completed operation's late cancellation returns `missing`;
  an already-cancelled or inconsistent/poisoned owner still refuses. The old
  source failed five focused assertions; the repaired flow passed 15 tests
  (`/tmp/treehouse-r36-hosted-flow-red.log`,
  `/tmp/treehouse-r36-hosted-flow-green.log`).
- Kotlin author `e0df8615338b9306d6b137c301592afb79d98103`, integrated as
  `56c3365d9`, maps biometric error callbacks to the protocol-safe symbolic
  `biometric_error`. The real review-result/terminal-codec regression failed on
  old source; 17 focused tests plus lint passed after repair.
- Validator author `1dde29ab9a5e39c2c38cd1e65d2f01bd615b1e94`, integrated as
  `859a2933a`, distinguishes structural packet failures, retained-context
  mismatch, unknown issuance, and authoritative-store failure. The possession
  nonce remains durably spent before untrusted parsing. Behavioral REDs covered
  both reported cases and corrupt-store misclassification; seven focused tests
  and 184 full JVM tests plus upstream tamper verification passed.

The proposed unconditional `onDrained()` acknowledgment after a journal-close
exception was rejected by both independent Sol reviewers. In-memory references
are cleared before OS lock/channel close is attempted; an exception does not
prove those resources were released. The existing flow intentionally withholds
positive drain/admission and requires process teardown/OS release. No coordinator
change or successful-cleanup claim was made for that condition.

Catalog PR87 is now merged as `33af72ab5021233c65ab6767bc9a3dc7ba87ac21`.
Its exact tree `bb8d4122faa05a8fe510d85cd71d2ee26b7be6d3` matched the expected
merge result and main run `34153218509` passed. The initial unchanged carrier
restart failure and successful failed-job retry of tip run `34150528756` remain
part of the closure history. The repaired combined root checks passed 119 Rust
tests plus three compile-fail docs (and a child-process helper), Android Rust
target compilation, 150 Android host tests (149 executed and one existing skip)
plus lint, 184 JVM tests plus upstream tamper verification, installed CLI smoke,
and 1,031 BEAM tests plus 27 properties with zero failures, three existing
exclusions, formatting and strict Credo. Logs are
`/tmp/treehouse-r36-hosted-repair-root-{rust,android,kotlin,validator,beam}.log`.
The new exact hosted tip and merge-result gates remain pending.

An independent source audit confirmed that retained challenge association alone
cannot establish generation freshness: the validator contract still needs a
challenge lifetime and clock/restart rule. The native 120-second review timeout
starts at a different boundary and cannot silently supply that rule. A future
validator-owned live ceremony may collect issuance-to-association timing while
continuing to report incomplete. Real protected generation, CryptoObject
possession and current device/package/boot evidence remain separate gates.
