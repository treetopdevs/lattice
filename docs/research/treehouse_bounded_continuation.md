# Treehouse bounded continuation: R04 contract and evidence

Status: **contract adopted after integrator and Claude Fable design review;
atomic BEAM/TS implementation and arity follow-up passed exact Fable review.
Final dependency integration is locally verified and awaits its bounded review
and hosted integration. No product profile
or production group is enabled by this packet.** Preparation base:
`389e9d4e520a9119913bfad591bc3c3f95ad12f8`; combined implementation base:
`d52366193c091aec0cf69598f44c10b9f718f124`.
This resolves the choices left by [R02](treehouse_founder_lifecycle.md) and
[unified R04](../../plans/roadmaps/treehouse-unified-2026-09-06.md#authority-contract-r02r04).
The accompanying [five probes](../../apps/lattice_core/test/treehouse/bounded_continuation_probe_test.exs)
characterize the unchanged legacy behavior. The original implementation used R03
`e08e3995bf562035bd36593687bd0e55ddd5f59e` and R09
`7f984d4482cd55d06ad437e8fcf7309b8bdd606f`, including R07/R08 ancestry. Section 8
preserves preparation evidence; section 9 records implementation proof and limits.
Section 10 records the final dependency integration without replacing that history.

## 1. Evidence that determines the boundary

| Probe | Observed at the base | Design consequence |
|---|---|---|
| C01 | Two same-author nominee successions from the founder, authored on partitioned logs with identical deps, each work locally. After heal the first in canonical topological order wins; the other is `recovery_claim_mismatch`. | Arrival order cannot choose the final acquisition. |
| C02 | Repeat that race after the nominee already holds the role: both same-predecessor renewals are honored; the last becomes the holder epoch. | Comparing only the holder public key does not consume a predecessor acquisition exactly once. |
| C03 | A transferred holder different from the fixed nominee cannot self-renew using legacy succession; the nominee can succeed it. | Holder renewal is an explicit new authorization path. |
| C04 | A later root genesis with an empty operation/role delegation adds metadata without resetting a transferred holder. Reusing the original full-role root delegation resets it. | The enrollment pin must introduce no roles. |
| C05 | A concurrent root policy genesis, absent from an attempted succession's ancestry, changes its legacy verdict from `unauthorized_succession` to honored after sync. | New profile resolution cannot use the global legacy policy fold. |

Every race heals all cross-partition links and compares retained operations,
authority analysis and materialized state across all surviving replicas. The
fixture deliberately gives two Sim realms the same synthetic signing identity
to generate same-author forks. Certificate keys are supplied directly; this is
neither physical custody nor witness availability evidence. The founder-loss
helper checks Sim's complete field inventory before dropping its identity, log
and capability cache. Tests use public authoring, sync, log and authority seams.

The corresponding source is `Authority.collect_policies/3`,
`build_role_timeline/6`, `decide_transfer/7` and
`decide_succession_proof/7` in
[authority.ex](../../apps/lattice_core/lib/lattice/authority.ex), and the exact
seven-field claim in
[succession_certificate.ex](../../apps/lattice_core/lib/lattice/authority/succession_certificate.ex).
R02 P07 additionally proves that legacy succession can expand operations and
self-issue an unleased rootless delegation; P12 proves that expiry/revocation
of a capability does not itself remove the held role token.

## 2. Select fresh versioned roots, followed by enrollment and a later pin

Reserve these exact replica-name families for newly created Treehouse roots:

```text
replica:treehouse:space:<nonce>#authority:bounded-continuation-v1#root:<root-tag>
replica:treehouse:thread:<nonce>#authority:bounded-continuation-v1#root:<root-tag>
```

`nonce` is the canonical unpadded base64url encoding of 32 random bytes;
`root-tag` remains the existing full SHA-256 root-public-key commitment. Both
must round-trip exactly. Use R09's hardened `Authority.bind_replica/2` on the
marker-free name (including the authority segment) to append the root suffix
once; rebinding an already root-bound name refuses. Full replica IDs, including
the authority marker, are already committed by every delegation and operation;
no canonical format changes.

The marker selects the authority family from the replica's birth, before a
policy pin exists. Recognition is confined to the exact
`replica:treehouse:space:` or `replica:treehouse:thread:` prefix plus a reserved
`#authority:` segment before the root suffix. Within those intended families,
an unsupported authority version, malformed nonce/tag, repeated/misplaced
segment or failure of the exact grammar above refuses authority evaluation and
signing; it must not fall back to legacy. Names without that reserved
prefix/segment combination follow the unchanged legacy path, including other
legacy namespaces that contain the literal `#authority:`. A typo creates a
different replica and cannot satisfy a retained pin for the intended replica.
For an unsupported reserved family, retain authenticated log input but expose
no active delegations, acquisitions or commands: analysis quarantines semantic
operations as `unsupported_authority_profile`, and author/review builders return
that typed refusal. Root-commitment inspection remains an identity observation,
not permission to bypass that analysis gate.

This identifier reservation is itself an explicit reviewed contract amendment.
No current checked-in vector uses the reserved family, but absence from vectors
is not proof about external history. Before enablement, audit checked-in IDs and
retained/release-profile IDs; any pre-existing ID colliding with the reservation
needs a named migration or disposition. No existing Treehouse production roots
are established by this baseline's evidence; do not infer the absence of unseen
roots. These checks qualify the legacy compatibility claim.

R09's corresponding existing TS exports are `bindTownshipReplica` and
`townshipReplicaCommitment`; its hardened authoring permits an already-bound
genesis only when the signer matches the root commitment. R04 must compose those
identity checks, not create another root-marker parser or rebind a later pin.
Its typed pin authoring must explicitly construct the empty delegation below;
calling a convenience genesis author with full-role defaults is unsafe. These
R09 interface details were confirmed with that packet's owner while its final
SHA was pending; record and test the landed versions during integration.

In the new family, integer/dormancy succession and the old `{:witnessed, cert}`
proof never authorize an acquisition. They refuse `continuation_required`, even
on a branch that omits a later pin. Otherwise a legacy proof would bypass the
new scope/lease limits. This is why merely adding a causally resolved profile
to an existing unversioned root is insufficient.

The lifecycle is:

1. R12 creates a fresh versioned root and its ordinary full-role genesis for a
   root-only preview. No member grant or continuation-readiness claim yet.
2. While the root lives, R13/R14 enroll actual members and separately bound,
   eligible governance keys. No witness identity comes from a hidden test key.
3. The root authors a **later** `{:genesis, empty_root_delegation, policies}`.
   The self-issued root delegation has `ops: []`, `roles: []`, `live: false`,
   `parent_id: nil`, `expires_epoch: nil`. `policies` contains the continuation
   profile below and the separate, unchanged R03 `__beacon__` policy. The pin
   depends on the reviewed enrollment evidence. Both genesis operations stay.
4. Issue/transfer the required scoped issuer authority, audit leases and all
   13 replica pins, and finish custody/readiness checks. Root loss before this
   step refuses the strong profile; it does not manufacture a later pin.

R04 accepts a continuation profile only from such a root-authored, valid,
zero-role/zero-operation/live-false genesis introduction. The initial full-role
genesis cannot double as this pin. Within a candidate's strict ancestry, choose
the last **valid** profile pin in canonical topological order, including its op
ID. Invalid replacement values do not erase a prior valid pin. No ancestor pin
means `continuation_not_configured`. A later or concurrent pin cannot change an
earlier candidate's profile or verdict. A root may replace a profile while it
lives; no nominee, current holder or witness quorum can rotate it after root loss.

Unversioned existing groups remain readable with identical legacy semantics.
They cannot acquire strong continuation readiness through an in-place profile
addition. Migration is an explicit new Space/root, fresh enrollment/grants,
independent catalog binding and retained read-only old history; it is not root
rotation or identity continuity. This chooses R02's permitted fresh-root branch
while retaining the unified enroll-then-later-genesis ceremony. R10/R12 must
adopt the family at creation before issuing the first pilot root. A later full
role genesis remains a real root-authorized acquisition, not metadata; readiness
must show its effect. Root power is not silently removed by this proposal.

## 3. Exact closed profile, claim and bytes

Reserved policy key: `:__continuation__`. Exactly these nine fields:

```elixir
%{
  mode: :bounded_continuation, version: 1, product: :treehouse,
  kind: :space, role: :admin,
  nominee: <<public_key::binary-size(32)>>,
  witnesses: [<<public_key::binary-size(32)>>, ...],
  threshold: positive_integer, max_lease_epochs: positive_integer
}
```

The only kind/role pairs are `space/admin` and `thread/moderator`, matching the
replica family. Public keys are raw 32-byte values. Witnesses must be distinct
and nonempty; normalize by unsigned byte order. `1 <= threshold <= count` and
`1 <= max_lease_epochs <= 65_535`. Unknown keys, duplicate witnesses, other
products/roles/versions, nonintegers and out-of-range values invalidate the
profile. Threshold and lease window are signed profile choices; Core does not
claim that distinct keys represent independently protected people/devices.
The R01b/R14 strong-readiness profile must separately select and prove that.

`profile_id = base64url_no_padding(SHA256(Canonical.term(
["lattice-continuation-profile-v1", normalized_profile])))`.
The proposed authoring body is exactly:

```elixir
{:succeed, role, new_delegation, {:continuation_v1, certificate}}
```

The certificate has exactly `claim` and `signatures`. Its claim has exactly
these **15** keys:

```elixir
%{
  version: 1, product: :treehouse, kind: :space,
  replica: full_replica_id, role: :admin,
  profile_id: profile_digest, profile_genesis: pin_op_id,
  holder: predecessor_public_key, holder_epoch: predecessor_acquisition_op_id,
  successor: new_holder_public_key, delegation_id: new_delegation_id,
  author: outer_op_author, deps: sorted_distinct_dependency_ids,
  epoch: epoch_integer, epoch_basis: sorted_distinct_maximum_beacon_op_ids
}
```

Use the corresponding thread/moderator values. IDs are canonical existing op,
delegation or SHA-256 digest strings, not display labels; `holder`, `successor`
and `author` are raw 32-byte keys. Deps are the actual outer op deps, sorted by
the existing canonical identifier ordering, with no duplicates. All claims
must equal independently reconstructed expected claims, not merely carry valid
signatures. The signature payload is precisely
`Canonical.term(["lattice-continuation-witness-v1", claim])`.

Each signature entry has exactly `witness` (32 bytes) and `signature` (64 bytes).
Require a strictly byte-sorted list, only configured witnesses, no duplicates,
at least threshold entries, and valid Ed25519 signatures for **every** entry.
An invalid surplus or unknown signature rejects the certificate. There is no
prefix threshold count or silent removal of bad entries.

Construction has no circular op ID: freeze the actual frontier; evaluate its
closure; construct/sign the leased delegation (its ID already commits replica,
keys, parent, ops, roles, live and expiry); derive this claim using that ID and
the fixed deps; collect signatures; then construct/sign the outer op. Changing
deps, profile source, epoch basis, new delegation or author needs fresh consent.
The new op ID is computed only after the certificate exists. An exact retry of
the same op is idempotent; signing a new frontier creates a distinct attempt.

The existing seven-field succession claim, its `lattice-succession-witness-v1`
domain, leased/unleased delegation encodings and all old canonical bytes stay
unchanged. Add this proof's atoms to the narrowly enumerated dump vocabulary,
and add exact BEAM-to-TS and TS-to-BEAM byte fixtures; do not create arbitrary
atom decoding or a second canonical codec. The new native claim purpose is an
R17b dependency after this Core contract lands, never a generic signing API.

## 4. Causal bound and one-use acquisition semantics

Evaluate all signed causal history with the normal verified DAG and authority
judge, retaining quarantined operations. Let `P` be the last **honored** role
acquisition among the candidate's strict ancestors, as established by the
canonical role timeline, not an acquisition merely presented in a certificate.
Its delegation must have a valid signature and static issuer/parent/attenuation
structure. Its effective signed operation set is the intersection along that
validated chain (equivalently its own ops after subset validation). Do not union
later grants, use a broader root grant, or import a noncausal acquisition.

The new delegation must satisfy all of:

- `issuer == audience == op.author`; author is either `P.holder` or the fixed
  profile nominee; the body and profile name the same single role.
- `parent_id == nil`, `roles == {role}`, `live == false`, and `new.ops` is a
  subset of P's effective operation set, including the empty subset if chosen.
- Let E be the maximum **valid R03 beacon epoch in the candidate's ancestry**.
  `epoch_basis` is exactly the nonempty sorted set of valid ancestor beacon IDs
  with epoch E. No local clock, role heartbeat or unvalidated beacon counts.
  Both valid root and witnessed beacons participate under R03's existing rules.
- E and `expires_epoch` are integers in `0..9_007_199_254_740_991` and
  `E <= expires_epoch <= min(E + max_lease_epochs - 1, 9_007_199_254_740_991)`.
  Compare with safe arithmetic in TS (subtract before addition or use BigInt).
  An absent epoch, `nil` expiry, negative value or expiry beyond the horizon
  refuses. A profile window crossing the horizon is clipped by that exact `min`
  formula: it may authorize a shorter finite lease through the horizon. It
  never wraps, rounds or requires an unrepresentable endpoint.

The profile's width bounds each new grant from its actual causal epoch; it is
not elapsed physical time. R03 still owns per-step bounds and root-beacon power.
No per-replica epoch is copied into another replica as evidence. A known higher
beacon outside the candidate's ancestry can make its new capability expired
under ordinary lease evaluation even if the acquisition is otherwise honored.
Clients must report this and re-review at a current frontier, not suppress the
beacon or describe a useless lease as renewed authority.

Expiry/revocation of P's capability does **not** remove the historical scope
bound or role token. This profile explicitly lets a quorum reauthorize that
scope with a fresh finite, rootless delegation after the dead ancestor expires.
The new chain does not depend on the old founder's expired delegation. Ordinary
child grants still attenuate through their actual new parent and cannot outlive
it. A malicious quorum can approve renewal or accelerate logical epochs inside
the configured bounds; it cannot add operations, rotate the root/profile, or
recover a lost holder-and-nominee key without another adopted contract.

After all structural, authority, scope, epoch and certificate checks pass,
compare **both** P's holder and acquisition op ID with the timeline's current
last honored acquisition. Equality consumes P and records the new acquisition.
Mismatch refuses `stale_continuation`. Thus concurrent holder renewal, nominee
installation and two self-renewals against P have one canonical first valid
winner. The losing certificate cannot be reused against the winner. Invalid
candidates never consume P. A child of a losing candidate cannot activate its
rootless delegation. The chosen winner can change when previously unknown
concurrent history arrives; after complete healing the result is deterministic.

There is one necessary companion rule **only in the new family**: ordinary role
transfer also requires its causal predecessor acquisition ID, not just its
holder key, to equal the fold's current acquisition ID. Otherwise a concurrent
transfer after a self-renewal could consume the old acquisition a second time.
The transfer's existing body/bytes stay unchanged; its dependency closure gives
the predecessor. Preserve existing invalid/not-holder checks; an otherwise
valid stale transfer keeps the existing `double_transfer` reason. Legacy
transfers and legacy succession retain their current interpretation.

No explicit `:revoke` semantics change: the actual issuer or the replica root
may revoke a delegation; current command checks honor revocation and causal
lease rules. This corrects the preparation draft against the existing
`Authority.revoke_authorized?/4` contract; it does not add revocation powers.
Revoking a predecessor capability does not ban quorum continuation of its held
role. Transfer to a different retained key removes the former holder's
self-renewal eligibility; changing the profile requires the living root. Removing
roster membership alone neither revokes a capability nor removes a role token.
R10/R14 must reconcile each replica's grants and role acquisitions; old issuer
grants whose issuer is unavailable remain effective until their signed leases
lapse. Readiness refuses removable unleased grants from unavailable issuers.
Transferring away from the fixed nominee does not revoke its pinned succession
eligibility. Permanently disabling that key requires a living-root profile
replacement or an explicitly new group; after root loss, quorum refusal is a
human control, not cryptographic removal of the nominee. V07's ordinary-member
removal must not be advertised as removal of this privileged eligibility.
Core continuation does not evaluate the Treehouse membership CRDT. R14's witness
review must show current verified roster status and refuse a removed recipient;
a role certificate gives no automatic roster re-admission. An authorized hostile
quorum remains able to approve the pinned nominee under the Core contract even
when honest product review would refuse it. This limitation must appear in the
privileged-member removal outcome, not be concealed by a green ordinary-member
removal test.
That roster check is a product-review control: R17's selected authority-only
projection authenticates application bodies but does not derive membership
verdicts. A webview roster assertion cannot become a native-verified membership
claim. Stronger native membership enforcement would require a separately scoped
domain projection and parity gate; this R04 proposal makes no such guarantee.

## 5. Explicit refusal contract and public interfaces

This is the proposed ordered R04 quarantine classification for a recognized
continuation body; the existing transport/canonical/signature/DAG rejection
boundary still runs first and makes no semantic admission claim.

| First failing check | Reason |
|---|---|
| Unsupported/malformed reserved replica authority family | `unsupported_authority_profile` |
| Legacy succession proof on the new family | `continuation_required` |
| New proof on an unversioned/unsupported product replica | `unauthorized_continuation` |
| Malformed proof/claim/certificate/delegation field types or portable integer shapes | `malformed_term` |
| No valid causal continuation pin | `continuation_not_configured` |
| No honored causal predecessor; issuer/audience/author/role mismatch; author is neither holder nor nominee; invalid new delegation signature | `unauthorized_continuation` |
| Extra ops/roles/live, non-nil parent, absent finite expiry | `continuation_scope_exceeded` |
| No valid causal epoch, mismatched epoch or beacon basis | `invalid_continuation_epoch` |
| Finite expiry outside the window derived from that epoch | `continuation_scope_exceeded` |
| Well-shaped claim differs from expected (including deps, predecessor, delegation or profile source), or invalid/unknown/duplicate/unordered/insufficient witness signatures | `invalid_continuation_certificate` |
| Valid candidate P is no longer the fold's current acquisition | `stale_continuation` |

Implement the table as distinct named stages, not dependence on map iteration.
Exact malformed/duplicate signature containers must be classified consistently
with the table: malformed entry field shapes are `malformed_term`; well-shaped
duplicate or unordered entries are `invalid_continuation_certificate`. A valid
pin containing unknown extra policy keys is invalid and ignored as specified
in section 2; a native verifier encountering authenticated unsupported authority
history must durably block signing under R17, not discard that history and sign
an older subset. Claims and audit projections must expose the same reasons.

Public BEAM implementation surface proposed for the atomic R04 PR:
`Lattice.Authority.ContinuationCertificate.normalize_policy/1`, `profile_id/1`,
`signing_payload/1`, `new/2`, and `verify/3`, plus an authority-backed review
builder taking a verified log, proposed author, exact deps and new delegation.
That builder returns either the fully reconstructed claim/review evidence or a
typed refusal; certificate verification alone does not prove an honored/current
predecessor. Extend Sim with an explicitly named `continue_role/4` helper taking
`:expires_epoch` and test witness identities; preserve `Sim.succeed` unchanged.

TS must offer the same typed profile, expected-claim/review and assembly seams,
with carrier term conversion using raw canonical bytes. Derivation receives
verified complete history and an exact proposed frontier, not caller-provided
holder or policy facts. Author through the normal leased-delegation and signed
op functions. `analyzeAuthority`, visible-op reduction, restore, compaction,
audit bundles and exported manifests must agree with BEAM. Native review uses
its independently verified history and the final Core contract; TS review is
not native evidence. Frozen-frontier assembly must refuse if the caller's
current review no longer equals the collected claim.

## 6. Executable acceptance contract

These are the **adopted acceptance requirements**. Their evidence is recorded
separately below. Use
public Sim partition/heal, fresh `Log` restoration, public TS authoring and
analysis; export new vectors rather than hand-authoring expected JSON.

| Case | Required positive and adversarial result |
|---|---|
| V01 creation/enrollment | Root-only new-family preview; actual member/key enrollment; later empty-role pin; retain both genesis ops and holder epoch. Missing pin and 12-of-13 partial pin refuse readiness. Legacy proof before/after/around pin never works on the new family. |
| V02 causal replacement | Valid pin replacement applies only to descendants; earlier or concurrent attempts keep verdicts. Invalid replacement cannot erase a valid pin. Wrong-root pin never authorizes. Unsupported family never falls back. |
| V03 scope | Start from a narrowed transfer; allow subset continuation, deny broader ops, second role, live=true, parent-bearing or unleased self-issue, unrelated wider grants and noncausal acquisitions. Mutate each bound field with a fresh outer signature. |
| V04 epoch/lease | Inclusive last epoch, one beyond expiry, absent/forged/old/noncausal basis, equal maximum beacons, min/max lease widths and horizon arithmetic agree. Valid historical predecessor may be expired/revoked; ordinary child of that expired chain still cannot extend it. |
| V05 consent | BEAM and TS produce identical normalized profile bytes, profile hash, claim bytes, witness signatures, leased delegation ID and final op bytes. Substitute product, kind, role, replica, author, deps, pin ID, profile hash, predecessor, new delegation, E or basis; reject every old certificate. Unknown/duplicate/reordered/bad-surplus/below-quorum signatures refuse. |
| V06 race | Separate holder and nominee, two copies of current holder, and duplicate nominee attempts all race from one P. Canonical first valid wins, others `stale_continuation`; transfer-versus-self-renew has one acquisition, stale transfer `double_transfer`. Invalid lexical-first candidate cannot steal P. A causal retry after the winner needs fresh bound consent. Compare every realm after healing and inverse delivery order. |
| V07 two cycles | Remove founder identity, log, cap cache and signing callbacks before E1. In each of 13 replicas renew issuer at candidate E5/E10 under fresh witnesses, then issue 12 finite member grants under that fresh parent. Advance through E14: both old generations expired; current grants work; no parent chain ends at the dead founder. Admit a new identity, remove/revoke a member and show exact stale-grant lapse. |
| V08 new child | After both cycles, a surviving authorized Space issuer permits creation/linking of a new Thread, with a distinct creator/root. Creator signs child genesis, actual members enroll, then creator pins its own reviewed policies and initial E. Show child moderator continuation and grants; deny cross-replica parent/cap/profile and an unpinned new child. No Space-root signature is available. |
| V09 hostile/lost keys | One lost witness with retained threshold succeeds; below threshold stalls; unavailable holder+nominee stalls even with quorum; quorum cannot add ops or rotate witness/root. Logical clock withholding/acceleration is documented, not a wall-clock guarantee. |
| V10 removal/restoration | Old issuer grants lapse without forged revocation; missing/corrupt evidence, fresh-log import, dump/fresh-VM vocabulary and compaction preserve role epochs, profile sources, beacons, quarantine and command results, including race losers. Retained catalog trust is supplied to R11c; service replacement is not asserted by a role certificate alone. |
| V11 migration | Replay all legacy vector bytes/verdicts and the five characterization cases unchanged. Other legacy namespaces containing literal `#authority:` keep behavior; malformed/unknown intended Treehouse families refuse. Audit retained IDs and disposition any reservation collision explicitly. New-family versions are additional fixtures. Product projections/claim contracts cannot label legacy, unpinned or partially pinned roots strongly ready. |

Until R10 supplies actual Treehouse schemas, Core can exercise space/admin and
thread/moderator in isolated test-schema modules with explicit admission,
removal, grant and child-reference commands. Such tests close generic R04
authority behavior only; R10 integration must replay V07/V08 with the actual
command vocabulary and public TS reduction before product claims change. No
test module or fixture may be silently described as a landed Treehouse product.

The candidate schedule remains **7 inclusive epochs, warnings at the last two,
renew every 5**: issue E0/E5/E10, expire E6/E11/E16. An epoch is a signed logical
unit with a proposed daily ceremony, not a measured day; no timing constant is
adopted here. The [R02 JSON](treehouse_renewal_fanout.json) measured founder-present
grant fanout only. For two candidate renewal rounds on 12 members × 13 replicas:

| Work | Ops | Cryptographic signatures | Required witness-claim approvals |
|---|---:|---:|---|
| 312 fresh member grants | 312 | 624 (delegation + outer op) | Not measured; ordinary member signing is separate from witness presence. |
| 26 issuer continuations at 2-of-3 threshold | 26 | 104 (delegation + two witness + outer op) | 52 separate per-replica approvals; no batching proof. |
| Witnessed E1..E14 on all 13 replicas | 182 | 546 (two witness + outer op) | 364 separate approvals; E0 root initialization excluded. |
| Combined post-E0 candidate fixture | 520 | 1,274 | 416 required witness approvals; zero executed/physically measured here. |

These counts are an explicit workload warning for review, not an acceptable
human burden finding. Two cycles in an accelerated test do not prove members
will perform the required per-replica prompts. R14/R17/R23 must measure the adopted
schedule; changing the ceremony to a multi-replica claim needs a separately
reviewed purpose/bytes contract, not reuse of one signature on 13 claims.
Initial grants, original genesis/pin operations, transfer, membership/removal,
new-child operations, retries and catalog operations are outside this subtotal.
R04 must regenerate exact byte/sig/operation counts from the implemented V07/V08
fixture; the arithmetic above is not serialized-size or device evidence.

The 416 count covers witness claims, **not every platform presence call**.
R03 requires a founder-absent beacon's outer author to be a configured witness
key, while R36 separates that protected governance key from the member/carrier
key and forbids generic signing. The integrator selected a separate typed native
**final-beacon-op** signing purpose, preserving R03's author contract; this is a
resolved design amendment pending final R17 review/implementation. Native code
constructs `:authority` / `{:beacon, E, verified_certificate}` with `cap: nil`,
its selected configured witness key and derived exact deps. It verifies the full
threshold certificate and expected claim; IPC cannot choose arbitrary bytes,
body, cap or author. This distinct purpose requires fresh native review,
single-use consent, per-operation presence and a generation check after blocking
platform signing. Witness-claim consent cannot authorize its outer signature.

For E1..E14 across 13 replicas this adds **182 expected native presence prompts**
for outer beacon signing, whose 182 signatures are already included in the 546
beacon-signature count above. The proposed governance workload is therefore
364 beacon-claim + 52 continuation-claim + 182 final-beacon = **598 presence
ceremonies**, with zero physical measurements here. Ordinary member-key custody
prompts are outside this count. The continuation delegation and its outer op
are signed by the holder/nominee **member authority key**; the two continuation
claim signatures use the separate protected witness keys. A beacon outer op
instead uses the selected configured protected witness key, matching the
certificate's author field. There is no weaker member-key beacon-author bypass.

## 7. Implementation sequence, gates and stop outcomes

After integrator adoption, one atomic R04 PR owns BEAM/TS judge, new certificate
module, authoring, exporter, dump/compaction mirrors and affected claim surfaces.
Do not begin it against a moving R03 worktree. Record its landed SHA, resolve any
R03 policy/reason API differences explicitly, and coordinate the authority writer.

1. At prerequisite integration, explicitly test that R09's `bind_replica/2`
   refuses rebinding, rather than silently accepting an already-bound name;
   retain matching-root later-genesis authoring as a separate permitted seam.
   Add V01..V06 RED public tests and deterministic new vector exporter cases.
   Keep this packet's legacy characterization tests; their verdicts must not move.
2. Implement new-family selection, causal profile sources and bounded acquisition
   stages; preserve the legacy path. Add TS-author-to-BEAM verification, not just
   BEAM-authored replay. Record both directions' exact bytes.
3. Add V07..V11, fresh-VM dump and compaction/restore parity, exact operation/sig
   counters, then affected audit/read-model/product-manifest refusal claims.
4. Run `mix verify` and `mix check` using the AGENTS toolchain; new targeted Core
   continuation tests; existing `witnessed_succession_test.exs`,
   `succession_time_travel_test.exs`, `root_binding_test.exs`, `lease_lapse_test.exs`,
   `compaction_spike_test.exs`, Township workflows/exports/audit/read-model and
   Treehouse contract suites. Run current TS `typecheck`, `canonical`,
   `conformance`, `township:authoring`, `succession:review`,
   `succession:artifact`, `tauri:bridge` and `build`; add/wire a real new
   continuation suite into CI and regenerate consumers. Use the final R03 gates
   for beacons/leased authoring as well; do not invent an existing script name.
5. Compare every pre-existing vector against the landed R03 baseline, especially
   all five beacon/lease and eleven tick-bearing files named by
   [Plan 179](../../plans/179-witnessed-beacons-af2-founder-loss.md). This selected
   fresh-family design needs new vectors, not a rewrite of old verdicts. Any
   required legacy change returns for a concrete scoped amendment and proof.

Stop strong readiness/provisioning for a legacy family, missing profile/epoch,
unavailable authorized issuer, incomplete 13-replica inventory, nonrenewable
unleased removable grant, insufficient quorum, or lost holder and nominee.
Stop implementation publication for byte/verdict/restore divergence, a hidden
founder signature, scope expansion, ambiguous race winner, or unsupported policy
silently treated as legacy. Stop native/pilot claims for unproved custody,
presence, prompt burden or exact-device behavior. Continue the authorized
root-only offline preview and read-only retained history where applicable.

This does not prevent withholding of unknown operations or whole-native-store
rollback; those remain R17's explicit trust limits. Catalog replacement still
requires R11c's retained bootstrap/authorized replacement chain and rollback
negatives. No role certificate substitutes for that service trust contract.

## 8. Preparation verification record, preserved from the design review

The five characterization probes and full `mix verify` pass at the recorded
base: **680 tests + 27 properties, 0 failures, 3 configured exclusions**. A later
`mix check` run completed with one existing `Township.ReadModelTest` 60-second
timeout in `preload_lattice_core/0` / `code.ensure_loaded/1`; no assertion failed.
The initial green run remains separate evidence. After other full-suite jobs
finished, the controlled `mix check` repeat with `ERL_FLAGS='+S 4:4'` exited zero:
**680 tests + 27 properties, 0 failures, 3 configured exclusions**, followed by
strict Credo exit zero. The preload timeout did not recur; no test timeout or
production behavior changed. Preserve the earlier failed-run evidence. A new
probe alias-order suggestion was corrected; standalone strict Credo also exited
zero (existing suggestions in unchanged files remain). C04 fixture
calibration first compared `Sim.transfer`'s returned delegation ID with an
acquisition op ID; the corrected test obtains the actual transfer from public
`Log.topo_ops`. That was test construction, not a production defect or R04 RED.
At that preparation checkpoint, no production, existing test, vector, shared
README or unified ledger was edited. Implementation changes below follow the
separate integrator adoption and preserve these earlier probes and evidence.

## 9. Atomic implementation evidence

The implementation's initial public RED is committed in `85a925ec`: six tests
construct real signed delegations, profile pins and certificates through public
Sim/Log APIs, without depending on missing helper functions. The baseline
reported `unauthorized_succession` for valid continuation, finite scope, witness
binding and race cases. The new judge makes these cases pass while all five
legacy characterization probes retain their original outcomes. Further tests
exercise V01–V11 at the Core boundary, including malformed outer/proof arities and
undeclared roles, which cannot acquire authority by avoiding a role timeline.

The [authority tests](../../apps/lattice_core/test/treehouse/bounded_continuation_test.exs)
cover causal replacement, invalid replacement retention, missing pins,
12-of-13 partial configuration, attenuated scope, inclusive lease bounds and
portable-horizon clipping, exact maximum-beacon basis, every claim binding,
quorum/signature refusals, invalid-first and valid-competing races, rejected
parent activation, current-frontier review, corrupt/missing retained history,
fresh-VM dump vocabulary, and compaction straddling the pin and acquisition.
The [lifecycle tests](../../apps/lattice_core/test/treehouse/bounded_continuation_lifecycle_test.exs)
remove every founder record before E1, run all 13 replicas through E5/E10
renewals and E14 lapse, admit/remove/revoke a new finite member, and create an
independent child root with signed enrollment before its own pin.

The new signed corpus lives only under
`clients/lattice-client/test/vectors/continuation/`. Fifty-seven BEAM histories
include all 13 two-cycle replicas, signed refusal cases and complete operation
bytes. Public TS carrier verification, authority analysis and materialization
match the BEAM role acquisition, quarantine reasons and post state in both
delivery orders. Profile hashes, profile bytes, claim bytes and full operation
bytes match. A separate TS-authored three-witness certificate is verified in
BEAM; signature verification alone does not change the holder. The original
seven-field recovery certificate and all pre-existing vector bytes are unchanged.
Two complete TS-authored histories additionally exercise Space holder renewal
and Thread nominee acquisition: BEAM authenticates every frame, matches full
operation/claim bytes and honors the final continuation through `Log.accept`
and `Authority.analyze`. Forged signatures remain quarantined, a genuine retry
can repair that retained forgery, and missing dependencies prevent admission.

Review reproduced two additional runtime mismatches before fixing them: a line
separator in an intended Treehouse replica name fell through to TS legacy
handling, and a malformed new-proof arity on a legacy replica used BEAM's old
succession refusal. Both now refuse consistently, with signed reciprocal cases
and public RED logs preserved as `/tmp/treehouse-r04-family-lines-red.log` and
`/tmp/treehouse-r04-legacy-proof-arity-red.log`.

Independent review also reproduced a signed extra-field genesis becoming a
pin only in TS. The same decoder class affected transfers, grants and revokes.
The versioned family now matches BEAM's exact ordinary authority tuple shapes;
unsupported shapes remain inert signed history and legacy decoding is unchanged.
The RED is `/tmp/treehouse-r04-authority-arity-red.log`. A separate signed
non-delegation body under the new proof head now exposes the agreed family-first
refusal through the TS decoder, authority analysis and quarantine adapter.
Its RED is `/tmp/treehouse-r04-refusal-precedence-red.log`. Truly malformed
carrier terms retain their earlier structural refusal. Standalone BEAM claim
normalization also now agrees with TS on nonempty valid UTF-8 replica text;
the failed empty-text case is `/tmp/treehouse-r04-replica-text-red.log`.

Claude Fable's exact implementation review of `8b7c9b53` passed without P0/P1
findings and identified one P2 audit mismatch: a surplus-arity legacy-proof
`succeed` on the bounded family was inert in BEAM but `continuation_required`
in TS. The signed regression in `22aaf8a5` reproduces that difference
(`/tmp/treehouse-r04-fable-legacy-succeed-red.log`). The bounded TS shape guard
now keeps that operation inert, while recognized new-proof heads retain their
family-first refusal rules. All 57 histories pass in both delivery orders
(`/tmp/treehouse-r04-fable-legacy-succeed-green.log`). Legacy decoding and
pre-existing vectors remain unchanged.

The public TS `reviewContinuationFromFrames` and
`assembleContinuationFromFrames` authenticate complete raw carrier snapshots,
derive the exact claim and compare a fresh review before signing. They refuse
hash/signature/replica/duplicate/closure errors, stale consent, changed
delegations, invalid surplus signatures and mismatched signers. Snapshot copying
protects asynchronous verification from caller mutation; returned signatures
are checked. The caller still owns serialization with its current store.
These APIs cannot prove that unknown operations were not withheld, and they
provide no native custody or presence evidence. `Authority.continuation_review/6`
also verifies signed log contents and reconstructed frontier metadata;
`Sim.continue_role/4` authors only after the same history/scope/lease review.

The candidate workload counter derives records from the signed histories after
bootstrap: **312 member grants, 26 continuations and 182 witnessed beacons**,
totalling **520 operations and 1,274 signatures**. The distinct native purposes
would require 52 continuation-witness approvals, 364 beacon-witness approvals
and 182 final-beacon-operation signatures: **598 estimated presence prompts**.
This is an operation count, not a device measurement or adoption of a daily
clock. The seven-epoch width and E5/E10 schedule remain test candidates.

CI retains every existing obligation and explicitly regenerates the new corpus
once alongside the legacy corpus. The existing conformance command also runs
the 12 strict codec tests and 13 authenticated-authoring tests. The new exporter
is separate because the legacy exporter has sixteen existing test invocations;
regenerating the full lifecycle corpus in each adds no independent proof.
CI also regenerates the two TS-authored histories after installing Node
dependencies, then runs their focused BEAM import/authority test on those fresh
bytes. The two directions therefore exercise current exporters and verifiers.

The checked-in configuration and source audit finds no pre-existing reserved
Treehouse instance IDs outside the new parser/fixtures. This does not establish
absence in external retained histories or release profiles. R12/profile
enablement must audit those IDs and give every collision a named disposition.
These test-only schemas prove the Core contract; integration with R10's actual
Space/Thread policies, R11 catalog trust, R14 membership/eligibility review and
R17 native implementation remains each downstream packet's explicit gate.
No product admission, independent-person quorum, protected-key custody, native
rollback resistance or production readiness is inferred from this evidence.

Final local gates passed on 2026-09-06 with `ERL_FLAGS='+S 4:4'` and the
AGENTS asdf/PATH toolchain, without changing any test timeout:

| Gate | Result |
|---|---|
| `mix check` (format, full suite, strict Credo) | 751 tests + 27 properties, zero failures, three existing exclusions; exit 0. Log: `/tmp/treehouse-r04-final-reviewed-check.log`. |
| Public authority/compaction focused gate | 40 tests + one property, zero failures; final full suite also includes all lifecycle and reciprocal tests. |
| TS `typecheck`, `build`, `conformance` | Exit 0; 56 new signed histories plus the legacy corpus, 12 codec and 13 authenticated-authoring tests. Log: `/tmp/treehouse-r04-final-reviewed-conformance.log`; final adapter replay: `/tmp/treehouse-r04-final-adapter-conformance.log`. |
| TS `canonical`, `v01:guard`, `township:authoring`, `succession:review`, `succession:artifact`, `tauri:bridge` | Each exits 0. |
| TS `carrier:township`, `carrier:relay`, `carrier:relay-sync`, `carrier:feed`, `carrier:township:live` | Each exits 0; live log: `/tmp/treehouse-r04-live-carrier.log`. |
| Reciprocal regeneration | BEAM-generated corpus and TS-generated full histories reproduced; TS-authored final operations pass the BEAM public import/authority test. |
| Legacy and scope protection | Every pre-existing vector remains byte-identical to R03 `e08e3995`; shared README and unified ledger untouched; `git diff --check` and local document links pass. |

After Fable's P2 correction, `mix check` again exited 0: 751 tests plus 27
properties, zero failures, three existing exclusions and strict Credo exit 0
(`/tmp/treehouse-r04-fable-final-check.log`). TS `conformance` now passes 57
histories, 12 codec and 13 authoring tests; `typecheck`, `build`, `canonical`
and `carrier:township` also exit 0. Only the new continuation corpus gains a
signed fixture; its prior entries and all legacy vectors are unchanged.

Independent bounded reviews identified the decoder/normalizer issues recorded
above; their final source rereads found no remaining demonstrated issue in that
scope. Claude Fable's design and exact implementation PASS records are separate
from final integrator review of the narrow P2 correction. Local gates do not
substitute for hosted checks, actual R10 product-schema integration, or
native/device evidence.

## 10. Final dependency integration, 2026-09-06

The exact implementation/arity follow-up at `75e544d2` passed Claude Fable
review. Integration `c2d85b9219f03521b7fb78a892b36882961f8789` adds final R09
`29fe54f3` (including accepted main `9bb7b340` and R06 verified restore) and R03
hosted remediation `4a823b96`. R03's final review/hosted closure remains separate;
this local integration does not declare that dependency complete.

The manual merge preserves R04's raw body/replica continuation parsing and inner
refusal adapter while using R03's contextual `decodeCarrierBody`. It combines
the authoring-test imports without duplicates. All three BEAM beacon-policy
collection calls, including `continuation_review_from_log`, now pass the resolved
root. No R10 product/effects implementation is included in this R04 packet.
R06's restored authentication/consumer changes are retained; Log differs from
the accepted restore baseline only by the required R03/R04 policy vocabulary.

At that exact integration, full `mix check` exits 0 with **772 tests and 27
properties, zero failures**, the same three exclusions, clean formatting and
strict Credo exit 0. Existing low-priority suggestions remain; lint configuration
is unchanged. The gate uses the documented asdf/OTP 28 PATH and `+S 4:4`.
TS typecheck, build, conformance (including 57 continuation histories and the new
R03 vectors) and Township authoring all pass. Logs are
`/tmp/lattice-treehouse-execution-20260906/r04-final-accepted-check.log`,
`r04-final-r03-conformance.log` and `r04-final-r03-authoring.log` in that directory.
The exact manual-resolution artifact is `r04-final-r03-manual-resolution.diff`.

The separate engine integration `90a07e2b` exercises R04 with R10's actual
Space commands and ordered effects. Its product evidence belongs to the R10
packet. Final integration review, exact PR-tip checks and merge-result checks
remain required before this R04 packet is DONE. No device or founder-loss pilot
proof follows from these local tests.
