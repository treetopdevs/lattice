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
| Frontier | Compute from the complete retained verified DAG; missing dependencies block signing until closure is restored |
| Freshness | Retained evidence prevents caller omission of already known history; it proves neither unseen completeness nor wall-clock freshness |

Distinguish storage admission from semantic judgment:

- Structurally malformed, oversize or signature/ID-invalid input is refused before
  admission and contributes no trusted operation. No signature or artifact is produced.
- An authenticated supported operation is retained even if semantically quarantined.
  Its known authority verdict is reproduced; ordinary application verdicts are not
  invented. Missing dependencies remain bounded pending evidence and block derivation.
- An authenticated unknown authority variant, policy version or relevant schema is
  durably retained with a signing-blocked marker. Omitting it on a later request or
  restarting must not restore signing over the older subset. A compatible reviewed
  implementation and complete revalidation, not dropping evidence, clears the block.

Thus unsupported-history refusal may write retained evidence and blocking state.
The guarantee is **no signing effects**, not zero store writes. Persist observation
and generation atomically before successful admission; a failure cannot report
trusted acceptance or permit a subsequent stale signing attempt.

R17b must reserve bounded durable space for incomplete/over-budget markers and
write an admission-in-progress fence before verifying a new batch. Clear it only
with a completed untrusted-input refusal, committed observation or durable blocked
outcome; restart with an
uncleared fence refuses signing. This prevents a failed persistence step from
turning already verified unsupported input into a silently forgotten observation.

## D3. Rollback, omission and durable limits

Keep an append-only union of verified observations, including competing branches
and quarantined operations. Derivation always reads that native union, never an
IPC-selected subset. Replaying an older cache cannot erase known revokes, policies
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

An IPC role string or replica name prefix cannot choose the schema or signing
domain. Unknown product/kind/role refuses. Add admin/moderator byte and semantic
vectors after their Core contracts land; preserve legacy clerk bytes. Beacon claims
remain in their distinct domain with R03 author/deps binding, ancestry policy,
step/horizon bounds and permitted fork/duplicate semantics. Presence/possession
binding uses another fixed domain; none exposes arbitrary signing.

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
signed frame as known native history before release, using the same crash-safe
admission fence; failed persistence releases nothing and leaves signing blocked.
The returned frame still requires explicit publication through the ordinary
member-authenticated carrier path. Signing itself opens no network connection.
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

Use these one-line OS templates; `P`, `R`, `S` and `H` come from native state:

```text
Treehouse Space R:abcdefghijkl admin recovery to S:abcdefghijkl H:abcdefghijkl
Treehouse Thread R:abcdefghijkl moderator recovery to S:abcdefghijkl H:abcdefghijkl
Township Matter R:abcdefghijkl clerk recovery to S:abcdefghijkl H:abcdefghijkl
Treehouse Thread R:abcdefghijkl beacon epoch 12345
```

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

`begin` accepts only an intent selecting an already pinned replica and supported
purpose. Native resolves the actual runtime window/caller/session and product,
derives the claim, shows the full native review, and creates an unpredictable token
bound to canonical claim bytes, domain/profile, replica, witness key, caller/session
and retained-store generation. A caller-supplied session label is not authentication.

Use a proposed **60-second monotonic TTL**, starting at token creation and covering the whole
attempt. Permit one pending attempt per native window/product/replica/key/domain;
replacement begin invalidates the prior token. Sign atomically consumes the token
once before any platform signing attempt. Cancellation, dismissal, session teardown
and process restart invalidate pending/in-flight release authorization. Re-signing
requires a new native review, token and fresh per-operation OS authentication.
R22/R23 ceremony and accessibility measurements may motivate a reviewed change to
this constant; expiry always fails closed and an active attempt never extends itself.

Check token expiry, cancellation, session, identity and store generation immediately
before presence/platform signing, then **again after every blocking presence or
platform-sign operation and immediately before signature release**. Serialize the
final generation check with release; an update cannot slip between them. If state
changes while the OS prompt is open or while hardware signs, discard any resulting
signature and release no artifact. Presence and the signing mutex do not substitute
for these checks. Durable history may have advanced even though no signature escapes.

At atomic cutover remove/refuse claim-only `lattice_sign_governance_witness` and
migrate all callers together. Bare claims, expired/replayed tokens, wrong caller,
window, product, purpose or key, stale generation and substituted claims refuse.
There is no temporary compatibility path that can bypass native derivation.
The separate final-beacon purpose binds its token to the complete canonical op
and certificate as well as the store generation. Claim-signing consent cannot
authorize the outer signature. Successful frame retention and the final release
check form one serialized transaction; its own history append must not be mistaken
for an unrelated generation race, and a crash before completion leaves a fence.

## Android eligibility and evidence order

Current AOSP registers an ED25519 key generator. That does not establish an API33
hardware guarantee or demonstrate Ed25519 plus per-use authentication and
attestation on the selected device. [AOSP provider change](https://android.googlesource.com/platform/frameworks/base/+/2c68aa6bc7d3).

R01b first adopts this fail-closed eligibility contract and native scope. R36 then
runs preliminary eligibility on the proposed physical devices **before key pinning**;
R14 enrolls/pins only eligible identities. R17c later supplies independent physical
proof of the exact integrated ceremony. An R36 probe cannot be a prerequisite fed
back into the earlier R01b approval, and preliminary custody is not final R17c proof.

Eligibility requires actual platform Ed25519 generation and a fresh, key-bound,
per-operation authenticated signing round trip with no seed transit or software
fallback. An independent validator must check the fresh challenge, actual witness
public key, chain signatures, current trusted roots/revocation, and the correct
first trustworthy attestation extension; it must not blindly inspect only the leaf.
[Android attestation validation](https://developer.android.com/privacy-and-security/security-key-attestation).

Require both attestation and key security level (KeyMint/Keymaster field for the
schema version) to be TEE or StrongBox, generated origin, Ed25519/signing purpose,
hardware-enforced per-use authentication rather than a reusable time window, and
the expected app package/signing-certificate identity and locked verified boot
state. Inspect software/hardware authorization lists according to their actual
schema; an absent or inconsistent required property fails eligibility. Match the
attested public key to the key that passes the fresh signing challenge.
[Attestation field schema](https://source.android.com/docs/security/features/keystore/attestation).

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
only governance events. Define the exact byte accounting in R17b before testing.
At exhaustion persist a visible signing-blocked condition; never truncate to sign
the old subset. This witness ceiling does not stop the separate carrier from
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
