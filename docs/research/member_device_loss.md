# Treehouse member device loss: R19a contract proposal

Status: **proposed for integrator adoption and Claude Fable design review. No
implementation or AF-3 success is claimed.** This document prepares unified
R19a on accepted R01a/R02 main commit
`f0e323b638e8a8095bbcf6f420066c238d126b6e`. R19b must implement and prove the
adopted contract in BEAM and TypeScript together; R20 owns packaged new-phone
readmission. R04, R10, R14 and the final landed R03 judge remain integration
dependencies, regardless of a prepared branch's local test results.

The proposed result is a group statement: **two other current member keys
vouched that this new key belongs to the person previously using that old
member key, and the current admin recorded their statement.** The statement
does not prove a human identity, carry a capability, recover a private key,
change an old signature or settle a loan. Admission and old-key exclusion are
separate, visible operations.

## 1. Evidence and the necessary amendments

Read this with [unified R19a/R19b/R20](../../plans/roadmaps/treehouse-unified-2026-09-06.md#three-losses-and-their-composition-r16-r18r20),
[Plan 177 AF-3](../../plans/177-group-first-antifragile-reaim.md#af-3-member-device-loss),
[Plan 178](../../plans/178-treehouse-contract-correction.md), and
[Plan 158](../../plans/158-real-device-beta-poc-program-map.md). Source Plan 180,
Phase 3, is the user-named untracked file
`/Users/nicholas/develop/lattice/plans/180-group-first-roadmap.md`, read only;
its SHA-256 at preparation is
`06f340581f0ae589b061265b62df0d6161ab95d37a656a46c4bc4ae7b2468c92`.
Its historical proposed Plan 182/183 slots map to unified R19a/R19b here; this
proposal allocates no numerical plan.

The following evidence was inspected, rather than inferred from old plan copy:

| Source | Observed contract | Consequence |
| --- | --- | --- |
| Accepted-base `Lattice.Authority.tombstoned?/1`, `authority.ex:134–154` | A root-authored `:tombstone` irreversibly kills the whole replica. | Never implement an identity retirement with this operation. |
| Accepted-base `Lattice.Crdt.OrSet`, `crdt/or_set.ex:1–12` | Membership removes only observed admission tags; a concurrent add survives. | Check the exact admission evidence, not a last-event string or a public-key list supplied by a caller. |
| Accepted-base `Authority.causal_context/5` and `Replica.command_conflicts/3` | Application callbacks receive only strict ancestors and prior individual verdicts. A separate final conflict pass can deny concurrent candidates. | Define causal membership and concurrent removal separately; do not recurse through authority analysis inside the callback. |
| R10 snapshot `3d6a44431c6f3f1a3802aeab948f0dbb8e8f73a5`, `Treehouse.Space` and `Treehouse.Invitation` | Recipient-signed invitation acceptance binds Space, invite ID, recipient and exact Thread scope. Space membership, capability issuance, held roles and transport admission remain separate. | Reuse ordinary explicit admission. The new certificate is not an invitation acceptance or a grant. |
| R04 snapshot `75e544d2a82266fad89021b411a303f18809745b`, bounded continuation contract and judge | A surviving holder/nominee can obtain only the preauthorized operation ceiling under a finite, witnessed profile. | The new admin command must be present in that ceiling before founder loss. AF-3 cannot retrofit it or rotate immutable root/witness bindings. |
| Plan 158 custody v2 and unified R24/R25/R29 | Return binds the original parties and active borrow; later original-grant expiry does not rewrite those parties. Selected receipts require fresh possession of the original signing key. | A continuity link is not a receipt signature or an exceptional lost-key return policy. |

The R04/R10 SHAs are immutable integration evidence, not claims that those
packets or the final R03 remediation have landed. R19b must recheck these seams
against the actual combined accepted source before its RED tests and code.

Proposed dated amendments, to adopt explicitly before R19b production edits:

1. **Plan 177 AF-3:** replace the meaning of “the old identity is tombstoned”
   with: “The log retains a signed old/new-key continuity statement. The old
   membership is explicitly removed, and each old capability is separately
   revoked by an authorized issuer/root or lapses under a valid signed epoch;
   transport removal is tracked separately. No replica tombstone or signature
   alias is created.” Preserve the original frozen paragraph as history and
   append the adopted correction; do not silently rewrite its status claim.
2. **Plan 178 exact Space vocabulary:** add exactly
   `attest_member_key_v1(claim, possession, vouches)`, described below. It
   records an admin-approved attestation or a fresh resolution using the same
   closed form. No new Thread command or operation kind is added. Preserve
   existing invitation, admission, removal, author-edit and tombstone meanings.
3. **Plan 180 Phase 3 / Plan 158 identity boundary:** select this closed
   two-member certificate, possession/context binding, conflict policy and
   lost-loan limits as the unified R19a decision. Reuse the certificate pattern,
   not succession/beacon bytes, governance keys or their authority semantics.
4. **R14 creation and enrollment integration:** include the exact new command
   in newly selected bounded Space admin ceilings before loss. Do not widen
   any existing delegation, silently regenerate a historical genesis, or make
   the R10 root-only preview helper derive a broader genesis from a newly
   expanded command registry. Its existing command list and vectors stay
   byte-identical; an explicitly versioned bounded-profile creator owns the
   new ceiling. Pin the legacy BEAM/TS creator to the literal original six-command
   ceiling, and pin the historical Space exporter fixtures to that same explicit
   ceiling through the reviewed Sim `ops:` option. Registry expansion must not
   determine any legacy genesis bytes. An old profile lacking this permission
   refuses AF-3 recording.

These are proposed amendments only. The source plans, frozen claim text,
shared README and unified execution ledger are unchanged by this document.

## 2. One certificate and one ordinary admin command

Use an existing `:command` operation with the exact body:

```elixir
{:attest_member_key_v1, [claim, possession, vouches]}
```

The command writes `"attest_member_key_v1"` to the existing `admin_actions`
authority marker, using its ordinary `:admin` holder gate. The whole command also
needs a real capability permitting this exact command. The full immutable
statement and certificate remain in the retained authenticated signed command
body, with its outer operation ID as provenance. A pure query derives continuity
records only from commands actually honored by the complete authority/application
analysis. It does not treat the marker's current value as an audit log, add a
materialized field, duplicate the evidence in another log, or change the marker's
type. This preserves legacy R10 state shapes and vector bytes. It does not modify
`members`, issue/revoke a delegation, change a role, alter a post, or admit a
transport peer.

Enable this application contract only for a supported R04 bounded **Space**
family. Legacy/root-only preview and Thread replicas cannot use the new
command as an AF-3 shortcut. Existing histories and kinds are unchanged. Root
possession alone does not bypass the normal capability and current-admin gates.

The threshold is **exactly two distinct other current member keys** in v1.
Both keys must differ from `old_pub` and `new_pub`; all signatures must verify.
The admin may be one voucher only if it independently has qualifying member
admission evidence. A held admin/moderator role is not membership. A singleton,
one surviving voucher, duplicated key, third surplus entry, or missing signature
refuses; select two and sign that exact set. A larger threshold is a separately
versioned policy decision, not a caller field. These are ordinary member keys,
not R17/R36 governance witness keys. No new grant is needed merely to make a
detached signed statement; only the final admin command writes to the Space.

Two keys do not prove two people or truthful recognition. An admin and
colluding members can make a false statement; the protocol exposes their
signed assertion and cannot establish civil identity. The admin can already
admit a fresh member through the ordinary path. This certificate does not add
an authority route for either party.

### 2.1 Closed claim and canonical bytes

Use this exact atom-keyed carrier map in BEAM, with a one-to-one closed
camelCase TS object mapped to the same atom keys. No omitted, extra or duplicate
map key is accepted. Text is nonempty valid UTF-8; the reserved Space identifier
must also satisfy R04/R09's exact ASCII grammar. Public keys and signatures are
raw 32/64-byte binaries in canonical terms, canonical padded Base64 in JSON.
IDs are canonical unpadded base64url SHA-256 IDs. Lists of IDs sort by their
ASCII bytes, with no duplicates. No JavaScript lossy string conversion is valid.

```elixir
%{
  version: 1,
  product: :treehouse,
  space: full_bound_space_replica,
  old_pub: old_raw_pub32,
  new_pub: new_raw_pub32,
  old_admission: honored_old_admit_op_id,
  old_membership: :active | :removed,
  nonce: fresh_raw_32_bytes,
  deps: sorted_actual_outer_op_deps,
  epoch: verified_logical_epoch,
  epoch_basis: sorted_maximum_epoch_beacon_op_ids,
  parents: sorted_prior_claim_ids,
  vouchers: [
    %{member: raw_pub32_a, admission: active_admit_op_id_a},
    %{member: raw_pub32_b, admission: active_admit_op_id_b}
  ]
}
```

Voucher records sort by raw member key bytes and contain exactly those two
fields. The old/new public keys differ. `parents` has at most 16 entries; an
excess refuses with a visible capacity stop rather than dropping evidence.
`deps` and `epoch_basis` obey the existing complete-history/carrier bounds and
must be nonempty. Do not guess that any fixed number of DAG heads always fits
the existing frame limit. The complete one-op carrier JSON envelope must fit
the unchanged 64,000-byte limit, including its normal batch/envelope overhead,
before signing and again before enqueue. Detached-artifact size alone is not
proof that the final operation can be relayed.

Define exact bytes using existing `Canonical.term/1` and the TS canonical
carrier-term encoder, not JSON serialization:

```text
claim_id = base64url(SHA256(Canonical.term([
  "treehouse-member-key-claim-v1", claim
])))

possession_bytes = Canonical.term([
  "treehouse-member-key-possession-v1", claim
])
possession = Ed25519_sign(new_member_key, possession_bytes)

vouch_bytes = Canonical.term([
  "treehouse-member-key-vouch-v1", claim, possession
])
vouches = [
  %{member: raw_pub32_a, signature: Ed25519_sign(member_a, vouch_bytes)},
  %{member: raw_pub32_b, signature: Ed25519_sign(member_b, vouch_bytes)}
]
```

Each signature entry has exactly those two fields, in the same member order as
the claim. Reject missing, surplus, unordered, duplicate, unknown, malformed or
bad signatures; do not verify only the first two of a longer list. The new
key signs the actual old-key assertion and full context, not an unrelated
possession challenge. Both vouchers sign that exact possession evidence.
An old-key, admin, witness-purpose, invitation-acceptance or cross-product
signature cannot substitute for it.

The final admin signs the existing normal canonical operation payload, which
includes the exact body, dependency list, replica, cap and raw author key. Its
ID is computed last. `claim_id` deliberately excludes that future outer ID;
its dependencies and prior claim IDs are already known, so no circular hash is
needed. Repeating the same claim in another otherwise valid wrapper records
the same logical statement, with every signed wrapper retained for audit.
It does not create a second vote or a new continuity head.

### 2.2 Independently derived evidence, not caller assertions

The review builder authenticates each retained frame's hash and signature,
exact replica, duplicate identity and complete causal closure, preserving
authenticated quarantined/application/inbox ancestry. It derives the actual
frontier; `claim.deps` must equal it. It obtains no holder, roster, epoch or
root from a caller label. A changed frontier before assembly requires a new
claim and fresh possession/vouches. The runtime cannot prove that an untrusted
caller or unavailable peer supplied all existing operations; this is a
retained-snapshot check, not a global freshness guarantee.

The new command requires the outer operation's dependency list itself to be
sorted by canonical ASCII op ID and duplicate-free. Compare it element-for-element
to the closed sorted `claim.deps`; reordered or duplicated outer dependencies
refuse this command even if they name the same set. This application requirement
does not change generic outer-op encoding or legacy command acceptance. Derive
all evidence from its strict ancestry and deterministic prior verdicts:

Admission recipients use canonical padded Base64 text. Require the existing
canonical decode/re-encode round trip, exactly 32 decoded bytes, then compare
those raw bytes to the claim key; never compare display labels, unpadded text,
case-folded text or a realm name. Apply this rule to both old-key and voucher
admission references.

1. `old_admission` is an honored ordinary `admit_member` in this Space whose
   recipient is exactly `old_pub`. A role-bearing genesis or a grant alone is
   not prior membership. Never-member, outsider and quarantined admission
   targets refuse. `old_membership` must equal the actual causal OR-set state.
   A previously removed member may be vouched for only with the signed
   `:removed` value explicitly shown to all three reviewers. This does not
   reverse a ban or restore any right; a separate current-admin admission is
   still required. Hiding that removal as `:active` refuses.
2. Each voucher's cited admission must be an honored `admit_member` for that
   exact raw key and have an unremoved add-tag in the causal membership view.
   The claim pins one active tag per voucher. Removing that tag and readmitting
   the same key does not make an old tag valid again; select new evidence and
   obtain fresh signatures. The OR-set's concurrent-add semantics stay intact.
3. The initial destination key must have no honored prior admission in this
   Space and no prior continuity statement linking it from another old key.
   A resolution may select a destination already named in one of its parent
   statements, including one separately admitted in the meantime, or a fresh
   never-admitted key. It cannot merge two existing members' identities.
4. Derive `epoch` as the maximum honored, valid R03 epoch in the strict
   ancestry, and `epoch_basis` as all sorted valid beacon IDs attaining it.
   No valid beacon means refusal; zero is a valid signed epoch, not a substitute
   for missing evidence. The horizon remains R03's safe integer horizon. There
   is no new elapsed-time claim, wall-clock fallback or AF-3 lease constant.
5. Derive the continuity graph and its causal heads for `old_pub`, as below.
   Require exactly that head set in `parents`. Verify the possession and both
   member signatures over the independently checked claim.

Member eligibility is at the ceremony's signed causal position. A causal
later voucher removal does not erase an earlier attestation's historical
meaning. Concurrent removal needs the separate rule in section 3; it cannot
be smuggled into the ancestor-only callback. Epoch/capability/role verdicts
still come from the normal full retained Core fold and may reclassify a command
when concurrent authority evidence arrives. Signed claim fields never override
that judge. Do not describe a frozen certificate as perpetually executable.

## 3. Concurrent removals and competing claims

### 3.1 Removed vouchers and the final conflict pass

After individual validation, use the existing `command_conflicts/3` seam.
An individually honored attestation loses with
`:application_continuity_stale_voucher` if an individually honored
`remove_member(voucher)` is concurrent with it and observes the exact
admission tag selected for that voucher. A remove already in its ancestry
fails causal eligibility; a remove causally after the final attestation keeps
the historical statement honored. A concurrent remove that did not observe
the selected concurrent admission tag does not retire that tag: preserve the
existing add-wins rule, and show the surviving membership honestly.

Compute conflict seeds first, then a deterministic causal pass propagates
`:application_continuity_invalid_parent` to any resolution for which a parent
claim has no remaining honored wrapper **in that resolution's strict ancestry**.
A concurrent/later wrapper cannot repair its missing causal evidence. This
closes the existing seam's
single-pass limitation: individual callbacks cannot see a parent's final
conflict loss. The propagation only denies previously individually honored
attestations; it never resurrects any command or alters authority evidence.
Unrelated admissions, grants, posts and historical signatures do not depend
on a continuity projection and do not become valid or invalid through it.

A separate collision is two different old keys claiming the same fresh
destination key. A causal prior accepted claim makes that target unavailable
to the second old key. Concurrent individually valid claims from different
old keys to the same new key both get
`:application_continuity_conflicting_target`; propagate parent invalidity as
above. Do not pick a person by canonical ID. The supported retry uses a fresh
destination key and new signatures; already admitted destination keys keep
their independent ordinary grants until explicitly removed/revoked/lapsed.

### 3.2 One old key, several asserted new keys

For each `(Space, old_pub)`, group final honored wrappers by `claim_id`.
`parents` references prior claim IDs, each supported by at least one honored
wrapper in the candidate's strict ancestry. The candidate must cover **all**
causal heads of this old key, not an arbitrary preferred subset. Parents are
always earlier; a cycle or self-reference is impossible to justify and
refuses. The head set is the retained honored claims not superseded by another
honored claim's parent edges. Use deterministic byte sorting for display.

| Complete retained result | Projection and allowed response |
| --- | --- |
| No honored claim | `unlinked`; ordinary fresh-key admission remains possible, but no AF-3 link claim. |
| One head | `attested`, naming its exact old/new keys, prior admission, two voucher keys, context and admin operation(s). This is an assertion, not proof of human identity. |
| Two or more heads, even if they name the same destination | `contested`, preserving all heads and vouchers; no single asserted successor is selected and continuity-based display shortcuts pause. |
| Parent lost on full-fold/conflict reanalysis | Its dependent resolution is refused; expose `review_required` with the affected retained statements and reasons. Do not silently present an invalidated resolution. |
| More than 16 heads or an oversized final envelope | `capacity_stop`; retain/export evidence and refuse another resolution. No eviction, arbitrary truncation or automatic outsider/operator override. |

Only the **current capability-authorized admin plus fresh possession by the
chosen destination key and two fresh qualifying member signatures** can
resolve a contested set. Use the same command and a fresh claim whose
`parents` is the exact set of all known causal heads. The new destination may
be one of the conflicting candidates or a fresh eligible key. The former
admin, one voucher, operator, old key alone or a software-selected minimum hash
cannot resolve it. A current admin who is also a qualifying member may supply
one of the two vouchers, never both.

Two concurrent resolutions create another contested head set. A resolution
missing a head already in its own ancestry refuses as stale context. A head
withheld until later creates a contested result after heal; there is no
unknown-history oracle. Replaying the same signed frame is idempotent, and
another valid wrapper around the identical claim is coalesced. Reusing old
possession/vouches with any changed new key, parent, admission, Space, nonce,
epoch or dependencies fails its signature checks. Nonces are fresh random
32-byte ceremony challenges, not clocks or a claim of global replay detection;
the complete signed claim and graph supply the replay binding.

Honored historical statements remain visible after a later resolution. Keep
old-key and new-key attribution separate: this graph never rewrites an author
or becomes an equality/alias relation. Do not infer that A→B and B→C authorize
C to sign as A, edit A's posts or present A's receipts. A losing destination
that was separately admitted does not lose those rights through this graph;
show and reconcile its actual grants/membership/transport separately.

### 3.3 Refusal precedence

Keep Core's existing structural → malformed/unknown command → capability →
holder → application-policy precedence. Within this new application's
individual check, pin the following order in both runtimes:

1. Closed shape, supported product/Space family, distinct keys, exact deps and
   exactly two ordered/distinct aligned signature-entry identities:
   `:application_invalid_continuity`.
2. Referenced admission, parent wrapper or epoch-basis target missing/not
   causal: existing `:application_target_not_visible`; quarantined target:
   existing `:application_target_quarantined`; wrong kind/recipient/Space:
   existing `:application_wrong_target`.
3. Old status, new-key eligibility or voucher active-tag mismatch:
   `:application_continuity_ineligible_member`.
4. Epoch/basis disagreement or absent valid epoch:
   `:application_continuity_invalid_epoch`.
5. Incomplete parent set/cycle/unsupported causal resolution:
   `:application_continuity_stale_context`.
6. Well-shaped but cryptographically bad possession or vouch signatures:
   `:application_continuity_invalid_certificate`.

Final concurrent-removal/cross-old-target reasons and propagated invalid-parent
reasons apply only after individual checks. If several final reasons apply,
use stale voucher, conflicting target, then invalid parent in that order.
Malformed encoding/signature lengths remain closed-shape failures; a
well-shaped wrong signature is a certificate failure. Contested same-old
claims are honored facts with a contested projection, not fabricated
cryptographic or authority failures. The exact dictionary and every ambiguous
precedence pair need reciprocal negative vectors before implementation closure.

## 4. Readmission, retirement and an old phone returning

The R20 durable workflow is:

1. Generate the new ordinary member identity in its own product store. Review
   the exact old/new fingerprints, Space and prior admission with the user.
   Do not import the lost key, share a seed, clone a backup identity into a new
   person, or reuse a governance witness key.
2. Obtain authenticated current Space evidence from an already admitted member.
   Derive the claim, record the frozen attempt, obtain the new-key possession
   signature and two member vouches, then recheck the actual retained frontier
   and current admin authority before signing/enqueueing the normal final op.
   Changed evidence cancels that attempt and requires new signatures. A
   transport retry retransmits the exact durable signed op; it does not
   regenerate an operation or solicit new consent implicitly.
3. After a locally verified non-contested attestation, conduct the ordinary
   recipient-bound invitation/acceptance and explicit admin admission. That
   existing acceptance is signed separately by the new key and binds the exact
   current Thread scope. Issue fresh exact-audience, bounded Space/Thread
   grants from surviving authorized issuers. A certificate alone cannot admit
   a member, post, or bypass a changed Thread inventory.
4. Explicitly remove old-key membership; request actual issuer/root revocation
   for every old Space/Thread grant, or wait for verified logical epoch lapse.
   Reconcile transport denial on the Space and every retained Thread,
   including archives. Show the independent grant and transport pending states.
   New-key admission may complete while old-key exclusion remains pending;
   do not call that completed AF-3 exclusion.
5. Record the verified link, new admission/grant/transport evidence and old-key
   retirement/removal evidence in the local durable workflow journal. Restart
   resumes exact signed attempts and authenticated evidence; missing/corrupt
   member identity storage never silently resets identity. Physical native
   store and restart proof belongs to R20/R21, not this document.

Detached vouch consent is a typed **ordinary member** operation in the future
product flow. Reuse of the ordinary member signer does not authorize arbitrary
bytes from a webview. R20 must review the closed claim and actual retained
evidence, bind the local attempt/session, and distinguish signing from merely
displaying a certificate. R17/R36 fixed governance endpoints remain unavailable
for this purpose. No protected-custody, biometric-presence, latency or
independently operated phone claim follows from an Ed25519 unit test.

| Old phone behavior | Required outcome |
| --- | --- |
| Replays old posts or receipts | Retain their original signatures and attribution; duplicate frames are idempotent. |
| Tries a new post while an old grant is still valid | Apply actual Core/Thread policy. It may still be honored; display pending exclusion and do not invent a continuity-based cap revocation. |
| Tries a post causally after a real authorized revoke or valid lease lapse | Quarantine under the existing capability/lease reason. Preserve the signed attempted op for audit. |
| Proves possession of the old key after an attestation | This proves possession of that key now, not which human lost/found/controlled it or whether the vouch was false. It does not cancel the link, restore membership, or grant new permissions. |
| Disputes the continuity statement | Record the verified old-key presentation below as a visible local unresolved claim; it cannot alone resolve or globally contest the graph. A current admin may obtain a fresh fully vouched resolution or take ordinary explicit admission/moderation/removal actions. Neither action proves which human controlled either key. |
| Was a fixed R04 nominee or held a distinct governance witness key | AF-3 does not rotate/revoke that immutable binding. Honest R14/native governance review must check the roster; a still-authorized hostile quorum/nominee remains the separately documented residual. |

Use this closed old-key presentation input in the R20 review flow:

```elixir
return_challenge = %{
  version: 1,
  product: :treehouse,
  space: full_bound_space_replica,
  old_pub: old_raw_pub32,
  heads: sorted_current_claim_ids_for_old_pub,
  deps: sorted_current_space_frontier,
  reviewer: actual_local_member_raw_pub32,
  nonce: fresh_raw_32_bytes
}
return_bytes = Canonical.term([
  "treehouse-member-key-return-v1", return_challenge
])
return_signature = Ed25519_sign(old_member_key, return_bytes)
```

Apply the same strict text/key/ID/map rules as the vouch claim. This is a fixed
ordinary-member possession purpose, not a command, receipt, admission or
governance signature. Require 1–16 exact current heads and nonempty deps; an
unlinked/oversized history cannot use this particular presentation surface.
The complete canonical challenge plus signature is bounded at 64,000 bytes
before review. The reviewing current member generates the challenge
from its own authenticated Space view and stores one pending attempt bound to
its actual native product/replica/key/session. Proposed local freshness is
60 seconds on a monotonic clock; cancellation/restart invalidates the pending
attempt, and a changed frontier/head set requires a fresh challenge. Verify
exact challenge equality, the old-key signature, actual reviewer identity and
unconsumed pending nonce before durably accepting once. Wrong key, old vouch
signature, wrong reviewer/Space/session, changed heads, replay, expired attempt
and restart replay refuse. The interval is a proposed local interaction
limit, not a distributed epoch or an identity-proof measurement.

An accepted response becomes a durable **local** `old_key_return_claim` review
record containing the challenge, signature and verified retained context. Show
`review_required` and the unresolved identity claim to that reviewing member;
reopening must not lose it. Acknowledging the notification does not erase the
record or mark the identity claim proved. Current members can review it and a
current authorized admin can change actual rights through ordinary explicit
operations or obtain a fresh fully vouched graph resolution. No v1 actor can
turn this presentation alone into a settled human-identity verdict. Subsequent
actions are displayed alongside the record without rewriting its evidence.

This local observation does not silently create a shared Core dispute op or
change another client's graph. A durable globally contested graph requires
competing valid attestations under section 3. If a later product requirement
needs an old-key-only assertion to freeze the graph on every client, that is
an explicit new payload/vocabulary and denial-of-service tradeoff to adopt and
prove before implementation, not permission implied here. R25 owns the
distinct custody-dispute format.

A founder-issued unleased old grant whose issuer/root is unavailable remains
irrevocable under current rules. Stop the claim of eventual old-key exclusion
for that profile. A stalled valid beacon chain likewise supplies no elapsed
lease guarantee. Even successful transport removal cannot erase data already
copied by the old key. Readiness covers one Space plus at most 12 total Threads,
including archives; it is not a whole-device or cross-community identity ban.

## 5. Lost-key loans and receipt boundaries

The following decisions are part of R19a adoption, not deferred ambiguities:

- Old receipts retain the old signing key. A new key can display the signed
  group statement alongside authorized history, but cannot satisfy R29's fresh
  same-key challenge for old-key receipts. Do not export a replacement signature,
  silently transfer a reputation record or aggregate a score.
- A loan borrowed by `old_pub` remains that exact active loan with its original
  parties, request and grant. An attestation, new membership, admin statement,
  owner statement or physical handover assertion cannot make `new_pub` the old
  borrower or close the ordinary loan. A new loan uses its own ordinary grant
  and exact receiving-party consent.
- A claimed physical return after loss may be recorded only as the separately
  adopted R25 dispute/assertion fact, attributed to its actual signer. It is
  not a co-signed return. The ordinary loan remains open/unresolved unless its
  actual protocol closes it. No exceptional lost-signer closure policy is
  proposed here.
- If the old signing key later returns, ordinary custody v2 can accept its
  genuine request/consent only when all exact party/loan and independent
  authority conditions hold. Original-grant expiry/revocation after the borrow
  does not by itself prevent return under R24; AF-3 must not add a blanket
  retirement rule that accidentally blocks this supported return.
- Every link is scoped to its Treehouse Space. It neither creates a Shed
  identity registry nor grants access to a Tool log. Cross-Space/Shed reuse
  refuses, and subject-selected disclosure remains bounded by actual access.

## 6. Build boundaries and executable acceptance contract

R19b is one atomic implementation packet after adoption: pure BEAM/TS closed
certificate codecs/verifiers; Space command and ordered effects; causal
membership/epoch/graph checks; deterministic final conflict propagation;
read-only projection; authenticated review/assembly helpers; signed reciprocal
vectors; dump/restore and relevant compaction mirrors; exact vocabulary and
profile-creation amendments. Reserve the shared authority/carrier/codec writer
before integration. Do not change Core authority primitives, R04 profiles,
legacy seven-field certificates or named legacy vectors to make this pass.

Each row below requires a public signed-input RED, a passing implementation,
matching BEAM/TS final op set, quarantine/reasons, attestation graph, membership
and rendered state, plus reverse delivery and authenticated dump/restore where
concurrency is involved. Tests must use the real judge and raw author keys,
not a supplied `is_member`/`is_admin` boolean. These rows are **OPEN**, not tests
executed by this docs-only packet.

| ID | Signed scenario | Required result |
| --- | --- | --- |
| A01 | Founder present; old member, fresh new key, two eligible vouchers, actual admin/cap; normal invitation/grants follow | One attested head; zero membership/capability change from the certificate itself; separate new admission and use succeed. |
| A02 | Founder identity/log/cap cache removed; actual R04 continuation; same AF-3 flow across Space and 12 retained Threads | No founder signature or hidden root; exact authorized issuers/grants and real lease/revoke exclusion prove the supported profile. |
| A03 | Zero/one voucher, duplicated key, old/new self-vouch, role-only voucher, unadmitted admin offered as a voucher, third surplus, invalid surplus/changed signature | Closed refusal taxonomy; no partial effects or accidental count by realm alias. |
| A04 | Never-member old key; quarantined/wrong-kind/wrong-Space admission; removed old key falsely labelled active; valid removed-old explicit review control | Invalid cases refuse; truthful removed-old claim is a statement only and requires a separate explicit admission. |
| A05 | Voucher removed before claim; removed/readmitted same key with stale tag; removal concurrent with final op; causal-later removal; unseen concurrent add survives | Before/stale/concurrent-observed removal refuses; causal-later statement remains historical; exact OR-set control agrees in both runtimes. |
| A06 | Wrong possession key, invitation signature, beacon/succession domain, member-vouch used as possession, cross-Space/product, changed old/new/nonce/deps/epoch/parent | Signature or scope refusal at the pinned precedence; legitimate bytes match cross-runtime. |
| A07 | Missing, forged, unsupported or stale epoch basis; signed zero control; no-beacon negative; changed frontier before assembly | Derive actual valid logical epoch; never substitute wall time or silently update a signed claim. |
| A08 | Same frame replay; same claim in two valid wrappers; reused certificate in changed claim | Idempotent logical statement, retained wrapper provenance; changed claim fails. |
| A09 | Same old key → two new keys on partitioned snapshots, then heal both orders | Both individually valid facts retained; deterministic contested heads; no ID-selected human identity or automatic cap loss. |
| A10 | Fresh two-member resolution covers all heads; omits visible head; races another resolution; withheld head arrives later; resolution parent loses in final conflict pass | Exact all-head resolution succeeds; omission refuses; races/heal become contested; invalid-parent propagation prevents a false resolved view. |
| A11 | Different old keys claim same fresh destination, causal and concurrent variants | Causal target ineligible; concurrent candidates both refused with the exact conflict reason; retry uses a fresh key. |
| A12 | Actual old-key return before and after revoke/lapse; removed transport versus stale acknowledged session; a losing separately admitted new key | Judge actual rights and preserve pending states; continuity never becomes a universal revoke or admission. |
| A13 | Existing unleased founder grant after founder loss; stalled beacon; old profile missing new admin command; quorum shrinks to one | Explicit unsupported/unresolved stop; no fabricated recovery, constant-time expiry or authority widening. |
| A14 | Old-author edit/tombstone and old-key receipt challenge attempted by linked new key; lost-key open loan/claimed physical return; genuine original-party return after original-grant expiry | Existing author/receipt/party boundaries hold; no invented closure; supported genuine return remains available under R24. |
| A15 | Missing/extra/duplicate map keys, malformed UTF-8/Base64/IDs, reordered/duplicate arrays, 16/17 heads, final envelope boundary | Byte/refusal parity and explicit capacity stop; no legacy byte movement or retained-evidence truncation. |
| A16 | Restore into independent BEAM VM and TS client; repeated delivery; current full authority fold changes an earlier statement's verdict | Same retained evidence and exact projection/reasons; invalidation visible; no persisted stale-success shortcut. |
| A17 | Fixed old-key presentation bytes: valid response, wrong key/domain/reviewer/Space, changed heads/deps, replay; R20 expiration/cancel/restart controls | BEAM/TS verifier parity; R20 accepts once into its durable local unresolved review record, never a grant, graph override or global dispute. |

R20 adds the selected physical/new-phone profiles, durable cancellation/restart,
two actual member approvals, separate ordinary admission, displayed conflict
resolution and old-grant/transport pending states, an adversarial returning old
phone, and independently verified results. Input-size and consent-prompt counts
are measured there; no test helper counts as physical consent. R19a itself
claims only this concrete proposal and source inspection.

## 7. Adoption checklist and STOP outcomes

The integrator/Fable review must accept or replace these exact choices before
R19b: one named command; exactly two ordinary member vouchers; raw-byte domains
and closed 13-field claim; explicit removed-old-member review; at-ceremony
membership with concurrent observed-removal refusal; claim-ID graph and
all-head fresh resolution; cross-old destination refusal; 16-head/envelope
stops; the eight-field local old-key presentation and proposed 60-second pending
attempt; no loan or receipt substitution. Do not treat a generic approval of AF-3
as adoption of a different wire shape or hidden identity authority.

Stop the affected workflow, retain evidence and report the specific reason if
there is no current permitted admin, fewer than two qualifying vouchers,
unsupported family/permission, invalid/missing causal evidence, an unresolvable
oversized conflict set, unresolved old grants, missing physical custody proof,
or unavailable final dependency gates. None authorizes software witness
fallback, a new root, operator signing, old-key re-signing, a cross-community
registry, or a root `:tombstone`. Ordinary independent admission may still be
possible; it must be labelled separately from a successful AF-3 link and
complete old-key exclusion.

No runtime tests were run for this docs-only preparation. Exact source reads,
document scope checks and `git diff --check` are the preparation evidence;
all A01–A17 and packaged outcomes remain unproven until their named packets.


## Proposal compatibility correction — 2026-09-06

The integrator replaced the proposed extra materialized attestation list before
adoption or production edits. Full certificates already live in signed retained
command bodies; derived records must select actually honored authenticated
commands. The existing `admin_actions` authority marker and its admin gate remain
unchanged. This mirrors the adopted R11 compatibility rule and preserves the
legacy R10 schema, fixed root-only command ceiling and existing vectors. The
closed claim, signatures, membership checks, conflicts and A01–A17 acceptance
matrix are unchanged and remain proposed for exact Claude Fable design review.


## Design review corrections — 2026-09-06

Claude Fable reviewed `2cf28134` and returned a design PASS with a P1 build-rule
gap and P2 representation clarifications; these are repaired before adoption.
The legacy six-command genesis ceiling and historical fixture path are now explicit.
Admission recipients compare canonical decoded raw key bytes; outer command
dependencies must themselves be sorted-distinct and match the claim exactly.
The fixed threshold, closed claim/signature domains, 16-parent/head capacity stop,
60-second local return challenge, truthful removed-member flow and required signed
beacon basis remain selected defaults awaiting final follow-up review and explicit
adoption. No source-plan amendment, production implementation or A01–A17 result
is inferred from this proposed document.
