# Native governance witness verification: R17a decision

Status: reviewable design, awaiting R01b adoption and implementation. Prepared
2026-09-06 at `641cbbd7` in `codex/treehouse-r17a-native-decision`, incorporating
Claude Fable's recommendation and the independent adversarial review. No native
feature, eligible Android profile or physical evidence is delivered by this packet.

**Recommend Option A: authenticate and retain the complete bounded signed history
natively, then reproduce the supported Core authority projection to derive each
claim.** A short bundle of signed acquisitions cannot prove their honored status
without equivalent authority evaluation; Option B is therefore rejected.

This answers [Plan 174](../../plans/174-governance-witness-verification-spike.md).
The [build roadmap](../../plans/roadmaps/treehouse-native-witness-build-2026-09-06.md)
assigns prompt repair, custody, verification, parity and physical gates separately.
The shared ledger and native-scope approval belong to the integrator.

## Existing proof and provenance

**BEAM verifier, two-sentence summary.**
`SuccessionCertificate.verify/3` validates an exact claim against its caller's
expected claim and checks the normalized policy, distinct known ordered witnesses,
domain-separated signatures and threshold. The claim becomes grounded in authority
state only when `Authority.decide_succession_proof/7` derives that expected claim
from the honored causal acquisition and current canonical-fold holder.

**Rust signer, two-sentence summary.**
The current signer checks a closed seven-field clerk claim, canonical key/digest
encodings and nonempty replica, requests presence, and checks the loaded seed's
public key against its sidecar. It does not verify the paired replica, policy,
holder acquisition or successor before signing, and the submitted replica shapes
the prompt.

| Hop | Verification today | Remaining assumption |
| --- | --- | --- |
| `local_log.ts:22-30`, persisted semantic cache | JSON parse and array shape | Operation signatures, IDs and contents are authentic; no omitted history |
| TS authority reduction | Embedded delegation signatures/IDs, chain/root rules and authority fold | Cache-loaded outer operations were authenticated |
| `authority.ts:325-405`, `deriveWitnessedSuccessionReview` | Derives holder/holderEpoch, successor, policyId, witness membership and frontier; compares a prior review | The input operation set is authentic and sufficiently complete |
| `township_actions.ts:279-334`, native invocation | App passes a structured claim | Caller actually followed review; direct IPC can bypass it |
| `governance_witness.rs:27-68` | Closed shape, version1, clerk role, canonical encodings | Semantic truth of all submitted fields |
| `lib.rs:729-778`, presence and sign | OS authentication, protected seed/sidecar match | Prompt identity is truthful; no native authority derivation exists |
| `native_workflow.ts:150-198`, response check | Recomputed payload digest and strict Ed25519 response verification | The signed claim was true |
| Later BEAM application | Judge-derived expected claim and certificate verification | This does not undo a misleading native review or exported signature |

Plan 174's assertion that no cryptographic check occurs until BEAM is stale:
delegation verification and the TS response verification already exist. Neither
authenticates every cache-loaded operation nor establishes native claim truth.

| Attack | Precondition and current outcome | Existing control |
| --- | --- | --- |
| Direct hostile claim | Compromised webview submits attacker successor; native can sign after presence | Shape checks only; no semantic authorization |
| Edited semantic cache | Cache write access supplies forged outer operations to derivation | Delegation checks catch some forgeries; outer cache load is unauthenticated |
| Cache rollback or omitted known branch | Old consistent input yields stale claim; native can sign it | No native retained-history comparison |
| Unpaired replica | Webview selects a syntactically valid foreign replica | No native pairing/policy check on sign |
| Prompt spoof | Newline, direction-control or oversized replica makes hostile request look routine | No filtering on this path |
| Replay or state race | Sign again, bypass review, or change state during authentication | Mutex serializes calls; it is not authorization |
| Whole native-store rollback | Attacker restores native data and its old integrity metadata together | No independent rollback anchor exists |
| Withheld unseen operation | Sync path never delivers a newer branch | No offline absence/completeness proof |
| Domain/alias confusion | Try carrier service or another signing purpose | Existing fixed clerk encoder and carrier alias/prefix refusal; preserve and extend |

## D1. Native authoritative state and custody boundary

Native owns the product binding, reviewed per-replica pin, witness public identity
and provider handle, retained signed-operation store, and outstanding ceremony
attempts. Claims, frontiers, policy/holder facts and display fields are derived
from those values; IPC cannot supply them as authority.

The pin binds the full replica ID, root commitment, verified root genesis,
application kind/schema and supported purpose/profile. The `#root:` suffix is
unpadded base64url SHA-256 of the root public key, not the public key itself and
not a unique group identifier. Native verifies the genesis audience against that
commitment. Distinct replicas may share a root key.

Establish the pin through native-reviewed enrollment/product bootstrap, binding
authenticated root and creation evidence to the fixed product schema. A deep-link
label, cache field or caller-provided kind cannot establish it. Without a trusted
kind/profile binding, signing stays off.

Current macOS custody is protected **seed retrieval**: Rust generates the seed
(`lib.rs:691-693`), and `load_seed` returns it into Rust memory before signing
(`lib.rs:755-776`). It is not a non-extractable hardware signing key. Preserve that
existing adapter's behavior while introducing an opaque provider interface;
Android eligibility requires generation and signing inside the platform provider,
with no private seed entering Rust, JavaScript, a database or a fallback keyring.

Native binding/history storage must be inaccessible through webview storage and
cache APIs and trusted against mutation within this threat model. Preserve it
across restart and crash; an existing key plus missing, corrupt or mismatched pin/
store refuses readiness and signing instead of creating a new empty history.
Whole native-store compromise/rollback remains outside the proved boundary.

## D2. Authentication, closure and proof mechanisms

Authenticate **all supported signed operations**, including `command`, `inbox`,
`authority` and `tombstone`, their body/cap terms and complete dependency closure.
Posts, edits and application tombstones routinely lie in authority ancestry;
rejecting them or retaining only authority-kind ops makes the design unusable.
Recognized application bodies may remain opaque to the authority projection:
their bytes, IDs, signatures and DAG position are verified without claiming their
application verdict or materializing their CRDT effects.

Port the existing closed `CarrierTerm` grammar: nil, boolean, nonnegative integer,
binary, atom, list, tuple, map, mapset and v2/v3 delegation; preserve current op
canonicalization and signature acceptance. Authenticate complete opaque application
terms with that grammar, not an authority-only body encoder. Exact parser limits,
integer acceptance, sorting, duplicate rejection, encodings and malformed-term
outcomes must match the landed BEAM/TS contract, including R07/R09/R03 changes.
No arbitrary general CBOR, dynamic code, general-purpose signing or new substrate
term is authorized.

| Element | Native mechanism and current gap |
| --- | --- |
| Frame/operation | Strict bounded decoding, canonical op bytes, recomputed ID and strict Ed25519; Rust lacks this complete path today |
| Replica/root | Native pin plus valid root genesis/delegation whose audience hashes to the commitment; never infer key from the suffix |
| Delegation | Recompute v2/v3 signed bytes and ID; preserve replica, parent, attenuation, introduction and honored-candidate activation rules |
| Policy | Existing role policy merges valid root geneses in canonical order; v1 policyId hashes the normalized four-key recovery map, not genesis bytes. R03 beacon policy is resolved per candidate ancestry |
| Holder/acquisition | Evaluate honored acquire/transfer/succeed timeline, causal holder-at-deps and canonical-fold holder; preserve competing-branch rejection reasons |
| Frontier | Compute from the complete admitted verified DAG; relevant missing dependencies block signing, while unconnected evidence stays outside it under the fixed-point admission rules below |
| Freshness | Retained evidence prevents caller omission of already known history; it proves neither unseen completeness nor wall-clock freshness |

Distinguish storage admission from semantic judgment:

- Structurally malformed, oversize or signature/ID-invalid input is refused before
  admission and contributes no trusted operation. No signature or artifact is produced.
- An authenticated supported operation is retained even if semantically quarantined.
  Its known authority verdict is reproduced; ordinary application verdicts are not
  invented. Known shapes proved inert by the fixed pinned grammar remain supported;
  today's temporary quarantine alone cannot establish permanent inertness.
- Unknown authority variants, policy versions and schemas use the conservative
  eligibility closure below. Relevant unknown or incomplete evidence durably blocks
  signing. Unconnected unknown input and its unconnected supported descendant cones
  remain staged outside the admitted frontier. A fresh self-signed key cannot cause
  a permanent signing block merely by sending an unknown op or a supported wrapper
  that depends on it.

**Eligibility closure E is evidence of cryptographic introduction, never permission.**
Compute the least fixed point over all retained authenticated evidence, including
staged supported evidence whose DAG is incomplete. Seed E with the pinned root and
the witness/nominee keys in every retained root-authenticated recognized profile,
including superseded profiles. This explicitly includes each recognized legacy
role policy's designated `successor` and the witness keys in its v1 four-key
recovery map, as well as R04's nominee and R03's witnesses. Extend E through verified same-replica delegation
introductions with canonical signed ID, issuer already in E, and complete parent
proofs satisfying the existing issuer/audience and attenuation rules. A recognized
parentless succession/continuation delegation whose issuer equals its audience and
is already in E supplies a conservative chain anchor; it adds no new key itself.

These positive rules do not depend on current acquisition winners, effective pin,
revocation, lease expiry, candidate activation or semantic quarantine. They are
monotone for the same retained evidence union. The embedded delegation signature
introduces its actual audience even if a different key authored the outer operation.
Citing a public capability for another audience introduces neither the citing
author nor any dependency author. Unknown ancestry never expands E, and missing
parent proofs remain unresolved instead of being guessed. Supported staged
introductions must be inspected before DAG admission to avoid a closure deadlock.

Reclassify retained evidence to that fixed point before derivation and before the
serialized release check. Unknown evidence authored by E, and unknown or missing
ancestry of authenticated E-authored supported evidence, blocks durably. Unresolved
parent evidence needed for an otherwise E-issued introduction also blocks; using a
different outer carrier cannot hide an authenticated relevant issuer. Unconnected
supported descendants with missing dependencies stay staged, so wrapping an unknown
op in a fresh-key supported command cannot bypass the eligibility boundary.

A later verified introduction or E-authored descendant atomically promotes relevant
staged evidence or persists its block before any claim is derived. Omitting retained
evidence on a later request or restarting cannot restore signing over an older
subset. A reviewed compatible implementation and complete revalidation, never
dropping relevant evidence, clears an unsupported-history block. No transport peer
or caller-supplied trust flag participates in this decision.

This intentionally permits conservative overblocking by historically introduced,
revoked or quarantined keys. An eligible author that signs an ancestry citation of
unknown evidence also causes a block, including an honest author's automatic
frontier citation. The repair prevents an unintroduced key from qualifying itself;
it does not prove availability against eligible signatures. Unknown future
introduction semantics are outside this pinned-version proof.

Reserve a separate staging subquota (proposed 128 operations / 512 KiB), plus
capacity for admitted history, promotion, intake and durable markers within the
overall ceiling. A full unconnected staging quota refuses new unconnected input
without evicting retained evidence or blocking otherwise complete admitted history.
Quota-refused bytes are not trusted retained observations and cannot later be
reclassified from storage. Resubmitting identical bytes once connected is a fresh
admission, not a persistent per-bytes denylist. Order independence covers the same retained union, not different
quota-dependent admission sets. Pin exact accounting and reservation sizes in R17b
before RED, including a full-staging promotion case.

This explicitly refines R04's unconditional unknown-history admission block and
the earlier R17 missing-dependency rule. R17b must record the same scoped amendment
in R04's native boundary before implementation; the landed Core judge, signed
bytes and verdict semantics remain unchanged.

Thus unsupported-history refusal may write retained evidence and blocking state.
The guarantee is **no signing effects**, not zero store writes. Persist observation
and generation atomically before successful admission; a failure cannot report
trusted acceptance or permit a subsequent stale signing attempt.

R17b reserves durable capacity for its admission journal as well as incomplete,
over-budget and pending-input records. One atomic durable write stores an admission
fence **and the complete bounded batch bytes** (or a digest referencing bytes made
durable in that same transaction). The store API cannot construct a fence without
recoverable input. The provisional intake batch ceiling is 64 frames / 512 KiB,
within the overall retained-byte budget; each frame still obeys the carrier limit.

Only classification of that exact journaled batch clears its fence: completed
untrusted-input refusal, committed supported observation, pending-journal retention
or durable block. Restart replays the same classification before enabling signing;
an unrelated retry or different batch cannot clear it. An unreadable or mismatched
journal is a corrupt-store refusal. Admission failures preserve the old committed
state and recoverable batch; an ordinary crash cannot silently forget a verified
unsupported observation or permanently strand a readable valid intake journal.

## D3. Rollback, omission and durable limits

Keep an append-only union of retained verified observations, including staged input,
competing branches and quarantined operations. Derivation first classifies that
entire union under D2, then reads its complete admitted DAG, never an IPC-selected
subset. Replaying an older cache cannot erase known revokes, policies
or acquisitions; dependency pruning cannot erase retained ancestry. A valid new
fork remains a fork and is judged under Core rules, not refused merely because
its dependencies exclude an unrelated newer beacon.

Acquisition and policy hashes have no scalar time ordering. Native store generation
is only an internal race token, not a semantic frontier, global epoch floor or
rollback-resistant counter. A MAC, encrypted database or app-private path cannot
detect restoration of the whole old store and its matching metadata. This design
introduces no independent monotonic anchor. Unknown withheld operations also
remain unknowable offline; signatures prove a decision against retained evidence.

## D4. Architecture choice and exact projection boundary

Option A adds a third implementation of the needed authority slice and its byte
verification. It proves native derivation over authenticated retained history
under the matched Core rules, assuming the trusted native store and delivery limits
above; the conformance cost is substantial and belongs to R17b's atomic cutover.

Option B would verify a compact signed acquisition/genesis bundle without evaluating
authority. Signatures alone cannot establish whether a transfer was honored:
`authority.ex:871-888` rejects validly signed transfers for invalid authority,
non-holder authorship and competing transfers; `930-955` also checks causal and
fold holders. Multiple valid geneses merge policies, and candidate activation
depends on honored succession. No trusted semantic producer or proof-of-execution
system exists here. A bundle that independently decides these facts needs equivalent
evaluation; trusting its sender would add a new authority. This is why A is selected.

**2026-09-06 comparison completion (Plan 174 step 4).** The following evaluates
both candidates against all six decisions. Option B here is the proposed signed
frame/acquisition bundle, not an existing proof-of-honored-history protocol.
No such independently verifiable semantic proof or trusted producer is adopted.

| Decision / cost | Option A — selected native projection | Option B — rejected compact bundle |
| --- | --- | --- |
| 1. Authoritative native state | Native product/root pin plus the complete retained union, D2 admission classification and the matched authority projection. The browser cache is input, never authority. | Native product/root pin plus retained authenticated bundle bytes and references. These can establish signer/root identities but supply no authoritative honored holder/policy projection; a producer's semantic assertion is not authoritative. |
| 2. Frames, replica, policy, frontier and freshness | D2 verifies canonical bytes, IDs, signatures, root/replica and complete supported ancestry, then derives policies/acquisitions and frontier from the classified union. Freshness means the retained evidence at review/release, not current global history or elapsed time. | Verify canonical bytes, IDs, signatures and root binding of supplied frames, plus any explicitly checked static chain constraints. That proves authentic supplied evidence, not an honored transfer, effective merged policy or complete frontier. A signed bundle timestamp, nonce or epoch does not prove missing competitors/revocations absent. No compact semantic/completeness proof exists here. |
| 3. Rollback and omission | D3's retained union prevents an IPC retry from erasing known history; generation checks prevent local review/sign races. Whole-store rollback and unseen withheld operations remain undetectable without an independent anchor. | Could retain every accepted bundle/reference and bind review to that store generation, so replay cannot erase already retained bytes. It still cannot determine the authoritative history from those bundles without semantic evaluation, prove global completeness, or detect restoration of the whole old store. A MAC or local counter alone does not close those gaps. |
| 4. Evaluation versus proof | Port only the needed landed Core authority rules after authenticating all supported history, with explicit refusal parity. No application CRDT materialization. | A sound independent proof must establish the same causal/current-holder, competing-acquisition and policy facts. Checking the full rules collapses into A; accepting a trusted producer adds a new trust authority; a succinct execution proof needs a new specified proof system. None is supplied or adopted by the compact bundle proposal. |
| 5. Native review and OS prompt | D5 derives every identity/role/purpose field from native verified state, uses fixed allowlisted labels and bounded fingerprints, and exposes full escaped values in native review. Missing verified fields refuse before presence. | Authenticated bundle identity may be shown as such, but its claimed holder, effective policy or successor cannot be labeled verified. The same safe rendering and bounds are necessary; until the missing semantic proof exists, the required verified recovery review cannot be formed and signing must refuse. Presence cannot turn an authentic bundle into a true claim. |
| 6. Direct IPC authorization | D6 uses explicit native review acceptance, caller/session/product/replica/key/domain/claim/generation binding, one-shot expiring tokens and post-blocking-work checks through serialized release. Bare claims and substitutions refuse. | Would require the same native caller/session binding, review acceptance, exact claim-plus-proof digest/store-generation binding and one-shot release controls. A valid token authorizes only the verified intent; it cannot compensate for absent semantic proof, so a syntactically valid bundle/token is insufficient to sign. |
| What is proved / assumed | Proves native derivation over the retained authenticated union under matched Core rules. Assumes native code/custody integrity and the stated observation/store limits; no trusted semantic relay or proof producer. | Proves authenticity of the included signed statements and any checked chain facts. Honored state, completeness and freshness would remain assumptions if the sender were trusted. That additional producer trust is explicitly rejected, not silently supplied by a signature. |
| Conformance and build size | Substantial third-runtime canonical/authority implementation: R17b Stages 3–5 must land atomically, with BEAM/TS/Rust bytes, refusal and semantic oracles; R36/R17c custody and physical work remain separate shared costs. | An authenticity-only bundle parser/verifier would be smaller, with canonical/signature/chain parity, but would not satisfy the ceremony. A sufficient alternative needs a new proof specification, producer/prover, verifier, trust/completeness/rollback model and semantic adversarial corpus; its cost and feasibility are unmeasured, with no demonstrated reduction over A. No existing honored-history oracle or completed proof implementation is claimed. |

The compact bundle's missing semantic proof can be identified from the existing
judge by inspection; no prototype or benchmark was needed to choose A. This
comparison does not authorize building Option B, a new semantic producer or a
new proof system. **Option A remains the single recommended architecture.**

Project only the authority facts needed by each supported signing purpose:
root/policy resolution, delegation validity/attenuation/activation, honored role
timeline, revocation and beacon facts where the landed judge consumes them. Current
capability revocation/lease expiry does not erase a holder acquisition; do not add
that rule. Do not materialize application CRDTs, endorse command effects or use a
relay's semantic verdict. R17b must match **landed R03 and R04** semantics and
per-purpose claim definitions before enabling those purposes; this record does not
guess R04's future continuation claim or turn R02's candidate into native authority.

The native pin selects a fixed product/kind/role allowlist:

| Product and verified replica kind | Supported role/purpose |
| --- | --- |
| Township / `Township.Matter` | `clerk` succession; retain exact legacy clerk payloads |
| Treehouse / `Treehouse.Space` | `admin`, using the approved landed Core profile |
| Treehouse / `Treehouse.Thread` | `moderator`, using the approved landed Core profile |
| Approved per-replica beacon pin | Beacon witness purpose, separate from role succession |

**Legacy clerk consent remains frontier-unbound.** Its frozen seven-field claim
binds the succession tuple, holder acquisition and policy, but no deps, epoch basis
or native-store generation. Review, token and generation checks govern creation of
the signature; they add nothing to its signed bytes. A released artifact remains
usable wherever Core derives that same seven-field claim, including later history
or signatures collected over different frontiers. No Treehouse-strength consent
claim may cite it. R04 continuation and R03 beacon claims bind their own exact deps;
Township frontier-bound succession would require a separately adopted new domain,
purpose and Core verifier. Preserve legacy bytes and disclose their actual scope.

An IPC role string or replica name prefix cannot choose the schema or signing
domain. Unknown product/kind/role refuses. Add admin/moderator byte and semantic
vectors after their Core contracts land; preserve legacy clerk bytes. Beacon claims
remain in their distinct domain with R03 author/deps binding, ancestry policy,
step/horizon bounds and permitted fork/duplicate semantics. Presence/possession
binding uses another fixed domain; none exposes arbitrary signing.

**Shared beacon author selection.** A beacon witness-claim intent can select one
proposed outer author from the natively verified pinned witness set. All other
claim values are native-derived: the exact canonical frontier of admitted history,
the pinned replica, version and next valid epoch. The native purpose chooses one
epoch beyond the admitted valid causal maximum, refusing beyond R03's horizon or
profile step bound; the separately adopted R14 cadence governs when a human starts
the ceremony, not a hidden wall clock. Echoed deps/epoch may be compared for exact
equality but cannot select an older retained subset or missing evidence.

Every witness sees and accepts the same proposed outer author. Different admitted
frontiers require synchronization before witnesses can produce identical claims;
signatures over different author/deps/epoch values cannot form a certificate. The
full native review labels the outer-author key separately from the local approving
witness. Final-operation signing additionally requires that selected author to be
this device's own configured witness key. This selects an available consenting
witness without a fixed lowest-key availability dependency or a generic author IPC.

R03 also requires a founder-absent beacon's **outer operation author** to be a
configured witness key. Claim signatures alone are insufficient, and substituting
the member/carrier key cannot satisfy that rule. Add a separate fixed native
final-beacon-operation purpose: derive the pinned replica, current exact deps,
local witness public key and epoch; verify the complete threshold certificate
against that independently derived claim; construct only the existing
`:authority` body `{:beacon, epoch, certificate}` with `cap: nil`; then sign the
existing canonical operation bytes with that same protected witness key. No
caller-selected author, capability, body, arbitrary op or signing bytes is admitted.

This operation requires its own native review, one-shot token and fresh per-use
platform authentication, including all D6 checks after blocking work. Its review
says **sign beacon operation** and shows the verified epoch and certificate
signers; it is distinct from signing a witness claim. Persist the successfully
signed frame and a pending-release outbox entry in one authorized atomic commit
before any IPC response. The entry holds only the op ID, purpose, creation
generation and advisory publication state; there is at most one per retained
signed frame and its bytes count inside the same ceiling. An authenticated
same-product caller can enumerate entries and retrieve identical committed frame
bytes after restart, without new signing, presence or consent. A crash after
commit but before response therefore loses no publication input.

The atomic commit is the release-authorization point: all D6 checks must pass in
the serialized transaction. Cancellation before it prevents commit; cancellation
after it cannot retract an already authorized artifact. An uncommitted outgoing
signing attempt is aborted on restart, never automatically authorized from an
old token or confused with replay of an incoming admission journal. Failed commit
produces no retrievable outbox entry and releases no signature.

The existing carrier has no signed durable-publication receipt for this purpose.
A webview's published report is only an advisory annotation, never proof or
permission to delete the entry. Entries remain retrievable for the retained
history's lifetime and never block subsequent signing merely because publication
is unconfirmed. Duplicate publication is idempotent. The returned or recovered
frame still needs ordinary member-authenticated carrier publication. Signing and
retrieval open no network connection; no remote durability claim is invented.
Legacy clerk artifacts and their export-only behavior stay unchanged. R17b must
prove exact BEAM/TS/Rust outer-op bytes, wrong-author/member-key refusal,
certificate/deps substitution, replay and crash boundaries. Count this additional
per-use authentication in R02/R14 workload estimates and physical measurements.

**Scoped Plan 146 Seam 5 extension:** R17b may implement the bounded existing
CarrierTerm/op grammar needed to authenticate complete history. The old restriction
to one fixed clerk payload cannot apply to that verifier. Its replacement gate is
exact BEAM/TS/Rust bytes, IDs and rejection parity for the closed current grammar,
while fixed per-purpose signing encoders and legacy clerk bytes remain unchanged.
No broad general CBOR stack or Core semantic change follows from this extension.
Record the precise amendment in Plan 146 with R17b before that implementation.

## D5. Native review and one-line OS reason

The full native-controlled review displays product, complete replica/pin and kind,
role/purpose, witness and successor keys, holder acquisition or exact beacon epoch,
profile, dependencies and lease consequences. A compromised webview cannot replace
those fields. A caller's candidate claim may be compared for equality but never
supplies a missing verified value. Missing verified identity refuses before presence.

Authenticated strings are not display-safe by virtue of their signatures. Every
free-form value appears in a fixed-label, visually isolated monospace field with
its full SHA-256 fingerprint and exact original byte count always visible.
Newline, control and Unicode direction characters render as explicit codepoint
escapes, never as layout or direction instructions. The proposed initial viewport
is at most 256 rendered UTF-8 bytes with an explicit continuation indicator; the
exact escaped full value remains accessible in bounded scrolling chunks of at most
4 KiB. Rendering must remain bounded by the admitted input sizes and must refuse
before presence if the full value cannot be displayed safely. No silent truncation,
WebView-provided label or inserted structure is permitted. Raw byte identity, not
the escaped display, remains the signed value.

For legacy clerk review, state explicitly that the artifact authorizes the shown
succession while its seven-field tuple remains applicable; displayed dependencies
are not bound by its released signature. A full review cannot imply a stronger
claim than its domain encodes.

Use these one-line OS templates; `P`, `R`, `S` and `H` come from native state:

```text
Treehouse Space R:abcdefghijkl admin recovery to S:abcdefghijkl H:abcdefghijkl
Treehouse Thread R:abcdefghijkl moderator recovery to S:abcdefghijkl H:abcdefghijkl
Township Matter R:abcdefghijkl clerk recovery to S:abcdefghijkl H:abcdefghijkl
Treehouse Space R:abcdefghijkl beacon epoch 12345
Treehouse Thread R:abcdefghijkl beacon epoch 12345
```

For a Treehouse beacon, select the Space or Thread template from the natively
verified pinned replica kind. Never infer it from submitted claim text, a replica
name prefix or a hard-coded Thread default. A missing, unsupported or mismatched
product/kind refuses before presence; another beacon product/kind needs its own
adopted allowlisted template. This applies to both beacon witness review and the
separate final-beacon-operation review without merging their signing purposes.

R is the first 12 base64url characters of SHA-256 of the **full pinned replica ID**;
S is the same fingerprint of the verified successor public key; H is the first
12 characters of the verified acquisition ID. Full values appear in the native
review; abbreviated display is not authorization or unique identity proof. Product,
kind and role labels come only from the fixed native allowlist. Beacon epoch is
the exact verified integer. Assert printable ASCII, no newline/control/direction
characters, and **strictly fewer than 200 UTF-8 bytes** for the whole reason;
construction failure refuses before presence.

The independent first commit changes today's unsafe prompt to the fixed one-line
`Sign Township clerk recovery witness`. It interpolates no unverified identity
and claims no native semantic verification. Adversarial input tests prove that
controls, Unicode direction overrides and long replica strings cannot affect it.
The full verified template activates only with the R17b cutover.

The admin/moderator templates are provisional until R04 lands: current-holder
renewal must say renewal and display its actual verified intent, rather than
presenting every continuation as recovery to a successor.

## D6. Native authorization, token lifetime and races

`begin` selects an already pinned replica and supported purpose, with only the
closed beacon outer-author selection described in D4 where applicable. Native
resolves the actual runtime window/caller/session and product, derives the claim
and opens a **displayed, unaccepted** review. Its proposed display timeout is
120 monotonic seconds. No signing token is issued yet, and no IPC message can
synthesize acceptance of the native-controlled review surface.

An explicit native UI acceptance rechecks caller/session, generation and the
re-derived claim against the display. Any change requires a new review; accepting
a stale display refuses. Only then is an unpredictable token activated, bound to
canonical claim bytes, domain/profile, replica, witness key, caller/session and
generation. Its proposed 60-second monotonic TTL starts at acceptance and covers
the entire remaining attempt. A supplied session label is never authentication.
One attempt is allowed per native window/product/replica/key/domain; replacement
begin invalidates the previous display and token. Sign refuses an unaccepted or
missing token before any platform work, and consumes an accepted token exactly
once before any signing attempt. Cancellation, dismissal, session teardown
and process restart invalidate pending/in-flight release authorization. Re-signing
requires a new native review, token and fresh per-operation OS authentication.
R22/R23 ceremony and accessibility measurements may motivate a reviewed change to
either timeout; expiry always fails closed and an active attempt never extends itself.

Check token expiry, cancellation, session, identity and store generation immediately
before presence/platform signing, then **again after every blocking presence or
platform-sign operation and immediately before signature release**. Serialize the
final generation check with release; an update cannot slip between them. If state
changes while the OS prompt is open or while hardware signs, discard any resulting
signature and release no artifact. Presence and the signing mutex do not substitute
for these checks. Durable history may have advanced even though no signature escapes.

These are signing-time controls. After the authorized release point, only the
fields in the signed domain remain bound; legacy clerk artifacts have D4's
explicit frontier-unbound consequence. For an outgoing frame, atomic durable
history/outbox commit is that release point, and recovery returns the already
authorized bytes rather than creating a new artifact under an expired token.

At atomic cutover remove/refuse claim-only `lattice_sign_governance_witness` and
migrate all callers together. Bare claims, expired/replayed tokens, wrong caller,
window, product, purpose or key, stale generation and substituted claims refuse.
There is no temporary compatibility path that can bypass native derivation.
The separate final-beacon purpose binds its token to the complete canonical op
and certificate as well as the store generation. Claim-signing consent cannot
authorize the outer signature. Successful frame retention and the final release
check and outbox write form one serialized transaction; its own append must not
be mistaken for an unrelated generation race. Restart aborts an uncommitted
outgoing attempt; a committed attempt remains retrievable through D4's outbox.
Incoming admission-journal recovery is a separate transaction type.

## Android eligibility and evidence order

**2026-09-06 eligibility correction:** this documentation-only amendment makes
R17a/R36's existing opaque Ed25519 requirement executable against the public
Android API. It supplies no native implementation or physical eligibility result.

Android 13/API33 supplies the Ed25519 signing path, with Curve25519 hardware
support introduced by KeyMint v2. Use
`KeyPairGenerator.getInstance("EC", "AndroidKeyStore")` with
`KeyGenParameterSpec` and `ECGenParameterSpec("ed25519")`; the explicit
`"Ed25519"` generator alias was added later. Do not initialize this provider with
bare `NamedParameterSpec`, infer hardware eligibility from an API level or alias,
or fall back to another provider. The selected device must pass the full combined
probe below. [Android13 generator](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/keystore/java/android/security/keystore2/AndroidKeyStoreKeyPairGeneratorSpi.java),
[Android13 signing provider](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/keystore/java/android/security/keystore2/AndroidKeyStoreBCWorkaroundProvider.java),
[later generator alias](https://android.googlesource.com/platform/frameworks/base/+/2c68aa6bc7d30124fd27a1d00508722823e1768e).

This Ed25519 profile targets TEE (`TRUSTED_ENVIRONMENT`). AOSP excludes
Curve25519 from StrongBox; do not request StrongBox or use its feature flag as
eligibility evidence. Generate with `PURPOSE_SIGN` and `DIGEST_NONE`, not key
agreement or `PURPOSE_ATTEST_KEY`. Attestation of this signing key is requested
through the generation challenge; making the witness an attestation signing key
is a different purpose. [Pinned KeyMint contract](https://android.googlesource.com/platform/hardware/interfaces/+/c07fb30b8f0d50fe8f800562cff42de5a8dc8188/security/keymint/aidl/android/hardware/security/keymint/IKeyMintDevice.aidl).

R01b first adopts this fail-closed eligibility contract and native scope. R36 then
runs preliminary eligibility on the proposed physical devices **before key pinning**;
R14 enrolls/pins only eligible identities. R17c later supplies independent physical
proof of the exact integrated ceremony. An R36 probe cannot be a prerequisite fed
back into the earlier R01b approval, and preliminary custody is not final R17c proof.

Eligibility requires actual platform Ed25519 generation and a fresh, key-bound,
per-operation authenticated signing round trip with no seed transit or software
fallback. An independent validator must check the fresh generation challenge at
initial provisioning, the actual witness public key, chain signatures, current
trusted roots/revocation, and the correct
first trustworthy attestation extension; it must not blindly inspect only the leaf.
[Android attestation validation](https://developer.android.com/privacy-and-security/security-key-attestation).

Require both attestation and key security level (KeyMint/Keymaster field for the
schema version) to be TEE for this profile, generated origin, Ed25519/signing
purpose, hardware-enforced per-use authentication rather than a reusable time window, and
the expected app package/signing-certificate identity and locked verified boot
state. Inspect software/hardware authorization lists according to their actual
schema; an absent or inconsistent required property fails eligibility. Match the
attested public key to the key that passes the fresh signing challenge.
[Attestation field schema](https://source.android.com/docs/security/features/keystore/attestation).

Request `setUserAuthenticationRequired(true)` and
`setUserAuthenticationParameters(0, selectedAuthenticators)`, and bind the actual
`Signature.getInstance("Ed25519")` operation to `BiometricPrompt.CryptoObject`. The selected
strong-biometric/device-credential policy must be recorded and tested; a bare
prompt success, recent unlock, or weak biometric is not a substitute. In the
KeyMint authorization schema, per-use authentication has hardware-enforced
`USER_AUTH_TYPE`, absent `NO_AUTH_REQUIRED` and absent `AUTH_TIMEOUT`; the public
API's timeout `0` does not mean an attested timeout field containing zero.
`USER_SECURE_ID` is deliberately non-attested and must not be required in the
certificate. Require positive authentication evidence and reject inconsistent
lists; these documented absences do not permit absent authentication requirements.
[Pinned authentication parameter translation](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/keystore/java/android/security/keystore2/KeyStore2ParameterUtils.java),
[pinned KeyMint tag semantics](https://android.googlesource.com/platform/hardware/interfaces/+/c07fb30b8f0d50fe8f800562cff42de5a8dc8188/security/keymint/aidl/android/hardware/security/keymint/Tag.aidl),
[attestation field schema](https://source.android.com/docs/security/features/keystore/attestation).

Persist the original generation attempt, validator challenge, exact certificate
chain and public-key binding with the create-only identity. Public
`setAttestationChallenge` is a generation parameter, not an API for refreshing an
existing key's attestation. On retry or restart, reconcile that retained attempt
and chain and require a fresh single-use possession challenge under the same key;
do not regenerate it to obtain a newer attestation. The initial challenge must
have been issued for that exact retained attempt; a stale or unrelated supplied
chain still refuses. [Pinned generation specification](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/keystore/java/android/security/keystore/KeyGenParameterSpec.java).

Attestation describes generation-time key authorizations, app identity and boot
state. Fresh possession proves current use of that same key under its enforced
authentication policy; it does not freshly attest every later OS/app/boot state.
Recheck trust/revocation and retain this limitation in restart and exact-candidate
evidence. If required current-state evidence is unavailable, report incomplete
eligibility instead of reinterpreting old attestation as current. The R17c physical
ceremony and exact candidate checks remain separate and mandatory.

This is a proposed eligibility requirement, not proof a selected device satisfies
it. R36 records failure as unsupported/incomplete, publishes no eligible key and
does not pin or silently regenerate it; R12's offline preview remains available.
Generation/probing can leave explicit incomplete native custody state, which must
be reconciled visibly rather than described as zero writes. Record enrollment
change/invalidation, reboot, lockout and cancellation behavior on the actual profile.

Product namespaces derive from native-bound `products.json`. Treehouse governance
must be distinct from both Treehouse carrier custody and Township governance;
carrier/witness alias refusal works in both directions. Only public identity and
attestation metadata may be exported without signing; a possession operation signs
only a native-issued fixed domain-separated binding challenge. The exact challenge
and attestation validation workflow must have independent replay/substitution tests.

## Proposed budget, non-claims and validation

Propose a witness ceiling of **8,192 operations or 16 MiB per replica**, counting
all retained signed history, pending evidence and relevant durable overhead, not
only governance events. Include admission-journal bytes, reserved promotion and
blocking metadata, and retained outbox pointers without double-counting their
referenced frame. Define exact byte accounting and reservations in R17b before
testing. Exhausting only unconnected staging refuses that input as D2 specifies;
exhausting admitted/relevant capacity persists a visible signing-blocked condition.
Never truncate relevant history to sign an old subset. This ceiling does not stop
the carrier from
retaining bounded recovery input. Healing can exceed it; there is no guarantee
that every posting-stop overshoot fits. R35 owns the resulting lifecycle decision.

Propose full verification/projection of **5,000 operations / 10 MiB within five
seconds**, and one appended-operation update within **500 ms**, on the minimum
supported physical profile. These are unmeasured acceptance targets; failing them
blocks readiness and returns the budget/profile to review, not partial verification.
Also measure a cold run just below the retained ceiling, plus an at-ceiling refusal
run, against the same proposed five-second bound before R17b readiness. Passing
the smaller corpus cannot conceal an unusable restart near the retention limit.

Even after implementation, no claim covers whole-native-store rollback, unknown
withheld operations, trusted time, user comprehension, human identity, witness
independence/honesty, non-coercion or OS/TEE compromise. One witness artifact remains
subthreshold. macOS choreography is not Android custody/presence evidence.

No prototype was needed to select A over the unsound proof shortcut. Code and
primary documentation were read; device feasibility and latency are deliberately
build/profile gates, with no measurements asserted here. This packet changes only
the decision, follow-on roadmap and scoped Plan 174 evidence amendment.
