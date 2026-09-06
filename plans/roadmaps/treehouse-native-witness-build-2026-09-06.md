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

R01b's adopted eligibility contract requires all of the following on each proposed
physical device **before pinning its real witness key**:

1. Actual platform Ed25519 generation and a key-bound per-operation authentication
   round trip, with independently verified signature under that public key.
2. A fresh validator challenge and independently checked attestation chain for the
   actual key. Validate the correct trustworthy extension occurrence, current
   trusted roots and revocation, both attestation and key security levels, generated
   origin, signing purpose/algorithm, per-use authentication authorizations,
   app/signing identity and locked verified boot state as specified in decision D1/D2
   and the Android section. The verifier must reject a valid chain for another key.
3. Public metadata and a create-only persistent binding that survive restart.
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
binding, replay, concurrent ensure and restart during creation. A failed probe
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

Persist every authenticated observation, including semantic quarantines and
competing branches, keyed by verified op ID with dependency closure. Missing
dependencies make derivation incomplete. Structurally invalid wire input or invalid
ID/signature is not trusted admission; a valid signed operation with an unsupported
authority variant/policy is retained with a durable signing-blocked marker. A later
request that omits it, or restart, cannot clear the block. Refusal means no signing
effects; observation/block persistence may be necessary.

Store pin, observations, pending evidence, blocking state and generation crash
safely outside webview/cache mutation APIs. An existing key with missing/corrupt
binding/history refuses; no empty-store auto-repair. Derive from the union of all
retained evidence, not an IPC subset or a saved signed-snapshot list. No scalar
ordering of op hashes, global beacon floor or invented rollback-resistant counter.

Reserve durable capacity for incomplete/over-budget markers. Before verification,
write an admission-in-progress fence; only a completed untrusted-input refusal,
committed observation or durable blocked outcome clears it. An uncleared fence
at restart refuses signing. Test
write failure and capacity exhaustion at each fence/observation/marker transition,
so unknown authenticated input cannot disappear through a failed transaction.

RED: ordinary command/inbox ancestors before a valid acquisition; semantic
quarantines retained; outer ID/signature mutation; malformed canonical data;
duplicate map/set encodings; missing deps; known branch omitted; unknown signed
authority/policy followed by an old-history retry and restart; crash at every
admission transaction boundary; restored whole old native store remains an
explicit non-claim rather than a misleading passing rollback test.

**Plan146 Seam5 scoped extension for this stage:** amend its fixed-claim-only
restriction for R17b's closed history verifier. Allow the current CarrierTerm/op
canonical subset required for ordinary histories, with exact BEAM/TS/Rust byte,
hash and rejection parity. Preserve its fixed legacy clerk payload and all existing
legacy vectors. General CBOR, new canonical terms, generic signing and changes to
Core semantics remain outside scope. The old broad-codec STOP must not prohibit
this explicitly reviewed bounded extension.

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

Add the separately typed **final beacon operation** purpose required by R03:
after independently verifying the assembled threshold certificate, native derives
the exact replica/deps/epoch/local witness author, constructs only
`{:beacon, epoch, certificate}` as `:authority` with `cap: nil`, and signs the
existing canonical op bytes using that configured protected witness key. An
ordinary member/carrier signature cannot substitute for the required author.
Do not expose a generic op or bytes signer. This purpose has a fresh review,
one-shot token and per-use authentication distinct from each witness-claim signature.
Persist the signed frame in native retained history before releasing it through a
crash-safe fenced transaction; no signature escapes failed persistence. Explicit
later publication uses the ordinary member-authenticated carrier, with no network
action during signing. Legacy clerk artifact export remains unchanged.

RED/oracles additionally cover complete outer-op byte/ID/signature parity,
unconfigured author or member-key substitution, changed deps/epoch/certificate/cap,
insufficient or invalid surplus signatures, cross-purpose consent reuse, generation
changes during authentication/signing and every retain-before-release crash point.
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
admin/moderator/clerk allowlist and cross-role substitution; unknown authority
blocks; R03 lifted certificate, threshold and permitted fork/duplicate cases;
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

Implement D6: begin derives and binds the full native claim; unpredictable token,
proposed 60-second monotonic TTL, one pending attempt per native window/product/replica/key/
domain, actual native-resolved caller/session, atomic consume once, cancel/restart
invalidation. Check state generation and all release authorization immediately
before presence, after blocking presence/platform signing, and atomically with final
signature release. A signature computed after invalidation is discarded.
R22/R23 ceremony/accessibility measurements may revise the TTL through review;
an active attempt never extends itself. Admin/moderator prompt templates must name
the landed R04 action correctly, including current-holder renewal.

RED: bare claim/no token, token replay/expiry, wrong native window/session/product/
key/domain, supplied caller label, substitution, cancellation and second begin;
state change before presence, **during the blocking OS prompt**, during platform
signing and just before release; process death/restart; each yields no released
signature/artifact. Test two replicas sharing a root get different native replica
fingerprints, and all supported roles render correctly. Full review retains exact
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
accounting before RED. At either bound, durably block witness signing and show why;
no truncation, partial projection or old-subset signature. The carrier's recovery
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
unknown authenticated history discarded; missing/corrupt native store silently
reinitialized; state race releasing a signature; unsupported physical eligibility;
or a claim of global freshness/whole-store rollback resistance without a separately
reviewed mechanism. Preserve evidence and the offline preview.

The bounded grammar extension is explicitly in scope after R01b adoption; arbitrary
general CBOR or new Core authority semantics is not. Failure of the physical or
budget gate requires an explicit device/profile/lifecycle decision, never a silent
downgrade. Do not mark R36/R17b/R17c done from this document or a simulator result.
