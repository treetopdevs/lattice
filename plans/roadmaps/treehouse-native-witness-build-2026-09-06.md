# Treehouse native witness build: R36, R17b and R17c

Status: reviewable follow-on to [R17a's decision](../../docs/research/governance_witness_native_verification.md),
prepared 2026-09-06 at `641cbbd7`. This plan implements nothing and allocates no
numeric plan. R01b adopts scope before implementation/profile enablement; the
integrator owns the [unified ledger](treehouse-unified-2026-09-06.md), publication
and exact-tip review. Every implementation stage needs named public-seam RED,
GREEN, adversarial diff review and evidence appropriate to its claim.

## Dependency and ownership map

| Packet | Work and closure | Ordering |
| --- | --- | --- |
| R17a | Decision, this build plan and Plan174 drift amendment | Design review only; no Android eligibility claim |
| R01b | Adopt Android/native scope, fail-closed eligibility contract, custody limits, deferred-ceremony and scoped Plan146 extensions | After R01a/R17a, before R36; does not wait for R36's physical probe |
| R36 | Opaque provider, distinct persistent identities, preliminary physical eligibility, reviewed public binding | After R01b/R12/R17a; eligibility precedes R14 key pinning |
| R17b | Complete-history authentication, retained store, authority projection, per-purpose encoders, native review and token cutover | After R17a/R01b/R03/R14; R14 transitively supplies landed R04/R10/R36. Match exact R03 and R04 semantics |
| R17c | Independent physical proof of custody, presence and the integrated ceremony | After R17b; prerequisite to founder-loss/strong candidate claims |

The preliminary R36 eligibility result can block use of a selected device; it is
not a circular prerequisite for the earlier R01b contract adoption. R17c proves
the final candidate separately. Root-owned plan/status amendments travel with the
corresponding reviewed packet, never as an incidental implementation edit.

## Stage 0: remove attacker-shaped prompt text, independent first commit

Change the current reason to exactly `Sign Township clerk recovery witness`, one
fixed ASCII line with no submitted replica or successor interpolation. This small
maintenance commit may precede the larger custody/projection work; it does not
claim native semantic verification. R17b replaces it with the verified product/
replica/role template from decision D5.

RED through the injected presence provider: oversized replica, newline, CR, NUL,
non-ASCII and direction overrides in otherwise accepted claims all produce the
same bounded constant reason. Existing clerk payload/signature bytes, typed
cancel/unavailable outcomes and ordinary release-provider binding stay unchanged.
Scope: shell `src-tauri/src/lib.rs` and focused prompt/custody tests only.

## Stage 1: opaque generation and signing seam, R36

Replace governance callers' seed creation/load interface with provider-owned
generation returning public identity/opaque handles and authorized typed signing
returning signature/public metadata. Change generation as well as signing:
wrapping `load_seed` while still generating an Android seed in Rust is insufficient.
No command takes a caller-selected key ID or arbitrary signing bytes.

The macOS adapter retains existing protected Keychain seed retrieval internally;
its seed still enters native memory. Android must generate and sign in its
provider without any private material crossing the seam. Keep those claims distinct.
Keep strict create-only identity, cross-process race reconciliation, sidecar/key
agreement, no automatic recreation and fresh authentication per operation.

RED: public API has no seed-returning operation; caller/alias isolation in both
directions; duplicate/concurrent ensure, crash at each creation write, incomplete
identity, sidecar mismatch and restart; no silent overwrite/rotation; cancel,
lockout and unavailable do not release signatures or artifacts. Deliberate cleanup
of an unpinned failed first creation must have its own bounded transaction and
tests; do not describe all creation failures as zero native writes.

Scope: `clients/township-tauri-shell/src-tauri/src/lib.rs`, existing
`macos_governance.rs` and test provider, focused native tests; provider types shared
with Android only as required. Preserve legacy clerk bytes and platform behavior.

## Stage 2: Android eligibility and public binding, R36

Build a product-bound Android plugin/provider exposing typed generation,
authenticated signing and public metadata/attestation export. Native-bound
`products.json` selects the product; Treehouse governance never reuses Township
governance or Treehouse carrier aliases. Carrier APIs cannot select witness keys
and witness APIs cannot select carrier keys. The generation/signing path has no
software fallback or exported/imported seed.

**2026-09-06 documentation correction:** implement the decision's
[Android eligibility API and evidence rules](../../docs/research/governance_witness_native_verification.md#android-eligibility-and-evidence-order).
Use the AndroidKeyStore EC generator with `ECGenParameterSpec("ed25519")`, a
SIGN-only/DIGEST_NONE key and TEE-backed KeyMint Curve25519. The newer explicit
Ed25519 generator alias and an API33+ version are not hardware eligibility proof;
StrongBox Curve25519 is unsupported in the pinned AOSP contract. Generation and
signing remain opaque, without a software provider or seed fallback.

R01b's adopted eligibility contract requires all of the following on each proposed
physical device **before pinning its real witness key**:

1. Actual platform Ed25519 generation and a key-bound per-operation authentication
   round trip, with independently verified signature under that public key.
2. A fresh validator generation challenge and independently checked attestation
   chain for the actual key at initial provisioning. Validate the correct trustworthy
   extension occurrence, current trusted roots and revocation, TEE attestation and
   key security levels, generated origin, signing purpose/algorithm, per-use
   authentication authorizations, app/signing identity and locked verified boot
   state as specified in decision D1/D2 and the Android section. The verifier must
   reject a valid chain for another key. Per-use authorizations contain
   hardware-enforced USER_AUTH_TYPE with absent NO_AUTH_REQUIRED and AUTH_TIMEOUT;
   USER_SECURE_ID is non-attested. Do not require an attested zero timeout or SID.
3. Public metadata and a create-only persistent binding that survive restart,
   retaining the original generation attempt/challenge and exact chain. Retry and
   restart reconcile those bytes and require fresh fixed-domain possession under
   the same key; they never recreate it to refresh attestation. Original attestation
   reports generation-time state, not every later OS/app/boot state. Recheck trust
   and revocation; missing required current-state evidence remains incomplete.
   Record enrollment/invalidation, reboot, cancel/lockout and unsupported outcomes.

Use a native-issued fixed `lattice-witness-binding-challenge-v1` possession intent
bound to product, replica enrollment, actual caller/session, witness key and fresh
nonce. Its canonical shape is closed, its nonce single-use and its signing path
separate from succession/beacon domains; it is not generic challenge-byte signing.
Public-key/attestation reads may be presence-free and create-free. Validation
metadata contains no private key or content-bearing group history.

RED: forged/untrusted/revoked chain, stale challenge, substituted public key,
wrong extension, software attestation or software key level, imported origin,
no-auth/reusable-auth parameters, wrong app/signing certificate, unlocked boot,
unsupported algorithm/authentication combination and absent attestation all remain
ineligible. Test domain crossover, cross-product/alias/caller/session/recipient
binding, replay, concurrent ensure and restart during creation. Include a positive
per-use attestation with the documented absent fields, negative timed/no-auth
records, authentication-operation substitution, reused possession nonces, retained
creation-challenge mismatch and recovery that must not overwrite an existing key.
These are required future public tests, not results from this documentation change.
A failed probe
publishes no eligible identity and changes no pin; incomplete custody is explicit,
not silently replaced. R12 preview remains usable.

Scope: Android plugin under the selected product shell's native integration path,
new Android provider/bridge, necessary Rust/Kotlin dependency locks, typed TS bridge,
public attestation validator/probe tooling and focused native/bridge tests. Use the
existing plugin precedent and record exact paths before edits if R12 relocates the
shell. No manifest alias collision or unrelated dependency upgrade is authorized.
Only the selected Android workflow wiring changes. Preliminary physical results
are custody eligibility evidence, not final R17c ceremony closure.

## Stage 3: complete-history verification and durable retention, R17b

Port the **existing bounded closed CarrierTerm/op grammar**, not a collection of
authority-only fixed body encoders. Cover nil, bool, unsigned integer, binary,
atom, list, tuple, map, mapset, delegation v2/v3 and signed op core. Canonical
verification handles complete bodies/caps of supported `command`, `inbox`,
`authority` and `tombstone` operations, including opaque application terms.
Recognized ordinary posts/edits must authenticate and remain usable as ancestors
without requiring application CRDT materialization or an application verdict.

Apply decision D2's complete fixed-point admission contract. Retain authenticated
supported evidence, semantic quarantines and competing branches. E tracks positive
cryptographic introductions from the root/recognized profile keys through valid
embedded delegation issuers and parent proofs, including already-E self-issued
succession/continuation anchors. Seed legacy designated successors and v1 recovery
map witnesses explicitly alongside R04 nominees and R03 witnesses. It never uses current honored status, revocation or lease
expiry as a filter, never grants permission and never grows from unknown ancestry.
Inspect supported staged introductions before requiring complete DAG admission.

Relevant unknown/missing evidence durably blocks signing. Unconnected unknown input
and its unconnected supported descendant cones stay in bounded durable staging
outside the admitted frontier. Reclassify the full retained union before deriving
or releasing a claim; later eligible introductions/citations promote or block
atomically. Known shapes proved inert by the fixed grammar remain supported.
Invalid wire/ID/signature and quota-refused input are not trusted observations.
Omitting retained evidence or restarting cannot remove a block. Preserve D2's
eligible-author denial residual and same-retained-union convergence limit.

Store pin, observations, pending evidence, blocking state and generation crash
safely outside webview/cache mutation APIs. An existing key with missing/corrupt
binding/history refuses; no empty-store auto-repair. Derive from the union of all
retained admitted evidence after classifying the entire union, never an IPC subset
or a saved signed-snapshot list. No scalar
ordering of op hashes, global beacon floor or invented rollback-resistant counter.

Reserve capacity for staging, promotion, intake and durable markers. Atomically
journal the fence and complete bounded batch bytes/digest-backed durable input;
the API cannot create a fence alone. Proposed intake is 64 frames / 512 KiB within
the overall ceiling. Restart classifies that exact recoverable batch before signing.
Only completed refusal, retained pending/supported evidence or a durable block
clears its fence; unrelated retries cannot. Corrupt/missing journal bytes refuse.
An ordinary crash with a readable journal must recover, not strand the witness.

RED: ordinary command/inbox ancestors before a valid acquisition; semantic
quarantines retained; outer ID/signature mutation; malformed canonical data;
duplicate map/set encodings; relevant missing deps; known branch omitted; eligible
unknown authority/policy followed by an old-history retry and restart; fresh-key
unknown plus fresh-key supported descendant remains staged; public capability
citation cannot introduce its citing author; embedded E-issuer introduction with
another outer author, rootless continuation children, superseded/revoked-key
overblocking and staged introduction before DAG closure; later eligibility promotes
or blocks before release; staging exhaustion leaves admitted signing usable, while
relevant-capacity exhaustion blocks; a legacy designated successor's unknown op
blocks and its self-issued succession can anchor valid children; quota-refused
bytes can be resubmitted as fresh admission once connected; readable fence recovery and corrupt-journal
refusal at every admission boundary. Restored whole old native store remains an
explicit non-claim rather than a misleading passing rollback test.

**Plan146 Seam5 scoped extension for this stage:** amend its fixed-claim-only
restriction for R17b's closed history verifier. Allow the current CarrierTerm/op
canonical subset required for ordinary histories, with exact BEAM/TS/Rust byte,
hash and rejection parity. Preserve its fixed legacy clerk payload and all existing
legacy vectors. General CBOR, new canonical terms, generic signing and changes to
Core semantics remain outside scope. Also record D2's explicit R04 native-boundary
amendment for unknown/incomplete admission, retained versus quota-refused input,
and the conservative E closure before RED. The old broad-codec STOP must not
prohibit this explicitly reviewed bounded extension.

Scope: new native canonical verifier and store modules, `lib.rs`, focused native
tests; new BEAM exporter scenarios and generated new oracle files, focused TS oracle
checks, and scoped Plan146 amendment. Do not hand-edit vectors. Coordinate exporter/
codec ownership with R03/R10; no authority.ex/authority.ts semantic changes here.

## Stage 4: matched authority projection and per-purpose claims, R17b

Reproduce the landed judge's root/policy/delegation/role logic and exact refusal
reasons needed by supported purposes. Include valid multiple-genesis policy merge,
static parent attenuation, honored candidate activation, causal acquisition and
canonical-fold current-holder checks, double-transfer conflicts and root binding.
Retain revoke/lease evidence without inventing automatic holder removal. Full
history verification precedes this narrow projection; application command effects
remain outside its claim.

Native verified pin selects only Township.Matter/clerk, Treehouse.Space/admin or
Treehouse.Thread/moderator, plus separately pinned beacon purpose. Caller-selected
role/schema strings are never authority. Add admin/moderator vectors after their
Core contract exists; preserve legacy clerk payload bytes. Each versioned R04
continuation purpose must match the final landed Core profile/claim, rather than
implementing this plan author's guessed continuation semantics.

Legacy clerk's seven-field signed tuple remains frontier-unbound. Review/token
generation checks govern signing time only; an exported artifact can be reused
wherever that same tuple applies, including different frontiers. Disclose that
scope and preserve bytes. A future stronger Township claim needs a separately
adopted domain/purpose and Core verifier.

For shared beacon witness claims, the sole author selector is a key in the native
pinned witness set. Native derives all other fields from the exact admitted
frontier and chooses its next valid causal epoch, within R03 step/horizon bounds.
Every witness accepts the same displayed outer author; differing frontiers require
sync before identical claims can be signed. R14's human cadence governs when to
start, without trusted-time claims. Final op signing requires the selected author
to equal the local configured protected witness key.

Add the separately typed **final beacon operation** purpose required by R03:
after independently verifying the assembled threshold certificate, native derives
the exact replica/deps/epoch/local witness author, constructs only
`{:beacon, epoch, certificate}` as `:authority` with `cap: nil`, and signs the
existing canonical op bytes using that configured protected witness key. An
ordinary member/carrier signature cannot substitute for the required author.
Do not expose a generic op or bytes signer. This purpose has a fresh review,
one-shot token and per-use authentication distinct from each witness-claim signature.
Commit the signed frame and one pending-release outbox pointer atomically after
all consent/generation checks. That commit is the release-authorization point.
Cancellation before commit prevents it; after commit the artifact is already
authorized. Restart aborts an uncommitted outgoing attempt, distinct from replaying
an incoming admission journal. Failed commit leaves no retrievable outbox entry.

The authenticated same-product caller can enumerate/retrieve identical committed
frames after restart without re-signing or new presence. Pointers count inside
the retained ceiling and remain retrievable for the frame's history lifetime.
Webview publication hints are advisory, never proof or deletion authority;
unconfirmed entries do not block later signing. Ordinary publication is idempotent
and member-authenticated. Signing/retrieval initiate no network. Legacy clerk
artifact export remains unchanged.

RED/oracles additionally cover complete outer-op byte/ID/signature parity,
unconfigured author or member-key substitution, changed deps/epoch/certificate/cap,
insufficient or invalid surplus signatures, cross-purpose consent reuse, generation
changes during authentication/signing, two witnesses selecting the same available
author, changed author/frontier refusing aggregation, and every retain-before-release
crash point. Verify commit-before-response recovery returns identical bytes without
another presence/signature, failed commits return nothing, uncommitted attempts
abort on restart, and advisory publication cannot delete or strand pending frames.
Count final-beacon authentication separately in the R02/R14 ceremony workload.

For R03 beacons, use its exact five-field claim `(version, replica, epoch, author,
deps)`, domain, ancestry-scoped policy/prior maximum, step bound and structural
horizon behavior. Preserve permitted forks around a high beacon and inert
same-author/same-dependencies duplicates. Domain-bound signing intent may use the
full retained frontier, but the history judge may not reinterpret those permitted
forks as unauthorized under an invented global epoch rule.

RED/oracle matrix: competing signed but dishonored transfers; invalid parent,
lease/role distinction; before/after candidate activation; valid and impostor
multiple geneses; superseded policies; native/BEAM/TS holder and policy equality;
admin/moderator/clerk allowlist and cross-role substitution; D2-relevant unknown
authority blocks; R03 lifted certificate, threshold and permitted fork/duplicate cases;
R04's approved scope, expiry and claim-substitution cases. If native needs another
authority fact, extend the projection against the Core oracle before claiming it.

Scope: native authority/per-purpose encoder modules, projection/store integration,
new exported oracles and focused TS/native checks. Core source semantics remain
owned by R03/R04/R10. Stage4 cannot close until their applicable definitions land.

## Stage 5: native review and atomic IPC cutover, R17b

Implement decision D5's native-controlled full review and one-line printable-ASCII
OS reason under 200 UTF-8 bytes. Hash the full pinned replica ID for its displayed
fingerprint, not merely the root commitment. Product/kind/role, verified successor
and acquisition fingerprint or exact beacon epoch come from native state. Missing
verified display fields refuses before presence, with no submitted-value fallback.

Use D5's escaped, structurally isolated full-value rendering: fixed labels,
monospace escaped values, always-visible full SHA-256 and original byte count,
bounded initial viewport and explicit continuation to exact full escaped values
in at most 4 KiB chunks. Controls, newlines, bidi and confusable strings must not
create labels/structure or hide identity. Rendering is bounded by admitted sizes;
inability to render safely refuses. Legacy clerk review explicitly discloses that
its released signature does not bind displayed dependencies.

Implement D6: begin derives the full claim and opens a displayed, unaccepted native
review with a proposed 120-second timeout. No token exists until an explicit native
UI gesture accepts the unchanged re-derived claim and generation; IPC cannot
synthesize acceptance. Then activate the unpredictable one-shot token with a
60-second monotonic TTL from acceptance. Bind actual native caller/session and
window/product/replica/key/domain, allow one pending attempt, and invalidate on
replacement/cancel/restart. Check state generation and all release authorization immediately
before presence, after blocking presence/platform signing, and atomically with final
signature release. A signature computed after invalidation is discarded.
R22/R23 ceremony/accessibility measurements may revise the TTL through review;
an active attempt never extends itself. Admin/moderator prompt templates must name
the landed R04 action correctly, including current-holder renewal.

RED: bare claim/no token, displayed-but-unaccepted review, synthetic IPC acceptance,
stale native display, token replay/expiry, wrong native window/session/product/
key/domain, supplied caller label, substitution, cancellation and second begin;
state change before presence, **during the blocking OS prompt**, during platform
signing and just before release; process death/restart; each yields no released
signature/artifact before authorization. Already committed outbox frames remain
retrievable under Stage4's explicit commit boundary. Test two replicas sharing a
root get different native replica fingerprints, hostile full-value rendering and
all supported roles. Full review retains exact
keys, deps and lease consequences even though the OS line is abbreviated.

Stages3-5 land as one atomic signing cutover: remove/refuse legacy claim-only IPC
and migrate existing `township_actions.ts`, `native_workflow.ts`, current product
callers, bridge tests and packaged smoke together. Do not ship a dual-accept bypass.
New retained evidence may persist on a refused attempt; no refused attempt emits
an artifact, semantic op, outbox frame or publication. Keep public artifact export
separate and preserve legacy artifact bytes and subthreshold interpretation.

Scope: the native modules above, native-controlled review/registration, existing
TS adapters and affected UI contracts, exact packaged migration wiring. Update
Plan146's review/custody/IPC claim boundaries in this same unit. No generic signer,
presence bypass, carrier authority or public witness-exchange API is added.

## Budget and required automated gates

Proposed witness ceiling: 8,192 operations or 16 MiB per replica, counting **all**
signed history, pending evidence and defined store overhead. Pin the exact byte
accounting before RED, including intake journal, staging/promotion reservations,
durable markers and outbox pointers without double-counting referenced frames.
Proposed staging subquota is 128 operations / 512 KiB, separate from admitted
capacity; filling only unconnected staging refuses further unrelated input without
blocking complete admitted signing. Exhausting relevant/admitted capacity durably
blocks signing. No truncation, partial projection or old-subset signature. The
carrier's recovery
ingestion is separate, and offline healing can exceed this ceiling. A lifecycle
decision is required if the supported witness envelope is exhausted.

Proposed physical measurement gates: 5,000 operations/10 MiB full authentication
and projection in five seconds; one-operation incremental update in 500 ms on the
minimum supported profile. Include posts/edits, authority, inbox and quarantined
history, competing branches and bounded adversarial term shapes. Record actual
numbers; these targets are not current measurements or guaranteed feasibility.
Include cold verification just below the retained ceiling and an at-ceiling
refusal run against the same proposed five-second bound before R17b readiness;
the smaller benchmark alone does not establish restart usability near the limit.

Required commands at the actual landed implementation paths:

- Focused native verifier/store/projection/token/provider tests and ordinary
  release-binding gates; existing `governance_witness_custody` and
  `governance_release_binding` targets remain green.
- BEAM exporter/oracle tests and exact regenerate-and-diff check preserving legacy
  vectors; client `typecheck`, `canonical`, `conformance`, `township:authoring` and
  `build` with generated-dist parity.
- Shell typecheck, native bridge/action/persistence contracts, product-manifest and
  package/workflow wiring gates; appropriate Android instrumentation and existing
  macOS choreography remain distinct from physical evidence.
- Full asdf/OTP28 `mix check`, applicable boundary checks, `git diff --check`, and
  exact-diff Fable review at RED/GREEN/corrections and final cutover. Serialize Mix
  commands and use AGENTS.md's explicit toolchain. Do not broaden unrelated runtime
  scope just to satisfy a stale command path; resolve paths against the R12 build.

## Stage 6: independent physical closure, R17c

On the exact signed candidate, record APK hash, signing identity, device model/API,
installed artifact match, separately validated actual-key attestation and fresh
per-operation presence. Use unrelated eligible physical witness devices and verify
cancel, lockout, reboot, interrupted collection, state change during authentication,
same-root different-replica display, wrong caller and release-token replay. Confirm
no private seed transit and no fallback on failure. Keep serials local.

Independent validation repeats freshness/key/security-level/app/boot checks on the
actual candidate identities; a prior test key's attestation is not sufficient.
R36 preliminary eligibility and emulator choreography are not substitutes. Carry
exact measured latency and ceremony workload into R22/R23. State whole-native-store
rollback, unseen operations and human comprehension as non-claims; do not call one
artifact threshold authorization or macOS evidence Android evidence.

## STOP and closure conditions

Stop the affected signing/profile workflow for native/Core disagreement; missing
landed R03/R04 claim definitions; generic bytes/key selection; custody fallback;
retained relevant unknown history discarded or unconnected input promoted without
D2's classification; missing/corrupt native store silently
reinitialized; state race releasing a signature; unsupported physical eligibility;
or a claim of global freshness/whole-store rollback resistance without a separately
reviewed mechanism. Preserve evidence and the offline preview.

The bounded grammar extension is explicitly in scope after R01b adoption; arbitrary
general CBOR or new Core authority semantics is not. Failure of the physical or
budget gate requires an explicit device/profile/lifecycle decision, never a silent
downgrade. Do not mark R36/R17b/R17c done from this document or a simulator result.
