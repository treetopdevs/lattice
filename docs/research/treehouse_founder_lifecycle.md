# Treehouse founder lifecycle: R02 decision and probes

Status: proposed contract for integrator and Claude Fable review. Preparation base:
`7610cc9b`, 2026-09-06. No profile is enabled by this document. R01a was awaiting
hosted closure when this preparation began. R03, R04, R10, R11 and native/device
proof remain separate gates. Approval must name the selected constants and the
versioned continuation and catalog contracts; this document alone does not adopt them.

The recommendation is a leased, witnessed continuation profile, with renewal of
the issuer's authority before member grants, a separate root for every child,
and a pre-authorized catalog replacement certificate. Merely leasing grants and
adding a witnessed clock is insufficient. A fresh child cannot extend a dead
founder's expired parent, while today's rootless successor can issue a broader,
unleased capability. Both are reproduced below.

## 1. Evidence and claim boundary

Read together with the [unified roadmap](../../plans/roadmaps/treehouse-unified-2026-09-06.md),
[Plan 179](../../plans/179-witnessed-beacons-af2-founder-loss.md), the
[succession decision record](succession_tick_provenance.md), and
[Plan 158 catalog contract](../../plans/158-real-device-beta-poc-program-map.md).
Source Plan 180 section 2.1 proposes the predecessor's effective operations as a
successor ceiling; it is in the original checkout, outside this branch. This
record makes the proposed interpretation explicit without importing that file
or changing its status.

The [probe suite](../../apps/lattice_core/test/treehouse/founder_lifecycle_probe_test.exs)
uses `Township.Matter` to exercise the actual Core authority engine. It does not
implement Treehouse membership policy. The
[fan-out script](../../scripts/treehouse_renewal_fanout.exs) signs real synthetic
Core delegations and operations, round-trips every carrier frame into a fresh
log, and independently verifies its authority. Its founder remains present:
root-signed epochs measure today's substrate, not future founder-loss survival.
No mock catalog validator or native-presence success substitutes for missing code.

Reproduce from this worktree, serially:

```sh
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/treehouse/founder_lifecycle_probe_test.exs
MIX_ENV=test PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix run scripts/treehouse_renewal_fanout.exs
```

These are characterization tests. P05 and P07 intentionally pin missing or unsafe
current behavior. R03/R04 must replace their relevant expectations with named
RED/GREEN evidence when implementing their approved contracts. A green R02 suite
must never become a check that requires those gaps to survive the later work.

| Probe | Current observed result | Consequence |
| --- | --- | --- |
| P01 | Expiry 6 authorizes at epoch 6; epoch 7 lapses later commands. A causally earlier command remains honored. | Inclusive arithmetic; no wall-clock expiry claim. |
| P02 | A child expiring at 6 remains lapsed after its founder parent expires. Extending it to 13 makes the grant introduction `not_attenuated` and its command `invalid_capability`. | Renew issuer authority first; a new ID is not proof of renewal. |
| P03 | Surviving issuer revokes its child. Its revoke of a founder grant is `unauthorized_revoke`; an unleased founder grant remains usable. | Track actual issuers; permanent residual cannot be hidden by UI removal. |
| P04 | Unpinned succession fails. A survivor's replacement genesis is `impostor_genesis`. | Founder loss before pinning cannot be repaired on that root. |
| P05 | Non-root simple beacon is `unauthorized_beacon`. A three-field beacon is ignored by the beacon collector and lapses nothing, even though it has no quarantine reason. `Sim` cannot yet author the reserved beacon policy. | R03 is missing; absence of quarantine is not beacon authority. |
| P06 | With founder and one witness removed, two-of-three succession succeeds; one remaining witness is `insufficient_recovery_witnesses`. | One lost witness tolerated only while the other two remain available; no rotation proof. |
| P07 | Witnessed successor acquires more operations than its narrow predecessor, self-issues without parent or lease, admits a member and issues a child grant. | Current succession is not the bounded continuation profile. |
| P08 | Removing a member from Matter's materialized set leaves a separate Core posting capability usable. | R10 policy and R14 grant/transport reconciliation must supply product removal. |
| P09 | A surviving key can create an independent child root. A Space grant introduced there is `wrong_replica`. | New child genesis is possible; authorized Space listing, grants and transport are separate unfinished work. |
| P10 | Repeating a grant's identical inputs reproduces its ID/signature. Re-authoring its introducing op with new dependencies grows the log; replaying the exact original op is idempotent. | Persist the signed attempt and retransmit exact frames; do not call the authoring API again for a transport retry. |
| P11 | Twelve pinned, independently named replicas succeed; the thirteenth unpinned replica fails after founder loss. | Readiness is per replica, including archives; a Space pin is insufficient. |
| P12 | Revoking and expiring a holder capability does not erase its honored role acquisition. A fresh witnessed succession still works. | Preserve current role-timeline semantics. A capability lease is not automatic removal of the holder token. |

At this base, the production Treehouse schemas and signed catalog replacement
validator are absent. The source catalog ticket requires the founder for lost-key
recovery. R11c therefore needs an explicit scoped amendment, not an assertion that
its old-key rotation or encrypted-key restore already proves combined loss.

## 2. Signers and retained evidence

All semantic evidence below means verified signed operations and their dependency
closure on the named replica, with both original and later root geneses retained.
Every authority judgment is relative to that available evidence. A retained copy
cannot prove unseen completeness. A Space admin, witness and operator are separate
authorities even when one person holds multiple product-scoped keys.

| Action | Space | Existing Thread, including archive | New Thread | Future Tool root |
| --- | --- | --- | --- | --- |
| Admit/remove semantic member | Current admin with scoped grant; causal membership/invitation evidence | Each Thread's authorized issuer/moderator and local roster evidence | New root issues initial grants; Space admission does not copy a stale roster | Separate Tool admission/consent contract; Space membership grants no custody |
| Issue/renew member grant | Surviving issuer with active bounded continuation acquisition, then attenuated exact-audience child | Same operation independently on every Thread; record issuer and parent ID | Child creator's root during bootstrap, then its own pinned continuation issuer | Tool issuer's own parent/lease; no Space grant substitution |
| Revoke grant | Its issuer or immutable Space root | Its issuer or that Thread root | Its issuer or new Thread root | Its issuer or that Tool root |
| Acquire/renew serialized role | Proposed witnessed continuation for admin, or valid voluntary transfer | Independently pinned moderator continuation/transfer | New root creates role; nominee and witness policy pinned before readiness | Defined by Tool policy, not inherited from admin/moderator |
| Advance lease epoch | R03 root or pinned beacon witness threshold | Separate valid beacon on each Thread | Creator emits reviewed initial root beacon; later local witnesses | Group witnesses gain no Tool clock power; UTC-day assertion remains Tool-root-signed |
| Create root / semantic reference | Admin authorizes the scoped child reference with new root/creation digest | Existing root cannot be replaced by listing a new key | Named child creator signs its own genesis; admin signs Space reference | Named Tool creator signs its own root; Shed reference/consent follows module contract |
| Admit/remove transport peer | Host operator applies reviewed public identity to exact route | Operator reconciles all current and archived routes | Readiness, manifest activation and exact peer list precede catalog publication | Operator on exact Tool route; no authority to sign Tool receipts |
| Replace service/catalog identity | Proposed root-pinned catalog recovery threshold authorizes transport binding only | Retained Space bootstrap plus exact unchanged replica/root/creation bindings | New catalog entry only after authorized creation and route readiness | Separate product/module binding; replacement grants no Tool root authority |

The founder can sign root grants, policies and initial catalog bootstrap only while
that key lives. The operator signs catalogs and manages routes only. No successful
row may recover a founder seed, replay a hidden founder signing service, or give
the operator semantic authority. The operator and successor must both be absent
in the negative controls where their availability is the subject of the test.

Enrollment order is members and independent governance keys first, then a living
root's per-replica profile pin, grant inventory audit, and custody confirmation.
Revoke/reissue removable unleased founder grants while their issuer lives. An
unleased founder root delegation remains the root commitment, not a removable
ordinary member grant. Before declaring readiness retain an inventory for all
13 replicas: root and pin IDs, scoped issuer acquisition, grant parents/expiry,
nominee, witnesses, current epoch, roster cutoff, catalog generation and operator.
Partial pinning produces an explicit list of unready replicas and stops the strong
profile. A new Thread repeats this ceremony under its new creator; it does not
inherit the lost Space founder's root or silently adopt a Space witness set.

## 3. Recommended R04 continuation contract, subject to review

Adopt a new closed, versioned profile. Unversioned Township/Toolshed succession,
its canonical bytes and its historical interpretation remain unchanged. R03 must
first land with every named Plan 179 legacy vector byte-identical. R04 owns any
separately approved new vectors or explicit legacy contract amendment. Do not add
continuation fields to Plan 179's five-key beacon policy.

Resolve the new continuation profile from the candidate's verified causal policy
evidence. Do not feed a later new profile into old succession operations through
the existing global role-policy fold. The unversioned path keeps its existing
fold and bytes. Adding a profile to a living-root replica requires a migration
case that proves earlier operations keep their verdicts; otherwise enable the
profile only on newly created, explicitly versioned Treehouse roots. R04 must
resolve that integration choice before coding, with R14's enroll-then-pin flow
included in the acceptance case.

Use the last **honored acquisition in the candidate's causal ancestry** as the
operation ceiling. Its delegation must have verified signatures, valid issuer and
parent/attenuation structure, and an honored introducing acquisition. Also enforce
the existing timeline's current-holder and competing-acquisition checks. A signed
acquisition offered without that evaluation proves neither its honored status nor
that it is the relevant predecessor. Do not union unrelated later grants, use the
genesis's full operations when a transfer narrowed them, or read a noncausal grant
to increase the ceiling.

Precisely, proposed `new.ops` is a subset of that acquisition's effective signed
operation set; `new.roles` is exactly the single acquired role; `new.live` is false;
the issuer and audience are the same authorized continuation key; `parent_id` is
nil; `expires_epoch` is finite and lies in `[E, E + L - 1]` for the valid causal
beacon basis E and adopted lease window L. Missing epoch basis refuses. The actual
R10 command vocabulary must give a membership issuer the operations it needs at
the original acquisition; succession cannot manufacture them later.

Continuation may either renew the current holder or install the fixed nominee
pinned by the root, each with a fresh threshold certificate. This allows a current
holder reached through an ordinary valid transfer to renew without forcing every
renewal back through a dead nominated key. It is a proposed versioned extension,
not existing `decide_succeed` behavior. If the current holder key and fixed nominee
are both lost, this profile stops; AF-3 or a separately approved recovery contract
must supply new-key authority. Witness rotation after the root is lost is not added.

The certificate must bind a separate continuation purpose/version, full profile
digest, product, replica, role, predecessor holder and acquisition ID, new holder,
the exact new delegation ID, author, dependencies and epoch basis. The delegation
ID commits its operations, role, lease and key. Domain-separate the new claim;
reusing the existing seven-field succession certificate without binding the new
delegation would let one review authorize different scopes/leases. Native R17/R36
must expose the exact new intent, not arbitrary bytes or a generic signing method.

The ceiling is a **historical acquisition bound**, not proof that an expired or
revoked chain is active now. P12 shows that the role token survives those events.
The new policy explicitly authorizes witnesses to reauthorize a leased, bounded
rootless continuation even when the predecessor's lease has expired. That is how
the dead founder's ancestor is left behind; it is not ordinary child attenuation.
Current ordinary grant, revoke, command-capability and role-timeline rules remain
intact. A removed member receives no automatic roster re-admission from a role
certificate; application membership and per-replica grant issuance still need
their own authorized operations and R10/R14 checks.

Renew the issuer acquisition first, then issue each member's fresh child under
that new parent with expiry no later than the parent's. A stale prior parent,
cross-replica parent or parent whose remaining lease is too short is a visible
failed batch item. Preserve old acquisition/grant evidence; do not rewrite it.
The predecessor's old children lapse or revoke by existing causal rules. A quorum
can deliberately authorize continuation and can advance beacons to lapse leases;
it cannot be represented as a mere availability helper or as automatically benign.

R04 acceptance must explicitly settle the final claim/policy shape and reason
atoms in both runtimes. Until then this is a recommendation, not a second authority
implementation embedded in test helpers.

## 4. Exact candidate epoch and renewal schedule

Recommend testing this candidate before adoption. It favors bounded review and
requires R14 batches; raw per-grant prompts are not operational evidence.

| Quantity | Proposed value and definition |
| --- | --- |
| Unit | One explicitly reviewed signed group day. Epoch 0 maps to the Space bootstrap's stated UTC calendar date. Epoch E maps to that date plus E days; witnesses attest that mapping. Wall time cannot create a beacon or cause lapse. |
| Normal cadence | One reviewed next epoch per UTC date, per replica. This is an operator practice, not a verifier-enforced frequency or trusted clock. |
| Initial epoch | Root-signed epoch 0 at Space bootstrap. A new Thread creator signs its reviewed current group-day E as that Thread's initial beacon before witness-only continuation. Without this, a step-one witness policy cannot jump from no beacon directly to a large E. |
| Beacon issuer | Root or the R03 pinned threshold, proposed two of three independent governance keys. Only root or a listed witness authors the witnessed op. Root retains its legacy unbounded beacon power. |
| Witness maximum step | `max_epoch_step: 1`, within Plan 179's `1..65_535`. Each candidate is checked against its causal prior maximum, not a global floor. Fixed witnessed horizon remains `2^53 - 1`. |
| Ordinary catch-up | At most two missing group days per reviewed ceremony, represented by two separately signed, dependent step-one beacons. Show all grants that each step would lapse. |
| Larger gap | Stop normal advancement and provisioning. Reconcile retained frontiers and issuer/member renewals first, then an explicitly reviewed recovery ceremony can advance a bounded two-step batch at a time. No jump, clock substitution or automatic loop. Repeated ceremonies are not cryptographic rate limiting. |
| Lease | L = 7 inclusive signed epochs, issued at E with maximum expiry E + 6. Last valid epoch equals expiry; lapse begins at expiry + 1 when a valid beacon is present and the command is not causally earlier. |
| Warning | The final two inclusive epochs: `0 <= expiry - observed_E < 2`. Show stale-epoch status separately; no wall-clock claim that a grant has lapsed. |
| Normal renewal | Start at the first warning epoch. E0 grant expires6; renew at E5 to expiry11; renew at E10 to expiry16. Seven inclusive epochs with two warning epochs means a five-epoch renewal interval. |
| Missed renewal | Report each lapsed/failed item and stop dependent new authoring/provisioning. Preserve drafts and signed outbox evidence; old offline work follows causal lapse rules after healing. A rootless continuation requires the explicit new certificate, never an unbounded fallback grant. |
| Coordinator | Record a named lead and named backup before profile creation. Each knows the 13-replica inventory, per-issuer renewal queue and witness contact procedure. Name people at enrollment; do not invent available operators in this design. |

At epoch 14, the initial grants (expiry6) and first renewals (expiry11) have both
crossed their lapse boundary, while second renewals (expiry16) remain active. A
14-day observation starting at E0 can therefore exercise two **overlapping**
renewal rounds and two old-generation expiry cycles. If the lead selects a longer
window, extend R23 observation until its two cycles occur; do not accelerate a
real pilot's signed days secretly.

The local signer should review the union of verified retained evidence, but that
does not change Core semantics: a valid fork excluding a high beacon can still
be honored at a lower epoch. A held beacon can make concurrent offline work lapse
after healing. A hostile threshold can rapidly sign repeated step-one beacons.
The daily practice, two-step review and secure UI reduce accidental issuance;
they do not establish a global clock or quorum honesty. Tool-root UTC-day custody
assertions remain a separate authority domain.

## 5. Measured fan-out and unresolved prompt cost

The script creates 13 independently named replicas and 12 recipients on each,
issues at E0/E5/E10, and emits root beacons E0 through E14. It verifies that old
generations lapse and the final generation stays active. The scope is the existing
one-operation `[:post]` grant, so Treehouse's eventual multi-command profile can
only be claimed after measurement on R10/R14 bytes. JSON byte counts below exclude
array delimiters, transport envelopes, logs' storage metadata and user content.

| Work | Measured/derived count |
| --- | --- |
| One member renewal round | 156 grant ops, 312 Ed25519 signatures: each delegation plus its introducing op |
| Two renewal rounds | 312 grant ops, 624 signatures, 39,936 signature bytes |
| Serialized renewal frames for those two rounds | 279,072 JSON bytes; 157,392 canonical op-preimage bytes, which include embedded delegation terms but exclude separate delegation-signing preimages |
| Initial grants plus two rounds | 468 grant ops and 936 signatures, before root geneses and beacons |
| Two rounds of issuer continuation, if one issuer per replica | Additional 26 acquisition ops; proposed two witness signatures plus self-delegation and op signatures gives 104 signing calls; not implemented or measured |
| Daily witnessed epochs E1 through E14 on 13 replicas | Additional 182 beacon ops, 364 witness signatures plus 182 op-author signatures; R03/native behavior not measured here |
| Initial witness epoch, if used instead of root bootstrap | Additional 13 claims and threshold signatures; excluded from the E1-E14 budget |
| Actual native prompts measured by this script | Zero; all identities are explicit synthetic software signers |

The [recorded aggregate output](treehouse_renewal_fanout.json) includes all 13
per-replica measurements. Entire fixture: 676 operations, 1,157 signatures,
513,793 JSON bytes and 281,054 canonical op-preimage bytes. Those values are
specific to the deterministic names and single-command scope in the script.

One native review per member renewal intent would mean 312 prompts across two
rounds; one review for a bounded exact-replica batch of 12 means 26 issuer reviews.
These are candidate UI counts, not observations. A signing API that prompts once
per primitive signature could require 624. Separately, unbatched witness review
for daily beacons costs 364 witness reviews, and op-author approval may add 182;
do not silently assume one approval can cover both before the final certificate
and exact op exist. Issuer continuation adds at least 52 witness-claim reviews and
26 issuer reviews without further batching. More role holders/issuers increase
these figures.

R14 must retain a bounded reviewed batch containing exact product, replica,
recipient, parent, scope, expiry, intended signed frames and roster/frontier
binding. Signatures and per-grant results persist before transmission. Retry
resends the original signed frames; changed roster, epoch, parent or frontier
requires a new review. P10 demonstrates why re-authoring the same grant into new
dependencies is not an idempotent transport retry. Cancellation, partial signing,
partial durable write and interrupted upload all need visible recovery states.
Batch authorization does not permit arbitrary bytes, new recipients or new roots.

Each replica has 52 authority ops in this root-present fixture: one genesis,
36 grants and 15 beacons. Real witnessed certificates, role renewals, revocations,
transport records and catalog evidence add overhead. R15's proposed 3,200-op
warning and 4,000-op stop count authority and quarantine evidence too. The
seven/five schedule is a recommendation for a measured pilot; adopt it only after
R14/R17 record actual sign calls, prompts, elapsed operator time and missed-lead
rehearsal. Otherwise choose and document a longer finite window before enabling
profiles, and extend pilot observation. Neither software throughput nor 14 elapsed
days proves that people can sustain the ceremony.

## 6. Catalog replacement without founder or old service key

Amend the Plan 158 catalog lost-key clause in R11c: a root-pinned, product-scoped
recovery authority may replace transport identity. Keep ordinary old-key-signed
rotation and encrypted same-key restore as separate paths. A newly generated
operator key, a URL, a fresh client seeded with a new trusted key, or an injected
test trust object is never the replacement proof.

At living-root bootstrap, pin the immutable Space root, product ID, catalog key,
service identity and an explicitly separate catalog-recovery purpose with a
proposed two-of-three witness policy. The public bootstrap and witness keys must
already be retained by installed clients before loss. Use distinct product key
namespaces and domain-separated signing endpoints; beacon or role-recovery
authority alone does not imply catalog-replacement authority. No change to Plan
179's beacon-policy schema is necessary or permitted for this purpose.

Recommend a closed replacement claim binding the bootstrap op/profile digest,
product, Space replica, prior catalog generation and digest, next generation,
new catalog public key, new service identity, exact route inventory digest and
retained per-replica cutoff frontiers. Require fresh new-key possession signatures
and threshold signatures over that complete claim under a catalog-replacement
domain. It changes transport bindings only; replica IDs, roots, creation ops,
signed semantic references, roster and semantic grants remain independently
validated. This exact wire contract and its canonical bytes belong to R11c review.

An installed client validates from its retained bootstrap and replacement chain,
including all locally retained later authorizations. It requires a descendant of
its accepted generation/digest, rejects substitution or cross-product use, and
atomically persists the new generation before use. Missing chain entries request
bounded recovery input; they do not reset trust. Competing authorized replacements
at the same next generation produce an explicit fork and stop automatic route
switching until an approved resolution covers both retained heads. A deterministic
winner alone is not evidence of operator intent. Whole-store rollback still needs
an independent native anchor or a separately stated recovery gate under R17; an
application-private file or MAC does not establish rollback resistance.

R11c's combined-loss fixture must keep an already-installed client's original
trust store, destroy access to founder, old catalog and old service private keys,
then generate replacement identities independently and have only surviving
pre-authorized witnesses approve the claim. Reseed verified member frames to the
new durable carrier. The old installed client accepts the new service only by
that retained chain and independently reconstructs the same supplied frontier.
The operator signs the new catalog and activates routes after readiness; witnesses
cannot make a referenced route available by certificate alone. Below quorum or
missing preauthorization stops replacement. Known rollback, forged signer,
unknown extra witness, wrong root/product, inventory mismatch, fork and missing
dependency evidence are separate negative cases.

## 7. Downstream executable acceptance matrix and stop outcomes

Run P01-P12 and the fan-out script for current behavior. The rows below are named
implementation acceptance cases, not green tests or adopted new verifier reasons.
R03, R04 and R11 owners must supply public-entry tests and parity vectors under
these case IDs; until then each is OPEN and no profile may claim its exit.

| Case | Required experiment and result | Owner / stop |
| --- | --- | --- |
| A01 two-cycle continuation | Physically remove founder identity/log in both runtimes; acquire leased issuer, issue/admit/remove, advance witnessed epochs, renew issuer then all children at E5/E10; verify old IDs lapse at E7/E12, new IDs work at E14, and every retained replica agrees. | R03/R04; failure stops live provisioning/strong pilot. |
| A02 bounded succession | Narrow predecessor acquisition, attempt wider ops, extra role/live privilege, unleased/too-long expiry, foreign parent, noncausal acquisition and wrong epoch basis; all refuse. Honored acquisition with expired ancestor may renew only through the explicit continuation certificate. | R04; any scope expansion is a hard authorization stop. |
| A03 claim substitution | Reuse a certificate with different delegation ID/expiry, author, deps, replica, product, role, holder epoch or profile; none gains authority. Exercise concurrent acquisition and an omitted known acquisition. | R04/R17; signing/verification mismatch stops the ceremony. |
| A04 partial readiness | Lose founder before any pin and after 12 of 13 pins; show precisely unready roots. Valid root add/replace while alive works according to its causal contract; non-root repair fails. | R03/R14; no all-ready claim from Space-only pin. |
| A05 witness failures | One of three lost succeeds with two; two lost fail; unknown/duplicate/reordered certificate signatures fail as specified. Hostile authorized threshold advancement is an explicit permitted-risk case, not silently denied by a fake clock. | R03/R04/R17; below quorum stops, hostile quorum pauses profile, post-loss rotation remains unavailable. |
| A06 member removal | Revoke own-issued children, fail foreign issuer revoke, lapse leased founder grants, retain unleased negative control. Fan out across 13 replicas including archives and transport; disconnected/missing issuer stays `removal_pending`. Test concurrent old posts on heal. | R10/R11/R14; unresolved grants stay visible; no false completed removal. |
| A07 new Thread after loss | Live authorized creator signs independent child genesis and initial epoch; Space admin signs exact reference, child grants/pins use current reviewed roster, operator readies route and catalog then lists. Attempt forged root, reused Space cap, stale/removed-member roster and phantom route. | R04/R10/R11; missing creator/issuer/pin/route stops listing. |
| A08 Tool separation | Apply Space admin, Thread moderator and beacon-witness keys to Tool-root day assertion, Tool grants and custody; no inherited authority. Tool creator/issuer and recipient consent remain necessary. | R24-R26; module stays disabled until its gates. |
| A09 catalog replacement | Run the installed-client combined-loss ceremony in section 6, then wrong signer/product/root, rollback, known fork, incomplete chain and inventory/cutoff mismatch negatives. | R11c/R16/R18; preserve old trust and show unavailable, never replace it with a fresh injected key. |
| A10 crash boundaries | Kill between `local_draft`, `genesis_created`, `carrier_pending`, `listed`; during manifest activation, signature persistence and renewal upload. Resume exact attempt without duplicated genesis/route/op or phantom listing. | R11b/R14; ambiguous durability or identity reset stops workflow. |
| A11 missed renewal/quorum | Lead absent, backup operates; then quorum absent through warning. Resume from retained union, show each impending lapse, recover only through approved bounded ceremony, refuse ordinary catch-up beyond two steps. | R14/R18; no hidden clock, auto-loop or unbounded grant. |
| A12 packaged workload | Execute full 12-by-13 roster for two renewal rounds on selected devices, counting primitive signatures, user prompts, time, bytes, queued failures and exact retries, including continuation and beacon ceremonies. | R14/R17/R22/R23; missing native/device measurements block cadence adoption/profile enablement. |
| A13 version and migration | Replay every legacy vector unchanged. Add a new profile with a living-root pin after enrollment, and prove old operations keep their prior verdicts while only causal descendants can use continuation. If that migration is not supported, reject it and restrict the profile to fresh versioned roots. | R04/R14; changed historical meaning without a separately approved contract is a stop. |

## 8. Source evidence and verification record

Live baseline sources for the findings:

- `apps/lattice_core/lib/lattice/authority.ex`: `bind_replica/2` and `root_tag/1`
  bind the immutable root; `validate_child_delegation/6` and
  `validate_attenuation/3` enforce structure; `decide_succeed/8` has no ops ceiling;
  `decide_succession_proof/7` checks the honored holder acquisition and certificate;
  `expired_as_of?/5` is inclusive/causal; `collect_beacons/3` only handles two-field
  root beacons. Role acquisition and capability lapse/revoke remain distinct.
- `apps/lattice_core/lib/lattice/authority/delegation.ex`: `attenuates?/2` and
  `expiry_within?/2` prohibit a child outliving its parent; `new/4` signs a
  content-addressed delegation and `genesis/3` is unleased.
- `apps/lattice_core/lib/lattice/sim.ex`: `create_replica/3`, `grant/4`,
  `succeed/4`, `beacon/3` and the closed `resolve_policy/2` harness cases.
- `clients/lattice-client/src/authority.ts`: corresponding successor checks and
  parent lease attenuation at this base; no TS execution is implied by BEAM
  characterization. R03/R04 own the two-runtime behavior and authoring proof.
- `plans/158-real-device-beta-poc-program-map.md`, Replica Catalog and Lifecycle:
  lost old key currently requires a founder/product-root ceremony. The unified
  R11c contract requires an installed retained client to survive without it.

Recorded 2026-09-06 on preparation base
`7610cc9b2fab3acf21bf0b1b02db04a6b9a497c6`:

| Gate | Result |
| --- | --- |
| Dedicated P01-P12 suite | Exit 0; 12 tests, no failures |
| Fan-out script, final E0/E5/E10 schedule | Exit 0; all signed-frame restores and lapse/active assertions passed; aggregate output linked above |
| `mix verify` through the required asdf/PATH toolchain | Exit 0; format gate and full umbrella suite, 675 reported tests plus 27 properties, no failures, three configured exclusions |
| Explicit `mix format --check-formatted` on the test and script | Exit 0; the script is outside the umbrella formatter's default input glob |
| Recorded JSON and local Markdown links | All 13 replica schedules, renewal totals and linked paths verified |

The first P02 characterization run corrected an expectation: the invalid grant
introduction reports `not_attenuated`, but a command citing it reports
`invalid_capability`. Both seams are now asserted. This is probe calibration,
not RED/GREEN evidence of implementing continuation. No TS, native, device,
hosting or human-prompt execution is claimed by these local results.

No authority implementation, Plan 179 vector, source worktree, shared README or
unified status row is changed by R02 preparation.
