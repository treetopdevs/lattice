# R19b member continuity: implementation boundary

Prepared read-only on clean `codex/treehouse-r19b-member-continuity` in
`/Users/nicholas/develop/lattice-treehouse-r19b-20260906`, exact base
`e5f5a4ef8f6f300cf7e3762829c04bb3a5cc278c`.
The initial preparation was read-only. The dated integrator adoption below
now authorizes only the initial codec slice; later shared changes remain gated. Root supplied R19a accepted-main
`413425da` / hosted run `34065326328` PASS; that is dependency evidence supplied
by the integrator, not a new hosted verification in this preparation.
R04/R10 final accepted-main gates remain prerequisites; this branch is no
permission to enable a community profile.

## 1. Recommended boundary and initial slice

Implement R19b as one eventual atomic BEAM/TS packet with one new ordinary
Space command, pure closed artifacts, authenticated observation/review/assembly,
and deterministic application conflicts. No new field, identity alias,
authority primitive, member admission, capability grant/revoke, transport right,
receipt signature or loan effect follows from an attestation.

Start with an independently reviewable **closed artifact codec and reciprocal
signed-fixture slice**. It supplies all four domains, the exact 13-field claim,
two vouches, eight-field old-key return challenge, canonical adapters and pure
signature verification in both runtimes. Keep the command unavailable until the
actual policy/conflict/raw-observer slice joins it. This is useful executable
cryptographic groundwork, not A01 or AF-3 success. The remaining slices below
are requirements of the same atomic implementation, not optional follow-ups.

Before production edits, root/Fable should adopt the concrete internal epoch
context addition, cutoff vocabulary union, and compaction disposition in §8.
These are actual current-source gaps, not permission to change global ingress.

## 2. Frozen artifacts and exact bytes

BEAM fields are atom keys and binary values. Public TS objects use the listed
camelCase names; adapters map them one-to-one to existing CarrierTerm maps.
Keys/signatures/nonce become raw bytes in canonical terms and canonical padded
Base64 in public JSON. IDs use canonical 43-character unpadded base64url SHA-256.
Use the existing `Canonical.term/1` and `canonicalBytesForCarrierTerm`; JSON is
only transport, never a signed encoding.

Claim, exactly 13 fields:

| BEAM | TypeScript | Closed constraint |
| --- | --- | --- |
| version | version | literal 1 |
| product | product | atom/string treehouse |
| space | space | exact supported bounded Space ASCII family/root grammar |
| old_pub | oldPub | canonical raw 32 bytes / Base64; differs from newPub |
| new_pub | newPub | canonical raw 32 bytes / Base64 |
| old_admission | oldAdmission | canonical op ID |
| old_membership | oldMembership | active or removed |
| nonce | nonce | raw 32 bytes / canonical Base64; caller's reviewed ceremony nonce |
| deps | deps | nonempty sorted-distinct ASCII op IDs |
| epoch | epoch | integer 0..9007199254740991 |
| epoch_basis | epochBasis | nonempty sorted-distinct canonical op IDs |
| parents | parents | sorted-distinct canonical claim IDs, 0..16 |
| vouchers | vouchers | exactly 2 closed {member, admission} records, member raw 32 bytes and admission op ID; raw-key-byte order; different from each other, oldPub and newPub |

Certificate representation is exactly `{claim, possession, vouches}` in the
helper API; the command arguments remain `[claim, possession, vouches]`.
Possession is raw 64 bytes / canonical Base64. Vouches are exactly two closed
`{member, signature}` records, aligned with the claim's ordered member keys,
with raw 64 bytes signatures. Missing, extra, duplicate, unordered or invalid surplus
fields/entries never get ignored. Preserve duplicate raw-map pairs until the
existing closed adapter rejects them. Metadata sentinels are not accepted values.

The four domains, with exact existing canonical list framing:

1. `treehouse-member-key-claim-v1`: `[domain, claim]`; SHA-256 then unpadded
   base64url yields claimId. It excludes the future outer operation ID.
2. `treehouse-member-key-possession-v1`: `[domain, claim]`; signed by newPub.
3. `treehouse-member-key-vouch-v1`: `[domain, claim, possession]`; signed by each
   selected ordinary member over the actual possession bytes.
4. `treehouse-member-key-return-v1`: `[domain, returnChallenge]`; signed by oldPub.

Return challenge is exactly eight fields:
`version, product, space, old_pub/oldPub, heads, deps, reviewer, nonce`.
Heads are 1..16 sorted-distinct current claim IDs, deps nonempty sorted-distinct
current frontier, reviewer raw 32 bytes and nonce raw 32 bytes. The closed challenge plus
signature is <=64000 canonical bytes before review. For the adopted detached-artifact bound, measure the exact domain-separated
`return_bytes` length plus the 64 signature bytes, with 64000 inclusive; a later
transport wrapper cannot claim a larger relay allowance. Root/Fable should pin
that measurement in both runtime tests before code. The pure verifier checks
exact expected challenge equality and signature; R20 alone supplies the native
60-second monotonic pending-attempt deadline, session/key binding, one-use
consumption, cancellation/restart invalidation and durable local unresolved
record. No helper boolean will claim those native facts.

The normal final command is exactly
`{:attest_member_key_v1, [claim, possession, vouches]}` / matching CarrierTerm.
Its sole ordered effect is `admin_actions := "attest_member_key_v1"` through
that field's existing admin gate. It requires an actual command capability.
The exact one-push JSON envelope `{type:"push",ops:[frame]}` is <=64000 bytes,
checked before outer signing using the fixed64-byte signature representation
and again on the actual signed frame before returning/enqueueing. Keep equality
at 64000 valid. Do not introduce an aggregate/frame limit or truncate deps/heads.

## 3. Proposed public seams

Names below are proposed concrete APIs, not existing exports.

### Pure artifact layer

BEAM new `Treehouse.MemberContinuityCertificate`:
`normalize_claim/1`, `normalize_certificate/1`, `normalize_return_challenge/1`,
`claim_id/1`, `claim_bytes/1`, `possession_bytes/1`, `vouch_bytes/2`,
`return_bytes/1`, `verify_certificate/2` (certificate, independently expected
claim), `verify_return/3` (challenge, signature, independently expected challenge).
Normalizers return `{:ok, normalized}` or `{:error, :invalid_member_continuity}`;
verifiers return `:ok` or that error. They confer no semantic membership.

TS new `treehouse_member_continuity_codec.ts`: exported exact interfaces
`MemberContinuityClaim`, `MemberContinuityCertificate`, `MemberKeyReturnChallenge`;
`normalizeMemberContinuityClaim`, `normalizeMemberContinuityCertificate`,
`normalizeMemberKeyReturnChallenge`, `memberContinuityClaimId`,
`canonicalBytesForMemberContinuityClaim/Possession/Vouch/Return`,
`verifyMemberContinuityCertificate(certificate, expectedClaim)`,
`verifyMemberKeyReturn(challenge, signature, expectedChallenge)`;
`memberContinuityCertificateToCarrierTerm/FromCarrierTerm` and the narrow
DecodedTerm adapter for the three command arguments. Normalizers/adapters
return null on invalid values, byte helpers reject malformed input, verifier
returns false. No new generic term decoder or canonical encoder is needed.

### Authenticated observation

BEAM new `Treehouse.MemberContinuity.observe/1` accepts a complete Log, calls
`Log.verify_authenticity/1` before any projection, checks requested supported
Space, then the actual `Authority.analyze(Treehouse.Space, log)` and reducer.
An optional `from_frames/2` convenience must go through Wire, complete closure,
and R06 validation before this function; it must not silently drop refused data.

TS `observeMemberContinuityFromFrames({replica, frames})` accepts cloned raw
accepted frames only. It authenticates every hash/signature, exact replica,
duplicate identity and complete causal closure before projecting. Authenticated
semantic/unknown-command/inbox/quarantined frames stay in the retained snapshot
and verified frontier. A bad-signature rejection journal remains separately
retained by its existing owner and cannot supply accepted causal closure.
No semantic Op[] or is_member/is_admin value is accepted as trusted public input.

Proposed result:

```ts
{ok:true, replica, verifiedFrontier:string[],
 records:{claimId:string, claim:MemberContinuityClaim,
          wrappers:{opId:string, author:string, capId:string}[]}[],
 links:{oldPub:string, heads:string[],
        status:"unlinked"|"attested"|"contested"|"review_required"|"capacity_stop",
        affectedWrappers:{opId:string, reason:string}[]}[],
 quarantine:{opId:string, reason:string}[]}
| {ok:false, reason:"invalid_verified_history"|"unsupported_continuity_history"}
```

Sort records/links/wrappers/reasons deterministically by raw-key/ASCII-ID rules.
Return exact canonical certificates through retained wrapper bodies or a named
body field, not by copying a lossy marker. Include query key input `oldPub?` if
an explicit unlinked key needs a row; absent keys otherwise need no invented
list entry. Final honored records are separate from authenticated refused
wrapper evidence. `review_required` exposes invalidated parent-dependent
resolutions; it does not invent a winner or supersede stronger capacity_stop.
Do not return one selected successor for contested rows. Membership and grants
are ordinary independent projections, not fields owned by this link graph.

### Review and assembly

`reviewMemberContinuityFromFrames` / `MemberContinuity.review` take raw complete
Space history plus explicit requested oldPub, oldAdmission, newPub, reviewed
oldMembership, nonce and exactly two voucher admission IDs, and the proposed
raw admin author/cap reference. Derive voucher keys, actual status, frontier,
valid epoch/basis and exact all-head parent set from history. Do not accept
caller holder, roster, profile, epoch, parents or frontier as authority.
Return the closed claim, exact claimId and bytes to be reviewed/signed, plus
actual raw admin key/cap and frozen raw frontier; changed removed/active state
refuses rather than silently rewriting consent.

`assembleMemberContinuityFromFrames` / `MemberContinuity.assemble` take a fresh
raw snapshot, previous review, certificate and the ordinary admin signer.
Recompute the review and compare canonical claim bytes exactly, verify possession
and both vouches, verify signer == actual raw author, and preflight the actual
normal candidate through existing capability/holder/application judgment.
A deterministic unsigned candidate is an internal intent only, never an accepted
Log/verified raw result; no separate permission algorithm is permitted. Sign only
a passing exact intent, verify returned signature/hash and final envelope size,
then re-run the public signed-input fold before returning the frame. Return
`{ok:true,frame,claimId}` only for an actually honored local candidate; otherwise
return the normal reason or a named `stale_verified_state`/capacity failure.
The caller owns durable frontier/session serialization and enqueue. A resend
reuses the saved signed frame; the helper never silently refreshes consent.

## 4. Individual command judgment

The Space command parser creates its existing admin marker effect even when
well-framed arguments normalize invalidly, so semantic shape errors reach the
application check after normal structural/arity/capability/holder precedence.
No malformed command gains a fallback effect, and no application code bypasses
Core's all-or-none behavior.

Causal member tags come from individually honored ordinary `admit_member`
operations in `context.visible_ops/verdicts`, canonical recipient decode to
raw 32 bytes, and individually honored removes that observe those exact add op IDs.
Use the existing OR-set definition: a key is active if any admitted tag survives;
removing an old tag and admitting a new tag does not revive the old voucher tag.
An admin/moderator role or grant is not membership. OldAdmission must be a genuine
honored admission even when the truthful claim says removed. Active/removed for
the old key is the aggregate causal OR-set state; it is not a claim that its cited
old tag necessarily remains live.

The new key is never previously admitted for an initial link, and not claimed
from another old key. A resolution may choose a parent's previously named target
(including independently admitted meanwhile) or a fresh eligible key. This does
not permit merging two existing members or infer transitive key equality.

Reuse the judge's already computed valid R03 beacon evidence, restricted to strict
ancestors (§8), never a caller epoch or a second policy decoder. Require at least
one valid beacon; signed zero is valid. Select all max-epoch IDs. Any valid legacy
high-uint64 epoch outside the R03 safe claim horizon refuses without rounding or
reinterpretation. No elapsed-time fallback.

Parents are claim IDs, not wrapper IDs. Every parent needs at least one honored
wrapper in strict ancestry for this same old key; derive all causal heads there.
Missing/not-causal targets precede quarantined targets, then wrong kind/Space/raw
recipient, then eligibility, epoch, parent context and cryptographic certificate.
Within each tier scan every referenced target before advancing to the next tier,
so error choice is not accidental list order. A known parent with only quarantined
causal wrappers is target_quarantined; a merely concurrent/later wrapper cannot
repair it. Exact outer deps must themselves be sorted-distinct and equal claim.deps
rather than relying on generic canonical set normalization.

Pin exact individual reasons in the adopted order:
`application_invalid_continuity`, `application_target_not_visible`,
`application_target_quarantined`, `application_wrong_target`,
`application_continuity_ineligible_member`, `application_continuity_invalid_epoch`,
`application_continuity_stale_context`, `application_continuity_invalid_certificate`.
Malformed signature length is shape; well-shaped bad bytes are certificate failure.

## 5. Final conflict function and graph

Add `Space.command_conflicts/3` delegating only to the new pure continuity module,
and the equivalent Treehouse.Space dispatch in TS `policy.commandConflicts`.
Keep generic Core's existing individually-honored filter and one callback call.
The callback itself returns the complete deterministic denial map:

1. Seed `application_continuity_stale_voucher` for concurrent honored
   remove_member operations observing a voucher's exact selected admission tag.
   Causal-before removes fail individual eligibility; causal-after removes do
   not erase the historical statement; unseen concurrent add tags survive.
2. Seed `application_continuity_conflicting_target` for every pair of concurrent
   individually honored claims with different old keys and identical new key.
   Deny both, without an ID-selected person. Causal reuse is individually ineligible.
3. Walk candidates in canonical topological order. A resolution whose parent
   claim has no remaining honored wrapper in its strict ancestry gets
   `application_continuity_invalid_parent`; honor no concurrent/later repair.
   Multiple wrappers around the same claim count once but preserve provenance.
   Seeds take priority stale_voucher > conflicting_target > invalid_parent.

This deny-only pass never resurrects a command, changes ordinary membership,
or feeds application facts into authority. Coalesce final honored wrappers by
claimId; supersede only via final honored parent edges. Two same-old heads are
contested even if they name the same new key. Show more than 16 as capacity_stop
while retaining all evidence; deny an oversized resolution rather than truncating.
A full new raw fold reclassifies history; do not persist a stale successful view.

## 6. Ordered vocabulary and literal legacy bytes

At this base the Plan178 and exact `ContractTest.@commands` list already ends its
Space portion with `catalog bootstrap v1`, `replace catalog v1`. The R19a adopted
amendment authorizes inserting exactly `attest member key v1` **after both** and
before Thread `post`. Update the ordered plan list, exact assertion and BEAM/TS
command mappings together. Do not reorder or remove the catalog entries.

Current runtime implements catalog_bootstrap_v1 but not replacement activation.
R19b must not activate replace_catalog_v1 as a side effect of matching this ordered
product vocabulary. The distinction between adopted vocabulary and enabled
workflow remains explicit.

Already-correct byte pins must remain literal and unchanged:
- `Treehouse.Space.@preview_commands` (space.ex:15): create_space, create_thread,
  issue_invitation, revoke_invitation, admit_member, remove_member.
- TS `prepareTreehouseSpaceCreation` (treehouse.ts:159): that same explicit list.
- `Mix.Tasks.Lattice.ExportVectors.treehouse_preview_commands/0` (exporter:267)
  and all historical Treehouse.Space Sim.create_replica calls use explicit ops:.

Snapshot every preexisting vector Git blob before edits; regenerate normally and
require byte equality for every old signed vector. Add separate R19b fixtures.
Only R14's explicitly selected new bounded profile can preauthorize the new
command. Existing grants/pins never gain it; old-profile/no-command is a public
negative, including possession of the immutable root key.

## 7. Current callgraph and proposed allowlist

Read-only source facts at e5f5a4ef:

| Existing seam | Observation / proposed connection |
| --- | --- |
| `apps/lattice_core/lib/treehouse/space.ex:61,65,72,265` | Ordinary admission/remove OR-set effects, existing catalog admin marker, causal callback. Add one command and delegate its individual/final checks. |
| `apps/lattice_core/lib/lattice/authority.ex:1326,1350,579` | Builds causal context from prior individual verdicts; invokes one final conflict hook; valid beacons already computed at495 and in cap_evidence555. Add only causal beacon projection to context. |
| `apps/lattice_core/lib/lattice/replica.ex:101` | Default conflict hook already overridable; no new authority hook required. |
| `apps/lattice_core/lib/lattice/crdt/or_set.ex:1` | Tag identity is add op ID; removal retires observed tags. Reuse this rule, not membership_events labels. |
| `clients/lattice-client/src/treehouse.ts:28,59,265,294,342` | Authoring body/type union, decoder table and final application callback. No continuity support yet. |
| `clients/lattice-client/src/quarantine.ts:100` / `policy.ts:37,76` | Causal context is built after Core cap/holder gates; only PolicyFixture currently has conflict dispatch. Add causal validBeacons and Treehouse.Space conflict dispatch. |
| `clients/lattice-client/src/materialize.ts:171` | Existing deny-only final conflict result is unioned into quarantine before reduction. Keep generic semantics unchanged. |
| `clients/lattice-client/src/authority.ts:127,143` | Exact legacy beacon evidence is number or decimal string; validBeacons is already judge-produced. No new beacon judging. |
| `apps/lattice_core/lib/lattice/log.ex:136,333,363` | Authenticity check, verified restore and explicit safe atom vocabulary preload. New application codec modules must be loaded before fresh-VM Wire/restore; do not create imported atoms. |
| `Treehouse.CatalogCutoff` / TS cutoff module / cutoff_atoms_v1.json | Fixed130-atom shared portability set currently rejects nine needed new command atoms; see §8. |
| `test/support/compaction_spike.ex:18,41,137,267` | Research snapshot freezes covered reasons and drops raw covered ops; retained continuation mirrors authority. It currently supplies no full application graph context. See explicit gate in §8. |

Proposed full-packet source ownership (reserve writers before edits):
- New BEAM: `apps/lattice_core/lib/treehouse/member_continuity_certificate.ex`,
  `member_continuity.ex` (policy/conflicts/projection), `member_continuity_review.ex`.
- New TS: `clients/lattice-client/src/treehouse_member_continuity_codec.ts`,
  `treehouse_member_continuity.ts`, `treehouse_member_continuity_authoring.ts`.
- Narrow existing source: BEAM Space and Authority causal-context plumbing;
  TS treehouse.ts, policy.ts, quarantine.ts; catalog cutoff enum pairs;
  Log safe vocabulary only if module preload is not sufficient.
- New tests: `apps/lattice_core/test/treehouse/member_continuity_{codec,policy,conflicts,review,reciprocal,restore}_test.exs`;
  TS `test/treehouse_member_continuity_{codec,policy,conflicts,authoring}.ts`;
  `test/support/member_continuity_vectors.ex`, TS exporter
  `test/support/export_member_continuity.ts`, new `test/vectors/member_continuity/*`.
- Atomic integration only: exact Plan178 vocabulary and contract_test assertion;
  existing exporter helper pins are verified rather than broadened;
  test-support compaction mirror and focused gate once disposition adopted;
  cutoff atom fixture and its enum/hash assertions; index.ts explicit public
  exports, package scripts, normal generated dist and CI wiring owned by root.
- No native/shell/key/transport/receipt/custody implementation files. Existing
  permission and party tests may be referenced or extended only by exact scope.

Initial slice allowlist is only the two new artifact codec modules, the BEAM/TS
codec tests, one new independent exporter per runtime and new reciprocal fixture
files. No command registry, authority, cutoff enum, index/dist or profile change
is needed to establish that slice's cryptographic bytes. Root may integrate
exports/build outputs when the atomic packet is ready.

## 8. Concrete decisions needed before shared production edits

1. **Causal valid epoch evidence:** extend BEAM context with
   `valid_beacons: [%{op_id: id, epoch: exact_integer}]`, TS with
   `validBeacons: readonly {opId:string,epoch:number|string}[]`, filtered to the
   command's strict ancestors from the already computed Core beacon result.
   Add causal/future/unauthorized-beacon controls. Existing callbacks ignore the
   added readonly field. Do not recursively call analyze/materialize from the
   new command's callback, and do not implement a second beacon policy checker.
   This is the smallest transparent internal plumbing amendment I recommend.

2. **Cutoff portability:** the exact new literal atoms required by the shared
   command body, absent from the adopted 130 set, are:
   `attest_member_key_v1, old_pub, new_pub, old_admission, old_membership,
   vouchers, admission, active, removed`.
   Propose a reviewed additive 130→139 enum union in both cutoff modules and the
   tracked fixture, explicitly amending its contract/hash before edits. Old
   payload/cutoff bytes remain identical; new histories become portable only
   after both runtimes support the union. Do not add detached local return fields
   to shared Core grammar merely because they exist in the pure verifier.
   Existing unknown-atom refusals remain. Without this union, attestation would
   disable catalog recovery-cutoff observation for its Space. Also preload those
   fixed literal field atoms from the trusted Treehouse.Space application module
   (or its explicit startup contract) before fresh-VM Wire decoding; a remote
   alias alone does not eagerly load the certificate module's atom chunk. The
   host may load its selected application vocabulary but must never create atoms
   from input. A fresh-VM first-frame test and verified restore test must exercise
   the actual schema startup path, not a codec preloaded by the test runner.

3. **Compaction feasibility gate:** this test-only prototype cannot judge a
   retained attestation/resolution from its current snapshot alone: it lacks
   exact covered admission/removal/wrapper ancestry and certificates, and freezes
   covered verdicts. Do not silently declare existing snapshot summaries adequate.
   The full R19b contract currently calls for relevant mirrors. Recommended safe
   bounded disposition for root/Fable consideration: explicitly refuse the new
   continuity application in the research compact/reduce path until it has a
   retained authenticated application-evidence closure, with a public signed
   refusal test; ordinary complete Log.dump/restore remains required and works
   through actual full reanalysis. This is an explicit proposed contract
   refinement, NOT already adopted or equivalent to a passing compaction mirror.
   If the mirror requirement is retained, implement a test-only retained evidence
   arm committing every required covered command/ancestor and re-run the actual
   application conflict algorithm; compare full state/reasons/graph to the real
   Log. Do not freeze success or discard old membership tags to satisfy it.

4. **Preflight scope:** use the ordinary full judge on a deterministic internal
   unsigned intent after authenticating all retained frames; it grants no raw
   authentication and cannot enter persistent Log. Then authenticate the actual
   signed normal op and recheck publicly. If current helper visibility makes this
   awkward, adopt a narrow intent-preflight adapter rather than duplicating cap
   and holder rules. Tests instrument signer invocation on refused cap/holder.

## 9. A01–A17 executable mapping

Every row remains OPEN. Use self-contained deterministic synthetic signers,
actual bound replica IDs, real invitations/recipient signatures, real admission
tags, real cap/role/epoch judges and actual normal signed command frames. Public
BEAM and TS import/replay must compare exact IDs, bytes, retained wrappers,
quarantine/reasons, continuity graph, membership and state. Reverse order and
independent verified restore apply to conflict rows. No boolean oracle stubs.

| ID | Concrete signed fixture and assertions | Gate ownership |
| --- | --- | --- |
| A01 | Root+old member+new key+two separately admitted vouchers; root or continued admin with exact command cap; signed zero beacon; attest then separately invite/accept/admit/grant/post. Assert attest changes only existing marker; roster/caps unchanged until ordinary ops. | R19b policy/review/reciprocal |
| A02 | Fresh bounded profile with command ceiling; remove founder identity and root/cap caches; real R04 nominee/holder continuation; Space + 12 retained Threads including archives; perform A01 and exact authorized revoke/lapse grants. Never call founder signer after simulated loss. | R19b core integration after R04/R10/R14 source; R20 physical remains separate |
| A03 |0/1/3 vouches, duplicate/self/old/new keys, role-only and unadmitted admin, malformed surplus and aligned-but-bad signature; one actual admitted admin plus another ordinary member positive. | codec + policy + precedence vectors |
| A04 | Never admitted, wrong-kind/Space/quarantined old admission; removed old falsely active; truthful removed label succeeds only as statement and does not admit new key. | membership policy |
| A05 | Remove selected voucher tag before claim; remove/readmit stale tag; concurrent observing remove; causal-later remove; removal missing concurrent add-tag. Compare OR-set tag survival and final reasons. | policy + conflict + reverse/restore |
| A06 | Four exact domains and cross-domain substitutions, wrong possession key, invitation/governance signature substitution, changed every signed binding field. Verify byte parity independently both directions. | codec + reciprocal |
| A07 | Valid root/witnessed zero; absent beacon; missing/bad-signature/quarantined/unsupported basis; lower and high legacy uint64 epochs; wrong maximum/basis; fresh current frontier differs at assembly. | causal beacon plumbing + review |
| A08 | Same signed frame repeated through Log; distinct valid wrappers for identical claim and cap/author context; coalesced claimId with retained wrapper IDs; changed claim with stale possession/vouches refused. | graph + raw observer |
| A09 | Two partitioned old→different-new claims then heal; both individually honored, two heads, contested; no canonical winner or cap/member side effect. | conflict projection + reverse/restore |
| A10 | Fresh all-head resolution, missing visible head, two racing resolutions, withheld later head, and parent losing stale-voucher/target conflict; no concurrent/later wrapper repairs resolution ancestry. | propagation + reciprocal |
| A11 | Different old keys use same fresh key causally (ineligible) and concurrently (both conflicting_target); fresh destination retry; competing same-old claims remain facts. | conflict + precedence |
| A12 | Old post before and after actual revoke/lapse, separate old transport acceptance state, independently admitted losing new key retains actual grants. No continuity-derived universal denial. | R19b core rights; stale acknowledged transport/device proof R20 |
| A13 | Unleased lost-founder grant, stalled beacon, old ceiling missing new command, one remaining voucher. Named refusal/unresolved outcome, no authority widening or fake expiry. | R19b negative integration; R20 display |
| A14 | New linked key attempts old-author edit/tombstone and old-key receipt proof; old loan remains exact/open; alleged handover is not closure; genuine original-party return still follows R24 after original-grant expiry. | Existing author controls in R19b; R24/R25/R29 dependent actual custody/receipt gates stay OPEN until available |
| A15 | Duplicate/missing/extra maps, wrong UTF-8/Base64/ID/nonce length, array order/duplicates,16/17 parents/heads, exact 64000/64001 one-op envelopes. Preserve all old vector Git blobs. | codec + raw envelope + vocabulary |
| A16 | Independently fresh BEAM VM verified dump/restore and TS signed raw replay; repeated delivery, healed conflict invalidates previous statement/resolution. Compare current fold every time, not stored success. | restore/reciprocal; compaction §8 disposition required |
| A17 | Pure old-return bytes/signature exact equality across runtimes; wrong domain/key/reviewer/Space/heads/deps; no shared command effect. Actual one-use/session 60s/cancel/restart/local-record persistence tested only in R20. | R19b verifier; R20 durable controls |

For every ambiguous application precedence pair, construct one signed candidate
violating both conditions and assert the higher-priority exact reason, in both
runtimes. Additional generated permutations cover valid wrappers supporting one
parent, one wrapper's loss with another still causally honored, and conflict seed
ordering. Count envelopes by actual encoded JSON bytes, not character length.

## 10. Ordered implementation and closure

1. Root/Fable adopt this implementation proposal's shared-seam decisions; reserve
   writers and refresh accepted-parent inventory. No profile enablement.
2. Initial codec slice: public RED for absent strict APIs, exact domain and shape
   negative matrix, reciprocal independent signed fixtures; focused gates only.
3. Add BEAM command/policy/denial-only conflicts plus actual signed RED/GREEN.
   Add TS matching decoder, causal-context and conflict functions in the same
   atomic working packet; no temporary client-only acceptance release.
4. Authenticated observer/review/assembly and return verifier integration; actual
   signed final op accepted by the other runtime in both directions, including
   negative imports; no private keys serialized or printed.
5. Vocabulary/cutoff union and explicit legacy creator/exporter pins, fresh-VM
   verified dump/restore, adopted compaction disposition. Regenerate normally;
   verify all preexisting signed vector blobs unchanged.
6. Real founder-absent core scenario and A01–A17 core negatives. Report dependency
   rows still awaiting R14/R20/R24/R25/R29 as unclosed, not substituted unit proof.
7. Root serializes final `mix check` with required OTP28 PATH/asdf and `+S4:4`,
   TS typecheck/build/full conformance plus new suites, exact generated diff,
   immutable Claude Fable review, fixes, hosted tip/merge CI. Only the resulting
   atomic packet can close R19b's implementation gates. No local green enables
   enrollment or claims physical AF-3, old-key exclusion or custody recovery.

Preparation ends here: exact source read, callgraph, scope and test design only.

## 2026-09-06 integrator adoption after actual Fable review

Actual Claude Fable5 reviewed this proposal against accepted R19a and source
`e5f5a4ef`: initial pure codec/reciprocal slice is ready, while two P2 shared
integration findings require the concrete adoption work below. This document
adopts section1's initial slice only. It does not activate the command, change
Core context, cutoff constants, protected assertions, compaction, public index,
package scripts or an authority profile. Root will integrate those atomically
after independent review and named gates. All A01–A17 rows remain open.

The first slice implements the exact four domains and closed13/8-field artifacts,
pure signature verification, and independently authored BEAM↔TS public fixtures.
Use the new codec modules and test/support/fixture files named above. Preserve
all existing vector bytes. Add a public reciprocal negative for a genuinely
signed frame containing the new literal atoms while the command remains
unimplemented: both runtimes must refuse through the ordinary command/capability
judge. Loading a BEAM module interns its declared atom literals; do not claim
ingress is unchanged by their availability or add dynamic atom creation. The
cutoff130 portability set remains unchanged in this slice.

The detached old-key return bound is pinned as
`byte_size(return_bytes) + 64 <= 64_000`, inclusive, where `return_bytes` includes
the exact domain-separated canonical framing. Any later transport envelope is
separately subject to the actual carrier cap. This clarifies accepted R19a's
complete-challenge wording without weakening it. Pure verification does not
claim native one-use, monotonic deadline, session or durable storage facts.

For later integration, adopt the existing judge-produced beacon evidence as a
read-only context addition, strictly filtered to included causal ancestors and
sorted by op ID ASCII in both runtimes. Preserve exact legacy integer values.
No second beacon judge or recursive authority analysis is authorized.

Before changing cutoff constants/tests, append a dated lifecycle-contract
amendment preserving the historical130 paragraph and its original fixture
bytes/hash. Pin a separate nine-atom continuity-extension fixture and its actual
SHA256, and explicitly authorize the sorted139-name union. Update both runtime
constant equality tests and fresh reciprocal checks to assert that exact union,
including interleaving sort order. Require real cold-VM known-literal loading
and safe-restore/first-frame proof. No extension hash is invented in advance.

Section8.3's blanket compaction refusal alternative is not adopted. The existing
research spike lacks application-policy and final conflict callbacks, affecting
ordinary Treehouse commands as well as continuity. Compaction acceptance stays
OPEN until a separately reviewed concrete bounded retained-evidence algorithm
uses the real application callbacks and reproduces both existing ordinary
application refusal and continuity parent/conflict outcomes. Preserve the
spike's actual stable-frontier contract; do not assume every covered operation
is visible without verifying that premise in current source. Production
compaction remains out of scope. A safe refusal is never called equivalent
behavior or acceptance closure.

The proposed unsigned-intent preflight may call only the existing ordinary judge
in internal preparation. The intent must never enter a verified/public log or
be reported accepted; actual signed-frame public authentication and full judgment
remain mandatory after signing. Signer-not-invoked negative controls are required.

These later refinements must receive independent review with their concrete
source/tests before shared production edits or A01–A17 closure. R04/R10 accepted
main gates, R14/R20/native and physical loss-ceremony evidence retain their own
requirements. This adoption grants no membership, capability or transport right.
