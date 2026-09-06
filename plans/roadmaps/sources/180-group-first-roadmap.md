# Plan 180: Group-first roadmap (from the corrected map to a Treehouse pilot)

## Status

DRAFT program roadmap. It schedules existing plans and names the new ones; it changes no code
and no operator decision. Not a product, security, availability, E2EE, founder-loss or
centerless-operation claim.

- **Priority**: P0 (program direction).
- **Effort**: S for this file. Every chunk below carries its own size.
- **Depends on**: `plans/158-real-device-beta-poc-program-map.md` (the map),
  `plans/177-group-first-antifragile-reaim.md` (the re-aim and the AF gates),
  `plans/178-treehouse-contract-correction.md` (the frozen contract),
  `plans/179-witnessed-beacons-af2-founder-loss.md` (the AF-2 build) and
  `docs/research/succession_tick_provenance.md` (the AF-2 decision record).
- **Planned at**: `origin/main` `af84459b`, 2026-09-04. `gh pr list` showed no open PRs at
  read time; refresh it before opening this PR. The working checkout
  `claude/lucid-cerf-6af5a8` (`9601f146`) is 51 commits behind and was not used as the baseline;
  every fact below was read from `origin/main`.
- **Lands with**: this file, `plans/180-group-first-roadmap.html` (a lossy one-page summary of
  this roadmap; this file is the full text) and one appended row in `plans/README.md` (proposed text at the end of this file).
  Open the PR from a fresh branch at `origin/main`, not from the stale checkout.

## Destination

Plan 177's intention, made checkable. "There" is all six of these, each with evidence in the tree:

| Gate | What must be true | Today (`af84459b`) |
| --- | --- | --- |
| E1 Treehouse on phones | A signed Android candidate passes the Plan 158 physical gate on two unrelated phones and one 9 to 15 person community runs the two-week pilot | contract frozen and pinned; no domain, realm, shell, device evidence or pilot |
| E2 Three loss gates | AF-1, AF-2 and AF-3 each have a merged green `Lattice.Sim` loss test mirrored in both runtimes, and AF-1 has a user-facing reseed path | AF-1 green (`relay_reseed_test.exs`); AF-2 fails by design (Plan 179 step 1 merged, steps 2 to 9 open); AF-3 has no design |
| E3 Toolshed as a module | The Plan 158 isolation contract carries the operator countersign; custody v2 is green in both runtimes; the custody ledger read model renders facts only (D2) with a subject-present presentation flow | countersign absent; custody v1 only; `read_model.ex` reads one Tool log |
| E4 Rollover (D3) | The instrument measures per-thread ops, bytes and cold-open time against 4,000 / 8 MiB / 5 s and offers `archive thread` plus `create thread` | policy only; the frozen vocabulary has no `archive thread` |
| E5 Honest copy (D1) | Every hosting sentence names who can read and who can withhold; no founder-loss claim precedes AF-2; the ledgers say what merged | one-pager corrected; Plan 158 still carries the superseded order; README rows 152, 158, 177 stale |
| E6 Member-operated relay | Plan 150 host mode exists as a privacy option with D1 copy, without LAN discovery | Plan 150 TODO; Plan 152 says BLOCKED rather than superseded |

Outside "there", by the `CLAUDE.md` boundary and Plan 177: federation and cross-space identity
(M6), key rotation, recovery and E2EE (M3), production compaction, coercion-resistant elections
(`Lattice.Attestation.Stub` stays frozen and false), Township B waves and iOS (Wave E) until E1 holds.

## Where main stands (2026-09-04)

| Area | State on `af84459b` | Evidence |
| --- | --- | --- |
| Wave A1 shared foundation | closed: pilot carrier runtime, product isolation and migrations, signed Android distribution plus Device A harness | PRs #45, #48, #49, the Android distribution closure commits, #56; `apps/lattice_carrier_server/lib/*` (health, durability, manifest, release) |
| Wave A2 policy context | closed: `command_op_status/3`, causal context, `command_conflicts/3`, TS parity, adversarial vectors | PR #51 |
| Wave A2 WSS deployment | not started; blocked on operator inputs (host, DNS, TLS, backup destination, secrets custody) | no deployment files in the tree |
| Wave A2 replica catalog | not started | no catalog or `pilotctl` code in the tree |
| Wave A3 camera and links | not started | no `CAMERA` declaration or permission bridge |
| Plan 177 re-aim | merged (PR #52) but the README row and the plan header still say DRAFT/TODO | `plans/README.md` row 177 |
| Plan 178 contract | merged (PR #53); README row DONE; plan header still says DRAFT | `apps/lattice_core/test/treehouse/contract_test.exs` |
| Plan 179 AF-2 | step 1 docs merged (PR #55); steps 2 to 9 open | README row 179 |
| Plan 175 spike | DONE; decision record in `docs/research/succession_tick_provenance.md` | PR #54 |
| Toolshed | `Toolshed.Shed`, `Toolshed.Tool`, v1 consent test and vector, one-log read model | `apps/lattice_core/lib/toolshed/*` |
| Substrate backlog | 172 in flight in a Codex worktree (1 commit ahead, dirty); 146 IN PROGRESS at Seam 11; 164, 166, 167, 170, 171, 173, 174, 176 TODO; 154, 156, 157 TODO (Township instrument, behind E1) | README rows |

## Roadmap decisions (scheduling only; no operator decision changes)

- **R1 Catalog code before deployment.** Plan 158 makes the replica catalog depend on WSS
  deployment. The catalog, `pilotctl` tasks and the client provisioning saga are built and tested
  against the local supervised runtime from Wave A1; the deployment ticket adds only host-level
  restart, backup and restore evidence when the operator inputs exist. Nothing else on the
  critical path waits for a host. The catalog itself stays a parent of the Treehouse domain:
  Plan 158 lists Replica Catalog and Lifecycle as a dependency of Treehouse Domain and
  Cross-Runtime Parity, and the frozen `create thread` runs the provisioning saga. So 4.1 and
  4.2 are unmerged prework on the integration branch, and the D1 integration PR (4.1, 4.2 and
  4.3 together) merges only after A2b is on `main`.
- **R2 AF-2 lands before the Treehouse TypeScript half.** Plan 179 and the Treehouse parity PR
  both touch the vector exporter, `carrier.ts`, `op.ts` and `codec.ts`, which Plan 158 lists as
  one-owner hot files. The Treehouse BEAM domain proceeds on an unmerged integration branch; its
  TypeScript half rebases after Plan 179's second PR merges.
- **R3 `archive thread` enters the contract by amendment before the domain build**, so
  `Treehouse.Thread` is built once. It is a Thread command: `command_op_status/3` sees only the
  op's own log's causal past, so the archived state has to live on the Thread for a `post` to be
  denied. Plan 178 says the contract may not widen without amending that file; chunk 0.3 is
  that amendment.
- **R4 Host mode is off the pilot critical path.** The pilot runs on the Plan 158 operator-hosted
  topology; Plan 150 host mode (E6) is a privacy option scheduled after E1 and never a
  centerless claim.
- **R5 Hardening interleaves at named points.** Plans 172 and 173 (bounded transport) in either
  order, then Plan 176 (fail closed at the wire), because README row 176 lists 172 and 173 as its
  parents; those three and Plan 170 (redact private keys) merge before any phone holds pilot
  identity or runs the candidate on cellular; Plan 171 before an audit export is handed to a
  third party; Plan 167 before the reseed ceremony claims to explain a stale copy.
- **R6 Four operator decisions are queued, not assumed** (see "Operator inputs"): D4 lease
  founder-issued grants at genesis; D5 the isolation countersign; D6 the AF-3 vouch shape; D7
  whether the first pilot accepts the unleased hostile-member gap.

## Chunk index

Sizes are the repo's S/M/L/XL. Risk is LOW/MED/HIGH. "Slot" follows the Plan 158 four-slot
schedule (root plus three workers). Each chunk is one PR unless it says otherwise.

| ID | Chunk | Plan | Size | Risk | Depends on | Exit in one line |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1 | Ledger truth | 180 | S | LOW | none | README rows 150, 152, 158, 177 and the 177/178 headers say what merged; pin suites green |
| 0.2 | Plan 158 normalization | 180 | S-M | LOW | 0.1 | the group-first order is the body text; the July order is a marked appendix; the pinned 178 paragraph is byte-identical |
| 0.3 | Contract amendment: `archive thread` | 178a | S | LOW | none | a Thread command gated by the `:moderator` authority; `archived thread` denial last; re-pinned by `contract_test.exs` |
| 1.1 | AF-2 RED: authoring half and oracle probes | 179 steps 0, 2 | M | HIGH | 179 step 1 (done) | `Sim.beacon/4 witnesses:` builds; 2a to 2d and the founder-removed test fail for the recorded reason |
| 1.2 | AF-2 GREEN: BEAM judge | 179 step 3 | L | HIGH | 1.1 | `beacon_certificate.ex`, ancestry-resolved policy, both bounds, `expired?/2` parity |
| 1.3 | AF-2 Sim helpers, exporter, vectors | 179 steps 4, 5 | M | MED | 1.2 | five new vectors; every pre-existing vector byte-identical |
| 1.4 | AF-2 TypeScript mirror and leased authoring | 179 steps 6, 6b | L | HIGH | 1.3 | `collectBeacons` parity; TS authors a beacon-policy genesis and a leased delegation |
| 1.5 | AF-2 compaction parity and dump vocabulary | 179 steps 7, 7b | M | MED | 1.4 | extended GATE red then green; fresh-VM restore |
| 1.6 | AF-2 full gate, claim-boundary docs, index | 179 steps 8, 8b, 9 | S | LOW | 1.5 | PR 2 merges; ADR 0004 and `lattice_poc_status.md` updated; 158/177 status lines appended |
| 1.7 | Contract amendment: founder loss after AF-2 | 178b | S | LOW | 1.6 merged | Plan 178 sentence and one-pager line say exactly what AF-2 proved and what it did not |
| 2.1 | Bound the witnessed successor's self-issued ops | new 181 | M | MED | 1.6; merges before 5.2 | `decide_succeed/8` checks `d.ops` against the predecessor's ops in both runtimes; the Plan 162 succession vectors re-pinned explicitly |
| 2.2 | D4 lease-at-genesis default for Treehouse | 177 amendment | S | LOW | operator, recorded in R0 | decision recorded before 4.1 touches `create space` or any founder-issued grant |
| 3.1 | AF-3 spike: member device loss | new 182 (spike) | M | LOW | 1.6, D6 | `docs/research/member_device_loss.md` answers the vouch questions and opens the build plan |
| 3.2 | AF-3 build | new 183 | L | HIGH | 3.1 | founder-present and founder-absent Sim tests green in both runtimes with negative controls |
| A2b | Replica catalog and lifecycle (code) | 158 ticket | L | MED | A1 (done) | signed catalog, `pilotctl`, provisioning saga and limits tested on the local runtime |
| A2c | WSS deployment and recovery | 158 ticket | M | LOW | operator inputs | public WSS from Wi-Fi and cellular; restore drill reproduces its cutoff |
| A3 | Native links and camera permissions | 158 ticket | M | MED | A1 (done) | denial, regrant, cold-start link and wrong-product refusal proven on Device A |
| 4.1 | Treehouse BEAM domain (unmerged prework) | 158 D1 | L | MED | 0.3, 2.2 | `Treehouse.Space`/`Treehouse.Thread`, policy reasons, workflows test T0 to T7 with the T7 qualifier, RED vectors |
| 4.2 | Treehouse TypeScript mirror (unmerged prework) | 158 D1 | L | MED | 4.1, 1.6 (R2) | TypeScript half on the same integration branch; `treehouse_*` vectors green |
| 4.3 | Catalog-coupled lifecycle and the D1 integration PR | 158 D1 | M | MED | 4.2, A2b on `main` | 4.1, 4.2 and 4.3 merge as one parity-atomic PR: thread saga, join bundle, removal fan-out with `removal_pending`, route mismatch tests |
| 5.1 | Treehouse TypeScript realm | 158 D2 | L | MED | 4.3 merged | authoring, projection, persistence, carrier composition; headless stable-server gate |
| 5.2 | Treehouse shell | 158 D2 | L | MED | 5.1, D5, 2.1 | isolated package, bounded screens, recipient-bound join, explicit Sync, packaged CI smoke |
| 5.3 | D3 rollover instrument | 177 D3 | M | LOW | 5.2, 0.3 | thresholds measured; archive-and-start control; benchmark profile support |
| 5.4 | Reseed bundle export and import | 177 AF-1 | M | MED | 5.1, A2b | member export plus operator seed reproduces the AF-1 test in the product; stale bundle shows a behind frontier |
| 6.1 | Treehouse Android candidate gate | 158 D2 | M | MED | 5.3, A2c, A3, 170, 173, 176 | Plan 158 physical gate on Device A and unrelated Device B; benchmark cold opens under 5 s |
| 6.2 | Two-week pilot | 158 D2 | pilot | MED | 6.1 | one community, stop conditions honored, evidence exported, audit matches an independent client |
| 7.1 | Isolation countersign and module contract | 158 amendment | S | LOW | operator (D5) | countersign line present; collision table revised; Toolshed one-pager under D1 |
| 7.2 | Custody v2 PR 2: offer, request, transfer | 158 C | L | HIGH | A2 policy (done) | exact due binding and adversarial exit list green in both runtimes |
| 7.3 | Custody v2 PR 3: admission, decline, day ceremony | 158 C | M-L | HIGH | 7.2 | invitee-bound admission, pinned projection, `:legacy_custody_v1`, root-only `Assert current day` |
| 7.4 | Custody ledger read model | 177 item 4 | M | LOW | 7.3 | per-member facts across Tool logs in both runtimes; lists, never totals |
| 7.5 | Subject-present presentation | 177 D2 | M | MED | 7.4 | challenge signed by the receipts' key; verifier checks against its own log; dispute appended |
| 7.6 | Toolshed module screens, QR co-signing, Device C gate | 158 C, 160 | XL | HIGH | 7.1, 7.5, 6.2 | Plan 158 Toolshed physical gate, then a 5 to 8 household pilot |
| 8.1 | Host mode as a privacy option | 150 (revised) | L | MED | 6.2, 5.4 | packaged desktop app supervises the sidecar; D1 copy; no LAN discovery |
| 8.2 | Reseed ceremony inside host mode | 150 (revised) | M | MED | 8.1, 167 | 5.4 import runs on the hosting device; stale copy explained, not detected |
| 9.x | Substrate hardening interleave | 172, 173, 176, 170, 171, 164, 166, 167, 146, 174 | S-L each | varies | see R5; 176 after 172 and 173 | each plan's own done criteria |

## Phase 0: Ledger truth (docs only, this week)

### 0.1 Ledger truth

One PR at `origin/main`. Rows and headers only; no wording of a pinned sentence changes.

- `plans/README.md` row 177: TODO becomes DONE, naming PR #52 and the AF-1 test.
- `plans/177-group-first-antifragile-reaim.md` and `plans/178-treehouse-contract-correction.md`
  Status headers: DRAFT becomes DONE with the merge PR.
- Row 158: TODO becomes IN PROGRESS, listing Wave A1 closed (#45, #48, #49, the Android
  distribution closure, #56), Wave A2 policy context closed (#51), WSS deployment and replica
  catalog open, camera and links open.
- Row 152: BLOCKED becomes SUPERSEDED, citing Plan 177 (c); append a status paragraph to Plan
  152 saying LAN discovery is dropped and QR image and deep link remain the only offer carriers.
  The plan's un-parking request is withdrawn, so `TOWNSHIP_BUILD_MAP.md` stays untouched.
- Row 150: keep TODO; add "retained as a privacy option only (Plan 177 (c)); scheduled as Plan 180
  chunk 8.1".
- Append row 180 (text below).

Guards: `audit_bundle_test.exs` and `read_model_test.exs` pin rows for Plans 121 and 122 and
`TOWNSHIP_BUILD_MAP.md`; `contract_test.exs` requires row 178 to be present exactly once and
unchanged. Run all three. If a row this chunk wants to edit turns out to be pinned, leave it and
append a note instead.

### 0.2 Plan 158 normalization

Rewrite Plan 158 so the body text says what is in force: the Status "recommended product order"
becomes Treehouse, Toolshed as a module, Township; the four-slot schedule lists Waves D1 and D2
before B1 and B2; the July 2026 order moves to an appendix titled "Superseded order (history)".
The `## Amendment 2026-09-01 (Plan 177)` section stays as the decision record. The 2026-09-03
Plan 178 status paragraph stays byte-identical because `contract_test.exs` matches it
whitespace-tolerantly. The flagship workflow re-includes `plans/15[89]-*`, so this PR gets normal
PR-tip and merge-result runs.

### 0.3 Contract amendment: `archive thread`

D3 rollover archives a Thread and starts a new one, but the Plan 178 vocabulary has no command
that marks a Thread archived, so the state cannot exist in the log. Add an amendment section to
Plan 178 and update `contract_test.exs` in the same PR. The rules are pinned here so an executor
does not choose them:

- `archive thread` is a **Thread** command, listed directly after `moderator tombstone`. It has to
  live on the Thread: `command_op_status/3` sees only `context.visible_ops` from the op's own
  log, so a `post` on a Thread can be denied only by an archive op in that Thread's causal past.
  A Space-level flag would be invisible to Thread ops.
- It mutates one Thread field, `archived`, declared `authority: :moderator`, so the whole command
  is holder-gated by the same moderator authority that gates `moderator tombstone`. An admin who
  wants to archive must hold the moderator role, which `change moderator` can grant; a Space
  genesis may name the founder as both. There is no `unarchive` in the first beta.
- Application denial reason `archived thread`, appended last in the pinned order, because it is
  a product-state conflict and Plan 158 puts product-state conflict after target and author
  checks. A `post`, `author edit` or `author tombstone` whose Thread carries an honored archive in
  the op's causal past is denied. `moderator tombstone` stays honored on an archived Thread so
  moderation of history remains possible. A `post` concurrent with the archive, with neither op in
  the other's past, is honored; canonical order is unchanged.
- The Space keeps its Thread reference as it is; the instrument reads each Thread's `archived`
  field to render the catalog. Each rollover still consumes one of the 12 Thread slots.
- Copy rule unchanged: archiving is never deleting, compacting or forgetting; archived Threads
  stay readable and replayable.

## Phase 1: AF-2, the founder-loss clock (Plan 179 steps 2 to 9)

Plan 179 is the executor document; the chunks are stage markers on its one integration branch,
and they land as one parity-atomic PR because the plan requires it. Two workers (BEAM, TypeScript)
plus the root reviewer. Everything below the step numbers is already written in Plan 179; this
roadmap only fixes the order and the merge point.

- **1.1** Step 0 drift check against `8200c38d`, then step 2: the authoring half (`Sim.beacon/4`
  with `witnesses:`, the reserved `:__beacon__` policy clause, test-side certificate assembly)
  and the failing probes 2a to 2d plus the founder-removed AF-2 test. RED evidence is the absent
  beacon verdict the plan describes, not a guessed reason.
- **1.2** Step 3: `Lattice.Authority.BeaconCertificate`, `collect_beacons/4` resolving the policy
  from each beacon's own ancestry, the `1..65_535` step bound in the judge, the `2^53-1` horizon
  as structural `:malformed_term`, author rule, `expired?/2` parity, unchanged root branch.
- **1.3** Steps 4 and 5: Sim helper cleanup, exporter scenarios, the five new vectors including
  `township_beacon_witnessed_horizon`, and the enumerated byte-identical check of every existing
  vector with the lease and `township_beacon_unauthorized` vectors named first.
- **1.4** Steps 6 and 6b: `authority.ts` `collectBeacons` parity, `codec.ts` beacon-claim bytes,
  `township.ts` genesis policy, and the leased-delegation authoring input so the creation-time
  lease mitigation is expressible from the shells.
- **1.5** Steps 7 and 7b: the compaction GATE extended with a witnessed beacon and a straddling
  lease (red against the unchanged mirror, green after), `known_dump_policy_atoms/0`, fresh-VM
  restore.
- **1.6** Steps 8, 8b and 9: full gate, the `dormant_ticks: 0` policy-replacement preflight
  reproduced or refuted before the ADR sentence, ADR 0004 and `docs/lattice_poc_status.md`,
  README row 179, appended AF-2 status lines in Plans 158 and 177. Merge.
- **1.7** After 1.6 is on `main`: a Plan 178 amendment PR (its own file says the contract may not
  change without amending it; the spike's item (e) says the sentence changes only after (a) to
  (d) are green). The new founder-loss sentence says: after founder loss a pinned witness set can
  advance the beacon; admission works through a capability delegated before the loss; a
  delegation is revocable only by a surviving issuer; a leased founder-issued grant lapses by
  witnessed epoch; an unleased founder-issued grant is permanent; manual admin transfer remains
  the only handoff the first beta exercises on a device. One-pager line 190 and the contract test
  follow. The prohibited-phrase list does not change.

Claims after 1.6: "in `Lattice.Sim`, mirrored in TypeScript, a pinned witness set advances the
epoch after the founder realm is removed; admission works through a capability delegated before
the loss; a delegation is revoked only by a surviving issuer; a leased founder-issued grant lapses
by witnessed epoch; an unleased founder-issued grant is permanent". Never "founder loss is
survived": Plan 177's STOP keeps that phrase out until AF-2 and AF-3 both pass, and nothing here
is about availability, E2EE, hosting or a device.

## Phase 2: AF-2 residue

- **2.1 Bound the witnessed successor's self-issued ops (new Plan 181).** Spike section 8.3
  records that `decide_succeed/8` never checks `d.ops` on the root-less delegation a successor
  self-issues, so genesis bounds who may succeed, not what the successor may do. The plan adds a
  bound, a pinned quarantine reason, the TypeScript mirror and a Sim negative control. Prefer the
  predecessor's effective ops as the bound over a new policy field, so the Treehouse genesis
  bytes from 4.1 do not change when it lands. It changes succession vectors, so it must state up
  front that it re-pins the three Plan 162 succession vectors with a named RED/GREEN, rather than
  inheriting Plan 162's byte-identical STOP. Ordering: after 1.6, because Plan 179's own STOP
  forbids byte changes to those vectors, and to every other pre-existing vector, inside its PR; before 5.2, so no shell exposes a succession
  control while the gap is open; and before the witnessed succession ceremony is un-hidden (146,
  174). Until it merges, 4.1's T7 carries the qualifier in Phase 4 and the claims ledger keeps it.
- **2.2 D4: lease founder-issued grants at genesis (Plan 177 amendment, operator decision).**
  Recommended: yes. Treehouse `create space` leases every founder-issued grant with a long
  `expires_epoch` step, and the admin renews by re-grant before expiry. Leasing adds an exit for a
  founder-granted member who turns hostile after founder loss and removes no existing recovery:
  if no beacon can advance, the leases never lapse, which is today's behavior (spike 6.6 and
  8.3). The cost is one renewal action per lease window, a beacon cadence the root or the
  witnesses must keep, and copy that names both. Root queues D4 in R0 and records the answer
  there; 4.1 may not touch `create space` or any founder-issued grant before it is recorded, so
  its R0 prework covers Thread commands and the policy reasons. If the operator declines, D7
  records that the first pilot accepts the unleased hostile-member gap, and no surface may say
  founder-granted access can be removed after founder loss.

## Phase 3: AF-3, member device loss

- **3.1 Spike (new Plan 182, docs only, Plan 175 shape).** Questions it must answer with existing
  op kinds only: the vouch artifact (a threshold certificate by current members over `(replica,
  old_pub, new_pub, epoch)`, reusing the `SuccessionCertificate` pattern, carried inside an
  existing kind); who signs the new key's grants (the admin, exact-audience, through the ordinary
  admit path); what happens to the old key (its grants revoked by their issuers or lapsed by lease,
  which is where D4 matters again, and a `:tombstone` whose semantics for an identity are defined);
  how history is linked (a projection fact "new key vouched for old key by these members", D2,
  never a score); the TypeScript mirror; and the negative controls (subthreshold vouch, vouch for
  a key that was never a member, replayed vouch, vouch signed by removed members). STOP: any old-key
  re-signing (M3), any cross-space registry (M6), any new op kind.
- **3.2 Build (new Plan 183).** Sim tests in both runtimes: a member loses its device, creates a
  new key, k members co-sign the vouch, the admin admits the new key, the old key's causally later
  post is quarantined, the projection links both keys, every replica materializes byte-identically;
  run once with the founder present and once with the founder removed (so AF-2 and AF-3 compose).
  Vectors exported; compaction mirror extended if a certificate reaches the reducer.

Claims after 3.2: "re-admission after member device loss by group attestation is proven in
`Lattice.Sim` and mirrored in TypeScript". Not "recovery", not "rotation".

## Phase A: shared foundation remainder (parallel to Phases 1 to 4)

- **A2b Replica catalog and lifecycle (code).** The Plan 158 ticket, minus host-level evidence:
  signed per-product transport catalog with a root-bound bootstrap op, `pilotctl add-replica`,
  `add-peer`, `remove-peer`, `status`, `reconcile`, the durable client saga `local_draft ->
  genesis_created -> carrier_pending -> listed` with crash injection between transitions, the
  limits (one Space, 12 Threads, 64 routes, four foreground sockets), removal fan-out with
  `removal_pending`, and the trust tests (wrong signer, cross-product key, rollback, rotation,
  lost-key founder ceremony). All of it runs against the Wave A1 supervised runtime.
- **A2c WSS deployment and recovery.** TLS edge, loopback-only listeners, secret mounts, health
  checks, encrypted daily backup with a signed cutoff manifest, the clean-host restore drill,
  runbook. Blocked until the operator inputs exist; report them as prerequisites, never as
  localhost or self-signed substitutes.
- **A3 Native links and camera permissions.** Android `CAMERA` declaration and runtime request
  through the Tauri boundary, cold-start deep-link queue, untrusted-input review before any
  persistence, Device A proof. iOS code lands with the shared boundary; its proof stays parked.

## Phase 4: Treehouse domain and cross-runtime parity (Wave D1)

- **4.1 BEAM domain (unmerged prework).** `Treehouse.Space` (name, members,
  capability-authorized Thread references, invitations, admin and moderator authority fields)
  and `Treehouse.Thread` (title, posts with author binding, and the `archived` field gated by
  `:moderator` from 0.3) using only the existing Replica DSL. Commands are exactly the Plan 178
  set plus `archive thread`. `command_op_status/3` pins the ordered reasons (`missing or
  not-causal target`, `quarantined target`, `wrong target kind or thread`, `wrong author`,
  `already tombstoned`, `archived thread`). Multi-mutation commands carry ordered `effects[]`,
  all-or-none. Witnessed succession of the admin role is pinned in genesis under the Plan 145
  policy shape (and, once 1.6 has merged, the beacon witness set under `:__beacon__` and leased
  founder grants per D4). `apps/lattice_core/test/treehouse/workflows_test.exs` covers T0 create
  space and thread, T1 concurrent invite, admit and post, T2 partition and heal with a tombstone
  winning over every edit, T3 moderator change and stale-moderator quarantine, T4 member removal
  denying a causally later post, T5 rollover (archive, create, post-to-archived denied, moderator
  tombstone on the archived Thread honored), T6 dump and restore byte-identical, T7 witnessed
  admin succession as domain evidence only. T7 qualifier: the successor self-issues exactly the
  predecessor's ops, and the test states that the runtime does not yet bound those ops (spike
  8.3) until 2.1 merges. RED vectors are exported as a `treehouse_*` family. R0 work starts with
  Thread commands and the policy reasons; the genesis grant shape waits for D4.
- **4.2 TypeScript mirror (unmerged prework).** Product injection into the shared decoder,
  `effects[]` normalization, delete-aware causal-list reduction, the same reasons, conformance
  over the `treehouse_*` vectors, on the same integration branch, rebased after Plan 179's second
  PR (R2). Every Township and Toolshed vector stays green.
- **4.3 Catalog-coupled lifecycle and the D1 integration PR.** `create thread` runs the A2b saga
  and publishes the Space reference only after the route is ready; the join bundle carries both
  current sets plus per-Thread admissions and exact-audience grants; `remove member` revokes
  Space and Thread grants and transport admission with `removal_pending` until reconciliation;
  missing, extra and mismatched routes do not change semantic visibility. This is the merge
  point: Plan 158 lists the catalog as a parent of the Treehouse domain, so 4.1, 4.2 and 4.3 land
  as one parity-atomic PR after A2b and 1.6 are on `main`.

Claims after 4.3: "Treehouse membership, roles, invitations, posts, edits, tombstones, rollover
and witnessed admin succession are deterministic through partition, heal, dump and restore in both
runtimes, with the successor's self-issued ops unbounded until Plan 181". No device, no hosting, no
availability.

## Phase 5: Treehouse realm and shell (Wave D2, part one)

- **5.1 TypeScript realm.** `clients/lattice-client/src/treehouse.ts`: command authoring with cap
  selection and frontier deps, projection, persistence through the existing local-log seams,
  carrier composition (pull, one-op relay, availability subscription). A headless real-socket gate
  against the stable server, in the Plan 133 shape, compares to `Lattice.Sim`.
- **5.2 Shell.** The product-isolated package with the isolation-table IDs (or, if D5 has been
  countersigned, the group app that Toolshed later joins as a module; replica, catalog and
  manifest isolation is retained either way). Screens: create and join, thread list, text post,
  edit and tombstone, offline queue, members and roles, connection health, audit. Recipient-bound
  join by QR image or deep link: the joiner creates its own keys, the admin admits the transport
  key and signs exact-audience grants; nothing bearer crosses the link. Separate Use, Post and
  Sync actions. Fresh boot is empty. Product-marker refusal tests. A packaged CI smoke in the Plan
  131 pattern.
- **5.3 D3 rollover instrument.** Per-thread op count and bytes from the local log, cold-open
  timing, the 4,000 / 8 MiB / 5 s thresholds, an "Archive this thread and start a new one"
  control that appears as a thread nears them, copy per the D3 rule, and support for the
  separately named disposable benchmark profile the candidate gate needs.
- **5.4 Reseed bundle export and import.** A member exports its retained log plus the transport
  peer admission list it holds as pairing state; `pilotctl seed-from-bundle` creates a fresh
  relay identity and path from it; the app re-pairs to the new service fingerprint. This is the
  AF-1 test as a product path. A stale bundle produces a relay whose frontier is behind; the
  product shows the frontier, and any claim to detect the gap waits for Plan 167.

## Phase 6: Treehouse Android candidate and pilot (Wave D2, part two)

- **6.1 Candidate gate.** The Plan 158 Treehouse physical gate on Device A and an unrelated
  Device B: QR and deep-link join with camera denial and regrant and a cold-start link; wrong
  recipient, wrong replica, wrong server, tampered, replay-rebound and revoked invitations refuse;
  offline post and edit then heal; deterministic tombstones; manual admin and moderator transfer;
  stale-moderator quarantine; revocation denying a later post; force-stop, reboot and signed
  upgrade retain identity and history; carrier restart and restore resume convergence; Wi-Fi and
  cellular; audit export matches an independent client. Before testers: the benchmark profile at
  5,000 ops and 10 MiB with three cold opens under five seconds, then the approved profile
  deletion. Requires A2c, A3, and Plans 170, 173 and 176 merged (R5).
- **6.2 Two-week pilot.** One community of roughly 9 to 15 under the Plan 158 stop conditions:
  stop posting at 4,000 ops, 8 MiB or a cold open over five seconds, export evidence. The
  common physical acceptance record is filled in. Notifications, background delivery, media, bots,
  federation, E2EE, automated recovery and the 60-day multi-community gate stay excluded.

Claims after 6.2: "one assisted two-week Treehouse pilot ran on two unrelated phones over a public
WSS relay whose operator can read the log and withhold availability". That sentence is the
template; every hosting sentence in the app follows D1.

## Phase 7: Toolshed as a module (Wave C, reshaped by Plan 177 (b))

- **7.1 Countersign and module contract (operator act, D5).** The operator adds the countersign
  line to the Plan 158 Product isolation contract. The collision table is revised in the same PR:
  the group app keeps one app ID, scheme, key service and database; Toolshed rows become the
  module's replica-level isolation (each Tool keeps its own root, grant issuer, route and service
  fingerprint). `plans/toolshed_one_pager.html` drops the prohibited hosting phrase under D1 and
  stops calling Toolshed a sibling product. 7.2 to 7.5 are substrate and may proceed before this;
  7.6 may not.
- **7.2 Custody v2 PR 2.** `custody_offer_v2`, `custody_request_v2`, `custody_transfer_v2` with
  the exact due binding and the full Plan 158 enforcement list; Elixir projector and policy, Sim
  vectors, TypeScript decoder and projector, adversarial parity in one PR.
- **7.3 Custody v2 PR 3.** Invitee-bound admission, `custody_decline_v2`, the pinned
  completed/declined/pending projection, `:legacy_custody_v1` quarantine of v1 bytes without a
  crash, and the root-only foreground `Assert current day` beacon ceremony with rollback,
  duplicate and large-jump handling. Adds the `dispute` Tool command (a command, not a new op
  kind) so D2's "the subject can append a dispute" has an op to append.
- **7.4 Custody ledger read model.** `apps/lattice_core/lib/toolshed/read_model.ex` extended
  across every Tool log in a Shed: per member, the transfers, the returns made before their cited
  due epoch, the open return requests with epoch age, and the disputes, derived from op presence
  and the same projection in TypeScript. D2 wording: lists of facts with op ids, never a count, a
  rate, a rank or a total.
- **7.5 Subject-present presentation.** Pull only, within the shed: the verifier issues a
  challenge; the subject presents co-signed receipts and signs the challenge with the key that
  signed them; the verifier checks both against its own log copy; the subject may append a
  dispute so both sides show. Carried over QR image or deep link. No push, no broadcast, no export
  beyond the shed, no cross-shed portability (M6).
- **7.6 Module screens, QR co-signing, Device C gate, neighborhood pilot.** Plan 160's ceremony
  physics spike first, then the Plan 158 Toolshed Product Workflows and QR Co-Signing tickets
  inside the group app, the Android gate with Device C as the independent auditor, then one
  neighborhood of 5 to 8 households for 7 to 14 days.

## Phase 8: member-operated relay (privacy option, after E1)

- **8.1 Host mode (Plan 150, revised).** The packaged desktop app supervises one
  `lattice_carrier_server` release (the Wave A1 runtime) whose path-backed log lives in the app
  data directory, bound to loopback plus one explicitly configured interface. Pairing by QR image
  or deep link only; the LAN discovery and advertise items are dropped with Plan 152. Copy names
  who can read (the hosting device and its OS including any administrator, its backups, every
  admitted transport peer) and who can withhold (the host). No phone hosting, no NAT traversal, no
  availability claim.
- **8.2 Reseed ceremony inside host mode.** The 5.4 import path on the hosting device, so a
  member can stand up a replacement host from retained state. Plan 167's divergence explainer is
  the honest way to describe a stale copy; without it the ceremony shows frontiers and claims no
  detection.

## Phase 9: substrate hardening interleave

| Plan | Size | Merge before | Why there |
| --- | --- | --- | --- |
| 172 TS canonical-encoder strictness | S-M | 176, and 4.2 | in flight in a Codex worktree; README row 176 lists it as a parent; the Treehouse decoder inherits it |
| 173 bounded carrier transport | M-L | 176, then 6.1 | cellular connects and paged pulls; README row 173 depends on 169 (done), not on 172 |
| 176 fail closed at the wire and authority boundary | M | 6.1, after 172 and 173 | README row 176 lists 172 and 173 as parents; untrusted peers on a public relay |
| 170 redact private keys from inspect and crash reports | S | 6.1 | phones hold pilot identity; crash reports leave the device |
| 171 policy for every unverified `Log.restore/1` consumer | M | 7.5 and any third-party audit export | an auditor restores bytes it did not author |
| 167 divergence explainer | M | 8.2 | the only honest stale-copy explanation |
| 164 local CI parity, 166 shell typecheck | S, M | any time (root) | reduce review latency across every wave |
| 146 Seam 11, 174 governance-witness ceremony spike | L, M | un-hiding the witnessed succession mobile ceremony (after 6.2) | the ceremony stays hidden in the first beta by contract |

## Slot schedule

Four slots as in Plan 158: root integrator plus three workers, fresh worktrees from the last green
`origin/main`, one owner per hot file (workflow YAML, lockfiles, generated mobile projects,
`carrier.ts`, the vector exporter, shared native state). Waves are ordered, not dated; a wave
starts when its predecessor's merge-result `main` run is green.

| Wave | Root | Worker 1 (substrate) | Worker 2 (Treehouse) | Worker 3 (foundation, Toolshed) |
| --- | --- | --- | --- | --- |
| R0 | 0.1, 0.2, 0.3; 2.2 recorded; queue D5, D6, D7 to the operator | 1.1 | 4.1 RED prework: Thread commands and policy reasons first | A2b |
| R1 | reviews | 1.2, 1.3 | 4.1 GREEN, genesis shape after D4, vectors | A2b merges; 172 review |
| R2 | 1.7 after 1.6 merges; 3.1 | 1.4, 1.5, 1.6 (PR 2 merges) | 4.2 rebased on 1.6, then 4.3; the D1 integration PR merges after A2b | A3 |
| R3 | A2c when inputs exist; 3.1 done, 3.2 planned | 2.1, 170 | 5.1 | 7.2 |
| R4 | 7.1 if countersigned; pilot go/no-go inputs | 173, then 176 | 5.2, 5.3 | 7.3, 5.4 |
| R5 | 6.2 pilot stewardship | 3.2 | 6.1 device gate | 7.4, 7.5 |
| R6 | pilot evidence, claims ledger | 171, 8.1, 167 | 8.2, then Township B1 or Wave E prep | 7.6 (needs Device C) |

Critical path to E1: 0.3, then 4.1, 4.2 and 4.3 as one integration PR (after A2b and 1.6), 5.1,
5.2, 5.3, 6.1, 6.2, with A2c, A3, 170, 173 and 176 feeding 6.1 and 2.1 feeding 5.2. Critical
path to E2: 1.1 to 1.6, then 3.1, 3.2, plus 5.4 for the AF-1 product path.

## Claims ledger

What may be said, and only after the named merge:

| After | May say | Still may not say |
| --- | --- | --- |
| 0.1 | the ledgers match `main` | anything new |
| 1.6 | in Sim, a pinned witness set advances the epoch after the founder realm is removed; admission through a pre-loss delegated capability; revocation by a surviving issuer; lease lapse for leased founder-issued grants | founder loss is survived (Plan 177 STOP: not before AF-2 and AF-3 both pass); founder-granted access is revocable; anything on a device |
| 3.2 | a member with a new key is re-admitted by group attestation in Sim | recovery, rotation, cross-space identity |
| 4.3 | Treehouse semantics are deterministic in both runtimes; witnessed admin succession is domain evidence with the successor's self-issued ops unbounded until 2.1 | a product exists; anything about succession on a device |
| 5.2 | a packaged Treehouse app converges with Sim over the stable relay | phones, availability |
| 6.1 | two unrelated phones converge over public WSS | a pilot happened |
| 6.2 | one assisted two-week pilot completed with named readers and a withholding host | the prohibited Plan 178 phrases, E2EE, availability, safe unbounded history |
| 7.4 | the audit trail is the reputation, rendered as facts | score, karma, rating, any aggregate |
| 8.1 | a member can host the relay and its readers are enumerated | centerless operation, the prohibited hosting phrases |

## Operator inputs that block gates

- **Decisions**: D4 lease founder-issued grants at genesis (before 4.1); D5 the isolation
  countersign (before 5.2 chooses its package shape, and before 7.6); D6 the AF-3 vouch shape
  (threshold size, who may sign, what tombstoning an identity means; before 3.2); D7 whether the
  first pilot accepts the unleased hostile-member gap if D4 is declined.
- **Hosting**: one supported Linux host, a DNS name, TCP 443, certificate renewal egress, an
  encrypted off-host backup destination, a separately held recovery key, a clean restore host,
  and an owner who accepts the 24-hour disaster RPO (A2c).
- **Secrets**: service identity, one root-bound catalog signer per product, TLS material, peer
  admission manifests, all through secret files with a custodian and rotation record (A2b, A2c).
- **Devices**: Device B, an unrelated physical Android, before any two-phone verdict (6.1);
  Device C for the Toolshed audit gate (7.6). iOS stays parked.
- **People**: a 9 to 15 person community willing to run a text-only pilot with the stop
  conditions explained (6.2); 5 to 8 households for Toolshed (7.6).

## Non-goals

Everything in the `CLAUDE.md` boundary and the Plan 177 non-goals: no federation, cross-space
identity or universal tally (M6); no key rotation, recovery or E2EE (M3); no production
compaction; no coercion-resistant election, and `Lattice.Attestation.Stub` stays frozen and false;
no host migration; no availability claim; no score, rank, karma or aggregate; no new op kinds;
no Township B waves, no iOS and no Township instrument reports (154, 156, 157) ahead of E1.

## STOP conditions (inherited, restated)

- Any sentence in a plan, a surface or a commit claiming founder-loss safety or survival before
  AF-2 and AF-3 both pass (Plan 177 STOP; 1.6 alone permits only the narrow Sim clause in the
  claims ledger), or member-loss safety before 3.2, or using the Plan 178 prohibited phrases at
  any time.
- Any hosting sentence that omits who can read or who can withhold availability.
- Any numeric, ranked or aggregated reputation value; any push of negative reputation; any
  identity registry across communities.
- Any change to product isolation without the countersign line (7.1).
- Any edit to a sentence that `audit_bundle_test.exs`, `read_model_test.exs` or
  `contract_test.exs` pins.
- Any BEAM-only or TypeScript-only merge of a semantic slice (4.1 and 4.2, 1.x, 7.2, 7.3, 3.2).
- Any private key, seed or capability secret in a doc, fixture, log or test output.
- Any em-dash in this file.

## Verification (for this file)

| Command | Expected |
| --- | --- |
| `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_bundle_test.exs apps/lattice_core/test/township/read_model_test.exs apps/lattice_core/test/treehouse/contract_test.exs` (repo root, OTP 28 `PATH`) | green; every pin intact |
| `grep -c $'\xe2\x80\x94' plans/180-group-first-roadmap.md` | `0` |
| `git diff --name-only origin/main; git ls-files --others --exclude-standard` | exactly this file, `plans/180-group-first-roadmap.html` and `plans/README.md` |

## Done criteria (for this file)

- README row 180 appended; no other README line changed.
- Every chunk names a plan (existing or new number), a size, a risk, its dependencies and a
  one-line exit.
- The "Where main stands" table matches `origin/main` at the PR's base commit; refresh it if the
  base moves.

## Proposed README row

```
| 180 | Group-first roadmap: chunked schedule from the corrected map to the Treehouse two-week pilot (AF-2 and AF-3 builds, Toolshed as a module, D3 rollover, host option) | **P0** | S | 158, 177, 178, 179 | DRAFT (2026-09-04; schedule only, no code) |
```
