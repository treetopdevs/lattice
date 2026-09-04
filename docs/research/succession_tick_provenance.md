# Succession tick provenance: the Plan 175 decision

**Status:** concluded design spike, 2026-09-03, planned against `origin/main` `8200c38d`
(worktree branch `claude/175-succession-tick-spike`). No production source, vector, script or
TypeScript file was changed; every reproduction ran from scratch scripts outside the repository.

**Verdict:** **Do not change the legacy self-asserted succession tick now: keep
`after: {:dormant_ticks, n}` as a frozen, characterized POC compatibility mode, publish the
non-claim where the claims live, and spend the build budget on decision 4 instead, a witness set
with threshold pinned at genesis that may emit beacons after founder loss, opened as
`plans/179-witnessed-beacons-af2-founder-loss.md`.**

Three reasons. First, the only beta product (Treehouse) already pins witnessed succession with
dormant-tick succession disabled (Plan 158, Plan 178), so a repair of the legacy tick has no beta
customer while its build is L effort, HIGH risk, and necessarily churns every succession vector in
two runtimes. Second, every root-only variant of the three repair candidates makes succession fail
closed in exactly the founder-loss case that succession exists to handle, so decision 1 cannot be
answered well before decision 4 is. Third, witness-set beacons are inside the boundary (no key
rotation or recovery, no `Lattice.Canonical` change, same `:authority` op kind) and they are the
prerequisite for any later epoch-based dormancy being worth building at all, so they are the right
first build whichever way decision 1 is eventually settled.

## 1. Status

- Spike: Plan 175, `plans/175-succession-tick-provenance-spike.md`, priority P1, effort M.
- Concluded: 2026-09-03.
- Base: `origin/main` at `8200c38d` (the Plan 178 merge). Plan 162 is DONE, so the 175
  dependency on its step 2b(e) malformed-tick guard is satisfied.
- Green baseline in the spike worktree before any doc was written:
  `mix test test/lattice2/succession_time_travel_test.exs test/lattice2/witnessed_succession_test.exs test/lattice2/root_binding_test.exs test/lattice2/lease_lapse_test.exs`
  gives 52 tests, 0 failures.
- Drift check: Plan 175's own drift check diffs against `91bb6ca6` and lists production paths by
  design, because Plans 162, 177 and 178 landed after 175 was planned. That is not a STOP; the
  required response is the reconciliation in section 4, which finds the cited semantics intact.
- Repository state at the end of the spike: only `docs/` and `plans/` changed.

## 2. Recommendation

Restating the verdict for decision 1: do not build option A, B or C now. Keep the author-asserted
tick as a frozen compatibility mode (option D), record policy-gated option B as the designated
shape if Township ever needs automatic dormancy, and route the build budget to decision 4
(witness-set beacons pinned at genesis) as Plan 179.

Why not build the repair now: the Treehouse beta does not use dormant-tick succession, so the
repair protects nothing shipping; each candidate needs `beacons` threaded through the whole role
timeline fold in `authority.ex`, the `authority.ts` mirror, the compaction mirror and the Sim, plus
regenerated vectors, with conformance divergence a named STOP; and the lockout variant has no
retroactive fix under any option, so building A, B or C would not rescue a role that is already
pinned. Why decision 4 first: without a beacon emitter that can advance the epoch once the root key
is gone, every beacon-bound succession design freezes the role on its incumbent after founder loss,
which is worse than today's design in the failure mode succession exists for. Why witnessed beacons
and not delegated root powers: a single delegated beacon key becomes the clock and must itself be
witness-succeeded to avoid a deadlock, so the witness set is the simpler primitive and it is the
same governance shape Treehouse already commits to for succession.

The two documentation items that Plan 175 step 5 attaches to a "do not change it" outcome (the
non-claim sentence for `CLAUDE.md` and `README.md`, and the reconsideration of
`Township.Matter`'s `after: {:dormant_ticks, 3}`) are recommendations for Plan 179 to execute.
This spike is barred from editing `CLAUDE.md`, `README.md` and `apps/`, so neither edit happens
here.

## 3. Why the current design was accepted

Two sentences, per Plan 175 step 1. ADR 0004
([`docs/adr/0004-succession-validation.md`](../../docs/adr/0004-succession-validation.md))
accepted author-asserted ticks because the POC needed succession to be a pure function of signed
log content, so every replica replays byte-identically (G2) without a wall clock, and it explicitly
rejected carrier connection state, a process-local clock and free-identity counts as recovery
authority. Plan 144 ([`plans/144-succession-tick-provenance-boundary.md`](../../plans/144-succession-tick-provenance-boundary.md))
then pinned the consequence as a characterized compatibility mode rather than a dormancy proof
(the `township_succession_unproven_tick` vector honors an immediate `at_tick: 1_000_000`), and
Plan 145 ([`plans/145-genesis-pinned-witnessed-succession.md`](../../plans/145-genesis-pinned-witnessed-succession.md))
added genesis-pinned m-of-n witnessed recovery as the opt-in governance floor that is honest about
proving authorization, not absence.

Does it still hold? The determinism half holds absolutely and constrains every option below: any
repair must read only log content, which is why Plan 149's root-signed beacon is the only
admissible clock. The compatibility half holds only as long as nothing ships a dormancy claim,
which is true today: Treehouse pins witnessed succession with dormant-tick succession disabled
(Plan 158, Plan 178) and Township remains labelled untrusted-provenance
([`docs/lattice_poc_status.md`](../../docs/lattice_poc_status.md) lines 221-229). So the gap is
recorded and non-load-bearing for the beta. What the ADR's caveat does not say loudly enough is
that the legacy gate is decorative (section 6.1) and that its lockout variant is reachable on any
role with a plain `dormant_ticks` policy, which today includes
[`Township.Matter`](../../apps/lattice_core/lib/township/matter.ex) line 66.

## 4. Live-code reconciliation

Plan 175 was planned at `91bb6ca6`. Plans 162, 177 and 178 landed since. Every excerpt was
re-read against the live tree at `8200c38d`.

| Plan 175 excerpt | Plan line | Live location | Status |
|---|---|---|---|
| "The gate" `decide_succession_proof/7` dormant_ticks clause, cited at `authority.ex:681-688` | 94-105 | [`authority.ex`](../../apps/lattice_core/lib/lattice/authority.ex) 913-920 | UNCHANGED rule, one excerpt correction. Plan 175's quoted else-branch reads `record_acquire(st, op, d.audience, at_tick)`; the live line 919 reads `record_acquire(st, op, d, at_tick)`, passing the whole delegation rather than its audience. The `when is_integer(at_tick)` guard is present and the dormancy comparison is verbatim, so the argument nothing bounds `at_tick` from above is unaffected |
| "self-asserted inputs" `last_active_from/3`, cited at `:756-762` | 107-117 | `authority.ex` 988-994 | UNCHANGED (maxes `at_tick` over acquires ++ heartbeats visible in `anc`, 0 if none) |
| `collect_beacons/3`, cited at `:532` | 121 | `authority.ex` 719-732 | UNCHANGED in substance (root-authored, topo order, returns `[%{op_id, epoch}]` plus quarantine map) |
| `classify_beacon/6`, cited at `:547-561` | 121 | `authority.ex` 734-748, `valid_epoch?/2` at 750-751 | UNCHANGED (`:unauthorized_beacon` for non-root author, `:stale_beacon` for non-monotonic epoch) |
| `cap_ok/8` takes `beacons`, cited at `:884` | 122 | `cap_ok/9` at `authority.ex` 1123-1179 | CHANGED arity (Plan 162 step 2b(d) added `timelines` and `roles_needed`); beacons still consumed only by the `expired_as_of?` clause at 1169 |
| `expired_as_of?/5`, cited at `:924` | 123 | `authority.ex` 1238-1248 | UNCHANGED |
| "Confirm with" grep: `decide_transfer`, `decide_succeed`, `decide_heartbeat` take no beacons | 125-129 | `authority.ex` 871, 892, 964 | CONFIRMED; `build_role_timeline/6` (762-805) is called from `analyze/2` at 322-324 without beacons even though `{beacons, beacon_q}` is computed at 313 |
| `canonical.ex:35` `@uint64_max 18_446_744_073_709_551_615`; "nothing bounds it from above" | 131-135, 67-68 | [`canonical.ex`](../../apps/lattice_core/lib/lattice/canonical.ex) 35, exposed as `max_integer/0` at 45; `Lattice.Authority.valid_tick?/1` at `authority.ex` 466-468 | UNCHANGED constant; the sentence is now "only the uint64 shape bound applies": 2^64-1 remains a valid tick, so the lockout premise stands, and 2^64 is quarantined `:malformed_term` instead of raising inside the judge |
| Dependency on Plan 162 step 2b(e) | 37-39 | `role_event/3` at `authority.ex` 815-844 routes non-integer or out-of-range ticks to `{:malformed_tick, op}`, rejected `:malformed_term` at 777-778; structural mirror `malformed_tick_ops/1` and `malformed_tick_body?/1` at 474-487 | LANDED; Plan 162 status is DONE (`plans/162` lines 52 and 132), so README row 175's "162 step 2b (pending)" cell is stale |
| `stale_holder?/4`, cited at `:994-1016` (maintenance note) | 276-280 | `authority.ex` 1308-1330 | UNCHANGED (inspects only the immediately following acquire) |
| `Township.Matter:65` `after: {:dormant_ticks, 3}` | 150-151, 239 | [`matter.ex`](../../apps/lattice_core/lib/township/matter.ex) 66 | UNCHANGED text, shifted one line |
| Drift check against `91bb6ca6` | 8-27 | production paths listed: Plan 162 (`authority.ex`, `authority.ts`, exporter, vectors), Plan 177, Plan 178 | RECONCILED here; cited semantics intact, deltas are the step 2b guards and the `cap_ok/9` arity |
| TypeScript mirror (implicit in decision 6) | 161-163 | [`authority.ts`](../../clients/lattice-client/src/authority.ts) `successionRejectionReason` 637-723 (legacy arm computes `lastActive` over visible acquire and heartbeat `atTick` and returns `premature_succession` iff `proof.atTick < lastActive + dormantTicks`); `honoredAcquire` 466-487 copies the transfer or legacy-succeed `atTick` into the acquire; `collectBeacons` 1339-1380 mirrors `collect_beacons/3`, its `validBeacons` consumed only by [`capability.ts`](../../clients/lattice-client/src/capability.ts) line 130 | MIRRORS the BEAM rule for rule, including the absence of any beacon input to the role timeline. See the portable-input qualifier below: this is not full-range parity |

Parity here is portable-input parity, not full-range parity. The two runtimes agree on every value
either can carry, and that is the only parity the conformance corpus exercises, but their accepted
integer ranges differ. The BEAM admits any tick or epoch up to `Lattice.Canonical.max_integer/0`
(2^64-1); TypeScript stops at `Number.MAX_SAFE_INTEGER` (2^53-1), enforced in
[`carrier.ts`](../../clients/lattice-client/src/carrier.ts) by `integerValue` 1640-1642, by
`nonNegativeInteger` 1870-1871 (which gates the `dormant_ticks` policy decode at 1693 and the
`at_tick` decode at 1712), by the beacon body decode at 1500-1511 (a non-integer epoch term decodes
to `null`), and, before either of those, by `parseCarrierInteger` at 2117-2133. The ordering matters
and review round ci-3 corrected an earlier reading of it: `parseCarrierInteger` throws while
`decodeCarrierTerm` is still running, so the two term-level guards above never see an out-of-range
integer at all. `carrierOpToSemanticOp` catches that throw at 1215-1219 and marks the **whole op**
`structuralError: "malformed_term"`, which `materialize.ts` 136-138 records as the quarantine
reason. A larger value therefore fails the decode closed as a malformed carrier op rather than
diverging silently. `plans/README.md` lines 939-946
already records this as deferred format work, and this spike does not reopen it: closing it means
either an explicit cross-runtime bound or carrying `bigint` through authority semantics, and a
cross-runtime bound below 2^64-1 would be a change to what `Lattice.Canonical` admits, which is a
Plan 175 STOP condition.

Two states in this document sit inside that gap, so they are recorded here rather than left
implicit. Section 6.2's `at_tick: 2^64-1` lockout and section 6.6's `epoch: 2^64-1` ceiling are both
BEAM-reachable and both above 2^53-1. A TypeScript realm reconstructing such a log from the carrier
gets a fail-closed decode error for the offending op, not the BEAM's verdict, so the two runtimes
report the same replica differently: the BEAM says "honored, and succession or lease lapse is now
pinned", TypeScript says "this frame is malformed". Neither is a wrong answer under its own rules,
and neither is exercised by a vector, because the exporter never emits a value in that range. It
is a real limit on how far the conformance corpus can certify these two failure modes, and any
future plan that wants to pin either one as a vector has to settle the format question first.

One extra observation from the reproductions: the honored beacon epoch sequence is built into the
internal `cap_evidence` map (`authority.ex` 354-360) and is not surfaced on the analysis result
the scripts consumed, so the root-only reproduction read `:reasons` instead. Any beacon-bound tick
design would need that sequence surfaced, a small cost line for options A and C.

## 5. Blast radius

Collected per Plan 175 step 2 with the two prescribed greps plus a wider
`grep -rl -iE 'succession|succeed|heartbeat'` over the vectors, which surfaced one file the first
pass had missed (`township_authority_undeclared_role_tick.json`, placed below).

### 5.1 Tests (`apps/lattice_core/test`)

| File | Lines | Dependence on self-asserted ticks |
|---|---|---|
| [`lattice2/succession_time_travel_test.exs`](../../apps/lattice_core/test/lattice2/succession_time_travel_test.exs) | 28, 35 (test at 24) | heartbeat at 1, `Sim.succeed at_tick: 4` under `dormant_ticks: 3`, no beacon; any beacon requirement or epoch bound quarantines this succession |
| same | 55, 60 (test at 53) | heartbeat at 2, succeed at 3 expected `:premature_succession`; the reason changes under an epoch design |
| same | test at 67 | `state_at` replays the same self-asserted timeline |
| [`lattice2/witnessed_succession_test.exs`](../../apps/lattice_core/test/lattice2/witnessed_succession_test.exs) | 182 (test at 170), 210 (test at 192), 322, and the `founded/1` fixture at 14 | `Sim.succeed(..., at_tick: 1_000_000)` is the honored legacy control against witnessed-policy refusals; under any bound the control flips |
| [`lattice2/root_binding_test.exs`](../../apps/lattice_core/test/lattice2/root_binding_test.exs) | 99-111 (at_tick 100), 117-128 (parented genesis, at_tick 0 with `dormant_ticks: 0`), 156-168 and 196-207 (unrooted laundering at tick 0), 267-303 (succeed at 3 under `dormant_ticks: 3` with no heartbeat, then transfer at 4), 351-358, 363-376 (malformed ticks), 402-431 (over-range proofs, replay poisoning) | every honored succession relies on tick 3 clearing `last_active 0 + 3` with no beacon |
| [`lattice2/authority_test.exs`](../../apps/lattice_core/test/lattice2/authority_test.exs) | 94, 121, 122 | transfers at `at_tick: 1`; affected only if transfer ticks are bounded by beacon epoch (options B and C) |
| [`lattice2/convergence_property_test.exs`](../../apps/lattice_core/test/lattice2/convergence_property_test.exs) | 55, 94 | StreamData generator transfers at a running counter under `dormant_ticks: 2`; bounded ticks require beacons in the generator |
| [`lattice2/lease_lapse_test.exs`](../../apps/lattice_core/test/lattice2/lease_lapse_test.exs) | 24 (policy shape); root beacons at 41, 65, 80, 93, 95, 106, 131, 151 | corrected in review round 2, which found only line 24 recorded. The policy shape is affected only by a field rename and no tick is asserted anywhere in the file, so decision 1 does not touch it. The eight beacon cases make it the densest beacon-consumer suite in the tree, including V3's `:unauthorized_beacon` for a non-root beacon (80, 86) and `:stale_beacon` for a repeated epoch (93-98), so it is a direct regression gate for Plan 179 |
| [`lattice2/compaction_spike_test.exs`](../../apps/lattice_core/test/lattice2/compaction_spike_test.exs) | 59-98 and the GATE test at 121 (transfers at 1, 2, 4 and premature succeed at 3), 147-163, 168-190, 195-210, 221-236, 316-322, 407-410 (`at_tick: 1_000_000` under witnessed), 442, 452-467, 477-483, 540-573, 662-752 (generated property) | the compaction parity gate reduces the same self-asserted timelines through the mirror in [`test/support/compaction_spike.ex`](../../apps/lattice_core/test/support/compaction_spike.ex) |
| [`township/workflows_test.exs`](../../apps/lattice_core/test/township/workflows_test.exs) | 33, 67, 101, 137, 159, 202, 249 (`dormant_ticks: 3` policies); 174, 216 (W2 transfers at `at_tick: 1`); 79 (a root beacon at epoch 3 lapsing a lease) | W2 stale-holder tests depend on transfer ticks only; W3 (244) is dump/restore and does not succeed. The beacon at 79 was missed until review round 2 and makes this a Plan 179 regression gate as well as a decision-1 one |
| [`township/matter_property_test.exs`](../../apps/lattice_core/test/township/matter_property_test.exs), [`township/lease_property_test.exs`](../../apps/lattice_core/test/township/lease_property_test.exs) | 56, 103; 49 (tick counters). `lease_property_test.exs` 31 (`:beacon` and `:forged_beacon` generators) and 68-74 (a valid root beacon at `e + 1`, a forged beacon at epoch 99 from a non-root realm) | generators transfer at a counter under `dormant_ticks: 2`. The beacon generators were missed until review round 2: this suite asserts identical `:unauthorized_beacon` and `:lease_expired` verdicts across replicas under random beacon schedules, so it is a Plan 179 regression gate, and its forged-beacon arm is the property-level twin of section 6.5 |
| [`township/export_vectors_test.exs`](../../apps/lattice_core/test/township/export_vectors_test.exs) | 225-260 (test "pins an unproven author-asserted succession tick"; `tickProvenance == author_asserted_untrusted` at 245), 163 (W3 vector), 261 (witnessed recovery) | asserts the `1_000_000` succession is NOT quarantined and the resident wins; Plan 144 states this expectation is meant to be replaced by the remediation |
| [`clients/lattice-client/test/conformance.ts`](../../clients/lattice-client/test/conformance.ts) | 230 (type), 638-668 (clerk == resident and not quarantined), 925-941 (provenance marker) | plus generic state and quarantine equality for every vector below |
| [`toolshed/workflows_test.exs`](../../apps/lattice_core/test/toolshed/workflows_test.exs) | 36 and 238 (`dormant_ticks: 3` policies), 249 (`Sim.transfer ... at_tick: 1`), 65, 166, 196 (root beacons driving lease lapse and due-back) | missed by the first pass. Affected under options B and C by transfer-tick bounding, and affected by any beacon change, which makes it a direct regression gate for Plan 179 rather than for decision 1 |
| [`toolshed/custody_consent_test.exs`](../../apps/lattice_core/test/toolshed/custody_consent_test.exs) | 141 (`Sim.transfer ... at_tick: 1`) | missed by the first pass. Transfer ticks only; unaffected by option A, affected by options B and C |
| [`toolshed/read_model_test.exs`](../../apps/lattice_core/test/toolshed/read_model_test.exs) | 73 (`Sim.beacon(sim, "owner", 5)`, the "overdue is computed, not asserted" test) | missed by the first pass. No tick dependence; it is the read-model gate that any beacon change must leave green |
| `apps/lattice_stress/test/{adversarial_authority,property_authority_invariant}_test.exs` | none | no `at_tick`, `dormant_ticks` or `succeed(` references; regression gates only |

The beacon consumers deserve their own enumeration, because they are the regression set for the
recommended build rather than for decision 1, and the first two passes of this table recorded only
some of them. In full, every `Sim.beacon` site in the tree is:
[`lattice2/lease_lapse_test.exs`](../../apps/lattice_core/test/lattice2/lease_lapse_test.exs)
41, 65, 80, 93, 95, 106, 131, 151;
[`township/lease_property_test.exs`](../../apps/lattice_core/test/township/lease_property_test.exs)
31 and 68-74 (generated, valid and forged);
[`township/workflows_test.exs`](../../apps/lattice_core/test/township/workflows_test.exs) 79;
[`toolshed/workflows_test.exs`](../../apps/lattice_core/test/toolshed/workflows_test.exs) 65, 166,
196; and
[`toolshed/read_model_test.exs`](../../apps/lattice_core/test/toolshed/read_model_test.exs) 73.
Plan 179's regression set names all five files.

### 5.2 Vectors (`clients/lattice-client/test/vectors`)

| Vector | Content | Effect of a repair |
|---|---|---|
| `township_succession_w3.json` | heartbeat at 1, resident succeed at 4, no beacon | honored today; quarantined under strict A, B or C |
| `township_succession_unproven_tick.json` | the Plan 144 adversarial pin (`at_tick: 1_000_000` honored, `tickProvenance` marker) | designed to flip when provenance is fixed |
| `township_succession_witnessed_recovery.json` | witnessed proof, records `at_tick` 0. Its genesis pins `%{clerk: %{successor: "resident", recovery: %{mode: :witnessed, version: 1, witnesses: [...], threshold: 2}}}` at exporter 407-427, not a `dormant_ticks` policy | unaffected by every tick rule, and unaffected by a `dormant_ticks` rename: genesis policies come from `Sim.create_replica`'s `policies:` option ([`sim.ex`](../../apps/lattice_core/lib/lattice/sim.ex) 66-71), never from the `succession/2` DSL declaration at exporter 14-15, which is intent documentation only. It moves only if the genesis policy encoding or the certificate shape changes, which is exactly what Plan 179 must leave byte-identical |
| `township_authority_succession_genesis_poisoning.json`, `township_authority_succession_capability_laundering.json` | succeed at 3 (exporter 1635-1656, 1536-1569) with no beacon | honored today; flip under strict A, B or C |
| `township_authority_cross_role_succession_transfer.json` | succeed at 3 then transfer at 4 (exporter 1968-1973) | same |
| `township_authority_rooted_grant_as_genesis.json` | mallory succeed at 0 under `dormant_ticks: 0` (exporter 1459-1467) | same |
| `township_authority_malformed_heartbeat.json` | transfer with `at_tick "9"` (exporter 2003, 2052) pins `:malformed_term` | unaffected unless reason precedence changes |
| `township_authority_undeclared_role_tick.json` | heartbeat `{:heartbeat, :ghost, "9"}` and transfer `at_tick: "9"` on an undeclared role (exporter 2039-2078), both pinned `:malformed_term`, clerk holder undisturbed | missed by the first pass; exempt from tick provenance because both ops fail the Plan 162 shape guard before any dormancy arithmetic runs, so no option changes its bytes unless reason precedence changes |
| `township_carrier_w1.json`, `township_authority_replayed_genesis.json`, `township_foreign_replica_injection.json`, `township_zoning_variance_24.json` | carry `atTick` on transfers and/or `dormant_ticks` policies (exporter 253-278, 3631-3650, 3705) | affected only under transfer-tick bounding or a policy rename |
| `township_authority_double_transfer.json`, `township_authority_forged_transfer.json`, `township_authority_unattenuated_transfer.json`, `township_authority_rooted_transfer_not_holder.json`, `township_authority_malformed_transfer.json`, `township_authority_cross_replica_replay.json` | six more transfer-tick carriers, missed until review round 2. Their exporter bodies name the tick explicitly: `{:transfer, :clerk, forged_delegation, 0}` at 1079, `to_resident, 0` and `to_mallory, 0` at 1167-1170, `overbroad, 0` at 1237, `rooted_transfer_delegation, 0` at 1724, `sibling_transfer, 1` at 1927 | the same qualifier as the row above: unaffected by option A, affected only under transfer-tick bounding. Every one flips under strict option B or option C, and `cross_replica_replay`'s tick-1 sibling transfer flips under strict C |

Those six are worth a method note, because Plan 175 step 2's prescribed
`grep -rln "succession\|succeed" clients/lattice-client/test/vectors/` cannot find them and neither
could this document's wider `grep -rl -iE 'succession|succeed|heartbeat'`. A transfer tick is an
integer inside the canonical frame, not a word in the JSON, so no name-based grep over the vectors
reaches it. The correct enumeration is `grep -rl '"transfer"'` over the vector directory, checked
against the exporter's transfer bodies, which is how the six above were finally found. Any later
plan re-deriving this list should use that pair and not the prescribed grep.

The five vectors below carry no succession tick at all, so Plan 175 step 2's two prescribed greps
did not surface them and the first pass omitted them. They are listed here because they are the
vectors the recommended build touches most directly: every one of them exercises
`collect_beacons/3` and `collectBeacons`, which is the exact pair Plan 179 modifies. They are the
byte-identical proof obligation for that build, not for decision 1.

| Vector | Content | Effect of a repair | Effect of Plan 179 |
|---|---|---|---|
| `township_beacon_unauthorized.json` | a non-root beacon at epoch 9 pinned `:unauthorized_beacon`, a repeated root epoch 2 pinned `:stale_beacon`, and a leased post that stays honored because neither conferred a lapse (exporter 2602-2634) | none: no tick, no `dormant_ticks` policy | the single most load-bearing vector. It pins root-only as the default and both reason atoms, so it must stay byte-identical to prove that a replica with no beacon policy behaves exactly as before |
| `township_lease_valid_causal.json` | a lease honored because the beacon is not causally after the op (exporter 2481-2505) | none | must stay byte-identical: the ancestry-scoped lapse rule is unchanged |
| `township_lease_expired.json` | a beacon past `expires_epoch` lapses the delegation (exporter 2506-2539) | none | must stay byte-identical, and it is the shape the witnessed-beacon lapse case in Plan 179 step 2c copies |
| `township_lease_expired_chain.json` | lapse propagating along a delegation chain (exporter 2540-2569) | none | must stay byte-identical |
| `township_lease_renewed.json` | a renewed lease surviving the beacon (exporter 2570-2601) | none | must stay byte-identical |

### 5.3 TypeScript files

- [`clients/lattice-client/src/authority.ts`](../../clients/lattice-client/src/authority.ts):
  `successionRejectionReason` 637-723 (legacy dormancy arithmetic), `honoredAcquire` 466-487
  (`atTick` copy), `RoleState.heartbeats` 118-122, heartbeat handling 207-220, `collectBeacons`
  1339-1380; `validBeacons` would need threading into the role timeline.
- [`clients/lattice-client/src/capability.ts`](../../clients/lattice-client/src/capability.ts)
  line 130: the only current consumer of `validBeacons` (lease lapse).
- [`clients/lattice-client/src/carrier.ts`](../../clients/lattice-client/src/carrier.ts)
  1467-1476 (succeed decode) and 1684-1693 (`dormant_ticks` policy decode);
  [`op.ts`](../../clients/lattice-client/src/op.ts) line 117;
  [`township.ts`](../../clients/lattice-client/src/township.ts) line 392 (policy encode);
  [`materialize.ts`](../../clients/lattice-client/src/materialize.ts) line 17 doc comment.
- [`clients/lattice-client/src/codec.ts`](../../clients/lattice-client/src/codec.ts)
  `canonicalBytesForWitnessedSuccessionClaim` 206-221, which hard-codes the succession separator
  (line 95) and the seven-field succession claim over canonical encoders that are module private
  (318-350). Added in review round ci-2: any new witnessed claim shape needs its own exported
  function here, because it cannot be composed from outside this file.
- [`clients/lattice-client/test/conformance.ts`](../../clients/lattice-client/test/conformance.ts)
  230, 638-668, 941, and the authority op kind list;
  [`test/township_authoring.ts`](../../clients/lattice-client/test/township_authoring.ts), the only
  gate over `authorTownshipGenesis` and therefore over the genesis policy **encoder**.

### 5.4 Other production code and docs in the radius

- `authority.ex` 762-805 `build_role_timeline/6` and `analyze/2` 313-324 (beacons computed but not
  passed), 871-977 `decide_*` fold, 913-920 gate, 988-994 `last_active_from/3`, moduledoc bullets.
- [`sim.ex`](../../apps/lattice_core/lib/lattice/sim.ex) 105-121 `transfer/5` (`at_tick` default
  0), 128-141 `succeed/4`, 151-153 `heartbeat/4`, 161-163 `beacon/3`, 316-350 succession proof
  generation: any epoch design needs Sim helpers that derive the epoch from the realm's visible
  beacons.
- [`test/support/compaction_spike.ex`](../../apps/lattice_core/test/support/compaction_spike.ex)
  205-222 (`last_active_tick` seeding) and 538-544 `seeded_succession_proof` (mirrors the
  dormancy comparison); must change in lockstep or the compaction GATE goes red.
- Exporter DSL and scenarios listed in 5.2.
- `Township.Matter` line 66; `CLAUDE.md` line 160 (DSL line); ADR 0004;
  `docs/lattice_poc_status.md` 221-229; `TOWNSHIP_BUILD_MAP.md` rows pinned by
  `audit_bundle_test.exs` and `read_model_test.exs` (untouchable by this spike).
- [`test/treehouse/contract_test.exs`](../../apps/lattice_core/test/treehouse/contract_test.exs)
  lines 95 and 121 pin Plan 178's founder-loss sentence verbatim; every doc written here keeps that
  sentence true.

### 5.5 Why this list proves the two plans are separated

Plan 162's done criterion requires `township_succession_w3`,
`township_succession_unproven_tick` and `township_succession_witnessed_recovery` to be
byte-identical to their pre-162 versions, and its STOP condition forbids any succession test or
vector from changing. Every one of options A, B and C changes at least the first two of those
vectors (section 5.2) unless it is policy-gated, and even the policy-gated form changes
`succession_time_travel_test.exs` expectations for opted-in policies. A plan cannot both require
succession to behave as it does today and redesign it, so the repair is a separate plan, exactly as
Plan 175 argued. Plan 162 landed with the three vectors unchanged, which is the executable proof
that its guards and this spike's provenance question did not overlap.

## 6. Reproductions

All eight scratch scripts live under an agent scratchpad directory outside the repository, written
here as `<scratchpad>/spike175/<script>.exs` because no committed path may depend on one machine's
scratch location, and they were never committed: the five original runs `s1_seizure.exs`,
`s2_lockout_no_recovery.exs`, `s3_lockout_with_recovery.exs`, `s4_canonical_ceiling.exs`,
`s5_beacon_root_only.exs`, and the review-round additions `r1_epoch_ceiling.exs`,
`r2_pruned_deps_beacon.exs` and `ci1_fork_below_high_beacon.exs`. Each ran via `mix run` from
`apps/lattice_core` in the spike worktree. Outputs are verbatim. Both exploits named in Plan 175
step 3 reproduced, so the premise stands and the STOP condition "either exploit fails to
reproduce" did not fire.

`Lattice.Sim` derives every realm's Ed25519 keypair from the `seed:` string, so a seed is key
material. No seed value appears anywhere in this document, and none of the replica identifiers
below is derived from one. Anyone re-running these scripts picks their own seed; only the outputs
that are seed-independent (verdicts, quarantine reasons, holder equality, integer sweeps) are
stable across seeds, and the two seed-derived values that do appear (a truncated public key in 6.1
and two operation ids in 6.5) are public log content shown only to make the runs auditable.

### 6.1 Seizure (reproduced)

Setup: `Township.Matter`, replica `replica:township:p175-seizure`, realms clerk, resident and
bystander, `Sim.create_replica("clerk", policies: %{clerk: %{successor:
"resident", dormant_ticks: 3}})`. The holder is demonstrably active: `Sim.heartbeat` at tick 1,
then a `:close_matter` command that is accepted and takes effect, then `sync_all`. Three
independent branches off that base: A at `at_tick = N + dormant_ticks = 4`, B at `1_000_000`,
C control at `N + dormant_ticks - 1 = 3`.

```text
N (holder heartbeat tick): 1
heartbeat quarantined?: false
fresh holder command quarantined?: false
holder command took effect (clerk_locked?): true
baseline holder (expect clerk): "65f96cb2faf7"
baseline holder == clerk: true

A exact-threshold seizure (N+dormant_ticks): at_tick: 4
A exact-threshold seizure (N+dormant_ticks): quarantined?: false
A exact-threshold seizure (N+dormant_ticks): holder == resident: true
A exact-threshold seizure (N+dormant_ticks): holder==resident on clerk own replica: true

B far-future seizure (1_000_000): at_tick: 1000000
B far-future seizure (1_000_000): quarantined?: false
B far-future seizure (1_000_000): holder == resident: true
B far-future seizure (1_000_000): holder==resident on clerk own replica: true

C control (N+dormant_ticks-1): at_tick: 3
C control (N+dormant_ticks-1): quarantined?: {true, :premature_succession}
C control (N+dormant_ticks-1): holder == resident: false
C control (N+dormant_ticks-1): holder==resident on clerk own replica: false
```

Seizure is total, not marginal. The control one tick lower proves the comparison is live and that
the only thing the gate measures is the integer the claimant chose. A second finding widens Plan
175's framing: ordinary commands do not count as activity. The holder authored the exact op the
role exists to authorize, it took effect, and `last_active` did not move, because
`last_active_from/3` maxes only over acquires and heartbeats. A visibly active holder reads as
fully dormant.

### 6.2 Lockout without a recovery policy (reproduced; permanent on the pinned history, see 6.2a)

Setup: replica `replica:township:p175-lockout`, same policy shape. Two pin variants, each
`Sim.transfer(..., :clerk, at_tick: 18_446_744_073_709_551_615, ops: [:close_matter,
:reopen_matter])`: A is the self-transfer clerk to clerk, B is clerk to bystander (the rest runs on
B). Then `Sim.succeed("resident", :clerk, at_tick: max)`, then attempts to construct 2^64, then a
sweep of every interesting encodable tick.

```text
Canonical.max_integer/0: 18446744073709551615
A self-transfer(clerk->clerk) at 2^64-1 quarantined?: false
B pinning transfer(clerk->bystander) at 2^64-1 quarantined?: false
B holder is now bystander: true
succeed at 2^64-1 quarantined?: {true, :premature_succession}
holder still bystander: true
Canonical.term(2^64): {:raised, ArgumentError, "unsupported canonical integer: 18446744073709551616"}
Op.new heartbeat tick 2^64: {:raised, ArgumentError, "unsupported canonical integer: 18446744073709551616"}
Sim.succeed at_tick 2^64: {:raised, ArgumentError, "unsupported canonical integer: 18446744073709551616"}
sweep {at_tick, quarantined?} after the 2^64-1 pin: [
  {0, {true, :premature_succession}},
  {1, {true, :premature_succession}},
  {1000000, {true, :premature_succession}},
  {18446744073709551612, {true, :premature_succession}},
  {18446744073709551614, {true, :premature_succession}},
  {18446744073709551615, {true, :premature_succession}}
]
```

Both pin variants land, so the lockout needs no accomplice. After the pin every encodable tick
sweeps to `:premature_succession`, including 2^64-1 itself (the gate needs `at_tick >= 2^64 + 2`),
and 2^64 cannot be constructed at all: `Lattice.Canonical.term/1`, `Lattice.Op.new/6` and
`Sim.succeed` each raise at authoring time, so no such op reaches the judge. With a
`dormant_ticks` policy and no recovery policy, the legacy succession path for that role is dead,
for the life of the replica, on every history in which the pin is honored; the exits are a succeed
op whose deps fork around the pin (6.2a, reproduced by Plan 179 step 1, which corrected this
sentence from an unconditional "the only exits are outside this mechanism"), a voluntary transfer
by the pinning holder, or a new replica.

A harness detail worth recording rather than hiding: `Sim.transfer/5` defaults to `ops: [:lock,
:unlock]`, which are `Lattice.Demo.Thread` commands, not `Township.Matter` commands. With the
default both pins quarantine `:invalid_transfer` (the child delegation is not a subset of the
genesis grant) and the pin never lands, which reads as a false negative. Naming real Matter ops
fixes it. The first run hit exactly this.

#### 6.2a The pin is fork-escapable by the designated successor (reproduced 2026-09-03, Plan 179 step 1)

Plan 179 step 1 reproduced the question this section left open. `last_active_from/3`
(`authority.ex` 989-994) reads acquires and heartbeats only from the succeed op's own causal
ancestry, so the permanence claimed above holds only for succeed ops whose deps carry the pin
while the fold honors it; a pin the fold quarantines, as `:double_transfer` below, is invisible to
the gate.
Setup: replica `replica:township:p179-fork`, realms clerk, bystander, resident, the same
`%{successor: "resident", dormant_ticks: 3}` policy. Resident is partitioned from both other realms
before the clerk pins with `Sim.transfer(..., "bystander", :clerk, at_tick: 2^64-1, ops:
[:close_matter, :reopen_matter])`; resident then authors `Sim.succeed("resident", :clerk, at_tick:
t)` on its own frontier, so the deps are the genesis only, and the partition heals. Three runs, `t`
in `{5, 1_000_000, 2^64-1}`:

```text
fork@5: succeed deps carry the pin? false
fork@5: on clerk: pin quarantined=false succeed quarantined=false holder="resident"
fork@5: on bystander: pin quarantined=false succeed quarantined=false holder="resident"
fork@5: on resident: pin quarantined=false succeed quarantined=false holder="resident"
fork@5: byte-identical state on all three: true
fork@5: control succeed (deps carry pin) at 2^64-1 quarantined={true, :premature_succession}

fork@1000000: succeed deps carry the pin? false
fork@1000000: on clerk: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@1000000: on bystander: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@1000000: on resident: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@1000000: byte-identical state on all three: true
fork@1000000: control succeed (deps carry pin) at 2^64-1 quarantined=false

fork@max: succeed deps carry the pin? false
fork@max: on clerk: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@max: on bystander: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@max: on resident: pin quarantined={true, :double_transfer} succeed quarantined=false holder="resident"
fork@max: byte-identical state on all three: true
fork@max: control succeed (deps carry pin) at 2^64-1 quarantined={true, :premature_succession}
```

Every run lands the forked succeed on all three replicas with byte-identical state and resident as
holder. Whether the pin itself survives depends on the canonical topo order between the two
concurrent acquires: when the succeed sorts first, the transfer is retroactively quarantined
`:double_transfer` because the fold's holder is already resident when it reaches the transfer
(`decide_transfer/7`, `authority.ex` 883-885), and the only tick then gating a later succeed is
the forked succeed's own acquire (`fork@1000000`'s control at `2^64-1` passes; `fork@max`'s control
is `:premature_succession` because the forked succeed at `2^64-1` pinned `last_active` itself);
when the transfer sorts first, both acquires are honored and the later one,
the succeed, holds, and the control succeed at `2^64-1` whose deps carry the now honored pin is
`:premature_succession` again. A second variant needs no partition: with the holder's heartbeat at tick 100
and a real transfer to bystander at tick 200 both in the log, resident's honest succeed at tick 5
(deps carrying both) quarantines `:premature_succession`, while the same succeed with deps pruned by
hand to the genesis op lands on all three replicas with byte-identical state and resident as holder:

```text
heartbeat@100 quarantined=false transfer@200 quarantined=false
honest succeed@5 (deps carry hb+transfer): quarantined={true, :premature_succession}
pruned succeed@5 (deps=[genesis]) on clerk: quarantined=false transfer@200 quarantined=false holder="resident"
pruned succeed@5 (deps=[genesis]) on bystander: quarantined=false transfer@200 quarantined=false holder="resident"
pruned succeed@5 (deps=[genesis]) on resident: quarantined=false transfer@200 quarantined=false holder="resident"
byte-identical state on all three: true
```

Two corrections to the reading above follow. The lockout binds every succeed op
built on a history in which the pin is honored, not the role for the life of the replica; its exits
are a succeed op that forks around the pin, a voluntary transfer by the pinning holder, or a new
replica. And the
seizure of 6.1 does not depend on the holder being quiet in the log; it depends only on the deps
the successor chooses, because any ancestor with a low `last_active` satisfies the dormancy gate
whatever the holder has done since. Decision 5 in section 9 and the "unrecoverable" column of 7.5
read with the same qualification. Nothing here changes decision 1 (option D): the tick stays
untrusted, the non-claim sentence stays, and Plan 179's build does not touch the dormancy
arithmetic.

### 6.3 Lockout with a witnessed recovery policy (recovered)

Setup: replica `replica:township:p175-recovery`, realms clerk, bystander, resident,
witness_a, witness_b, witness_c, policy `%{clerk: %{successor: "resident", recovery: %{mode:
:witnessed, version: 1, witnesses: [...three...], threshold: 2}}}` with no `dormant_ticks`
(`decide_succeed/8` rejects `:invalid_recovery_policy` at `authority.ex` 906 when both keys are
present). Same pin, then an integer proof, then `Sim.succeed("resident", :clerk, witnesses:
["witness_a", "witness_b"])`, then a second witnessed recovery.

```text
pinning transfer at 2^64-1 quarantined?: false
holder is bystander (pinned last_active): true
integer at_tick proof under recovery policy: {true, :recovery_certificate_required}
witnessed certificate quarantined?: false
holder == resident after witnessed recovery: true
same on clerk replica: true
same on bystander replica: true
second witnessed recovery quarantined?: false
```

The witnessed arm of `decide_succession_proof/7` (`authority.ex` 930-956) calls
`record_acquire(st, op, d, 0)` and never consults dormancy, so a threshold certificate moves the
role and converges on all three replicas, and it is not a one-shot escape. The two configurations
are disjoint by construction: "dormancy-gated" and "witness-recoverable" are two different
deployments, not a belt-and-braces pair. `Township.Matter`'s shipped `after: {:dormant_ticks, 3}`
is the disjoint half with no recovery arm.

### 6.4 Canonical ceiling (confirmed)

```text
canonical.ex uint64_max occurrences {line, text}: [
  {35, "@uint64_max 18_446_744_073_709_551_615"},
  {45, "def max_integer, do: @uint64_max"},
  {151,
   "defp encode(int) when is_integer(int) and int >= 0 and int <= @uint64_max,"},
  {254,
   "defp major(major, n) when n <= @uint64_max, do: <<major::3, 27::5, n::64>>"}
]
Lattice.Canonical.max_integer/0: 18446744073709551615
== 18_446_744_073_709_551_615: true
valid_tick?(max): true
valid_tick?(max+1): false
```

Anyone re-running the lockout must use `18_446_744_073_709_551_615` exactly. It equals
`Canonical.max_integer/0`, so `valid_tick?/1` admits it; a script using max+1 is refused as
`:malformed_term` and would falsely report the lockout as fixed.

### 6.5 Root-only beacon (confirmed)

```text
non-root beacon (resident, epoch 7): {true, :unauthorized_beacon}
same verdict on the root replica: {true, :unauthorized_beacon}
root beacon (clerk, epoch 7): false
same verdict on the non-root replica: false
root beacon repeating epoch 7: {true, :stale_beacon}
root beacon epoch 8: false
authority reasons: %{
  "8FgiYRHdmnJ_5nZFOMK7x8nTirX8HqAMUC4x5YRKsqw" => :unauthorized_beacon,
  "uoWTJb96AV4RrtS9M6iUDaeti4f5O63LQNNR4hJdKUY" => :stale_beacon
}
```

The AF-2 premise (Plan 177, Plan 178) is intact: beacons are honored only from the replica root,
verdicts converge across replicas, and monotonicity is enforced.

### 6.6 The epoch has the same ceiling as the tick, and reaching it revokes every lease (reproduced)

Added in review round 1. Sections 6.2 and 6.4 analysed the `2^64-1` ceiling for `at_tick` and
stopped there. The same ceiling exists on the beacon epoch, and its consequences are worse, because
the epoch is not decorative: `expired_as_of?/5` (`authority.ex` 1238-1248, consumed by `cap_ok/9`
at 1169, mirrored by [`capability.ts`](../../clients/lattice-client/src/capability.ts) line 130)
lapses any delegation whose `expires_epoch` is below a visible beacon epoch that is not causally
before the op. Advancing the epoch is therefore a revocation power over every expiring delegation
on the replica, and advancing it to the ceiling is a permanent one.

Setup (`r1_epoch_ceiling.exs`): `Township.Matter`, replica `replica:township:r1-epoch-ceiling`,
realms clerk (root), resident and neighbor. A lease to resident with `expires_epoch: 1_000_000` and
one honored command under it, then a single root beacon at `2^64-1`, then a second command under
the same lease, then two fresh leases issued after the ceiling, then a sweep of later beacons.

```text
beacon at 2^64-1 quarantined?: false
same on resident: false
pre-ceiling op under lease: false
post-ceiling op under lease (expires 1_000_000): {true, :lease_expired}
fresh lease expiring at 2^64-2, first op: {true, :lease_expired}
fresh lease expiring at 2^64-1, first op (can never lapse): false
later root beacons after the ceiling {epoch, quarantined?}: [
  {0, {true, :stale_beacon}},
  {1, {true, :stale_beacon}},
  {1000000, {true, :stale_beacon}},
  {18446744073709551614, {true, :stale_beacon}},
  {18446744073709551615, {true, :stale_beacon}}
]
beacon at 2^64: {:raised, ArgumentError, "unsupported canonical integer: 18446744073709551616"}
```

Four things are established. One, `valid_epoch?/2` (`authority.ex` 750-751) requires only
`epoch > prior_max`, so a single beacon may jump the epoch as far as the canonical encoding allows;
there is no step bound anywhere. Two, one such beacon lapses every already-issued expiring lease at
its next use. Three, every lease issued afterwards is dead on arrival unless it expires at exactly
the ceiling, in which case it can never lapse: the mechanism has both failure directions at once.
Four, the clock is then stopped for every op that carries that beacon in its causal ancestry. Every
later beacon built on it is `:stale_beacon` for every encodable epoch, and `2^64` cannot be authored
at all, so no descendant op can advance the epoch again. Read that scope exactly: `classify_beacon/6`
computes `prior_max` over the candidate op's own ancestry, and section 6.8 reproduces a beacon whose
`deps` fork from before the high one still being honored at a lower epoch on every replica, so the
lockout is descendant scoped rather than replica wide. This is the beacon-side twin of section 6.2,
and it is not repairable by any change that respects Plan 175's STOP condition on
`Lattice.Canonical`.

Today this costs nothing, because only the replica root can do it, and the root can already revoke
any delegation it issued and stop beaconing at will. It is recorded here because the recommended
build changes exactly that: it hands the same power to any threshold subset of the pinned witness
set, and a witness set is granted for clock continuity, never for revocation. Section 8 carries the
consequence into the design, and Plan 179 carries it into a required bound.

### 6.7 A beacon re-placed with pruned deps lapses ops that were already honored (reproduced)

Added in review round 2, because section 8.2 reverses a design default on the strength of this
mechanism and a design argument is not evidence. `classify_beacon/6` computes `prior_max` over
valid beacons in the candidate op's **own** ancestry, and `expired_as_of?/5` lapses any op the
beacon does not carry in its ancestry. Together those two make a second beacon at the **same**
epoch, authored with pruned deps, both valid and retroactively destructive.

Setup (`r2_pruned_deps_beacon.exs`): `Township.Matter`, replica
`replica:township:r2-pruned-deps`, realms clerk (root) and resident. A lease to resident with
`expires_epoch: 3`, one honored post under it, `sync_all`, then a normal root beacon at epoch 9
carrying the whole history in its deps, then a second beacon at epoch 9 built with
`Op.new(clerk, replica, [genesis.id], :authority, {:beacon, 9})` and appended to every log.

```text
first beacon (epoch 9, full deps) quarantined?: false
early leased op after the first beacon: false
early post still materialized: true

re-placed beacon (epoch 9, deps = [genesis]) quarantined?: false
same verdict on resident: false
early leased op after the re-placed beacon: {true, :lease_expired}
same on resident: {true, :lease_expired}
early post still materialized: false
```

Three things are established. One, a duplicate epoch is **not** `:stale_beacon` when the carrying
op's ancestry holds no prior beacon, so ancestry-scoped monotonicity is not a replay defence.
Two, the re-placed beacon retroactively lapses a leased op that the first beacon had honored, and
the post drops out of materialized state on every replica. Three, the two replicas agree, so this
is convergent behaviour and not a divergence bug: it is the rule working as written.

Today this costs nothing, because only the root may author a beacon and the op signature covers
`deps`, so nobody else can produce that op. Section 8.2 is about what happens when a certificate in
the body becomes the authorization and any listed witness may be the author. The reproduction was
run root-authored for exactly that reason: it isolates the lapse mechanism from the authorship
question that Plan 179 changes.

### 6.8 A high beacon stops the clock only for its descendants (reproduced)

Added in review round ci-1, because 8.1 previously said a root beacon above the horizon
"permanently ends witnessed advancement" full stop, and that is wider than the rule. `prior_max` is
computed over the candidate op's **own** causal ancestry, so a high beacon constrains only the ops
that carry it.

Setup (`ci1_fork_below_high_beacon.exs`): `Township.Matter`, replica `replica:township:ci1-fork`,
realms clerk (root) and resident. A root beacon at `2^53` on the main history, then a normal
low-epoch beacon built on the resulting frontier, then a low-epoch beacon built with
`Op.new(clerk, replica, [genesis.id], :authority, {:beacon, 5})` and appended to every log.

```text
high beacon (2^53) quarantined?: false
descendant beacon (epoch 5, deps carry the high one): {true, :stale_beacon}
fork beacon (epoch 5, deps = [genesis]): false
same verdict on resident: false
```

Two things are established. One, the lockout is descendant scoped: an op that carries the high
beacon in ancestry is `:stale_beacon` at any lower epoch, while an op on deps that exclude it is
honored at that same epoch, and both replicas agree. Two, the fork is therefore an available move
for a witness set under Plan 179, because the witnesses sign over exactly the `deps` the author
proposes, so a threshold subset can legitimately certify a beacon on a pruned frontier. The claim
that survives is the narrow one: a high beacon ends advancement on the history that carries it, not
on the replica. Plan 179 turns this into a fork test rather than a paragraph.

Note the limit of the analogy. This reproduction is root-authored, so the fork half is available
today only to the root; and section 6.7 is the reason the same pruned-deps move is dangerous when a
body-level certificate becomes the authorization. The two sections describe one mechanism from two
directions: pruned deps buy availability for a legitimate witness set and buy a lifted-certificate
replay for a single witness, which is why Plan 179 binds the claim to `(version, replica, epoch,
author, deps)` rather than trying to forbid pruned deps.

## 7. Options

Decision 1 offers three repair candidates. Option D, the status quo, is added because Plan 175
step 4 names it as a legitimate outcome. In every option an "ancestry-keyed" compatibility arm
(no beacon visible in the op's deps, so fall back to legacy semantics) is unsafe and rejected: the
claimant chooses deps and can simply omit beacons. Only a policy-keyed opt-in arm (a new genesis
policy shape) preserves both safety and byte-identical legacy vectors, following the Plan 145
precedent.

### 7.1 Option A: require a valid root beacon in the succeed op's ancestry whose epoch satisfies the dormancy arithmetic

`at_tick` stays in the body but must be attested by a visible beacon with
`epoch >= last_active + dormant_ticks`.

- What it proves: a designated successor cannot claim a role until the root has published a
  beacon at least `dormant_ticks` beyond the holder's last recorded activity; seizure against an
  active holder requires root cooperation. It does not prove absence (the ADR 0004 caveat
  stands). Heartbeat and transfer ticks stay self-asserted, so a holder can still pin
  `last_active` at 2^64-1 (lockout remains) unless heartbeats are also bounded, which turns A into
  C.
- Cost: `authority.ex` threads beacons into `build_role_timeline/6` and `decide_succeed/8` with a
  new reason (for example `:unattested_succession`); `authority.ts` mirror in
  `successionRejectionReason` plus a beacon input to `RoleState`; `Sim.succeed` must pick deps
  that include the beacon; `compaction_spike.ex` mirror. Vectors: `township_succession_w3` and
  `township_succession_unproven_tick` flip (no beacon in either log), plus
  `succession_genesis_poisoning`, `capability_laundering`, `cross_role_succession_transfer` and
  `rooted_grant_as_genesis` unless a policy arm applies. Tests: both behavior-15 tests,
  `root_binding_test.exs` 267-303, the witnessed legacy controls, the compaction GATE and
  generated property, `export_vectors_test.exs` 225. Effort L, risk HIGH.
- Decision 2 (no beacons): strict makes succession unavailable until a beacon exists and breaks
  every existing log; the policy-keyed legacy arm is the only sound compatibility arm.
- Decision 3: `dormant_ticks` keeps its unit but is compared against beacon epochs, so it silently
  changes meaning unless renamed (`dormant_epochs`) in the opt-in shape; `Township.Matter` line 66
  would need the new DSL atom to benefit.
- Decision 4: root-only beacons make the root a liveness dependency for succession.
- Decision 5: no retroactive repair; a pinned `last_active` stays pinned; roles without a recovery
  policy remain unrecoverable via the legacy path on every history that carries the honored pin
  (6.2a: the designated successor's fork around the pin is the one legacy exit).
- Decision 6: lockstep BEAM and TS change with regenerated vectors in one parity-atomic PR (the
  Plan 158 rule); STOP if conformance diverges.
- Root goes quiet: no beacon after the holder's last activity means no succession can satisfy
  the gate; the role freezes on the current holder. Fail-closed toward the holder, which is the
  opposite of what succession exists for when root and holder are the same person.

### 7.2 Option B: replace `at_tick` with the epoch itself

Succeed, transfer and heartbeat name a beacon epoch that must be visible in their ancestry;
dormancy counts epochs.

- What it proves: every activity and succession timestamp is a reference to a root-signed beacon
  the author had seen, so `last_active` is bounded by beacon epochs and `dormant_ticks` (now
  epochs) measures beacons actually published between the holder's last attested activity and
  the claim. Fixes seizure. It does **not** fix the ceiling lockout, and an earlier draft of this
  document claimed it did. `valid_tick?/1` still admits `2^64-1` (`authority.ex` 466-468),
  `last_active_from/3` still records whatever the honored op carried (988-994), and succession
  still needs a value at or above `last_active + dormant_ticks` (913-919). Section 6.6 reproduces a
  root beacon at `Lattice.Canonical.max_integer/0` being honored, so once such a beacon exists the
  holder may name that epoch, pin `last_active` at the ceiling, and reach exactly today's lockout.
  What B removes is the holder's ability to do it unilaterally: the ceiling lockout becomes
  reachable only with root cooperation, and a root beacon at the ceiling is already terminal for
  every expiring lease and for the clock itself. Removing it outright needs a separate safe ceiling
  or horizon below `max_integer/0`, which is the same bounding device section 8.1 pins for the
  witnessed branch (and which lives above `Lattice.Canonical`, in the judge or the structural layer,
  never in a genesis field), not a consequence of epoch-valued ticks. Still not an absence proof and still
  root-liveness dependent.
- Cost: the largest semantic change. Bodies keep their integer slot (no canonical change) but the
  integer's meaning changes, so every tick-bearing vector and test changes unless the semantics
  are gated by an opt-in policy shape. `authority.ex`: beacons threaded through the whole role
  fold, `decide_heartbeat` and `decide_transfer` gain an epoch-visibility check,
  `decide_succession_proof` compares epochs; `authority.ts` and `compaction_spike.ex` mirrored;
  Sim gains epoch-deriving helpers; exporter scenarios rewritten around `Sim.beacon`. With the
  opt-in policy gate (for example `%{successor, dormant_epochs: n}`), existing legacy vectors
  stay byte-identical and the cost is new vectors plus the gated code paths: still L/HIGH, but the
  back-compat proof is the Plan 149 and Plan 145 "regenerate, diff is empty" shape.
- Decision 2: with the policy gate, a no-beacon replica under a legacy policy keeps today's
  semantics (the hole persists there, labelled); under the new policy succession is unavailable
  until a beacon exists, which is safe by construction (genesis could carry beacon 0).
- Decision 3: yes, dormancy becomes epoch-based and the field should be renamed
  (`dormant_epochs`) rather than reinterpreted; a policy carrying both fields is invalid,
  mirroring the existing `:invalid_recovery_policy` check at `authority.ex` 906.
- Decision 4: the strongest root-liveness dependency of the three (heartbeats also need beacons).
- Decision 5: retroactive repair impossible for legacy logs. Under the new policy a holder cannot
  create the lockout alone, but it is not unreachable: a root beacon at `max_integer/0` restores
  it, so B needs the section 8.1 horizon on top if the claim is to be "no future lockout".
- Decision 6: full lockstep; the opt-in gate keeps conformance green during the transition.
- Root goes quiet: no epochs advance, heartbeats cannot be attested, dormancy cannot accrue,
  succession cannot fire; the role freezes on its holder for as long as the root is silent. This
  is Plan 149's lease trade inverted: leases fail open toward availability, epoch succession
  fails closed toward the incumbent.
- Boundary note: Plan 149's scope note said "no quorum beacons" and placed multi-signer beacons
  beside M6 federation questions. That was scoping of Plan 149, not a milestone boundary; a
  witness set pinned inside one replica's genesis is neither federation nor cross-town identity.

### 7.3 Option C: keep `at_tick` but bound it above by the greatest valid beacon epoch visible in the op's ancestry

For succeed, heartbeat and transfer alike.

- What it proves: no author can assert a tick beyond what the root has beaconed, so seizure needs
  root cooperation and a future 2^64-1 self-transfer is impossible unless the root beacons that
  epoch. That qualifier is load bearing and the 7.5 table originally lost it: section 6.6
  reproduces a root beacon at `max_integer/0` as honored, so C narrows who can create the ceiling
  lockout without removing it, and only an added ceiling or horizon below `max_integer/0` (section
  8.1) would remove it. Between the bound and `last_active` the claimant still picks the number, so dormancy is
  effectively "beacon epochs elapsed" while the integer remains claimant-chosen: a slightly
  weaker, smaller-diff B.
- Cost: the smallest production diff of the three: one predicate in `role_event/3` or the
  `decide_*` fold (with beacons threaded into `build_role_timeline/6`), one reason (for example
  `:unattested_tick`), mirrored in `authority.ts` and `compaction_spike.ex`. Vector and test cost
  equals A if strict (plus the W1/W2 transfer-at-1 vectors and every generator that counts ticks
  without beacons), and is zero if policy-gated.
- Decision 2: strict breaks every existing log; policy-gated is the only safe compatibility arm.
- Decision 3: `dormant_ticks` keeps its name and unit but its practical meaning becomes "beacon
  epochs the root must publish past `last_active`"; `Township.Matter` line 66 keeps compiling but
  the doc must restate what 3 means.
- Decision 4: root-liveness dependency identical to A.
- Decision 5: not retroactive; existing pinned values stay, and a future ceiling pin still follows
  a root beacon at `max_integer/0` unless a horizon is added.
- Decision 6: lockstep; the smallest TS diff of the three.
- Root goes quiet: strict, no beacon visible means the bound is zero, no tick clears dormancy,
  and heartbeats are also refused, so the holder cannot even signal liveness. Policy-gated:
  legacy roles behave as today; opted-in roles freeze as under A.

### 7.4 Option D: keep author-asserted ticks and make the non-claim louder

- What it keeps: ticks exactly as ADR 0004 characterizes them. The interim sentence from Plan
  175's maintenance note ("`after: {:dormant_ticks, n}` means a designated successor may claim
  the role once it asserts a sufficiently large tick, not a time-based control") is added to
  `CLAUDE.md` and `README.md` by the follow-on plan, not by this spike, which may not edit those
  files. `township_succession_unproven_tick` stays as the executable pin. `Township.Matter` line
  66 is either relabelled decorative or moved to the witnessed shape at genesis in a later
  Township plan; under D, `Township.Matter` stays on the legacy unattested semantics indefinitely,
  because Township is outside Plan 179's witnessed-beacon scope.
- Cost: zero production, vector or TS change; no Plan 162 conflict; no Canonical change; the
  Treehouse beta is unaffected because it already pins witnessed succession with dormant-tick
  succession disabled.
- What it leaves: the dormancy gate stays decorative and the 2^64-1 lockout stays reachable on
  every plain `dormant_ticks` role (Township.Matter today), so no Township succession claim may
  grow until a build lands. Policy migration remains open in ADR 0004, but review round ci-2
  corrected what that means: `collect_policies/3` (`authority.ex` 492-507) merges the policies of
  every valid root-authored genesis and later merges win, and the existing
  `township_genesis_projection_parity` exporter scenario
  (`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` 509-608) already shows a second root
  genesis replacing the first policy, so it is not true that a role's policy is fixed at creation.
  What is unreproduced here is whether a witnessed recovery policy added by a later root genesis
  rescues an **already pinned** role; what is certain is that no root genesis, and therefore no such
  repair, is possible once the founder key is gone. Note the scope of that merged map, per review
  round ci-3: it is the replica's current policy map, which is what the role timelines read, and it
  is deliberately not what Plan 179's beacon judge reads, since that judge resolves the beacon policy
  from each candidate beacon's own ancestry instead (section 8).
- Decisions 2, 3, 5 and 6: unchanged from today (no beacons required, `dormant_ticks` keeps its
  unit and its decorative meaning, no lockout repair, no parity work).
- Decision 4: D settles nothing about it, and blocks nothing. AF-2 is about who may advance the
  beacon and hold top-level authority after founder loss, which is independent of decision 1, so
  Plan 177's "AF-2 decision via the Plan 175 spike, then its follow-on build plan" is satisfied by
  a Plan 179 that addresses beacon authorship alone.
- Root goes quiet: no change; the legacy path never consulted the root.

### 7.5 Comparison

| | Seizure fixed | Future lockout fixed | Existing lockout | Root quiet | Vectors changed (strict) | Vectors changed (policy-gated) | Effort / risk |
|---|---|---|---|---|---|---|---|
| A | yes | no (heartbeats still self-asserted) | unrecoverable | role freezes | 6 plus the six transfer vectors | 0 plus new | L / HIGH |
| B | yes | no at the ceiling: a root beacon at `max_integer/0` restores it (6.6). Fixed below the ceiling | unrecoverable | role freezes, heartbeats too | all tick-bearing | 0 plus new | L / HIGH |
| C | yes | no at the ceiling, same as B | unrecoverable | role freezes, heartbeats too | 6 plus W1/W2 plus the six transfer vectors | 0 plus new | L (smallest) / HIGH |
| D | no | no | unrecoverable | n/a | 0 | 0 | none |

The "existing lockout" cells read with the 6.2a qualification added by Plan 179 step 1:
unrecoverable on every history that carries the honored pin, and escapable by the designated
successor's fork around it, which is a property of author-chosen deps that none of the four options
evaluates.

The B and C cells in the "future lockout" column read "yes" in the first two drafts of this
document. That was wrong: neither option adds a ceiling below `Lattice.Canonical.max_integer/0`,
and section 6.6 shows a root beacon at that value is honored, so both leave the ceiling lockout
reachable with root cooperation. They narrow the actor set from "the holder alone" to "the holder
plus a root beacon at the ceiling", which is a real improvement and is not what "fixed" means. A
genuine fix needs the separate safe ceiling or horizon of section 8.1, and that device sits above
`Lattice.Canonical` (in the beacon judge, or in the structural layer that runs before it), so it is
compatible with the `Lattice.Canonical` STOP condition.

The strict vector counts also carry the six transfer-tick vectors added to section 5.2 in review
round 2. The repair columns only matter for roles that use plain `dormant_ticks`, which the
Treehouse beta does not. The "root quiet" column is the same for every repair and is the
founder-loss case.

## 8. Decision 4 and AF-2 founder loss

Plan 177 AF-2: "The founder's device is destroyed. The group can still admit a member, revoke a
delegation and advance the beacon." Today it fails by design (Plan 158 line 56-60, Plan 177 lines
122-128, Plan 178 contract section "Founder loss"). Three candidate beacon emitters:

1. **Root-only (status quo).** Section 6.5 confirms it. AF-2 fails, and every repair in section 7
   makes it worse: succession dies with the root. Nothing to build; it stays the default until a
   witness policy is pinned.
2. **A witness set with threshold pinned at genesis.** A genesis beacon policy names distinct
   witness keys and a threshold; a beacon body variant carries a domain-separated threshold
   certificate binding the claim to this replica and this epoch, and is honored with the same
   monotonicity and quarantine reasons as a root beacon. "Pinned at genesis" names the authority,
   not a one-shot moment: the policy is conferred only by a genesis op authored by the replica root,
   which `collect_policies/3` (`authority.ex` 492-507) already lets the root reissue, merging every
   valid root-authored genesis so a later one may add or replace the entry, while no witness, holder
   or member can change it and no root genesis is possible at all once the founder key is gone
   (review round ci-2; the existing `township_genesis_projection_parity` exporter scenario at
   `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` 509-608 is the demonstration).
   Review round ci-3 added the consequence for the judge, because that global fold is not what a
   beacon may be judged against: `collect_policies/3` merges every valid genesis in the whole
   topological order with no ancestry filter and merges before validating, so handing its result to
   the beacon judge would judge a beacon that predates a replacement, or forks around it, under the
   final policy, and would let an invalid replacement overwrite a prior valid value. Plan 179
   therefore resolves the beacon policy per candidate beacon, as the latest **valid** `:__beacon__`
   among the genesis ops in that candidate's own causal ancestry, folded in the shared topological
   order and validated before each replacement. The global fold is unchanged and keeps feeding every
   role timeline; the ancestry-scoped resolution is a beacon-judge concern only.
   This is the candidate proposed for testing post-founder-loss beacon advancement. It claims
   nothing until Plan 179's founder-removed Sim test is green and merged; no design argument on
   this page is evidence that founder loss is survived. It is not key rotation or recovery: the
   root key stays dead, nothing is re-signed, no new root-equivalent authority is minted, so it is
   inside the beta boundary provided the operator accepts a new body variant of the existing
   `:authority` kind (Plan 177's "no new op kinds"
   non-goal is respected: same kind, new body). It is the same governance shape Treehouse already
   pins for succession, so it composes with the frozen contract. It follows the
   [`SuccessionCertificate`](../../apps/lattice_core/lib/lattice/authority/succession_certificate.ex)
   pattern in both runtimes without reusing that module: review round 2 confirmed its
   `normalize_policy/1` hard-guards `map_size(policy) == 4` and its `@type claim` is
   succession-shaped (`role`, `holder`, `holder_epoch`, `successor`, `policy_id`), while a beacon
   policy carries five keys and a beacon claim is `(version, replica, epoch, author, deps)`. What is
   genuinely shareable is the domain-separated hashing shape, Ed25519 signature verification and
   threshold and duplicate-signer counting; policy normalization and the claim shape are
   duplicated. Plan 179 therefore adds a sibling module with its own two domain separators. This is the recommended build, subject to the two
   unresolved design questions in 8.1 and 8.2, which Plan 179 must settle before its step 3.
3. **Delegated root powers through a capability** (a delegation or role conferring `:beacon`).
   Would advance the epoch after founder loss only if that role's own succession is witnessed; a
   single delegated key becomes the clock, and if that role's succession were ever epoch-based the
   clock and its keeper would deadlock after founder loss. Rejected for the beta as a strictly more
   fragile version of option 2.

### 8.1 What the beacon power actually is, and the bound candidate 2 needs

Section 6.6 is the correction to a sentence this document carried in its first draft and Plan 179
carried in its non-goals: that a beacon confers epoch advancement "and nothing else, no operation
authority, no semantic authority, no role". The first half is true and the gloss is false. Epoch
advancement is the sole driver of Plan 149 lease lapse in both runtimes (`expired_as_of?/5` at
`authority.ex` 1238-1248, `capability.ts` line 130), so whoever may advance the epoch may expire
every leased delegation on the replica, and section 6.6 shows a single beacon at the canonical
ceiling expires all of them permanently while stopping the clock for every op that carries that
beacon in its ancestry. Section 6.8 pins that scope: a beacon on `deps` that fork from before the
high one is still honored, so the lockout is descendant scoped rather than replica wide.

Under root-only beacons that power is not new: the root already holds issuer-side revocation and
already chooses whether to beacon at all, so nothing is widened. Candidate 2 does widen it. A
threshold subset of the pinned witnesses is chosen for clock continuity after founder loss, and
under the naive design it silently receives mass lease revocation and a one-shot permanent clock
kill as well. That is precisely the "partitioned or colluding witness set" case, and neither this
document's first draft nor Plan 179's first draft addressed it.

The response, pinned here so Plan 179 does not have to choose, is **two** bounds enforced in the
judge's policy layer for the witnessed body variant. Review round 2 found that a single per-step
bound is not enough, for two separate reasons. Review round ci-1 added the distinction the first
draft blurred: the two bounds are not the same kind of thing. `max_epoch_step` is a **genesis-pinned
policy field**, the fifth and last key of the beacon policy, chosen per replica by the root in a
genesis op. The absolute horizon is a **fixed protocol constant**, a module attribute on the BEAM
mirrored by an exported `const` in TypeScript whose value is `Number.MAX_SAFE_INTEGER`, identical
for every replica, not configurable, and not expressible at genesis: a beacon policy carrying a
sixth key, including one attempting to pin its own horizon, fails closed. Nothing in the log can
raise or lower the horizon.

First, a per-step bound that admits any positive value is vacuous. `Lattice.Canonical.max_integer/0`
is positive, so a genesis pinning `max_epoch_step` at `2^64-1` would validate and one witnessed
beacon would reach the ceiling, reproducing everything above under a policy the plan's own done
criteria would call bounded. So the step needs its own pinned ceiling, and Plan 179 fixes it at
`1..65_535`: a witness set exists to keep a clock running, not to fast-forward it, and a group that
needs a larger jump can beacon twice.

Second, a per-step bound does not bound the total. Repeated legitimate increments accumulate, so
the ceiling stays reachable in principle after enough steps. Plan 179 therefore also pins an
absolute witnessed-epoch horizon at `9_007_199_254_740_991` (`2^53-1`), above which a witnessed
beacon is refused regardless of the step. That number is deliberate: it is
`Number.MAX_SAFE_INTEGER`, so on the witnessed branch the two runtimes accept exactly the same
range.

The two bounds are enforced at two different layers, and review round ci-3 pinned which, because an
earlier draft of this paragraph put both in one layer and cited the wrong TypeScript sites.
`max_epoch_step` is a value the beacon judge reads from the resolved beacon policy, and an epoch
above `prior_max + max_epoch_step` is `:unauthorized_beacon`. The horizon is not read from anywhere:
it is a compiled-in constant, and an epoch above it, in the witnessed beacon body or in its
certificate claim, is refused **structurally, before the judge runs**, with the reason
`:malformed_term` in both runtimes. That is the only contract the two runtimes can actually both
reach. In TypeScript an integer term above `Number.MAX_SAFE_INTEGER` already throws inside
`parseCarrierInteger` ([`carrier.ts`](../../clients/lattice-client/src/carrier.ts) 2117-2133) while
`decodeCarrierTerm` is still running, so `carrierOpToSemanticOp` marks the whole op
`structuralError: "malformed_term"` (1215-1219) and
[`materialize.ts`](../../clients/lattice-client/src/materialize.ts) 136-138 writes that reason over
any authority reason; `collectBeacons` never sees the op, because it carries no beacon evidence to
match. The BEAM has the mirror machinery already, and the comment above `malformed_tick_ops/1`
([`authority.ex`](../../apps/lattice_core/lib/lattice/authority.ex) 470-487) states the rule in the
same terms: the TypeScript decoder refuses a non-canonical integer before it consults any schema, so
the BEAM must quarantine `:malformed_term` structurally or the two runtimes diverge. Plan 179
therefore extends that existing fold with a clause for the witnessed body rather than adding a
horizon check inside the judge, and it widens no TypeScript decoder to carry a value no honored op
may hold. An earlier draft cited `nonNegativeInteger` (1870-1871) and the beacon body decode
(1500-1511) as the refusing sites; both read an already decoded term, so neither ever sees such a
value. Without the horizon, `max_epoch_step` and the witnessed epoch could both take BEAM-honored
values that TypeScript refuses as a malformed carrier op, and no vector would expose the divergence
because the exporter emits no such value today; Plan 179 adds one that does,
`township_beacon_witnessed_horizon`. This is a rule about one new body variant, not a bound on what
`Lattice.Canonical` admits, so it does not touch the Plan 175 STOP condition and it does not close
section 4's general format question, which stays open and deferred for every other integer,
including the root beacon body, whose range gap this changes nothing about.

Three residual facts belong here rather than in a footnote, because an earlier draft of this
paragraph overstated the protection.

- **Nothing quarantines a valid witnessed beacon.** The draft said reaching the ceiling would need
  "a long, visible, individually quarantinable sequence". That is false: `classify_beacon/6`
  (`authority.ex` 734-748) has exactly two rejection reasons, author and monotonicity, so a valid
  beacon is honored and there is no per-beacon veto anyone can exercise. The only protections are
  the arithmetic (with the horizon, the ceiling is unreachable on the witnessed branch at any step
  size) and the visibility of the sequence in the log.
- **The horizon is reachable, just bounded, and exhausting it is descendant scoped too.** At the
  maximum pinned step it takes on the order of `1.4e11` successive threshold-signed beacons to
  exhaust it. That is a number, not an impossibility. Review round ci-3 narrowed what happens next:
  an earlier draft said the witnessed clock then stops for the life of the replica, and that is
  wider than the rule, for exactly the reason the root case below is. `classify_beacon/6` computes
  `prior_max` over the candidate op's own ancestry, so once a witnessed beacon is honored at
  `2^53-1`, advancement ends **for every op that carries that beacon in its ancestry**, while a
  witnessed beacon whose `deps` fork from before it sees a lower `prior_max` and is honored at a
  lower epoch, on every replica, exactly as section 6.8 reproduces for a high root beacon. The
  witness set can legitimately sign a certificate over those forked deps, since it signs the `deps`
  the author proposes. Plan 179 carries this as the second arm of its fork test.
- **The root can still stop the witnessed clock on the history that carries it.** The root branch
  keeps today's bytes and today's unbounded behaviour, or `township_beacon_unauthorized.json` and
  the four lease vectors move. So a root beacon above the horizon, or at the canonical ceiling,
  ends witnessed advancement for every op that carries that beacon in its causal ancestry, which is
  every op built on the frontier after it. Review round ci-1 corrected the earlier "permanently ends
  witnessed advancement" full stop: the lockout is descendant scoped, not global, because
  `classify_beacon/6` computes `prior_max` over the candidate op's own ancestry, so a witnessed
  beacon whose `deps` fork off before the high root beacon sees a low `prior_max` and is honored
  below the horizon, and the witness set can legitimately sign a certificate over those exact deps.
  Section 6.8 reproduces it: after a root beacon at `2^53`, a descendant beacon at epoch 5 is
  `:stale_beacon` and a fork beacon at epoch 5 with `deps` pruned to genesis is honored, on every
  replica. Plan 179 makes that a fork test rather than a paragraph. The root power is still the existing one
  section 6.6 records, not a new one, and it is the reason the horizon is a witnessed-branch rule
  rather than a global one.

Within the step bound the witness threshold still lapses every lease whose `expires_epoch` sits
below `prior_max + max_epoch_step`. The bound limits the reach of one beacon; it does not remove
the revocation power, and the product surface still has to say so in the same sentence as the
grant. Neither bound is a log-configurable genesis field: the step is a policy value the beacon
judge reads, the horizon is a compiled-in constant enforced in the structural layer that runs before
the judge, and a genesis carrying a sixth key that tries to pin its own horizon fails closed.
`Lattice.Canonical` is untouched either way and stays frozen under the Plan 175 STOP condition.

### 8.2 Two threshold subsets under partition, and what "the prior beacon" means

The first draft bound the certificate to `(replica, epoch, prior valid beacon op id)`. That phrase
has no referent in the concurrent case. `classify_beacon/6` (`authority.ex` 734-748) computes
`prior_max` as the maximum epoch over valid beacons in the candidate op's **own causal ancestry**,
which is what makes the verdict a pure function of the log and therefore convergent. The
consequence is that two beacons at the same epoch, neither in the other's ancestry, are both valid,
and after a heal the replica holds two valid beacons at the maximum epoch and no single prior id.

This is unreachable today and that is why it was missed: the root is one realm with one log, so its
beacons are totally ordered by its own frontier. Candidate 2 makes it reachable in the first
failure mode a witness set exists for. Two disjoint threshold subsets, partitioned from each other,
each assemble a certificate for the next epoch; each is individually valid; both survive the heal.
An executor implementing "bind to the prior valid beacon id" then has to pick one of two ids, and
if two replicas pick differently the G2 identical-quarantine property breaks, which is a STOP.

**The binding is pinned here, and the simpler shape is rejected.** An earlier draft of this
section offered two admissible shapes and let Plan 179 default to the simpler one, binding the
claim to `(replica, epoch)` only. Review round 2 showed that shape is not merely weaker; it opens a
revocation vector that does not exist today.

The attack. A witnessed certificate is body-level content, and the author rule of Plan 179 step 3
admits any realm in the witness list as the author. With a `(replica, epoch)` binding, one witness
acting alone, well below threshold, copies an already-honored certificate for epoch `E` into a
fresh op whose `deps` exclude the original beacon and exclude the ops it wants to attack.
`classify_beacon/6` (`authority.ex` 734-748) computes `prior_max` over valid beacons in the
candidate op's **own** ancestry, so the re-placed op sees `prior_max` of `-1`, `valid_epoch?/2`
passes, and the beacon is honored a second time. Then `expired_as_of?/5` (`authority.ex`
1238-1248) lapses any op `X` whenever some valid beacon with `epoch > expires` does not carry `X`
in its ancestry, and the re-placed beacon carries almost nothing in its ancestry. Every leased op
that was causally before the original beacon, and was therefore honored on every replica, now
lapses on every replica. Section 6.7 reproduces that lapse half directly: a root-authored second
beacon at the same epoch with `deps` pruned to genesis is honored on every replica and turns an
already-honored leased post into `:lease_expired`, dropping it out of materialized state. Issuing a
fresh certificate needs `t` signatures; lifting an existing one needs one author. A root beacon cannot be re-placed this way, because the op signature covers
`deps` and only the root can sign a root beacon, so this is a new power that arrives with the
witness set. The epoch step bound does not close it: with `prior_max` of `-1` the lifted epoch only
has to satisfy `E <= max_epoch_step - 1`, which any early or moderately spaced epoch does.

So Plan 179 binds the claim to the carrying op's author and dependency list. The claim covers
`(version, replica, epoch, author, deps)`, where `author` is the public key that will author the op
and `deps` is exactly the `deps` that op will hold, and verification is structural equality against
`op.author` and `op.deps`. `Lattice.Op.new/6` already normalizes and sorts deps before signing
(`op.ex` 59, 66), so the list is canonical by construction and no new ordering rule is needed. The
cost is a coordination requirement, the author proposes `(epoch, author, deps)` and the witnesses
sign that exact triple, which is the ordinary shape of any threshold signature over a message.

The `author` field and the narrowed property statement are review round ci-1 corrections. An earlier
draft bound `(version, replica, epoch, deps)` and claimed "a certificate is valid for exactly one
op, because moving it to any other op changes `deps`". That claim was wrong twice. Without the
author field, any realm the author rule admits copies an honored certificate into its own op at the
same epoch over the same deps; the ancestry is identical, `prior_max` is identical,
`valid_epoch?/2` passes, and a second valid beacon is minted without re-acquiring threshold. The
author field closes that. What survives is only the narrow property: **the certificate is bound to
one author and one ancestry, so it cannot be moved to a different author or a different dependency
list.** It is still not unique to one op id, because `Lattice.Op.new/6` hashes `cap` alongside
author, deps, kind and body (`op.ex` 59-66) and the beacon judge never inspects `cap`, so the named
author can still mint duplicate valid beacons at the same epoch over the same deps. That
duplication is permitted and inert rather than closed: identical ancestry and identical epoch means
`expired_as_of?/5` reaches exactly the ops the original reached, so a duplicate confers nothing the
original did not, and its whole cost is log space and audit noise. Plan 179 pins it with a test
(same author, same deps, same epoch, both honored, identical quarantine and materialized state on
every replica) rather than with this sentence, and treats a duplicate that changes the lapse set as
a STOP.

The set-valued alternative, binding to the canonical sorted set of valid maximum-epoch beacon ids
in the op's ancestry, is admissible and convergent, and it defends every certificate issued after
the first valid beacon. It is recorded as the fallback rather than the choice because it has a
residual the deps binding does not: the **first** witnessed beacon on a replica has an empty
prior set, so its certificate can still be re-placed with pruned deps and lapse the ops the
original carried in its ancestry. `(replica, epoch)` alone is rejected outright.

Either admissible shape is convergent, so the concurrent case stays well defined: two disjoint
subsets sign over their own authors' deps, both beacons are valid at the same epoch, and every
replica agrees. That case still has to be a test with `Sim.partition` and `Sim.heal` asserting
identical quarantine sets and byte-identical state on every replica, not a paragraph, and Plan 179
adds a second test for the lift: a listed witness re-publishing a valid certificate with pruned
deps must be `:unauthorized_beacon`, and a lease honored before the original beacon must stay
honored.

### 8.3 The M3 line, the beta claim, and what AF-2 still needs

The M3 line, drawn in words so Plan 177's "top-level grants pinned at genesis" is read correctly:
grants issued at genesis and witness-attested beacons are governance authorization over content
already in the log and are in bounds. Anything that mints new root-equivalent authority after loss
by **issuing to a third party**, re-keying genesis, or re-signing any existing artifact, is key
rotation or recovery, is M3, and stays excluded.

That sentence needed the qualifier, and review round 2 supplied it. An earlier draft wrote
"witnesses issuing top-level grants" as the excluded case, which reads as excluding the mechanism
the AF-2 answer depends on. Witnessed succession, shipped under Plan 145, already mints a
root-less, parent-less, self-issued delegation: `Sim.succeed` builds
`Delegation.new(successor, replica, successor.pub, ops: ..., roles: [role], parent_id: nil)`
(`sim.ex` 128-141), and `decide_succeed/8` (`authority.ex` 892-910) checks only that it is a
succession delegation, that author, audience and issuer are the same key, and that the role is in
its roles. A witness threshold therefore already authorizes one top-level self-issue to the named
successor, and children may chain from it once the op is honored. That is in bounds because the
successor is named in the genesis policy and the grant is to that successor alone, not to a third
party of the witnesses' choosing.

What is **not** bounded, and is recorded here as an open gate rather than as a claim: nothing
checks `d.ops` on that self-issued succession delegation against the predecessor's delegation or
against anything pinned at genesis. `Sim.succeed` defaults to `ops: [:lock, :unlock]` and takes
whatever the caller passes. So the ops a witness-succeeded holder gives itself are chosen by the
successor at succession time, bounded only by what later attenuation checks do to its children. It
is therefore false to say "grants issued at genesis" is what bounds post-loss authority: genesis
bounds **who** may succeed, not **what** the successor may do. Closing that is a change to
`decide_succeed/8`, which is succession semantics, so it is out of Plan 179's scope by
construction and out of Plan 162's by its byte-identical-vector STOP. It is named in Plan 179 as
the next open gate after AF-2, not folded into it.

What the first Treehouse beta can honestly claim: exactly what Plan 178 already pins. Founder
loss is not survived today; manual admin transfer is the only handoff the first beta claims. This
document changes nothing in that sentence, and `contract_test.exs` keeps it pinned until AF-2
passes in a merged build.

**AF-2's "revoke a delegation" clause is narrower than its words, and this document has to say so.**
Plan 177 line 121-122 defines AF-2 as "The group can still admit a member, revoke a delegation and
advance the beacon", with no qualifier. The live rule is `revoke_authorized?/4` (`authority.ex`
705): a revoke is honored iff `author == d.issuer or author == root`. Once the founder realm is
gone, nobody can satisfy either arm for any delegation the founder issued, and that includes the
genesis-time top-level grants this whole design leans on. So after founder loss:

- Every **founder-issued** delegation is irrevocable. A surviving member's revoke of one is
  `:unauthorized_revoke` (`authority.ex` 687-689) on every replica, and stays so forever.
- The only post-loss exit for a founder-issued grant is a witnessed epoch advance past its
  `expires_epoch`, which is the mass-lapse power of section 6.6 and works **only if the grant was
  leased**. `Sim.grant` defaults `expires_epoch` to `nil` (`sim.ex` 90-97), so the ordinary genesis
  grant shape is unleased and therefore permanent.
- A group that wants to be able to remove a founder-granted member after founder loss must lease
  every founder-issued grant at genesis. That is a genesis-time decision with no later repair,
  exactly like the beacon witness set itself.

What AF-2 can honestly prove with existing mechanisms is therefore issuer-side revocation of
delegations whose issuer survives, plus lease lapse for leased founder-issued grants. The hostile
member holding an unleased founder grant is **not** addressed, and no sentence in this document or
Plan 179 may imply otherwise. Whether that is acceptable for the first beta is a product decision;
if it is not, it is the next open gate after AF-2 and not something the witnessed beacon fixes.

What AF-2 needs before it can pass: (a) the witnessed beacon policy and body variant from
candidate 2, with 8.1's two epoch bounds and 8.2's pinned prior binding, honored in both runtimes
with Sim-exported vectors; (b) a Sim test in which the founder realm is removed from the simulation
and the remaining members admit a member, revoke a delegation and advance the beacon, compared
byte-for-byte across replicas; (c) the "admit" and "revoke" clauses proven with existing mechanisms
only, an admin role with delegable admission ops granted at genesis, issuer-side revocation of a
delegation whose issuer survives, and witnessed succession of the admin role, with no new op kinds,
plus a negative control showing a surviving member's revoke of a founder-issued delegation is
`:unauthorized_revoke` on every replica; (d) a partition and heal test in
which two disjoint threshold subsets beacon concurrently at the same epoch and every replica still
agrees on the quarantine set and materializes byte-identically, since that is the failure mode a
witness set exists for and it is the one the naive design gets wrong; (e) the Plan 178 contract
sentence updated by its own plan after (a) to (d) are green, never before.

## 9. The six decisions answered

1. **What attests a tick?** Nothing new for now. The tick stays author-asserted and characterized
   as untrusted (option D). If Township ever needs automatic dormancy, the designated shape is
   policy-gated option B: an opt-in genesis policy such as `%{successor, dormant_epochs: n}` that
   compares beacon epochs and leaves every plain `dormant_ticks` vector byte-identical.
2. **A replica with no beacons?** Unchanged for legacy policies. For any future opt-in policy,
   succession is unavailable until a beacon exists; ancestry-keyed fallbacks are rejected because
   the claimant controls deps.
3. **Does dormancy become epoch-based?** Not now. `dormant_ticks` keeps its name and unit and is
   documented as decorative. Any future epoch-based policy uses a new field name
   (`dormant_epochs`) rather than reinterpreting the old one; both fields on one policy is invalid.
4. **Who must emit beacons?** Root-only stays the default. Plan 179 builds a witness set with
   threshold pinned at genesis as the only in-bounds candidate for advancing the epoch once the
   root key is gone; whether it does so is what Plan 179's founder-removed Sim test is for, and
   nothing here claims it in advance. Delegated single-key beacon power is rejected for the beta.
   Frequency is a policy question for the beacon holder and is not fixed here. A beacon confers no
   operation authority and no role, but section 6.6 and 8.1 correct the rest of that sentence: epoch
   advancement lapses every expiring lease on the replica, so it is a revocation power, and at the
   canonical ceiling it is a permanent one that also stops the clock on every history that carries
   that beacon in ancestry (section 6.8 shows the lockout is descendant scoped, not replica wide).
   Plan 179 therefore pins two bounds on the witnessed branch, not one, and they differ in kind: a
   genesis-pinned policy field `max_epoch_step` constrained to `1..65_535`, so a policy admitting
   `max_integer/0` cannot validate and make the bound vacuous, and an absolute witnessed-epoch
   horizon at `9_007_199_254_740_991` (`2^53-1`) that is a fixed protocol constant in both runtimes
   rather than a policy field, so accumulated steps cannot reach the canonical ceiling and the two
   runtimes accept the same range on the witnessed branch. They also enforce the two bounds at two
   layers, which review round ci-3 pinned: the step in the beacon judge as `:unauthorized_beacon`,
   the horizon structurally before the judge as `:malformed_term`, which is the verdict TypeScript
   already produces for such a term and so the contract neither runtime can drift from. Neither bound removes the revocation power inside the step, so the product
   surface must still say in the same words as the grant that a threshold of witnesses may expire
   every leased delegation whose `expires_epoch` is below the next admissible epoch. Section 8.1
   records the three residuals: no mechanism quarantines a valid witnessed beacon, the horizon is
   bounded rather than unreachable, and the unbounded root branch can still stop the witnessed
   clock. AF-2's "revoke a delegation" clause is also narrower than its words: after founder loss
   every founder-issued delegation is irrevocable under `revoke_authorized?/4`, so the clause
   covers only delegations whose issuer survives, plus leased founder grants that a witnessed
   epoch can lapse (section 8.3).
5. **How is an existing 2^64-1 lockout repaired?** Not by any option here; none of A, B, C or D is
   retroactive. A role with a plain `dormant_ticks` policy and no recovery policy that has been
   pinned is unrecoverable via the legacy path, for the life of the replica, on every history that
   carries the honored pin; the designated successor's fork around the pin is the one legacy exit
   (6.2a, Plan 179 step 1). Review round ci-2
   removed a wrong second half of this answer: it previously said the role "cannot adopt a witnessed
   policy afterwards" because policy migration is open. The live fold says otherwise.
   `collect_policies/3` (`authority.ex` 492-507) merges the policies of every valid root-authored
   genesis, later merges win, and `township_genesis_projection_parity`
   (`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` 509-608) demonstrates a second root
   genesis replacing the first policy. So a live root key can replace a role's policy, and whether
   doing so rescues an already pinned role is an open question this spike did not reproduce. What
   that fold is, exactly, matters for Plan 179 and review round ci-3 pinned it: the merge is global
   and unvalidated, over every valid root genesis in topological order, so it answers "what is the
   replica's current policy map" and nothing else. Plan 179's beacon judge does not read it; it
   resolves the latest **valid** `:__beacon__` in each candidate beacon's own ancestry, so a beacon
   that predates a replacement or forks around it keeps the earlier policy and an invalid replacement
   leaves the prior valid one in force. The
   witnessed arm of `decide_succession_proof/7` never consults dormancy (section 6.3), but that was
   reproduced with the recovery policy present at genesis, not added later. Say the certain part
   plainly: the legacy path itself offers no repair, its known exits are a voluntary transfer by the
   pinning holder or a new replica, and once the founder key is gone no policy replacement is
   possible at all. Do not build around it.
   The same ceiling exists on the beacon epoch and section 6.6 reproduces it: one beacon at
   `2^64-1` lapses every expiring lease, makes every later lease dead on arrival unless it expires
   at exactly the ceiling, and renders `:stale_beacon` every subsequent beacon carrying it in
   ancestry, since `2^64` cannot be authored (section 6.8: descendant scoped, not replica wide). That variant is likewise unrepairable after the fact and likewise
   out of reach of any fix that respects the `Lattice.Canonical` STOP condition. The difference is
   who can reach it: root-only today, which adds no power the root lacks, versus any threshold
   witness subset under Plan 179, which is why 8.1 pins two bounds on the witnessed branch, the
   genesis-pinned `1..65_535` `max_epoch_step` policy field and the fixed `2^53-1` protocol
   constant, and states the three residuals they do not remove.
6. **BEAM and TypeScript parity cost?** Zero for option D, and portable-input parity is already
   exact today (section 4 records the one range caveat: TypeScript stops at 2^53-1 where the BEAM
   accepts 2^64-1, which is deferred format work, not a rule divergence). For Plan 179's witnessed
   beacon: `collect_beacons/3` and `classify_beacon/6` in `authority.ex` plus `collectBeacons` in
   `authority.ts` gain a witnessed arm (`collect_beacons/3` becoming `collect_beacons/4`, whose new
   argument is the ordered beacon-policy sources rather than one merged policy, so each candidate
   beacon is judged under the policy in force at its own causal position), the policy **decoder** in `carrier.ts` (1684-1693) and the
   production policy **encoder** and its authoring type in `township.ts` (381-397 and 40-43, reached
   from `authorTownshipGenesis` at 210) gain the beacon policy, `codec.ts` gains an exported
   beacon-claim canonical-bytes function beside the succession one at 206-221 because that
   function's separator, claim shape and encoders are fixed and private (both added in review round
   ci-2, so a TypeScript client can author a witness set rather than only replay one, and so the
   claim preimage is not reimplemented in `authority.ts`), the beacon body decoder in `carrier.ts`
   (1496-1511) and the `AuthorityEvidence` beacon arm in `op.ts` (line 124) gain the certificate,
   `Lattice.Log.known_dump_policy_atoms/0` (`log.ex` 276-302) gains every new policy and
   certificate atom or `Log.restore/1` fails `:unsafe_dump` on a freshly booted VM, `conformance.ts`
   gains the new vectors, and the change lands in one parity-atomic PR with regenerated vectors,
   with conformance divergence a STOP.

## 10. Treehouse alignment

Plan 158 "Treehouse Domain and Cross-Runtime Parity" (lines 721-779) pins that role transfer,
revocation, succession and stale-holder refusal use existing authority semantics, that Treehouse
pins witnessed succession in genesis including witness set and threshold, that dormant-tick
succession is not enabled, and that the first beta device gate exercises manual role transfer only
with the witnessed ceremony hidden. Plan 178's frozen contract "Founder loss" section, pinned
verbatim by `contract_test.exs` lines 95 and 121, states founder loss is not survived and routes
the AF-2 decision here.

What the recommendation changes for that build: nothing in succession semantics. Options A, B and
C all leave the witnessed clause of `decide_succession_proof/7` (`authority.ex` 930-956, records
`at_tick` 0) untouched, and option D changes no code at all, so Treehouse's succession path and
its vectors are unaffected under any outcome. The only Treehouse-visible effect of Plan 179 is an
added genesis policy entry (the beacon witness set), which the Treehouse genesis may adopt in a
later slice; it does not enable dormant-tick succession, and Treehouse's admin role already has the
witnessed succession that any beacon-holding role requires. Treehouse leases (Plan 149) and the
AF-2 gate need a beacon emitter that can advance the epoch once the root key is gone, and that is
what Plan 179 proposes to build and to test.

## 11. Follow-on plan

`plans/179-witnessed-beacons-af2-founder-loss.md` is the follow-on. It is two pieces of work under
one plan number, and they are deliberately not one pull request.

Piece one is the documentation obligation that Plan 175 step 5 attaches to a "do not change it"
decision, and it is the "much smaller documentation plan" that step 5 describes. Plan 175's
maintenance note says the non-claim sentence "belongs in `CLAUDE.md` regardless of what this spike
decides", so it must not be held hostage to an L-effort, HIGH-risk build. It is Plan 179 step 1, it
is S effort and code free, and Plan 179 requires it to merge on its own before the build starts;
the parity-atomic rule applies to steps 2 onward. It is filed inside Plan 179 rather than as its
own README row because this spike may add exactly one row to `plans/README.md`. Its two items:

- add the non-claim sentence to `CLAUDE.md` (beside the DSL line, currently line 160) and to
  `README.md`: "`after: {:dormant_ticks, n}` means a designated successor may claim the role once
  it asserts a sufficiently large tick, not a time-based control", keeping the
  `TOWNSHIP_BUILD_MAP.md` rows that tests pin untouched;
- reconsider `Township.Matter` line 66: either relabel the clerk policy as decorative in its
  moduledoc or move it to the witnessed shape at genesis in a later Township plan; under this
  spike's decision it remains on legacy unattested semantics until that plan.

Piece two is the build, because decision 4 needs code and Plan 177 requires "its follow-on build
plan" for AF-2: a genesis beacon policy (distinct witness keys, threshold, version, and the
genesis-pinned `1..65_535` `max_epoch_step` from 8.1, with the `2^53-1` horizon a fixed protocol
constant rather than a sixth policy key, and enforced structurally rather than in the judge) under a
reserved policy key validated by its own shape and no schema context, so that `analyze/2` and the
live-path `expired?/2` build the identical beacon-policy sources from the same log and resolve the
identical policy for every op; a witnessed beacon body variant of the existing `:authority` kind, the
three-element `{:beacon, epoch, certificate}`, carrying a domain-separated threshold certificate
bound to the op's `author` and `deps` per 8.2; honored by
`collect_beacons/4` and `collectBeacons` with the same `:unauthorized_beacon` and `:stale_beacon`
reasons, and the same structural `:malformed_term` verdict above the horizon; root-only kept as the default; delegated beacon power rejected; an AF-2 Sim test that
removes the founder and still admits, revokes and advances, with a witness-partition and heal case;
parity proved in both directions rather than only by BEAM-generated vectors, which means the
TypeScript **authoring** path is in scope too (the `township.ts` genesis policy encoder and its
type, an exported beacon-claim canonical-bytes function in `codec.ts`, and the
`test/township_authoring.ts` gate) with a canonical payload parity assertion that BEAM bytes equal
TypeScript bytes; the compaction GATE extended with a witnessed beacon and a lease whose
`expires_epoch` straddles the frontier, because the GATE as it stands names no beacon or lease at
all and so cannot go red; the two claim-boundary documents ADR 0004 and
`docs/lattice_poc_status.md` updated per the Plan 145 precedent; and regenerated vectors in one
parity-atomic PR. Effort L, risk HIGH, dependencies Plans 145, 149, 162, 177 and 178. STOP
conditions: any change to `Lattice.Canonical`'s integer bound; any
change to the three Plan 162 succession vectors, to `township_beacon_unauthorized.json` or to the
four lease vectors; any witness-minted top-level grant or genesis re-signing (M3); conformance
divergence; any doc sentence claiming founder loss is survived before the AF-2 test is green and
merged.

## 12. Non-claims

- No founder-loss safety is claimed. Founder loss is not survived today; the Plan 178 sentence
  stays true at merge time and until Plan 179's AF-2 test is green.
- No absence proof. Neither a beacon nor a witnessed certificate proves that a holder is absent,
  offline or unwilling; they prove that configured keys signed one exact claim.
- No live clock. No option reads a wall clock, a process clock or carrier connection state; the
  only admissible clock is root-signed (or, after Plan 179, witness-signed) content in the log.
- No production compaction. The compaction mirror is cited only as a parity cost.
- No M3. No key rotation, recovery, E2EE, re-keying of genesis or witness-minted root authority is
  proposed; a dead root key stays dead.
- No M6. A witness set pinned inside one replica's genesis is not federation, cross-town identity
  or a universal tally.
- No coercion resistance. `Lattice.Attestation.Stub` stays frozen and false; nothing here touches
  W4 or `Township.Election`.
- No claim that a beacon is powerless. Section 6.6 and 8.1 withdraw the first draft's "no semantic
  authority beyond epoch advancement" gloss: epoch advancement is the sole driver of Plan 149 lease
  lapse, so a beacon emitter can expire every expiring delegation on the replica, and one beacon at
  the canonical ceiling does it permanently while stopping the clock for every op that carries that
  beacon in its ancestry, though not on a fork whose `deps` exclude it (sections 6.8 and 8.1).
  Under root-only beacons that is not a new power. Plan 179 widens it, bounds it with the two genesis-policy rules
  of section 8.1, and still has to grant the remaining power in words: inside the step, a threshold
  of witnesses may expire every leased delegation whose `expires_epoch` is below the next
  admissible epoch.
- No claim that founder-issued delegations can be revoked after founder loss. `revoke_authorized?/4`
  honors a revoke only from the delegation issuer or the replica root, so once the founder realm is
  gone every delegation it issued is permanently irrevocable, and a surviving member's revoke of one
  is `:unauthorized_revoke` on every replica. AF-2's "revoke a delegation" clause covers only
  delegations whose issuer survives, plus leased founder grants that a witnessed epoch advance can
  lapse. An unleased founder grant to a member who later turns hostile has no exit under these
  semantics (section 8.3).
- No claim that genesis bounds what a witnessed successor may grant itself. `decide_succeed/8`
  checks the successor's identity and role, never the `ops` on the root-less delegation the
  successor self-issues, so those ops are chosen at succession time. Genesis bounds who may
  succeed, not what the successor may do. That is a recorded open gate, not something Plan 179
  closes (section 8.3).
- No claim that a valid witnessed beacon can be individually refused. `classify_beacon/6` has
  exactly two rejection reasons, author and monotonicity; nothing quarantines a beacon that passes
  them. The epoch bounds Plan 179 pins are arithmetic, not a veto, the `2^53-1` horizon is
  reachable in principle after roughly `1.4e11` maximum-size steps rather than unreachable, and the
  unbounded root branch can still stop the witnessed clock on every op that carries its high beacon
  in ancestry, though not on a fork whose deps exclude it. The same scoping applies once the
  witnessed branch itself reaches the horizon: advancement ends for that beacon's descendants, not
  for the life of the replica (section 8.1).
- No claim that a witnessed certificate is usable in exactly one operation. Section 8.2 withdraws
  that sentence from an earlier draft. Binding the claim to `(version, replica, epoch, author,
  deps)` stops a certificate being moved to a different author or a different ancestry; it does not
  make the certificate unique to one op id, because `Lattice.Op.new/6` also hashes `cap`, which the
  beacon judge never inspects. The named author may therefore mint duplicate valid beacons at the
  same epoch over the same deps. Those duplicates are inert (identical ancestry and epoch, so
  `expired_as_of?/5` reaches exactly the same ops) and cost log space and audit noise, and Plan 179
  pins that with a test rather than claiming it.
- No claim that the reserved beacon-policy key is checked against the replica's declared roles.
  `Lattice.Authority.expired?/2` receives a log and a delegation id and no schema, so a
  module-dependent policy rejection is not reproducible in both beacon consumers. Plan 179 validates
  the policy by its own shape alone, and records as a separate open gate that `decide_succeed/8`
  reads `policy.successor` on any non-nil role policy without a shape guard, a pre-existing hazard
  under Plan 162's byte-identical-vector STOP that this work neither creates nor repairs.
- No full-range cross-runtime parity. Section 4 records that TypeScript accepts integers only up to
  2^53-1 where the BEAM accepts 2^64-1, so both ceiling states in this document are BEAM-reachable
  and TypeScript-undecodable. That is `plans/README.md` 939-946 deferred format work, it is not
  reopened here, and it bounds what a vector could ever certify about sections 6.2 and 6.6.
- No `Lattice.Canonical` change. Every option and the follow-on keep the uint64 integer bound.
- Hosting: this document proposes no relay or host. If Plan 179 names a member-operated relay or
  a witness device that serves the log, that sentence must name who can read (the device, its OS
  and administrator, its backups and every admitted transport peer) and who can withhold
  availability (the host), per Plan 177 D1; nothing is "nothing hosted" or "serverless".
