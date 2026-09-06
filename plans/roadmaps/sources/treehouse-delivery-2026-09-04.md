# Treehouse delivery roadmap

Status: proposed execution roadmap. Prepared 2026-09-04 against published `main` at `af84459bfc066b4ed405b99a02046b4f2c6315ee` (PR #56). This document plans future work; it does not mark that work complete or approve a deployment.

Revised 2026-09-05 after a [Claude Opus adversarial review](treehouse-delivery-2026-09-05-opus-review.md). The review and every disposition are retained there. This revision does not supply any operator countersign, un-park a platform or enable a new authority policy.

Companion: [HTML roadmap](treehouse-delivery-2026-09-04.html). Worktree: `/Users/nicholas/develop/lattice-treehouse-roadmap-20260904`. Branch: `codex/treehouse-roadmap-20260904`.

## Destination

Twelve people create a group, invite one another with recipient-bound capabilities, post and edit while offline, and keep their history when they reconnect. A member can replace a destroyed relay using retained evidence. The group continues after the founder loses their device. A member who loses a phone can rejoin with a new key and a visible, group-attested link to their earlier history. A busy thread rolls into an archived thread and a fresh one without deleting its signed history. When this group is proven, its members can enable Toolshed to lend a tool, co-sign its return and inspect the factual custody trail.

The first release is an assisted Android pilot for 9–15 people, tuned for 12. The product capacity target is up to 150 people; it becomes a supported limit only after R33. Plan 177 currently says **under** 150: R01 explicitly proposes changing that wording to an inclusive 150 and testing 149/150/151, rather than silently changing a boundary. Neither number is evidence of capacity today.

The relay holds plaintext. Its operator, the host device's OS administrators and backups, and admitted transport peers can read their copies; the host can withhold service. A member-operated relay is an optional deployment choice. Creating a remotely available Thread, including a rollover successor, requires the assisted relay operator to provision it; a member can sign and retain a draft without that operator, but cannot promise a live route. Toolshed receipts remain facts, with no scores or negative broadcasts. Presentation is subject-present pull within a shed; cross-community identity and federation remain deferred. Losing the receipt-signing key prevents a new same-key challenge presentation of those pre-loss receipts; the signed evidence itself remains readable and verifiable. Production compaction, E2EE, background-delivery guarantees, notifications, media, bots and civic elections are outside this delivery program.

The initial lifetime envelope is approximately 12 Threads × 4,000 operations = 48,000 Thread-log operations per Space, including authority and other overhead, not 48,000 messages. Byte or cold-open limits may stop it earlier; disconnected overshoot is not a coordinated global cap. At 150 members this is only about 320 operations per person over the Space's lifetime. Exhaustion leaves the Space readable/exportable but closed to new posting or Thread creation. A separately created Space is not automatic migration or identity continuity. R35 must establish an approved, measured lifecycle policy before R33 declares supported expansion beyond the observed 9–15-person cohort; neither packet promises unlimited history.

## What the baseline already contains

| Baseline evidence | Reuse and remaining limit |
| --- | --- |
| Plans 177 and 178, merged through PRs #52 and #53 | Product order and D1/D2/D3 are recorded; the Treehouse text contract and corrected copy are pinned by tests. They are not a product implementation. |
| AF-1 `relay_reseed_test.exs` | Two real WebSocket/runtime tests use Sim as the oracle. A replacement relay uses a different identity/path and retained member log plus public pairing/admission state. No packaged export/reseed ceremony exists. |
| Plan 175 decision and Plan 179 step 1, PRs #54/#55 | The emitter decision and legacy-clock non-claims are complete. Plan 179 steps 2–9 are unbuilt. Root-only beacons still govern production. |
| Shared carrier runtime, product isolation/SQLite migrations, Android signing/harness and causal application-policy context | Reuse merged work from PRs #35/#41/#48/#49/#51 and later fixes, including #56. Runtime helpers and build contracts do not prove a deployed service or an installed Treehouse release. |
| Toolshed `Shed`, `Tool`, `ReadModel` and consent vector | Legacy custody primitives exist. Exact request/loan/due binding, full product parity and the per-member ledger remain open. |
| Existing QR, deep-link and LAN discovery helpers | Reuse confirmed QR/deep-link ingress. Drop the additional Plan 152 LAN program; do not delete unrelated existing helpers. |
| Treehouse file inventory | A copy-contract test exists; no Treehouse production domain, TypeScript realm or app exists at this baseline. |

The preceding audit reran AF-1 (2 tests) and the Treehouse copy contract (11 tests) at `4c6b0003`, all green. That is historical, targeted verification; this roadmap does not convert it into a full-suite, physical-device or current-release claim. Inspect current checks when starting execution.

Sources: [Plan 158](../158-real-device-beta-poc-program-map.md), [Plan 177](../177-group-first-antifragile-reaim.md), [Plan 178](../178-treehouse-contract-correction.md), [Plan 179](../179-witnessed-beacons-af2-founder-loss.md), [succession decision](../../docs/research/succession_tick_provenance.md), [AF-1 test](../../apps/lattice_carrier_server/test/relay_reseed_test.exs), [product manifest](../../clients/lattice-mobile-core/products.json), [Toolshed read model](../../apps/lattice_core/lib/toolshed/read_model.ex).

## Delivery milestones

These are evidence milestones, not calendar promises. Development can proceed on independent ready chunks; product delivery stays Treehouse, then its Toolshed module, then Township.

| Milestone | Observable finish | Required chunks |
| --- | --- | --- |
| M1 — executable contract and loss model | One current product contract; founder authority, catalog recovery and social continuity have explicit boundaries; witnessed beacons and founder continuation pass both runtimes. | R01–R04; R19a supplies the member continuity decision only |
| M2 — two people can use the group | Empty native app; create/join; durable offline posts/edits; role changes and removal; thread rollover with visible limits; verified catalog lifecycle. | R05–R15, plus native witness identity bootstrap R36 |
| M3 — target: prove the three loss workflows | Packaged AF-1, AF-2 and AF-3 plus combined founder-and-relay loss; honest witness-presence evidence; supported WSS and recovery path. | R16–R21, including R19b |
| M4 — twelve-person Android pilot | Exact signed candidate passes physical gates, then 14 days with 9–15 members and all loss rehearsals. | R22–R23 |
| M5 — Toolshed works inside the group | Exact co-signed custody; offline QR borrow/return; factual ledger and subject-present presentation; household pilot. | R24–R30 |
| M6 — measured expansion | Optional member host, physical iOS, tested lifecycle and capacity toward 150; Township resumes after group evidence. | R31–R35, independently gated |

The product path joins independent branches: R01/R07/R09 → R10 → R12 gives an offline local preview; R01/R07 → R03 plus R02 → R04 supplies continued authority; both join at R11 → R13 → R14 → R15 → R16/R18/R20 → R22 → R23. R05–R09, R17, R19, R21 and R36 join at their explicit blockers below. M1 and M2 are evidence milestones, not an instruction to block the root-only local preview on M1. Toolshed semantics may be prepared once their dependencies pass, but its module rollout follows M4. No Township pilot is a prerequisite for Treehouse.

## Decisions that must be made concrete

### Already accepted

- Treehouse precedes Township in semantic and device delivery; Toolshed is intended as a module of the group.
- Plaintext readers and the withholding host are named; neither hosted nor member-operated transport grants semantic authority.
- Reputation is factual and subject-present pull; there is no broadcast, score, rank or cross-shed registry.
- Thread rollover is the pilot volume policy. Production compaction stays excluded.
- Plan 175 chose genesis-authorized threshold witnesses for beacons. Root-only remains the default; a delegated single-key clock is rejected. Legacy dormancy arithmetic stays outside Plan 179.

### Proposed defaults, recorded by R01/R02 before dependent code

1. **One group app.** Reuse the existing Tauri/Vue and shared native substrate for the first Android delivery. Keep Treehouse's app ID, scheme, signing lineage, database and key service; add Toolshed namespaces and permissions inside it. Township remains isolated. Retain old Toolshed identifiers as reserved/legacy until an explicit migration decision; never automatically import a second product's identity. R01 records the operator countersign required by Plan 177. This roadmap is not that countersign.
2. **One member key within a group and its Toolshed.** Reuse the subject's key for group and module receipts. This does not collapse the distinct protected governance-witness key purpose into carrier/member signing; R36 provisions that separate key before root pinning. Do not require one universal key across separate communities. The first pilot can use one group per installed profile; multi-group identity design is deferred.
3. **Rollover is explicit, durable archival.** Add an authorized `archive thread` command to the frozen vocabulary, and a retryable workflow that creates its successor. Preserve old signatures and readability. Recommend warning at 3,200 ops or 6.4 MiB (80%); preserve the 4,000-op / 8 MiB / >5-second cold-open stop. Existing limits count archived Threads: at most 12 total per Space until separately amended. At slot exhaustion, stop new thread creation and export evidence; no silent recycling or promise of months of capacity.
4. **Founder continuation has a lifecycle.** A proposed 2-of-3 witness profile can survive one witness loss; that quorum can also advance epochs and lapse expiring grants within the approved bounds. R02 must test this across Space and child replicas. R12 first creates a root-only local profile; R13 enrolls independently keyed members; R36 provisions and binds protected witness identities after R17a's platform decision; R14 lets the living root explicitly pin the validated beacon and succession profile in a later root-authored genesis, as Plan 179 permits. Until every required replica is provisioned and pinned, the app displays `recovery_not_ready`. No witness can perform this root act after root loss; new Threads must be created with their approved profile by their own authorized creation workflow. All founder-issued grants that need future removal are leased, with explicit units, duration, renewal and expiry behavior. A chain whose only delegator is an expired/dead founder is not a renewal mechanism. Root identity remains immutable; keys are never reconstructed or silently replaced.
5. **Social continuity is evidence, not recovered cryptographic ownership.** A threshold of current members attests a link between an old key and a new key within one Space; the new key proves possession, the old key's history retains its signatures. The link confers no capability, witness status or authority by itself. Old capabilities and transport admission are separately retired; conflicts remain visible. R19 settles threshold, current-member determination and conflict precedence before implementation.
6. **Host choice does not gate chat.** The supported initial relay can be hosted on a small Linux machine operated by a group member or an agreed operator. Packaged device hosting is R31. Either host has the stated plaintext visibility; an external operator requires informed pilot acceptance, not a claim that only group members can read.

Three traps explicitly gate the stronger product promise:

- **Founder grants and successors.** Plan 179 proves revocation only for surviving issuers and lapse of leased founder grants. It does not constrain every capability a successor can self-issue, rotate lost witnesses or solve future grant renewal. R04 closes the approved group-specific authority path; if it requires a wider succession contract, it gets its own versioned amendment and review before enabling the feature.
- **Relay trust after founder loss.** Plan 158's catalog recovery currently needs the founder/product root. R11 must use a creation-time, narrowly scoped recovery authorization established by R02/R04 and checked against retained anchors. A relay cannot declare its own replacement identity trustworthy. The combined-loss case must pass.
- **Rollover and late offline work.** Local threshold checks cannot globally stop simultaneous disconnected authors. Archiving must define concurrent/late posts, display retained-but-refused work and allow an explicit new signed copy in the successor thread. Never edit an old op's replica or signature. A policy table and vectors belong in R01/R10; a hard per-replica op ceiling must not pretend it prevents inbound evidence needed for convergence.

### Rollover and membership contract proposed for R01 adoption

| Interaction | Required behavior and proof owner |
| --- | --- |
| Invitation is accepted after its catalog changed | Never widen the old signed invitation. R13 shows a stale-catalog preview and obtains freshly reviewed, recipient-bound grants for the changed catalog before completing admission. Retrying the same approved set is idempotent. |
| A new member joins after rollover | R01 adopts an explicit history policy: this roadmap proposes read access to retained archived Threads only when the join review lists them and their exact-audience grants are issued. No implicit read or write authority follows from a Space grant. R13/R14 expose incomplete per-replica fan-out. |
| Existing member receives a successor Thread | R14/R15 reconcile the current roster, exact-audience grants and transport admissions. Removed members and unresolved old invitations are not copied blindly. |
| Archived Thread retains a route | R15 keeps its route, verified history and admission records. It still consumes a Thread slot and host route; no archive slot is reclaimed. R13 includes it in fair foreground round-robin pulls under the four-socket cap, with priority to visible/current Threads and an explicit full-history sync action. |
| Rollover waits for provisioning | R15 shows `carrier_pending` and the named operator; the successor is not listed as live until readiness and catalog publication. R18/R23 record the operator's transport action separately from member semantic signatures. |
| A departed member retained plaintext | Removal cannot erase their copies. R14/R15 test future admission/grant refusal and label the remaining historical-read limitation. |

### Signed epoch operations proposed for R02 adoption

R02 must freeze separate units for group leases and Tool due dates, with an executable cadence/expiry table. The proposed assisted pilot schedule is one reviewed UTC-day assertion each day and after a multi-day offline gap, with a quorum-agreed catch-up only within Plan 179's step/horizon bounds. Group witness coordinators collect the required independent signatures; each Tool owner performs its own root-only `Assert current day` ceremony under unchanged Plan 158 Decision 5. A reminder may use wall time, but it cannot author a beacon, lapse a grant, assert elapsed signed time or prove a date.

R14 displays issued/expiring/lapsed and renewal-pending/failed states. Proposed group admission leases last seven signed day-epochs, with a warning/renewal window opening at two remaining epochs; R02 must approve the exact inclusive expiry arithmetic, offline grace semantics (none by default), renewal issuer and maximum jump before any pilot profile uses these numbers. R02 must also size renewal fan-out before adopting that short window: at 12 members × (1 Space + 12 Threads), one leased grant per member/replica is up to 156 renewals per seven signed days, or 312 over two cycles, before extra role/delegation grants. Measure actual distinct issuers, quorum signatures, operator prompts, bytes and log growth rather than treating one batch as one operation. R14c supplies a reviewed, bounded, exact-recipient/replica renewal batch with per-grant results and idempotent retry, or R02 adopts a longer window based on that workload. A batch is not a general signing permission; each signed effect retains its own authorization. R17b verifies any witness-backed batch against its exact claims. The coordinator checks daily for due renewals and records missed ceremonies; it does not renew every grant daily. Below quorum, the app shows stale epoch and unresolved renewal; existing signed state is retained and no fallback clock or unbounded grant is minted. R18 rehearses two expiry cycles with controlled signed days; R23/R30 record actual daily ceremonies and stalled-clock behavior. This is an operator workflow, not background availability or trusted wall-clock time.

## How to execute a chunk

Every R-number is a workflow packet that can be handed to a fresh implementation session. Most packets end in one PR. An atomic packet contains named preparation sessions but merges once, with BEAM, TypeScript, byte vectors and affected claim documents together. No runtime ships half of a new authority or wire contract. A field packet finishes with an evidence record and may need no code PR.

1. Read this packet, its source plans in full and the live `AGENTS.md`. Recheck the immutable base, merged blockers and changed paths. Reuse completed work by evidence, regardless of stale TODO rows.
2. Create an isolated worktree from the latest accepted base; name its branch `codex/treehouse-rNN-<slug>`. Give one owner each shared authority/codec/carrier file and generated vector corpus. Independent ready packets can run concurrently; a blocker is a merge/evidence dependency, not a ban on preparatory design.
3. Write behavioral acceptance tests at the public seam, retain a failing regression where meaningful, implement the smallest complete behavior, and rerun named gates. Never use documentation word counts or prose pins as product behavior proof.
4. Review the exact proposed diff adversarially. Address findings and re-review semantic changes. Record PR SHA, merge SHA, commands, outcomes, evidence tier and remaining limitations. Hosted CI must be green at both the exact PR tip and merge result before a dependent feature enables. Approval or budget failures are external blockers, not a green result.
5. Update packet status and source-plan status only to the extent proved. Preserve unrelated dirty work and old signed artifacts. The current planning task authorizes these documents, not future code, deployments, secret changes, destructive device resets or publication.

Sizing is calibrated against this repository's XL action workflows (Plans 135–139) and L/high-risk authority work (Plan 179), not a promise of elapsed days. **S** = one bounded session; **M** = a few sessions; **L** = a multi-session integration effort; **XL/program** = several named behavior slices plus an integration gate. An atomic merge can be L or XL even though preparation is split into fresh-context sessions. Re-estimate after RED probes; never split the two runtimes across enabled releases.

## Workflow packets

All packets below are **PLANNED**. For a single-stage packet, listed blockers gate implementation. Composite packets R11/R17/R19/R21/R22/R31/R32/R35 have separately named entry/build/field sub-gates in the execution table below: starting the first stage does not complete the parent or unlock consumers. The sources/path map identifies existing seams; proposed files must not be mistaken for current code.

### R01 — Publish one current group contract

**Blocked by:** none. **Size:** M, with an explicit adoption checkpoint. **Finish:** reviewed contract/amendment PR, not just a draft. **Owner:** product and integration.

Use Plans 158/177/178 to append one current sequence and label superseded ordering without moving or rewriting protected historical text. Prose pins do not define new product requirements, but their asserted strings remain protected until a separately approved contract change. Required artifacts are amendments in Plans 158/177/178, the matching narrow Treehouse vocabulary test change for `archive thread`, current `plans/treehouse_one_pager.html` wording, a roadmap pointer/status in `plans/README.md`, and approved scoped §4a exceptions in `TOWNSHIP_BUILD_MAP.md`. Append source-plan → packet backlinks when adopting this roadmap; keep one execution ledger, not competing DONE statuses. Toolshed one-pager correction remains owned by R26 unless R01 touches that file; any earlier Toolshed copy edit pulls its full D1 correction and focused test forward into that same PR.

The amendment register must explicitly cover: archive semantics and the membership table above; inclusive 150 as an unproven target; the Toolshed isolation countersign; root-only local Treehouse semantics before catalog implementation (reversing Plan 158's `catalog → domain` edge); local catalog proof before public WSS; and replacing the deferred mobile witness ceremony with a gated Android AF-2 ceremony. R19a/R25 own later continuity/dispute vocabulary or wire amendments after their designs exist; R01 does not pre-approve unknown bodies or a fourth Treehouse role.

Request the Shared Beta Contract sign-off for physical Android, QR camera enrollment and cross-device pairing only. Until recorded, those execution stages remain parked; LAN remains parked, and iOS needs a separate R32a scope/hardware sign-off. R31 may reuse already-supported packaged desktop work only; any new parked physical-host scope requires its own explicit exception. Mark Plan 152's additional LAN/CD1 program withdrawn. Disposition Plan 151 as superseded for this delivery program by R10–R15's app-owned Treehouse experience, with reusable code retained; any independent Township instrument remainder moves to R34, not a new Treehouse blocker.

- [ ] Current index, program map, one-pagers and contract tests agree on Treehouse → Toolshed module → Township and on D1/D2/D3.
- [ ] The amendment register and named artifacts are approved and merged, with actual operator countersign/scope approval where required. An unresolved approval means R01 is draft/blocked, not DONE.
- [ ] Retire the additional Plan 152 LAN/CD1 program by status and cross-reference; retain existing shared helpers and regression coverage. Do not re-open M3/M6.
- [ ] Preserve README rows 121/122/178 (exactly one 178 row), Plans 121/122 DONE sentences, the Plan 178 status paragraph in Plan 158, and build-map strings pinned by the Township audit/read-model tests, including `plans 023-133` and `Phase G's audit surface is implemented by Plan 121`. Preserve Plan 178's required-sentence set, quoted-old-claim exemption and single prohibited-phrase paragraph; appended amendments must not add a second such paragraph or an unexempted `nothing hosted`/`serverless` occurrence (`contract_test.exs:147–155,177–202`). Run the three pin suites in the traceability table plus AF-1; only the explicitly approved vocabulary assertions may change, never unrelated fixtures or these protected status assertions.

### R02 — Prove the creation-time founder continuation design

**Blocked by:** R01. **Size:** M. **Finish:** decision record, executable probes and a frozen authority matrix. **Owner:** authority design.

Extend the Plan 175 outcome into a group lifecycle. Enumerate who can issue/renew/revoke each grant, create a Thread, admit transport peers, replace a catalog/service key and authorize a new endpoint after the founder is gone. Specify per-replica witness pins, durable catalog-recovery authority, quorum choice, lease units and renewal path. Test losing the founder before and after parent grants expire, and losing a witness without confusing an AF-3 identity link with witness rotation.

Freeze the enroll-then-root-pin procedure and distinguish beacon witnesses, succession witnesses, configured successor and recovery/catalog delegates. Validate the initial root-only interval, founder loss before pinning (no AF-2 recovery), partial pinning across child replicas, and new child creation after founder loss. Freeze the signed-epoch operations table above and identify the exact operational signer per replica; Toolshed's root-only day rule is unchanged unless a separately adopted Tool policy explicitly replaces it.

- [ ] Matrix covers Space, existing Threads, a newly created Thread and module Tool roots; founder and relay operator cannot be hidden signing dependencies.
- [ ] Probes characterize successor self-issue scope, expiring parent chains and unleased founder grants. No “advance time” result is presented as full founder continuation.
- [ ] Recommend a versioned group policy with explicit residual limits. A new authority semantic is approved here and built in R04, outside Plan 179's frozen legacy behavior.

### R03 — Implement witnessed beacons under Plan 179

**Blocked by:** R01, R07. **Size:** L/atomic. **Finish:** Plan 179 implementation PR. **Owner:** cross-runtime authority.

Reuse the completed spike and step 1. Execute Plan 179 steps 2–9 without revisiting legacy dormancy. Preparation sessions are (a) RED oracle/policy/certificate cases, (b) BEAM plus public expiry/dump paths, (c) TypeScript authoring and verification plus vectors, (d) compaction-mirror parity, adversarial review and evidence. These are one merge unit.

- [ ] Founder-removed Sim case passes; witness quorum, author/deps binding, policy ancestry, bounds, certificate replay and partition/heal negatives agree across runtimes.
- [ ] TypeScript can author leased delegations; old canonical vectors remain byte-identical; `expired?/2` and fresh-VM restore agree with authority reduction.
- [ ] Record narrowed revocation and remaining root power. No broad founder-loss or physical-presence claim is enabled by this packet alone.

### R04 — Close continued group authority after founder loss

**Blocked by:** R02, R03. **Size:** L/atomic. **Finish:** group-authority contract and implementation PR. **Owner:** cross-runtime authority.

Build the minimum approved policy required by R02, using existing delegation and witnessed role succession where sufficient. Prove repeated membership maintenance beyond the initial founder-grant lifetime and bounded successor power; add a versioned group policy only for demonstrated gaps. New behavior must not silently reinterpret legacy Township logs. Make catalog-recovery authorization reusable by R11 without granting the relay semantic authority.

- [ ] Remove founder, admit a member, remove a member, renew necessary authority across at least two expiry cycles and authorize a new Thread; all copies agree.
- [ ] An unleased founder grant remains an explicit negative control unless an approved new contract replaces that limitation. Disallowed self-issued capabilities fail in both runtimes.
- [ ] Quorum loss, hostile witness majority and absent witness-rotation support are stated precisely. If no bounded design passes, block all of R11 (including R11a provisioning), not merely replacement recovery. Consequently there is no live provisioning, two-app sync, packaged AF-1, WSS rollout, custody v2 enablement or later pilot/module/expansion path. R10/R12 may still deliver the explicitly root-only, offline engineering preview. That preview is not the antifragile pilot.

### R05 — Keep signing keys out of diagnostics

**Blocked by:** none. **Size:** S. **Finish:** Plan 170 PR or verified already-integrated disposition. **Owner:** runtime hardening.

Reuse the carrier holder's redaction pattern for identity inspection and the projection process. Route every new export/diagnostic surface through this boundary.

- [ ] Forced inspect/status/crash scenarios cannot render seeds/private keys; ordinary useful health and refusal evidence remains available.
- [ ] Run Plan 170's focused cases and required regression gates; do not put real user secrets into fixtures or logs.

### R06 — Verify every recovery input before trusting it

**Blocked by:** none. **Size:** M. **Finish:** Plan 171 PR. **Owner:** persistence and evidence.

Apply the explicit consumer policy to log restores, outsider bundles and registry loads. Recovery inputs are adversarial signed data, not trusted because they decoded successfully.

- [ ] Invalid signatures, wrong root/replica, corrupt/truncated input and mismatched declared inventory fail closed before replacing state.
- [ ] Restore never fabricates a fresh identity or empty community; valid retained signed bytes remain replayable. R16 uses this exact seam.

### R07 — Finish canonical-encoder strictness

**Blocked by:** none. **Size:** S–M. **Finish:** Plan 172 PR or proven equivalent integration. **Owner:** TypeScript codec.

Treat Plan 172 as unstarted unless an executor identifies an exact prior SHA and proves equivalent integration against the current base; no unnamed stash or branch is a prerequisite. Close duplicate canonical map/set terms and noncanonical Base64 without relaxing production validation. If legacy fixtures conflict, classify and deliberately amend the fixture contract in scope, preserving Plan 179's named byte-identical legacy vectors. R07 owns `codec.ts` and the vector corpus until its merge, then hands them to R03.

- [ ] Valid BEAM/TS byte parity holds; duplicate canonical values and noncanonical encodings are rejected with focused negative tests.
- [ ] Source, built consumer paths and declared fixture behavior agree; existing work is preserved and no branch/stash is deleted.

### R08 — Bound transport time and page large pulls

**Blocked by:** none; Plan 169 is already merged. **Size:** M/atomic for pagination. **Finish:** Plan 173 PR(s). **Owner:** carrier.

Use two review sessions: connect/setup deadlines first, then the paged pull protocol and both clients together. Keep per-frame limits and preserve full replay across page boundaries.

- [ ] Unreachable/slow peer setup terminates within a declared deadline; retries stay bounded and user-visible.
- [ ] Logs exceeding one frame converge byte-for-byte through interrupted/resumed pagination; malformed, repeated or inconsistent continuation cannot skip or invent operations.

### R09 — Enforce wire and authority input bounds

**Blocked by:** R07, R08. **Size:** M. **Finish:** Plan 176 PR. **Owner:** boundary hardening.

Apply the plan's lease-range, decode-depth, replica-marker and op-kind checks across the real ingress path. Preserve the separation between semantic quarantine and transport admission.

- [ ] Malformed/deep/oversized/foreign-replica inputs fail predictably before expensive work or visible effects, with BEAM/TS reason parity where applicable.
- [ ] Valid boundary values and multi-page logs still work; no parser or authority limit is raised just to pass a product benchmark.

### R10 — Land the complete Treehouse semantic core

**Blocked by:** R01, R07, R09. **Size:** XL/atomic integration. **Finish:** complete root-only domain/parity PR with a runnable offline demo. **Owner:** Treehouse domain.

Reuse `Lattice.Replica`, causal policy context, full-frontier conflict handling and the frozen Plan 178 commands plus R01's approved archive extension. Preparation slices are R10a create/membership/invitations, R10b posts/edits/tombstones/effects, R10c roles/removal/archive/references, and R10d reciprocal authoring/replay integration; each keeps BEAM and TS together. They merge atomically as an XL unit, never as half-enabled runtimes. Use the existing root-only authority and witnessed-succession replay shapes, with no founder-continuation claim. Catalog inputs are signed fixtures; live provisioning is R11. R14 later binds the approved R04 continued-authority profile into the group; R18 tests it. Demonstrate a local Space/Thread post/edit/replay path without R04 or a live catalog.

- [ ] Space/Thread state, authority, application quarantine and derived effects agree across runtimes and every arrival order, partition/heal and dump/restore case.
- [ ] One signed command retains one identity and one all-or-none verdict; wrong-author edits, quarantined targets, stale moderators, rebound invites and partial effects refuse.
- [ ] Archive, concurrent edits/posts and member-removal races follow explicit rules; no claim of global instantaneous revocation across offline replicas.

### R11 — Provision replicas and recover catalog trust

**Blocked by:** R02, R04, R06, R10. **Size:** L; three sequential PRs. **Finish:** a locally runnable lifecycle, then recovery. **Owner:** catalog and carrier.

Reuse manifest-driven carrier instances. R11a adds signed transport catalogs and assisted provisioning; R11b adds durable creation/removal reconciliation; R11c proves replacement service/catalog identity through R04's pre-authorized trust path. R01 must adopt both ordering inversions: fixture-based domain before catalog and local catalog before public WSS. Local tests use explicitly disposable signing identities. Before real replica provisioning, the operator generates the catalog key, the living root reviews and signs its bootstrap/service binding, and encrypted separate signing-key backup is verified. R16/R18 packaged tests use independently generated test-profile credentials through that same real ceremony; R21/R22 field gates use the selected pilot profile, never fixture trust injection.

Keep Plan 158 Decision 2: no public admin API. Only the named operator runs `pilotctl` on the host; a surviving member supplies authorized signed intent but the operator supplies transport liveness, not semantic authority. R15 and R18 may remain `carrier_pending` until that operator acts. The supported initial host serves one group: 1 Space + 12 Threads + 1 Shed + 20 Tools = at most 34 routes, below 64; no second full group is silently co-hosted.

- [ ] `local_draft → genesis_created → carrier_pending → listed` survives a crash at every transition without duplicate genesis/routes or phantom entries; readiness precedes publication.
- [ ] Extra/missing/mismatched catalog entries never confer semantic visibility or permission. Reconcile removal and exact-audience grants; preserve 64-route/4-socket bounds.
- [ ] An installed client with retained trust accepts the authorized replacement and rejects rollback/forged replacement, even after founder loss. Old service and catalog keys are not magically available in this test.

### R12 — Create an empty native group and retain local work

**Blocked by:** R01, R05, R06, R10. **Size:** L. **Finish:** one native local-preview slice. **Owner:** app and persistence.

Reuse shared product isolation, SQLite migrations, protected signing and the Tauri/Vue shell patterns. Introduce the Treehouse product entry point with empty boot, create-space preview, saved local draft, one local Thread and durable offline post/edit. Creation remains visibly local until R11 provisioning completes.

Display unset witness/catalog-recovery profile fields and `recovery_not_ready`; root-only creation is not AF-2 readiness. This preview issues no member grants of any kind, leased or unleased. Actual member admission in R13 already depends on R03 through R11/R04 and must use the approved leased-authoring path. The demo can complete offline without R04/R11, subject to R01's adopted scope; it carries no multi-device or physical recovery claim.

- [ ] Fresh app contains no Township fixture or environment-seeded peer; force-stop/reopen retains key, drafts, frames, outbox and selected group.
- [ ] Migrations fail closed, unknown product/schema is refused, and Township/legacy Toolshed storage and schemes cannot cross-read.
- [ ] Local display is derived from verified frames; pending transport is distinguishable from a signed local action.

### R13 — Join two apps and converge through foreground sync

**Blocked by:** R08, R11, R12. **Size:** L. **Finish:** one enrollment/sync integration PR. **Owner:** app enrollment.

Reuse confirmed QR image/deep-link inputs, native permission seams and public-key pairing. A joiner creates its own key; a reviewed recipient-bound exchange separately completes transport admission and semantic grants. Add Android camera permission/regrant and cold-start queued links. Synchronize current Threads with at most four live sockets and recover the durable outbox after disconnection. This packet enrolls the member/carrier identity only; R14 later adds the reviewed witness binding from R36. Enrollment alone never implies witness status.

- [ ] Two independently keyed apps join and exchange offline posts and edits; retry yields one semantic effect and acknowledged outbox drain.
- [ ] Wrong product/recipient/replica/server, revoked/rebound invitation, malformed QR and permission refusal cause no unauthorized durable change; preview drafts are explicitly user-created state.
- [ ] New Threads reach existing members; missing routes are unavailable rather than empty. No LAN discovery, secret-bearing invite or background-delivery claim is added.
- [ ] A pre-rollover invite cannot admit against an expanded catalog without fresh review/grants. Post-rollover admission enumerates archive read scope and all per-replica pending grants; current and archived Threads share a tested fair four-socket scheduler.

### R14 — Make roles and member removal work in the app

**Blocked by:** R13, R04, R36. **Size:** XL integration, three behavior sessions. **Finish:** governance/profile/renewal workflow PR. **Owner:** group workflows.

Expose admin transfer, moderator change, invitations and the removal reconciliation state. Use real signed authority and each replica's issuer; transport removal is a distinct step.

R14a binds the approved R04 authority policy and builds enroll-then-pin: the living root reviews R36's independently provisioned and member-bound protected witness public keys, successor, threshold, beacon bounds, leases and transport-recovery authority, then authors a valid root genesis for each required replica. R14b builds role/removal and current/archive membership fan-out. R14c exposes issued/expiring/lapsed leases, pre-expiry warning, scoped reviewed renewal batches with per-grant outcomes, pending/failed renewal and stale-epoch consequences. Root genesis is not silently rewritten; all raw history stays signed. Native witness collection is R17b, but R14 must make pinning and readiness visible first.

- [ ] Old moderator actions quarantine after valid transfer; author and moderator tombstones are visibly attributable and preserve audit evidence.
- [ ] Remove a member across Space and existing Threads, including an offline issuer; list outstanding grants and keep `removal_pending` until actual completion.
- [ ] Neither read-history erasure nor immediate worldwide revocation is claimed; future Threads do not accidentally re-admit a removed member.
- [ ] Founder loss before pinning leaves an explicit unrecoverable-profile state; partial per-replica pinning is not AF-2-ready. New Threads pin the approved profile at creation; a dead root is never impersonated to retrofit one.
- [ ] Pinning alone cannot bless a preview with unsuitable grants. Audit every required founder-issued member grant; revoke/reissue unleased grants while the root still lives, or refuse AF-2 readiness. No after-loss repair of an unleased grant is implied.
- [ ] Test renewal across two expiry cycles, lapsed permission mid-conversation, unavailable quorum, stalled epoch and stale-catalog invitation. No silent authority reset or automatic unbounded renewal occurs.

### R15 — Archive busy threads and measure growth

**Blocked by:** R14. **Size:** L. **Finish:** one volume workflow PR. **Owner:** group instrument.

Add op/byte/cold-open measurements, a warning and explicit rollover control. Archive and successor provisioning form a durable, recoverable workflow. Archived content remains replayable; display late offline drafts/refusals with an intentional “copy to new thread” action.

- [ ] At 3,200 ops/6.4 MiB warn; at the approved hard thresholds stop local new posts, preserve evidence and offer rollover. Measure total stored evidence, including quarantined data, rather than only visible posts.
- [ ] Crash between archive and successor creation recovers; repeated taps create one successor; imports cannot rewrite old signed history.
- [ ] Test the 12-total-Thread cap including archives, simultaneous offline overshoot, exhausted catalog slots and >5-second cold opens. The system continues receiving bounded evidence needed to converge; it never promises a global hard op cap without coordination.
- [ ] The rollover successor is created with the approved beacon/succession profile pinned; incomplete pinning keeps the Space visibly partial/`recovery_not_ready`.
- [ ] Archive read grants, post-rollover membership and stale invitations follow R01's table. Routes/slots are retained; operator provisioning wait is visible and retryable, with no background self-service admin API.

### R16 — Export member evidence and pass packaged AF-1

**Blocked by:** R06, R11, R15. **Size:** M. **Finish:** export/reseed workflow and packaged gate. **Owner:** recovery.

Turn the existing relay-reseed oracle into a user-operated workflow. Export exact verified frames plus necessary public pairing/admission/catalog trust state and an integrity manifest; no signing seeds. Validate into staging, show the replacement trust decision, seed a new path and reconnect installed members without discarding their local histories.

- [ ] Destroy the test relay and its disk, reseed a new service identity from member-retained state and reconverge in two packaged apps against Sim; no old-server backup is consulted.
- [ ] A stale export is visibly labeled incomplete when another retained copy demonstrates missing ops; an isolated stale copy cannot prove completeness and must not say it can.
- [ ] Oversized/tampered/wrong-root/partial bundles fail before state replacement; replayed export/import is idempotent. Content-bearing exports stay member-controlled and out of telemetry.

### R17 — Deliver the native witness ceremony

**Blocked by:** none. This is R17a's entry gate only. **Size:** M decision, L/high-risk Android build, then a physical gate. **Finish:** Plan 174 decision followed by a verified native ceremony. **Owner:** native custody.

R17a finishes Plan 174's read-only decision and opens its follow-on build plan. It may begin before the app exists and must account for native provenance, rollback, prompt truth, caller/session-bound single-use authorization and the BEAM/TS/native conformance burden. R36 uses R17a's adopted native architecture to provision distinct witness identities before R14 pinning. R17b requires R17a, R03, R14 and R01's explicit mobile-ceremony/scope amendment. Implement Android protected signing, truthful presence/claim review and durable collection for the exact beacon/role claim; macOS `LAContext` is not Android evidence. R17c records independent physical Android witness evidence before R18. Plan 146's real-presence macOS path is currently blocked on codesigning; it is an external gate only if macOS is selected as a supported witness platform, never substituted for Android verification. iOS remains R32.

Default failure branch: if native verification, protected custody or required physical presence cannot be proved on the selected Android profile, R36/R14 cannot establish a supported witness profile when custody itself is unproved; a later claim-verification/presence failure blocks R17b/c and R18/R22/R23. Either failure stops the strong group release and its downstream Toolshed module/pilot, iOS, lifecycle/capacity expansion and Township-resumption gates (M3–M6). Root-only preview, hardening and already-authorized fixture/core preparation may proceed under their actual blockers; R24/R25 semantics may proceed only if R11a and their other core gates passed, never as module enablement. R26/R30 and R34 remain blocked, not silently converted into preview releases. Software-only signing may support the labeled core/offline engineering preview; it cannot pass the physical AF-2 gate. Any later proposal to accept software-only witnesses needs explicit operator approval and revised threat/claim contracts before execution; this roadmap does not choose that downgrade.

- [ ] Each witness sees the group, action, epoch, dependencies and lease-lapse consequence; cancellation, interrupted signing, substituted claim and duplicate signer refuse.
- [ ] Threshold collection persists safely and resumes without reusing consent for changed author/deps; secret material stays behind the native boundary.
- [ ] Record software-only, native protected signing and physical user-presence evidence separately, with exact package/version and remaining platform limitations.

### R18 — Pass packaged founder and combined-loss gates

**Blocked by:** R04, R11, R15, R16, R17. **Size:** M. **Finish:** recovery workflow integration and evidence. **Owner:** recovery and QA.

Remove the founder's test device/key from the usable environment. Surviving witnesses recover the admin role, advance time, manage membership and create/roll over a Thread. Repeat with the relay and catalog signing identity destroyed as well, using only retained member evidence and the creation-time recovery contract.

The operator still provisions/reconciles the replacement host and new routes under R11's assisted contract; record that transport-only action and its latency. The operator never supplies founder/root signatures. The runbook names the signed-epoch coordinator, reachable quorum and missed-ceremony response before the drill.

- [ ] Packaged AF-2 reproduces Sim state/frontier/quarantine, including lease renewal/removal across two grant lifetimes; every action has a surviving authorized signer.
- [ ] Combined founder+relay loss passes approved endpoint/catalog replacement and new-thread provisioning; no hidden founder key, server backup or injected test-presence bypass supplies authority.
- [ ] Below-threshold witnesses and unleased founder grants retain the stated refusal/limit. Claim updates are a separately reviewed part of this completion, after evidence exists.

### R19 — Design and prove social identity continuity (AF-3 core)

**Blocked by:** R01, R02. These gate R19a only. **Size:** M decision then L/atomic build. **Finish:** R19a approved continuity contract; R19b BEAM/TS parity. **Owner:** identity continuity.

Specify a group-scoped attestation through existing op kinds, binding old key, new key, Space and evidence references; require new-key challenge possession and approved current-member witnesses. Keep historical signatures unchanged. Resolve competing links, stale/removed signers, replay, revocation and partial frontiers deterministically. Ordinary member recovery must not rotate a genesis root or witness set.

R19a explicitly amends Plan 178's command contract and the exact ordered vocabulary assertions if new user commands are required; current-member attesters are not a fourth Treehouse role. It records the effect on open Toolshed loans and pre-loss receipts: an identity link does not authorize a transfer from the old key. R19b requires R19a, R04 and R10 plus the adopted amendment; only R19a belongs to M1, while R19b completes in M3.

- [ ] A current-member quorum can attest a replacement, but the link alone grants no membership/capability and cannot forge an old signature.
- [ ] Conflicting links remain auditable and produce a deterministic unresolved/selected state; no ambiguity silently transfers authority.
- [ ] Cross-Space replay, removed witnesses, a substituted new key and an outsider's self-link refuse. Old-key receipts remain old-key receipts, including after a valid link.

### R20 — Rejoin on a new phone and pass packaged AF-3

**Blocked by:** R14, R19. **Size:** M. **Finish:** member-loss app workflow and gate. **Owner:** enrollment and recovery.

Provide the new-device challenge, witness review, explicit re-admission and history-link presentation. Revoke or lapse the old key's grants and remove transport admission with the same honest pending states as ordinary removal. Do not turn a social attestation into access to lost private keys.

- [ ] Fresh device with a new key receives verified history, displays the old/new link and gets deliberately issued new grants; all current copies converge.
- [ ] Old phone returns after recovery: stale capabilities and pending removal behave exactly as documented, with no duplicate identity silently treated as one signer.
- [ ] Key loss by a root/witness is identified as a different case; any loss of quorum is visible. Same-key receipt presentation cannot be claimed for receipts signed only by the lost key.
- [ ] Pre-loss outstanding loans are not silently relabeled to the new key. Until R25 adopts a separately signed loss/dispute fact, exact old-key custody closure remains unavailable; no fabricated ordinary return resolves it.

### R21 — Operate the supported WSS relay and rehearse restore

**Blocked by:** R05, R06, R08, R09, R11. **Size:** M build then field gate; separate deployment and restore evidence. **Owner:** operations.

Reuse the existing pilot release, manifest and health boundaries. Supply TLS, DNS, volume durability, least-privilege service configuration, redacted logs, backup inventory and signed cutoff. Rehearse clean-host restore with the same service identity from encrypted backups, then replay client-held post-cutoff ops. This is distinct from R16's new-identity reseed. Local deployment artifacts can be prepared before operator access exists.

- [ ] Supported Linux filesystem persists acknowledged ops through process and host restart; readiness stays false during corrupt/partial restoration.
- [ ] Wi-Fi and cellular WSS, certificate renewal, backup-age alert and controlled restart work; daily encrypted backup has a declared 24-hour disaster RPO and cannot promise post-cutoff data held nowhere else.
- [ ] Operator supplies host/DNS, backup destination and recovery credentials. No public rollout, secret mutation or destructive drill occurs merely because this roadmap was written.

### R22 — Release and verify the Treehouse Android candidate

**Blocked by:** R15, R16, R18, R20, R21a. This is R22a's build gate; R22b also requires R21's field restore. **Size:** M build then physical gate. **Finish:** internally distributed artifact and immutable device report. **Owner:** release and device QA.

Adapt the existing signing, artifact manifest and non-destructive harness to the Treehouse package. Use one exact artifact on unrelated physical Android phones and enough independent witness devices to meet the approved quorum after founder loss. Emulator/macOS evidence remains supporting evidence.

- [ ] Non-debug pilot signature, APK hash, Git SHA, version and installed artifact match; no developer tether, seeded identity, fixture fallback or public cleartext path.
- [ ] Real camera/link join, Wi-Fi/cellular, offline heal, force-stop, reboot and signed N→N+1 upgrade preserve keys and replayable state. AF-1/AF-2/AF-3 and combined loss pass on the target devices.
- [ ] Three cold opens at 5,000 ops/10 MiB each meet five seconds in a separate synthetic benchmark profile: deliberate headroom above the 4,000-op/8-MiB product stop, per Plan 158. Exact scoped deletion/reset requires operator authorization; existing user data is never the benchmark fixture.

### R23 — Run the twelve-person chat pilot

**Blocked by:** R22. **Size:** field work, at least 14 days. **Finish:** pilot report and go/no-go. **Owner:** pilot lead.

Use one real group of 9–15, targeting 12 people, for ordinary daily text coordination. Provide the reader/hosting disclosure, recovery instructions, support owner, release provenance and exit/export path. Measure workflow success, sync failures, local growth, cold-open latency and support incidents without central collection of message content.

Name an on-call provisioning operator and a daily signed-epoch coordinator/quorum; record both availability and missed ceremonies. Disclose operator-assisted new Threads, the finite Space lifetime, and the later Toolshed same-key receipt limitation. AF-1 is the group-survivor recovery promise; R21's encrypted same-identity disaster restore is an additional supported operator procedure. Rehearse both on agreed test profiles, plus the combined founder+relay case; do not conflate their retained-data assumptions.

- [ ] Rehearse relay, founder, member and combined loss on agreed test profiles; record actual outcomes and the limits people encountered.
- [ ] No unexplained lost acknowledged/retained op, unauthorized visible effect, identity reset or unrecoverable outbox; rollover and all threshold stops are usable.
- [ ] Record actual renewal grants/signatures/prompts per coordinator and replica, batch completion/retry latency, missed-renewal rate and lease-op share of the 4,000-op budget across two cycles. If the adopted cadence is not operable, stop and amend R02/R14; do not silently extend grants.
- [ ] Members see lease warnings, lapsed permissions, stale epoch and an authorized renewal or explicit renewal-failed state. Record quorum-unavailable and provisioning-operator-unavailable rehearsals; no wall-clock authority or hidden root fallback may keep the test green.
- [ ] Publish an evidence-based continue/fix/stop decision. Fourteen days is a minimum observation window, not a guaranteed completion date; fixes that alter the behavior restart its affected observation window.

### R24 — Bind every custody transfer to the exact loan

**Blocked by:** R03, R09, R11a. **Size:** M/atomic. **Finish:** custody v2 transfer PR. **Owner:** custody semantics.

Reuse the merged causal policy prerequisite; do not rebuild it as a new PR. Implement the offer/request/transfer v2 wire and canonical consent contract in both runtimes, including parties, direction, tool, request, original grant, due epoch and exact active loan. Retain legacy bytes for audit and quarantine them from beta custody state.

- [ ] Borrow requires active authorized grant and receiving party consent; return binds the original borrow and remains possible after expiry/revocation.
- [ ] Unrelated ancestor/grant, wrong party/tool/loan, unilateral return and reused request fail. Concurrent valid resolutions select one canonical winner in both runtimes.
- [ ] Legacy v1 restore does not crash or silently change meaning; exact due dates cannot be altered by an unrelated later lease.

### R25 — Add honest admission, decline and dispute facts

**Blocked by:** R24. **Size:** M/atomic. **Finish:** custody v2 admission/decision PR. **Owner:** custody semantics.

Bind admission to the invitee and implement authorized explicit decline with completed > declined > pending precedence. Freeze how a subject's signed dispute references an exact request/loan through an existing durable op kind; if no existing payload can express it faithfully, approve a narrow versioned payload before building it. This happens here, never as a hidden write in the read model.

Before this build, amend the Toolshed custody contract in Plan 158 and the consent/wire contract in Plan 0007 as needed, plus their behavioral tests; change Plan 178's ordered vocabulary only if the adopted group-level command surface actually changes. Explicitly specify the lost-signer case with R19a: a new-key attestation/dispute may record claimed physical return, but cannot masquerade as ordinary old-key co-signed loan closure. Any new exceptional closure policy needs its own adopted versioned semantics and adversarial parity cases; otherwise leave the loan unresolved with that limitation visible.

- [ ] Only the correct holder/receiving party can decline the exact request; completion cannot be hidden by a later/concurrent decline.
- [ ] An open request is **pending**, not proof of refusal, theft or fault. Both parties' signed statements are distinguishable from co-signed custody facts.
- [ ] Dispute reference, authorship, invalid lineage and cross-tool replay have matching BEAM/TS verdicts; no score or broadcast is introduced.

### R26 — Enable Toolshed inventory inside the group app

**Blocked by:** R01, R11, R14, R23, R25. **Size:** M. **Finish:** module shell/inventory PR. **Owner:** group module.

Use the adopted Treehouse identity/namespace contract to enable one Shed and up to 20 Tools inside the app. Reuse catalog provisioning and the group membership UI without collapsing each Tool's owner/root/issuer authority into the Space admin. Each new Tool's founder-loss guarantees are determined by its own creation policy.

Use only Treehouse's app/key/database row for this module. Keep the legacy Toolshed product row reserved/dormant, with no automatic identity import; R01 adopts the collision-contract change and R26 updates the shared product manifest's TS and Rust contract tests. The host topology remains one group, at most 34 group/module routes. Add the root-only `Assert current day` workflow: show exact UTC-day assertion/provenance, refuse wrong signer/rollback/duplicate, require extra review for a large jump, and show stale last-known day after owner/root loss without wall-time fallback. Witnessed group epochs are not automatically Tool epochs.

Correct `plans/toolshed_one_pager.html` to D1 while touching module copy: remove the unqualified `nothing hosted`/`serverless` promises, enumerate readers and the withholding host, and add a focused copy-boundary test using Plan 178's pattern. Preserve the separate custody, Tool-root-loss and lost-receipt-key limitations.

- [ ] Enable/disable module and list/create a Tool without a second app or copied private key; partial provisioning is visible and recovers idempotently.
- [ ] An admin or relay operator cannot sign for a Tool owner; removal across two Tool roots, including an offline owner, exposes unresolved semantic grants.
- [ ] Shared-group membership does not silently confer custody or Toolshed access; app/database isolation from Township remains intact.

### R27 — Complete offline borrow and return by QR

**Blocked by:** R13, R25, R26. **Size:** M. **Finish:** custody workflow and physical ceremony evidence. **Owner:** module UX.

Reuse Plan 160's QR-physics investigation after checking its evidence status. Bind two-phone offers/challenges to exact loan, parties and consent bytes; show both parties what they sign. Both phones durably store before success; later carrier sync performs convergence. No NFC/photos are required.

- [ ] Borrow and return work with the network disabled using actual camera scans and independent keys; partial/cancelled/duplicate exchanges resume or refuse explicitly.
- [ ] Tampered/replayed/wrong-loan payloads refuse; a third physical phone with a fresh independently generated identity, deliberately admitted and granted the required read scope, reconstructs the same custody audit. An unadmitted outsider gets no implicit access.
- [ ] Capture the timing intervals Plan 158/160 specify, including decode/consent/durable-completion boundaries. A transfer is not shown successful merely because one phone has a signature.

### R28 — Derive the factual custody ledger with zero writes

**Blocked by:** R25, R26. **Size:** M. **Finish:** pure read-model/UI PR in both runtimes. **Owner:** projections.

Extend the existing single-Tool read model across the authorized Tool logs. Per member show transfer records, dated/co-signed returns, which returns meet the exact signed due epoch, open requests with Tool-root-signed epoch age, and linked disputes. Under unchanged Decision 5 only the Tool root supplies those day assertions; group witnesses do not advance Tool time by implication. Present records, not a numeric or ranked reputation aggregate. Label due performance as relative to signed causal evidence, not independently proven wall-clock punctuality.

- [ ] Observing/exporting the ledger adds **zero operations**, makes no network authorization decision and never uses wall time to invent elapsed signed epochs.
- [ ] Missing/stale epochs or incomplete logs show unknown/stale coverage; current holder/receiving party and disputed facts remain visible. An aging pending request is not labeled an explicit refusal.
- [ ] BEAM/TS results match after partition/heal and replay, including changed canonical winners and late returns. Old signatures retain their original identity attribution.

### R29 — Present receipts with the subject present

**Blocked by:** R20, R27, R28. **Size:** M. **Finish:** local presentation workflow PR. **Owner:** evidence UX.

Let a subject choose co-signed receipts and sign a fresh verifier challenge bound to the shed, verifier/session, selected evidence digest and nonce. Verify the signed log context, both custody signatures and the exact same subject key. This is a presentation envelope, not a new reputation op or registry. The verifier displays “selected receipts,” not a completeness claim about hidden history.

- [ ] Wrong subject/key/shed, reused challenge, changed receipt selection and tampered lineage refuse; no automatic broadcast or remote reputation lookup occurs.
- [ ] Linked disputes known in the presented/current authorized context are shown; unavailable history is disclosed. A subset of good receipts cannot be described as the subject's complete record.
- [ ] A member with a replacement key may present the AF-3 link as a separate fact but cannot prove possession of a lost receipt-signing key. Cross-shed portability remains deferred.

### R30 — Run the Toolshed household pilot

**Blocked by:** R23, R27, R28, R29. **Size:** field work, 7–14 days. **Finish:** household-pilot report. **Owner:** pilot lead.

Use 5–8 households within the proven group to lend real tools. Test an ordinary return, overdue return, explicit decline, unanswered request and dispute; capture friction and correctness. Use the co-signed handoff as the success boundary and preserve physical third-device audit evidence.

Name each Tool's daily day-assertion owner and record the stale-root/offline branch. Disclose that a lost receipt key prevents future same-key presentation of earlier receipts, and that social re-admission does not close an old-key loan. Observe whether participants encounter these limits, and rehearse them on an agreed synthetic profile even if no real loss occurs.

- [ ] Participants complete the flow without operator-signing or fixture injection; outstanding requests, disputes and missing evidence are legible.
- [ ] No one is assigned a score or publicly accused by an automated interpretation of silence. Success is usable custody evidence, not guaranteed honesty or theft prevention.
- [ ] State what was observed, what failed and whether to continue. The one-pager's 90-day/two-neighborhood claim is a later evidence program.

### R31 — Offer member device hosting (optional)

**Blocked by:** R08, R11b, R16. **Size:** M runtime then M packaged; two PRs. **Finish:** scoped Plan 150 option. **Owner:** carrier host.

Package the reusable carrier as the Plan 150 desktop sidecar, with explicit start/stop, paths, admission, identity, backups and resource bounds. Join through confirmed QR/deep link. The pilot may already use a member-operated Linux relay; this packet adds app-managed hosting and does not promise mobile background uptime.

- [ ] Host loss/reseed, restart, key custody and read-only/relay refusal matrices pass in the supported packaged environment.
- [ ] UI enumerates readers and the withholding host; transport admission stays separate from semantic membership. No LAN discovery/NAT traversal/public-TLS promise is inferred from desktop host mode.
- [ ] Android/iOS host mode requires separate lifecycle/battery/platform evidence; it is not silently included or a gate for R23.

### R32 — Deliver physical iOS after Android (optional)

**Blocked by:** R23. **Size:** M signing/archive then physical gate; separate chunks for build and evidence. **Finish:** Treehouse TestFlight candidate and device report. **Owner:** iOS release.

Reuse shared protocol, persistence and enrollment behavior. Supply product bundle IDs, Keychain services, provisioning and App Store Connect credentials. Run physical force-quit, reboot, signed upgrade, WSS, camera/link and three-loss tests with independent witness devices. If Toolshed is included, R30 is an additional blocker.

- [ ] Physical iPhone identity/history survive reboot/upgrade and the exact distributed build passes group acceptance; simulator process-relaunch evidence is labeled separately.
- [ ] Native witness guarantees match the approved R17 claim or are explicitly limited before release.
- [ ] Toolshed is a module in the group app; there is no revived three-separate-app release order.

### R33 — Measure expansion toward 150 members

**Blocked by:** R23, R35. **Size:** M harness, then staged field gates. **Finish:** supported capacity declaration within R35's adopted lifetime envelope. **Owner:** performance and pilot.

Use the adopted inclusive boundary only after R01. Measure 12, 50 and 150 members, plus 149/150/151 admission boundaries, under mixed online/offline activity, archive growth, reconnect, removal and loss recovery. Keep 12-total-Thread, 64-route, four-socket and per-thread limits unless R35's separately approved measured amendment changes a named limit. The initial approximately 48,000-op Space lifetime is only about 320 operations per person at 150 and includes overhead; member-count admission alone is not durable capacity evidence.

- [ ] Record op/byte growth, cold-open distribution, memory/storage, paged sync completion, authorization/recovery latency and failed actions on minimum supported phones.
- [ ] Meet the declared five-second cold-open budget and correct bounded failure states at every stage; stop expansion on any consistency or recoverability defect.
- [ ] If archives exhaust the current catalog, design and test a capacity-policy change before widening. Do not call reference removal compaction or discard signed history to make the benchmark pass.

### R34 — Resume Township from the shared evidence (later)

**Blocked by:** R23. R30 is additionally required before a Township product pilot. **Size:** follow-on program, split using Plan 158 B1/B2. **Finish:** a separately scoped Township roadmap/update. **Owner:** Township product.

Reuse proven carrier, catalog, database, Android release and recovery primitives. Re-baseline Township's empty boot/create/join/post-edit/instrument/device/pilot tickets against what landed. Keep civic authority, M4 elections and Township's legacy succession non-claims distinct from Treehouse proof.

- [ ] Identify remaining Township behavior with tests rather than repeating completed foundation work.
- [ ] Issue bounded B1/B2 implementation packets and their own seven-day pilot gate; Treehouse completion does not confer Township readiness.
- [ ] M3/M4/M6 or production compaction requires a separate product/research decision, not automatic inclusion in this program.

### R35 — Prove the lifetime policy before expanding the group

**Blocked by:** R15, R23. **Size:** M decision/measurement, then explicitly scoped implementation slices if adopted. **Finish:** approved lifecycle policy and evidence for R33. **Owner:** capacity and lifecycle.

R35a uses observed pilot growth to measure the 12-slot/approximately 48,000-op lifetime, bytes, archive replay and join/removal fan-out, including authority overhead. Compare retaining a bounded finite-lifetime Space with an explicitly consented fresh-Space restart against a revised archive/route policy that preserves authenticated history without production compaction. Recommend one with supported device, storage, retention, retrieval and operator costs. No automatic identity migration, discarded signed bytes or silent cap increase is permitted.

R35b implements only the separately adopted change, through a concrete follow-on slice plan with owners and BEAM/TS/recovery gates. If the decision retains existing limits, R35b instead records a no-build disposition and proves end-of-life behavior; R33 may declare only that bounded lifetime, never indefinite service. If neither path is acceptable, expansion stops at the observed pilot cohort. R35 cannot be closed as merely “design later.”

- [ ] Exhausted Space is readable/exportable and rejects new posts/Threads consistently. Starting a new Space is visibly a separate community with new genesis and explicit admissions, not federated continuation or recovered key ownership.
- [ ] Any archive-policy change has positive/refusal, cold-device full-history retrieval, retained-anchor recovery, slot accounting and removed-member tests, with both runtimes agreeing.
- [ ] R33's release declaration names both member count and measured lifetime/storage envelope; it cannot pass on a member-limit benchmark alone.

### R36 — Provision protected witness identities before root pinning

**Blocked by:** R01, R12, R17a. **Size:** L, bounded native identity bootstrap. **Finish:** protected key provisioning and public-identity binding PR. **Owner:** native custody and enrollment.

Use R17a's adopted Android architecture to create the distinct protected governance-witness key purpose before R14 needs its public key. Existing native code deliberately separates this key store from carrier/member identity and rejects a governance key through carrier signing. Do not alias that key, export its seed, import an old device-bound macOS key or expose a generic signing command to solve the sequencing problem.

Provision through a typed native operation; export only public identity and platform/custody metadata. R14 consumes an explicit member-reviewed binding between the identity enrolled by R13 and the witness public key. If witness binding requires possession proof, R17a specifies a fixed, domain-separated identity-binding challenge with exact caller/recipient/session bounds; it cannot sign beacon, role or arbitrary payloads. R17b later implements verified witness claim/presence authorization. No witness powers become usable just because a key was provisioned.

- [ ] Independent devices produce distinct persistent witness keys; protected-key/public-binding state survives restart and refuses wrong caller, member, product, recipient and stale binding replay.
- [ ] Carrier/member signing cannot use the witness key; arbitrary payload requests, secret export and silent software fallback refuse.
- [ ] Missing or unprovable protected custody blocks this packet and R14's supported pinning, while R12's root-only preview stays available. Record exact native/core evidence; physical presence/claim proof still belongs to R17c/R18.
- [ ] Pin only these reviewed public identities, never placeholder or ephemeral keys. Loss/replacement after pinning requires a separately approved witness-rotation policy, not AF-3 or automatic rebinding.

## Scheduling and merge boundaries

Recommended initial frontier: **R01, R05, R06, R07, R08 and R17a** (the last is the read-only native decision, not a ceremony build). R01 settles contract authority while hardening proceeds. R03 waits for R07 to merge; `codec.ts`/legacy bytes are owned by R07, then R03. The integrator serializes vector-corpus writes by reservation across R03/R04/R09/R10/R19b/R24/R25; design and source-only work can overlap, but no second writer regenerates or amends reserved vectors. Before each handoff verify Plan 179's eight named byte-identical legacy vectors; R07 has no authority to alter them. R10/R12 can deliver a root-only local preview without R04. R11/R21 establish operational readiness before device/pilot claims.

Use a maximum of three active implementation lanes plus one integrator if multiple executors are authorized. Suggested lane ownership is authority/protocol, app/product, and carrier/operations. The integrator owns the ledger, contracts and merge queue. A single executor uses exactly the same dependency frontier sequentially.

Atomic groups are R03, R04, R10, R14, R24/R25 individually, and the build part of R19. R08 pagination also merges server and both clients together. Preparation sessions can produce reviewable commits/checkpoints; completion is at the group gate, not “BEAM done.” Split the L-sized catalog packet into the three ordered PRs named in R11. R17, R19, R21, R22, R31 and R32 explicitly separate decision/build/field evidence; do not keep a code session waiting for hardware or a two-week pilot.

### Composite packet stage gates

Sub-IDs are executable handoffs, not independent feature-enable permissions. A dependency on a parent R-number requires its final listed stage. M1 alone names R19a, not the completed parent. R24 names catalog build R11a; R22a names operations build R21a and leaves the field restore gate on R22b. R31a consumes lifecycle build R11b, but intentionally also waits for R16's completed packaged export/reseed workflow (and thus full R11); removing that transitive dependency would leave host recovery unverified. Security-relevant witness/device prerequisites likewise remain deliberate release dependencies. Preparation IDs R10a–d and R14a–c describe the atomic integration sequence; they do not create half-enabled merge points.

| Stage | Blocked by | Closure |
| --- | --- | --- |
| R11a | R02, R04, R06, R10 | Catalog/provisioning PR; disposable local proof, real bootstrap operator gate before real provisioning |
| R11b | R11a | Crash-safe lifecycle/removal reconciliation PR using signed fixtures where app UI is not yet available |
| R11c | R11b | Replacement trust/recovery PR; completes R11 |
| R17a | none | Plan 174 decision and follow-on Android build plan; no production or physical claim |
| R17b | R17a, R01, R03, R14 | Adopted native verification/custody/presence implementation; core/native negatives pass |
| R17c | R17b | Independent physical witness evidence and required signing/hardware access; completes R17 |
| R19a | R01, R02 | Adopted AF-3 decision and any exact command-contract amendment; M1 design evidence |
| R19b | R19a, R04, R10 | Parity-atomic continuity implementation; completes R19 in M3 |
| R21a | R05, R06, R08, R09, R11 | Reproducible deployment and restore artifacts; local proof |
| R21b | R21a | Named host/DNS/backup operator and field restore evidence; completes R21 |
| R22a | R15, R16, R18, R20, R21a | Exact signed distributable Android artifact |
| R22b | R22a, R21 | Physical candidate report on that exact artifact; completes R22 |
| R31a | R08, R11b, R16 | Scoped desktop sidecar/runtime PR |
| R31b | R31a | Supported packaged host/reseed evidence, explicit scope exception if needed; completes R31 |
| R32a | R23 | Separately approved iOS un-parking, signing/archive artifacts; R30 also required if Toolshed is included |
| R32b | R32a | Apple credentials, physical iPhone and device evidence; completes R32 |
| R35a | R15, R23 | Measured lifecycle decision with a concrete adopted path or a blocked expansion verdict |
| R35b | R35a | Approved implementation and evidence, or tested no-build/end-of-life disposition; completes R35 |

### Packet evidence tier and exclusions

This table supplies each packet's explicit finish tier and scope boundary in addition to its acceptance tests. “Physical” always requires the exact artifact record; later pilot observation never backfills missing core/refusal evidence.

| Packet | Finish tier | Explicitly not in this packet |
| --- | --- | --- |
| R01 | Designed/adopted | Product implementation or invented operator approval |
| R02 | Designed + executable probes | Production authority changes |
| R03 | Core | Legacy dormancy repair or mobile presence |
| R04 | Core | Root-key reconstruction, witness rotation or arbitrary legacy-log reinterpretation |
| R05 | Core | New key storage architecture |
| R06 | Core | Loss of bytes held nowhere or replacement identity invention |
| R07 | Core | Changing valid legacy canonical vectors |
| R08 | Core/real transport | Authentication redesign, larger frame caps or persistence-format changes |
| R09 | Core | New product semantics or raised limits |
| R10 | Core + offline demo | Live provisioning or founder-continuation claim |
| R11 | Core/local lifecycle | Public admin API or operator semantic authority |
| R12 | Packaged local preview | Physical multi-device or AF-2 claim |
| R13 | Packaged enrollment/sync | LAN discovery or background delivery |
| R14 | Packaged governance | Automatic witness rotation, history erasure or invisible renewal |
| R15 | Packaged volume workflow | Compaction or automatic route/slot reclamation |
| R16 | Packaged AF-1 | Same-key backup restore or unretained-data recovery |
| R17 | Designed → native/core → physical | Software-only downgrade satisfying the physical gate |
| R18 | Packaged recovery with physical witnesses | Founder impersonation or operator-free provisioning |
| R19 | Designed → core | A fourth role, root rotation or cross-community identity |
| R20 | Packaged AF-3 | Old-key ownership or silent outstanding-loan closure |
| R21 | Local operations → field restore | Public rollout without operator access/approval |
| R22 | Signed candidate → physical | Emulator-only release proof |
| R23 | Pilot | 150-member or indefinite-history support |
| R24 | Core | UI, score or legacy v1 reinterpretation |
| R25 | Core | Hidden read-model writes or an unapproved exceptional loan closure |
| R26 | Packaged module | A second app identity or implicit witness control of Tool clocks |
| R27 | Physical ceremony | Implicit third-party read access or theft prevention |
| R28 | Core/read model + UI | New operations, ranking or wall-clock punctuality proof |
| R29 | Packaged presentation | Complete-history or pre-loss key-possession claims |
| R30 | Pilot | The one-pager's 90-day/two-neighborhood evidence |
| R31 | Packaged supported host | Mobile background uptime or NAT traversal |
| R32 | Physical iOS | Automatic un-parking or macOS-as-iPhone proof |
| R33 | Capacity | Member count without a supported lifecycle envelope |
| R34 | Designed follow-on program | Automatic Township implementation or civic security proof |
| R35 | Designed → capacity/lifecycle evidence | Production compaction, discarded history or automatic identity migration |
| R36 | Native/core identity bootstrap | Generic signing IPC, witness claim authorization, carrier-key aliasing or premature physical AF-2 proof |

Every implementation handoff contains:

```text
Packet: RNN and title
Base: immutable Git SHA, worktree and branch
Blockers: merged SHAs/evidence links; unresolved operator inputs
Read first: this packet and the named source plans
Outcome: one observable behavior; exact inclusions and exclusions
Ownership: allowed areas and shared-file reservation
Acceptance: named positive, refusal, restart and parity gates
Review: exact diff SHA, findings resolved, required CI results
Completion: changed files, verification, claim tier, next ready packets
```

## Verification and claim gates

The established local toolchain is mandatory. Run from the executing packet's worktree, not the primary checkout. For BEAM child processes use:

```sh
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix verify
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix check
```

The applicable security gates are per-boundary Sobelow for `apps/lattice_server` and `apps/township_web`, and authentication/frame-bound/read-only/relay refusal tests for raw Cowboy `lattice_carrier_server`. Follow each source plan's exact commands. Do not expose the legacy `lattice_server` boundary as the pilot relay; its promotion blocker remains in the index.

Existing cross-runtime commands, when touched:

```sh
npm --prefix clients/lattice-client run typecheck
npm --prefix clients/lattice-client run conformance
npm --prefix clients/lattice-client run canonical
npm --prefix clients/lattice-client run township:authoring
npm --prefix clients/lattice-client run build
npm --prefix clients/lattice-mobile-core test
npm --prefix clients/township-tauri-shell run android:pilot:contract
```

New Treehouse and recovery tests must be wired into the actual CI/build consumer; a passing file that CI never runs is not a release gate. Treehouse-specific command names are to be introduced by their packets, not represented here as existing scripts. Verify generated vector/source/build consistency. Browser, packaged/native, load and physical suites are run when the corresponding execution packet is authorized; writing this roadmap does not run or authorize all of them.

| Claim tier | Required evidence |
| --- | --- |
| Designed | Reviewed contract, explicit state/authority table and unresolved decisions. No product claim. |
| Core behavior | Sim positive/negative cases plus reciprocal BEAM/TS authored bytes, state and quarantine; restart and fresh-VM restore where relevant. |
| Packaged workflow | Independent installed apps use ordinary production entry points, persistent keys and verified local state; a Sim-only harness is insufficient. |
| Physical candidate | Exact internally signed artifact on unrelated phones; hardware witness quorum; real camera, networks, reboot and upgrade. |
| Pilot | Real participants over the declared observation period with recoverability and incident evidence. |
| Capacity | Measured workload and device matrix at the declared member/replica/log limits. |

AF-1 completeness is limited to data retained by surviving members. AF-2 applies only to the approved genesis/authority/quorum profile, not arbitrary old replicas. AF-3 preserves an attested identity association and old signatures, not cryptographic ownership of the lost key. The combined founder+relay test is mandatory because separate positive tests can otherwise hide the same root/catalog dependency. Packaged and physical outcomes must preserve these limitations in their copy.

## Operator inputs and design checkpoints

These are gates on the named execution packets, not requests to stop planning. Start local work that does not require them.

| Input/choice | Recommended handling | Needed before |
| --- | --- | --- |
| Toolshed app-isolation countersign; archive vocabulary; inclusive 150 target | Review R01's concrete amendments and record adoption in the contract; no invented signature | R10/R12, and module enablement R26 |
| §4a scoped un-parking and mobile-ceremony amendment | Shared Beta Contract sign-off for physical Android, QR camera and cross-device pairing. LAN remains parked; iOS has a later separate sign-off | R13, R36, R17b/c, R20, R22, R27; any new parked scope in R31; iOS at R32a |
| Founder grant renewal, bounded successor authority, catalog recovery and witness threshold | R02 produces probes and one recommendation. Admit an explicit versioned policy if required; keep root immutable | R04/R11 |
| Catalog signer/bootstrap custody | Operator generates real catalog key, living root reviews/signs the binding, encrypted separate key backup is verified. Disposable local tests use labeled test keys | Real provisioning in R11a, then real-profile R21/R22; test-profile ceremonies in R16/R18 |
| Witness establishment and platform evidence | R17a selects the native architecture; R36 provisions distinct protected witness identities and reviewed member bindings, then enroll members and root-pin each required replica before losing its key; supply independent Android witnesses, protected signing and platform evidence. Plan 146 macOS codesigning is additionally required only if macOS witnesses are selected | R36, R14 pinning, R17b/c and R18 |
| Signed epoch cadence and renewal coordinator | Adopt R02's units/lease window and measured renewal fan-out; daily reviewed group quorum ceremony and Tool-owner root day assertions; named backup coordinator, no clock fallback when quorum is unavailable | R14/R18, then ongoing R23/R30 |
| Social attestation quorum/conflict policy | Separate decision PR before AF-3 code; ordinary member continuity cannot rotate witnesses | R19 build |
| Supported Linux host, DNS/TLS, encrypted off-host backup and restore host | Name one operator and choose member-run or disclosed external operator | R21 field gate |
| Android pilot signing custody and independent devices | Use existing signing runbook/harness. Enough devices for the selected witness quorum; no emulator substitution | R22 |
| Testers, assisted provisioning and informed plaintext-host acceptance | Recruit 9–15 people, support/on-call host operator and synthetic profiles; disclose finite lifetime, reader set, missed-epoch behavior and old receipt-key loss | R23, refresh for R30 |
| Apple team/credentials and physical iPhone | Optional lane only | R32 |
| Lifecycle/retention policy for expansion | Approve R35a's measured end-of-life or revised archive policy before its build; no indefinite-history promise | R35b/R33 |

## Traceability and source areas

These are current entry points, not an exhaustive edit allowlist. Reconcile paths and plan assumptions before implementation.

| Packets | Source plan / existing seam |
| --- | --- |
| R01–R04 | Plans 158/175/177/178/179; `docs/adr/0004-succession-validation.md`; `docs/research/succession_tick_provenance.md`; `apps/lattice_core/lib/lattice/authority.ex`, `sim.ex`, `log.ex`; `clients/lattice-client/src/{authority,codec,carrier,township}.ts` |
| R05 | [Plan 170](../170-redact-private-keys-from-inspect-and-crash-reports.md); identity and carrier-projection diagnostics |
| R06 | [Plan 171](../171-audit-bundle-verifies-signatures.md); log restore, Township audit bundle and registry consumers |
| R07 | [Plan 172](../172-ts-canonical-encoder-strictness.md); `clients/lattice-client/src/codec.ts` and canonical tests |
| R08–R09 | [Plan 173](../173-bounded-carrier-transport.md), [Plan 176](../176-fail-closed-input-validation.md); BEAM WebSocket client/server and TS carrier |
| R10 | Plan 158 domain ticket; Plan 178; `Lattice.Replica`, causal command callbacks, TS materialization and vector exporter. Treehouse modules and realm are new. |
| R11/R21 | Plan 158 catalog/deployment tickets; `apps/lattice_carrier_server/lib/lattice_carrier_server/{runtime,holder,health}.ex`, `config/runtime.exs`, release declaration in `mix.exs`. Catalog lifecycle is new. |
| R12–R15/R22 | `clients/lattice-mobile-core/{products.json,src,native}`, `clients/township-tauri-shell` pairing/native/storage examples and Android scripts/harness; `.github/workflows/flagship.yml` |
| R16 | `apps/lattice_carrier_server/test/relay_reseed_test.exs`; verified bundle/store APIs; existing packaged stable-relay tests |
| R17–R18/R36 | [Plan 174](../174-governance-witness-verification-spike.md), Plan 146 witness artifact; protected native governance boundary; Plan 179 certificate pattern |
| R19–R20 | Plan 177 AF-3; signed inbox/evidence/delegation/revocation paths. Group attestation contract and UI are new. |
| R24–R30 | Plan 158 custody v2 and QR tickets; [Plan 160](../160-pd003b-qr-ceremony-spike.md); [consent ADR](../0007-co-signed-consent.md); `apps/lattice_core/lib/toolshed/{shed,tool,read_model}.ex`; `clients/lattice-client/test/vectors/toolshed_custody_consent.json` |
| R31–R34 | [Plan 150](../150-device-hosted-carrier-boundary-cd1.md), superseded Plan 152 scope, Plan 158 later iOS and Township routes |

### Contract-test traceability

| Packet / contract | Source and load-bearing gate |
| --- | --- |
| R01 protected historical status | `apps/lattice_core/test/township/audit_bundle_test.exs`, `apps/lattice_core/test/township/read_model_test.exs`, `apps/lattice_core/test/treehouse/contract_test.exs`; preserve the exact status/build-map assertions described in R01 |
| R01 archive and R19a group vocabulary | Plan 178 exact ordered vocabulary/role assertions in `apps/lattice_core/test/treehouse/contract_test.exs`; amend only adopted semantics and corresponding assertions, not unrelated status pins |
| R01/R26 one-app collision contract | `clients/lattice-mobile-core/products.json`, `test/product_manifest.ts`, `native/tests/product_manifest.rs`; prove Treehouse row use and dormant legacy Toolshed identifiers |
| R03/R07 canonical invariance | Plan 179's named eight unchanged legacy vectors, leased-authoring gate and compaction mirror; valid bytes cannot be changed by a fixture convenience edit |
| R36 witness identity | `clients/township-tauri-shell/src-tauri/src/lib.rs`: `ensure_governance_witness_key`, `governance_witness_public_key`, `reject_governance_carrier_alias`; distinct protected key purpose and typed provisioning/export boundary, never a carrier-sign alias |
| R16 AF-1 baseline | `apps/lattice_carrier_server/test/relay_reseed_test.exs`; retain the two existing positive/stale-copy controls while adding packaged evidence |
| R25 custody/dispute | Plan 158 custody v2 and Plan 0007 consent contract; exact loan/party/due/refusal BEAM/TS vectors, including lost-key limitations |
| R26 public copy | Toolshed one-pager D1 corrections plus a focused prohibited-claim/reader disclosure test; no whole-document prose freeze |
| R35 lifecycle | Plan 158 Decision 8 and the adopted lifecycle amendment; measured exhaustion/retrieval/recovery tests required by R35b |

## Planning artifact validation

This roadmap and its HTML companion are documentation only; no production implementation or existing contract is changed by this worktree. Historical verification performed on 2026-09-04 before the Opus-review revision:

- Markdown/HTML consistency: all 34 packet IDs and 77 unconditional dependency edges match; no cycles, duplicate IDs, broken local links or trailing whitespace. R32/R34 explicitly retain their conditional Toolshed pilot gate.
- Chromium: search, all five filters, expand/collapse, dependency navigation through a filtered view, reset and empty-result behavior passed. No page overflow at widths 320, 390, 768 or 1,440 pixels. Desktop, mobile and print-media layouts were visually inspected.
- Print preparation opens all 34 packets, including filtered-out ones, then restores the view. With JavaScript disabled, all 34 native disclosure packets remain readable. Screenshots and browser diagnostics are local, ignored artifacts under `output/playwright/`.
- Runtime regression: `mix verify` passed using the required asdf/OTP 28 prefix from this fresh worktree, including formatting and the full default test suite with its existing exclusions (seed `161632`). Dependency resolution left `mix.lock` unchanged. This is local repository proof, not a Treehouse implementation, native release, hosted CI or physical-pilot result.

No future packet is complete merely because these planning artifacts or the existing baseline tests pass. Re-run each packet's named gates against its implementation and exact release candidate.

The 2026-09-05 review revision adds R35/R36, explicit composite-stage gates, revised dependencies and an appended README pointer. Its verification and all review dispositions are recorded in the [review record](treehouse-delivery-2026-09-05-opus-review.md); the historical 34-packet/77-edge count above is not the revised graph.
