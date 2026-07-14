# M4 interface-redesign brief

**Status:** council conclusion, 2026-07-13

**Decision:** replace the four-callback `Lattice.Attestation` wager with a phased
`Township.Election` protocol over a dedicated Lattice bulletin-board replica. Keep the
current Stub honest and unchanged until the new path clears every gate in this brief.

**Readiness:** this brief is ready to drive protocol and architecture decisions. It is
not authorization to implement or claim coercion resistance. The exact cryptographic
profile, anonymous channel, private registration path, close mechanism, artifact
availability, independent review, and measured town-scale cost remain blocking gates.

The research verdict explains why the old interface cannot work:
[`m4_receipt_freeness_verdict.md`](m4_receipt_freeness_verdict.md). The redesign accepts
that conclusion instead of trying to preserve a drop-in module swap.

## 1. Council conclusion

Codex, Claude, and Antigravity independently converged on five decisions:

1. Coercion resistance is a multi-role election protocol, not a local attestation
   primitive.
2. Lattice may provide the immutable bulletin board, capability-gated service
   publication, replication, and replay. It does not provide anonymous credentials,
   secret-share custody, an anonymous channel, a globally complete close, or the
   CHide security theorem.
3. A voter must never author the public ballot op with their ordinary
   [`Lattice.Identity`](../../apps/lattice_core/lib/lattice/identity.ex). An anonymous
   ballot box or relay authors the outer Lattice op; the encrypted inner ballot carries
   no Lattice voter identity or capability.
4. Pure deterministic replay verifies a threshold-produced, close-bound transcript.
   It does not locally decrypt and tally public ballot bodies.
5. Security properties are structured conditional claims. There is no replacement
   boolean equivalent to `receipt_free?/0`.

Antigravity's useful naming dissent is adopted: the new domain is
`Township.Election`, not `Lattice.Attestation.V2`. Ordinary attestations bind a
statement to an identity; this protocol deliberately prevents a public ballot from
being bound to the voter and yields only a collective result.

## 2. Selected construction direction

The target profile is a single, version-pinned CHide or encrypted-sorting CHide
construction—not a menu of interchangeable “crypto providers.” CHide supplies the
right semantic shape:

- trustees jointly establish an election key;
- registrars deliver private credentials and publish encrypted credential material;
- voters submit encrypted `(choice, credential)` ballots with the required proofs over
  an anonymous channel;
- ballots with fake or duplicate credentials remain accepted-looking and are hidden
  during encrypted cleansing; and
- anyone verifies the final tally transcript.

CHide assumes an honest same-view bulletin board, anonymous submission, private
credential delivery, honest-party bounds for registrars/trustees/auditors, and
specific cryptographic assumptions. Lattice plus the mechanisms below must be shown
to realize the board assumption; the theorem does not transfer automatically. See
[CHide](https://eprint.iacr.org/2022/430.pdf) and the
[encrypted-sorting treatment](https://eprint.iacr.org/2023/837.pdf).

JCJ's fake-credential semantics are the critical correction to the old API: the
coerced ballot is posted normally but intentionally does **not** count. It is not an
alternative body for an already-logged real ballot. See
[JCJ](https://eprint.iacr.org/2002/165.pdf) and
[Civitas](https://www.cs.cornell.edu/Projects/civitas/papers/clarkson_civitas.pdf).

The exact paper revision, algorithms, parameter set, transcript encoding, DKG,
mixnet/MPC, proof system, and implementation library must be pinned together as one
profile before crypto implementation begins.

## 3. Architecture boundary

The new subsystem has one public application facade and one dedicated board replica:

```text
Township.Election
  -> client ballot and decoy preparation
  -> role-state advancement for registrar, box, close, and trustee services
  -> pure board projection and final verification
  -> structured security claims

Township.ElectionBoard
  -> capability-gated append-only protocol artifacts
  -> no voter identities and no materialized plaintext tally
```

Private seams hidden behind `Township.Election` are:

- `Protocol`: the one pinned construction profile;
- `AnonymousTransport`: anonymous voter-to-box submission, with a deterministic test
  adapter and a separately assessed real adapter;
- `ArtifactStore`: immutable content-addressed artifact bytes and offline bundle
  assembly; and
- role runners for registration, close, and trustee protocol work.

The board is a separate replica linked to a `Township.Matter` by immutable election
configuration. Ballots do not become fields or commands on
[`Township.Matter`](../../apps/lattice_core/lib/township/matter.ex). W0-W3 remain on the
matter log; W4 observes the linked election log.

The link itself must be authorized on the Matter log; a board configuration that merely
claims a `matter_replica_id` is not sufficient. The redesign adds a Matter-side
`{:link_election, [spec_digest]}` command, citing a Matter-scoped capability. It records
the immutable configuration digest before any board setup begins. The resulting Matter
op is part of the verified election context and every open/final transcript binds its
ID. This changes the Matter schema/API without changing W0-W3 semantics.

Do not add a new unauthenticated `Lattice.Op.kind`. The existing
[`Lattice.Op`](../../apps/lattice_core/lib/lattice/op.ex) outer signature, content hash,
deps, and capability continue to protect service-authored board commands.

## 4. Roles and trust boundaries

Every public role key and threshold is frozen by the election configuration.

| Role | Protocol responsibility | What a Lattice capability proves | Additional assumption |
|---|---|---|---|
| Matter sponsor | Links a matter to an election and proposes administrative intent | The service may publish the configured admin command | No tally authority and no unilateral finality |
| Election supervisor | Publishes configuration and phase proposals | The key may publish administrative artifacts | Cannot make an incomplete board complete |
| Registration tellers | Produce construction-defined credentials and public roster material | The service may publish registration artifacts | Required honest-party/private-channel assumption from the pinned construction |
| Voter client | Holds a real credential, creates real ballots, and can create decoy material | Nothing; the voter does not publish a Lattice op | Uncompromised client and an unobserved opportunity to register and vote |
| Ballot box/relay | Receives ballots anonymously, checks only public form/size rules, and publishes them | The service may publish ballot wrappers | Anonymous ingress, delivery, non-linkability, and denial-of-service limits |
| Close committee | Certifies one exact ballot manifest; under the initial profile, the configured ballot boxes fill this role | The member may publish close messages | Separate non-equivocation/corruption assumption; not the trustee corruption/share-quorum bounds |
| Tally trustees | Run DKG, cleansing, sorting/mixing, and threshold decryption | The service may publish protocol contributions | Pinned threshold, non-collusion, secret custody, and durable randomness rules |
| Auditor/verifier | Replays and verifies the public transcript | No write capability is needed | At least one honest party reports verification failure where required by the profile |
| Lattice replica/carrier | Stores and delivers signed artifacts | Structural and publisher authorization evidence | No claim of completeness, anonymity, consensus, or cryptographic correctness |

Capabilities may authorize artifact families and attribute service actions. They do
not prove credential validity, anonymous eligibility, private delivery, honest
thresholds, correct client behavior, complete delivery, data availability, or a
non-equivocating close.

Ordinary Lattice succession cannot replace a cryptographic trustee. Replacement needs
a construction-defined resharing or share-refresh ceremony. Revoking a publishing
capability may stop future ops, but it must not silently change the frozen trustee or
close thresholds.

## 5. Public protocol interface

The interface is deliberately small and deep. Types below describe the contract; they
do not select an implementation language or native boundary.

```elixir
defmodule Township.Election.Protocol do
  @callback prepare_ballot(
              VerifiedElection.t(),
              Credential.secret(),
              choice(),
              Entropy.t()
            ) ::
              {:ok, BallotEnvelope.t(), CheckToken.t()}
              | {:error, voter_error()}

  @callback make_decoy(
              VerifiedElection.t(),
              Credential.secret(),
              Entropy.t()
            ) ::
              {:ok, Credential.decoy()}
              | {:error, voter_error()}

  @callback advance(
              RoleState.t(),
              VerifiedView.t(),
              RoleInput.t()
            ) ::
              {:ok, RoleState.t(), [Effect.t()]}
              | {:wait, [Requirement.t()]}
              | {:error, role_error()}

  @callback verify(
              VerifiedElection.t(),
              BoardSnapshot.t(),
              ResolvedArtifacts.t()
            ) :: Projection.t()

  @callback claims(Profile.t()) :: [ConditionalClaim.t()]
end
```

Contract notes:

- `VerifiedElection.t()` contains the verified Matter link, election ID, profile,
  choice domain, election public key, setup certificate, and roster commitment. Client
  and verifier operations may not accept an unverified self-asserted spec.
- `prepare_ballot/4` never receives `Lattice.Identity.t()` and never builds a Lattice
  op. It applies the pinned construction to the verified election key, the real private
  credential, and the selected choice, then returns the encrypted ballot and an opaque
  inclusion-check token that does not open the choice.
- `make_decoy/3` replaces `produce_alt/2`. CHide's `Fakecred(c)` derives fake material
  from the voter's real private credential; Civitas similarly modifies private
  credential-share material. The callback therefore receives both the verified
  election context and the real credential. The resulting coerced ballot is well formed
  but removed during encrypted cleansing.
- `advance/3` hides construction-specific setup, registration, sealing, and trustee
  rounds behind durable role state and explicit effects. It is not a claim that these
  phases are local or coordinator-free.
- Randomized role contributions must be persisted before publication. A restart
  republishes the same bytes for the same `(election, role, phase, round)` identity; it
  must not generate a second contribution.
- `verify/3` is pure, set-based, non-networked, and total over malformed input. Artifact
  resolution happens before it is called.
- `claims/1` returns a reviewed static manifest. It cannot activate a claim merely by
  returning `true`.

The pinned profile may use internal construction-specific operations corresponding to
CHide's `Setup`, registration, `Vote`, `Check`, `isVal`, `Fakecred`, `Ptally`, and
`Verify`. Those details must not leak as a growing collection of application callbacks.

## 6. Election configuration and artifacts

The immutable election configuration contains at least:

```elixir
%ElectionSpec{
  schema: "township-election-v1",
  subject: matter_replica_id,
  question_digest: binary(),
  choices: [term()],
  profile: %ProfileRef{id: binary(), version: binary(), parameters_digest: binary()},
  supervisor: pubkey(),
  registration_tellers: [pubkey()],
  ballot_boxes: [pubkey()],
  close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
  trustees: [pubkey()],
  max_corrupt_trustees: non_neg_integer(),
  tally_share_quorum: pos_integer(),
  result_policy: term(),
  domain: binary()
}
```

First compute `spec_digest` from the versioned canonical spec without an election ID.
The authorized Matter-side `link_election` op cites that digest. Then compute
`election_id` as a domain-separated hash of `spec_digest` and the immutable Matter-link
op ID. A changed choice, role, key, threshold, profile, policy, subject, or authorizing
link therefore produces a new election ID without a circular signature dependency.

`max_corrupt_trustees` and `tally_share_quorum` are separate because CHide's threshold
parameter is a corruption bound, not a safe generic synonym for “shares required.” The
pinned profile must validate both values, their relationship to the trustee count, and
the exact DKG/decryption theorem before setup is accepted.

Public artifacts are immutable, domain-separated, bounded byte encodings:

```elixir
%ArtifactRef{
  digest: binary(),
  byte_size: non_neg_integer(),
  codec: binary(),
  profile: binary(),
  availability_certificate: term() | nil
}
```

The public Lattice representation must use canonical primitive terms supported by
[`Lattice.Canonical`](../../apps/lattice_core/lib/lattice/canonical.ex). Internal
structs are encoded into a pinned byte codec before hashing; unconstrained BEAM terms
and mutable proof URLs are forbidden.

An artifact reference identifies exact bytes. It does not establish availability.
Final verification requires a resolved digest-to-bytes map and an offline bundle
containing every configuration, roster, ballot-manifest, trustee, proof, and result
artifact needed for replay.

## 7. Lattice board command surface

`Township.ElectionBoard` declares real command bodies matching Lattice's
`{command, args}` shape. The initial surface is:

```elixir
{:configure_election, [election_id, config_ref]}
{:publish_setup, [election_id, setup_ref]}
{:publish_roster, [election_id, roster_ref]}
{:open_election, [election_id, setup_digest, roster_digest, open_certificate]}
{:submit_ballot, [election_id, ballot_ref]}
{:publish_box_seal, [election_id, seal_ref]}
{:propose_close, [election_id, manifest_ref]}
{:attest_close, [election_id, manifest_digest, signature]}
{:certify_close, [election_id, close_certificate]}
{:publish_protocol_artifact,
 [election_id, close_digest, phase, round, trustee_id, artifact_ref]}
{:publish_tally,
 [election_id, close_digest, result, transcript_ref]}
{:abort_election, [election_id, reason, abort_certificate]}
```

The command schema lets
[`Lattice.Authority`](../../apps/lattice_core/lib/lattice/authority.ex) validate the
outer publisher and capability. A domain projector scans honored board commands and
validates the inner protocol. The board never exposes a plaintext per-voter choice or
materializes a trusted tally field.

Relayers may reject byte-size violations and malformed public well-formedness proofs.
They must not test whether the encrypted credential is real. Real, fake, and duplicate
credential ballots remain publicly unclassified; their fate is hidden inside the
verified cleansing transcript.

An exact ballot submitted through multiple boxes is deduplicated by its inner artifact
digest for protocol input, while every outer wrapper remains auditable. The chosen
construction's encrypted duplicate-credential policy remains separate from exact
transport retransmission deduplication.

## 8. Lifecycle

Phase is derived from verified certificates and explicit artifact references, never
from an LWW phase field or whichever concurrent op sorts first.

```text
:setup
  -> :registration
  -> :ready
  -> :open
  -> :closing
  -> :closed
  -> :tallying
  -> :finalized

Any non-final phase -> :aborted under the pinned abort policy
Any conflicting valid phase certificate -> :forked
```

- `:setup`: the immutable spec and DKG transcript are being published.
- `:registration`: setup is verified and private credential issuance is active.
- `:ready`: one valid registration certificate fixes the encrypted public roster.
- `:open`: an open certificate binds the setup and roster certificates.
- `:closing`: ballot-box seals and one union manifest are being assembled.
- `:closed`: one valid close certificate fixes the exact ballot set.
- `:tallying`: construction-specific cleansing, sorting/mixing, and decryption
  contributions are being published against that close.
- `:finalized`: the result and complete proof transcript verify against the same spec,
  roster, and close digests.
- `:aborted`: an irreversible, policy-authorized abort certificate exists.
- `:forked`: conflicting valid configuration, roster, open, close, or final
  certificates exist. No result is selected.

There is no reopen transition. A rerun receives a new election ID. DAG ancestry is
useful audit evidence, but every protocol artifact must explicitly reference its
prerequisite certificate IDs.

## 9. Close and ballot-set finality

An eventual CRDT frontier, a logical `at_tick`, or one capability holder's close op
cannot establish a complete canonical ballot set. The initial POC policy therefore
selects the conservative `:unanimous_boxes_v1` certificate:

1. Each configured ballot box signs exactly one seal for the entire election.
2. Its seal names the open certificate and every ballot wrapper it accepted. It must
   include every ballot op authored by that box in the seal's causal past; omission
   invalidates the seal.
3. A canonical manifest contains exactly one seal from every configured box and the
   sorted union of their ballot artifact digests and wrapper op IDs.
4. Every configured box verifies that its seal and all referenced artifacts are
   present, then signs the same manifest digest.
5. A close certificate contains the manifest reference and every required signature.

This gives uniqueness if at least one configured box is honest and never signs two
different manifests. It intentionally sacrifices liveness: one unavailable or
withholding box leaves the election pending. It also does not prove that a censoring
box published a ballot it received. Voters must submit to at least one honest box and
perform the construction's inclusion check; acceptance evidence supplies
accountability, not automatic coercion resistance.

If unanimous close is operationally unacceptable, the replacement is a separately
specified BFT close service—not Lattice ordering. Such a profile must name its protocol,
committee, keys, corruption bound, and quorum rule. For a conventional
`n >= 3f + 1`, `q = 2f + 1` design, uniqueness depends on quorum intersection and honest
members signing at most one manifest for the entire election. A profile that permits
multiple close attempts or epochs must add a consensus-proven cross-attempt lock and
transition rule; per-epoch non-double-signing alone is insufficient. That proof and
implementation are a future gate, not supplied here.

Close keys and assumptions are distinct from CHide's trustee/decryption threshold even
if operators overlap.

Rules for every close profile:

- Missing seal, signature, manifest, ballot, or referenced bytes means `:pending`.
- A digest mismatch or invalid certificate means `:invalid`.
- Competing valid close certificates mean `:forked_close`; never choose by hash,
  topological order, author, or arrival time.
- Ballots outside the certified manifest are late/excluded. Causal concurrency with a
  close proposal is not the eligibility rule.
- The registration roster and DKG result need equivalent sealing discipline.
- The certificate proves domain-specific non-equivocation under stated assumptions.
  Lattice itself still has no global finality.

## 10. Projection, replay, and convergence

`Township.Election.project/3` performs a pure reduction over an artifact **set**:

1. validate the Lattice log structurally;
2. apply Lattice authority analysis to board commands;
3. extract honored protocol artifacts;
4. canonicalize and deduplicate by inner artifact digest;
5. resolve explicit references to a fixed point from the supplied bytes;
6. verify role signatures, phase certificates, close, and construction proofs; and
7. derive phase, result, pending requirements, rejected artifacts, faults, and the
   reviewed claim-set ID.

```elixir
%Projection{
  election_id: election_id,
  phase: phase,
  status:
    {:pending, [Requirement.t()]}
    | {:invalid, [Finding.t()]}
    | {:forked, [Finding.t()]}
    | {:aborted, reason}
    | {:final, Result.t()},
  close_id: binary() | nil,
  rejected: [ArtifactVerdict.t()],
  faults: [ProtocolFault.t()],
  claim_set_id: binary()
}
```

Every permutation of the same complete op and artifact set must produce byte-identical
projection output. Partial replicas may report different progress, but none may report
`:final` without the full close-bound transcript. After complete delivery, they
converge.

Protocol-invalid artifacts remain immutable audit evidence but do not mutate the
verified projection. A later conflicting valid certificate changes the current status
to `:forked`; `state_at` still reproduces each earlier partial view. Under the stated
honest-signatory assumption, the conflict should be impossible. If it occurs, fail
closed rather than preserve an earlier displayed result.

Large proof artifacts may live outside the hot Lattice log only as immutable digest
references. Fetching is not part of verification. A replay without all verified bytes
is `:pending` or `:invalid`, never final. No compaction may discard security-relevant
bytes until an offline-verifiable bundle and snapshot trust rule are defined.

## 11. Security claim contract

The public security manifest is versioned and reviewable:

```elixir
%SecurityProfile{
  profile_id: binary(),
  construction: %{paper: binary(), version: binary(), parameters_digest: binary()},
  implementation_status: :research | :experimental | :independently_reviewed,
  theorem_reference: binary() | nil,
  ideal_leakage: [:final_result, :ballot_count, :removed_count],
  claims: %{
    board_integrity: claim(),
    convergence: claim(),
    universal_verifiability: claim(),
    eligibility: claim(),
    ballot_privacy: claim(),
    receipt_freeness: claim(),
    credential_surrender_resistance: claim(),
    forced_choice_resistance: claim(),
    forced_abstention_resistance: claim(),
    closure_safety: claim(),
    censorship_resistance: claim(),
    availability: claim()
  }
}
```

Each claim is `:not_claimed`, `:conditional`, or `:failed`, with named assumptions,
scope, exclusions, and evidence. A candidate CHide profile may eventually make ballot
privacy, universal verifiability, receipt-freeness, credential-surrender resistance,
and forced-choice resistance conditional claims.

Until a concrete anonymous transport, metadata model, cover/dummy policy, inclusion
evidence, and composition proof exist, forced-abstention resistance is **not claimed**.
Censorship resistance and tally availability are also not claimed by this design.
Close non-equivocation is conditional on its separate close policy.

The unavoidable ideal result and background-vote distribution stay explicit. A small
or unanimous electorate may reveal an individual's choice through the final tally even
when the transcript adds no extra leakage. Product language must not hide that fact.

## 12. Failure model

Keep structural, authority, and protocol failures separate.

| Layer | Examples | Projection effect |
|---|---|---|
| Lattice structure | bad op signature, wrong replica, missing dependency | existing structural rejection or pending dependency |
| Lattice authority | absent/revoked/wrong-audience capability, wrong command family | outer command quarantined and audited |
| Protocol | malformed artifact, bad proof, wrong phase reference, threshold failure, fork | rejected, pending, invalid, or fatal as defined below |

Stable protocol reasons should include:

- `:wrong_election`
- `:unsupported_profile`
- `:noncanonical_artifact`
- `:artifact_too_large`
- `:artifact_unavailable`
- `:artifact_digest_mismatch`
- `:invalid_role_signature`
- `:unauthorized_publisher`
- `:missing_phase_reference`
- `:invalid_ballot_proof`
- `:duplicate_role_contribution`
- `:trustee_equivocation`
- `:box_equivocation`
- `:checkpoint_incomplete`
- `:close_incomplete`
- `:forked_close`
- `:threshold_not_met`
- `:tally_proof_invalid`
- `:result_mismatch`

Missing data, seals, or shares are pending. Cryptographic failure, malformed certified
state, or conflicting valid certificates are invalid/fatal. Nothing silently produces
a partial tally.

Errors, telemetry, audit bundles, and exception text must never contain private
credentials, registration shares, ballot randomness, real/decoy labels, trustee secret
shares, or client coercion-strategy material.

## 13. Replacement test contracts

The current
[`Lattice.Attestation.Contract`](../../apps/lattice_core/test/support/attestation_contract.ex)
remains only for the legacy Stub. The new path uses distinct contracts.

### Board integration

- Every public body has a real declared `{command, args}` shape.
- Each service role is capability-restricted to its command family.
- A ballot op's outer author/cap/deps identify a box, never the voter.
- Append, sync, dump/restore, partial delivery, and replay preserve artifact IDs.
- Exact retransmission is idempotent and invalid artifacts remain auditable.

### State-machine properties

- Every arrival permutation of the same set yields the same projection.
- Invalid or missing phase references never advance state.
- No reopen exists; reruns require a new election ID.
- Missing artifacts/shares remain pending.
- Certificate forks fail closed.

### Close adversary suite

- partitioned and split box views;
- omitted causally prior ballot;
- missing or withholding box;
- double seal or close signature;
- two certified manifests;
- late/concurrent ballot;
- unavailable or corrupted manifest bytes; and
- proof that no hash/topological-order winner is selected.

### Cryptographic conformance

- official vectors for the pinned profile;
- proof/ciphertext tampering and domain separation;
- DKG corruption-bound and tally-share-quorum boundaries;
- fake and duplicate credentials remain publicly unclassified;
- encrypted cleansing excludes them without revealing which ones;
- final result and proof bind the exact spec, roster, and close digests; and
- BEAM/native/cross-runtime canonical bytes and verifier results agree.

### Secret handling and operations

- No secret-bearing value appears in logs, wire frames, dumps, read models, telemetry,
  exceptions, or audit bundles.
- Trustee crash/restart republishes persisted contribution bytes.
- Duplicate delivery is idempotent.
- Insufficient shares cannot produce a result.
- Offline verification succeeds from the complete exported bundle and fails closed
  when any committed artifact is absent or altered.

Comply/resist scenarios are useful regression fixtures but do not prove computational
indistinguishability. The security claim rests on the pinned construction's formal game
and reduction, plus a reviewed mapping from that construction to this transcript.

## 14. Migration from the current seam

| Current interface | Replacement |
|---|---|
| `receipt_free?/0` | reviewed `SecurityProfile` with conditional claims |
| `cast_vouch(identity, choice, opts)` | `prepare_ballot(verified_election, credential, choice, entropy)`, then anonymous submission |
| `tally(bodies, opts)` | pure board projection and verification of a close-bound trustee transcript |
| `produce_alt(token, demanded)` | `make_decoy(verified_election, real_credential, entropy)`, followed by an ordinary ballot that does not count |
| caller-held `vouches:` | linked `Township.ElectionBoard` log plus resolved, verified artifacts |
| cast token | private credential wallet and opaque inclusion-check state, never logged |
| `receipt_free?: true/false` read-model field | phase, verification status, claim-set ID, conditions, and explicit non-claims |

Migration sequence:

1. Correct Phase F documentation that still promises a drop-in module swap.
2. Freeze `Lattice.Attestation.Stub` as legacy and keep `receipt_free?/0 == false`.
3. Add the Matter-side authorized election link, versioned types, canonical artifact
   bytes, and the dedicated board schema with an in-memory artifact resolver—without
   any coercion-resistance claim.
4. Add pure projection, close-policy, offline-bundle, and adversarial replay contracts.
5. Prove the anonymous-ingress and private-registration operational design.
6. Select and pin one construction profile and its implementation dependencies.
7. Add registrar, box, close, and trustee role runners with durable secret/randomness
   handling.
8. Complete formal composition mapping, independent cryptographic review, conformance
   vectors, and town-scale benchmarks.
9. Change [`Township.ReadModel`](../../apps/lattice_core/lib/township/read_model.ex) and
   the audit bundle from caller-held vouches to verified election projection.
10. Switch W4 only after every gate passes; retire `M4Placeholder` and the legacy
    contract last.

W0-W3 need no semantic change. W4 and the shared read/audit surface do change; the
original “swap, not rewrite” claim is formally retired.

## 15. Blocking gates

All gates are mandatory before W4 may be described as conditionally
coercion-resistant:

1. Product accepts a multi-role, multi-phase election rather than a local vouch
   callback.
2. One exact CHide/encrypted-sorting profile, revision, algorithm set, parameters, and
   theorem mapping are pinned.
3. A maintained cryptographic implementation strategy is selected and reviewed for
   constant-time behavior, side channels, key handling, and native-process isolation.
4. Registration and private credential delivery satisfy the selected construction.
5. The anonymous-channel threat model, traffic observer, denial-of-service boundary,
   and inclusion-check behavior are explicit.
6. The POC accepts unanimous-box close, or a named BFT close protocol and proof replace
   it.
7. Artifact data availability and a complete offline replay package are specified.
8. Trustee corruption bound, tally-share quorum, DKG, key custody, restart, randomness
   persistence, abort, and resharing semantics are fixed and validated as one profile.
9. Artifact codecs, bounds, domain separation, and cross-runtime canonical bytes are
   pinned.
10. No secret-bearing value enters any Lattice or operational transcript.
11. Official vectors and the adversarial contracts above pass.
12. An independent cryptographic review clears the implementation and composition
    argument.
13. Measured 100-, 1,000-, and 10,000-participant runs report CPU, wall time, memory,
    network bytes, artifact bytes, cold/warm verification, trustee count, candidate
    count, dummy ballots, and revotes. Product accepts the observed cost; this brief
    invents no latency target.

Until then, the runtime claim set remains `:research`/`:not_claimed`, and the existing
Stub remains the only W4 implementation.

## 16. Non-goals

- No claim that Lattice provides consensus, a globally complete view, or election
  finality.
- No protection under continuous physical surveillance or a compromised voter client.
- No anonymous-channel claim from merely naming Tor, Nym, a VPN, or a relay.
- No availability or censorship-resistance claim against selective denial of service.
- No recovery after the selected registrar or trustee corruption threshold is broken.
- No automatic trustee succession through ordinary Lattice capabilities.
- No chameleon rewriting or deletion of Lattice history.
- No production transcript compaction before offline replay and snapshot trust are
  solved.
- No 10,000-participant feasibility claim before measurement.
- No assumption that a Rust NIF, isolated process, or particular library is required
  before the pinned construction and review choose it.
- No change to W0-W3, key recovery, E2EE, federation, cross-town identity, or the
  casting UI in this brief.

## 17. Open research decisions

- Which exact updated CHide or encrypted-sorting construction is sufficiently reviewed
  and implementable to pin?
- Which DKG, mixnet/MPC, proof, and threshold-decryption implementations satisfy its
  assumptions?
- What are the real time, memory, bandwidth, and transcript sizes at town scale?
- How is private registration delivered with the required honest-party assumption?
- What anonymous transport withstands the in-scope traffic observer?
- Is unanimous-box close operationally acceptable, or is a separately proven BFT close
  service required?
- How do acceptance and inclusion checks improve accountability without creating new
  coercion evidence?
- Which revoting, duplicate, dummy-ballot, and settlement policies match the security
  game?
- How are trustee crashes, resharing, randomness persistence, and secret deletion
  handled safely?
- How does a small electorate bound unavoidable ideal-result leakage?
- Which artifacts must survive forever, and how is their availability certified?
- How is decoy credential behavior exposed without teaching the client, logs, or UI to
  label which credential is real?

## 18. Final conclusion

**Adopt this interface direction; do not implement M4 behind the old callbacks.**

The stable seam is now clear:

- `Township.Election` owns the phased coercion-resistance protocol;
- `Township.ElectionBoard` is a dedicated capability-gated Lattice bulletin board;
- anonymous boxes publish voter-created encrypted ballots without voter identity;
- a separate certificate fixes the exact ballot manifest;
- trustees produce a proof-bearing tally transcript; and
- every replica deterministically verifies the same finalized artifact set.

The next authorized work should be a decision/spike package for gates 2-7—not an
`M4Placeholder` implementation and not a `receipt_free? == true` test.
