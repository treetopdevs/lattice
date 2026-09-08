# Treehouse roadmap — Claude Opus adversarial review and disposition

Review date: 2026-09-05. Reviewer: `claude -p --model opus --effort high` (resolved model `claude-opus-5`, Claude Code 2.1.231). Reviewed commit: `b9ea8bcd675a1109621f6c1e4fa62dad74d80bbb`; source baseline: `af84459bfc066b4ed405b99a02046b4f2c6315ee`. Read-only tools were restricted to Read/Grep/Glob; no other worktree or agent was coordinated with. The review completed successfully in approximately 12 minutes.

This record preserves the complete returned review, including all 26 findings, seven open questions and five optional improvements. References such as `md:125` identify the original reviewed revision, not the revised document. The roadmap remains a proposal; addressing a planning defect does not approve its future contract changes or prove a product gate.

Final outcome: **READY FOR PROPOSAL ADOPTION**, after three completed read-only Opus reviews and documented remediation. The complete 37 numbered Opus findings, seven questions, five optional suggestions and additional primary-agent sequencing correction are retained below. All corrections are to the proposed roadmap, not product code; operator adoption remains pending.

## Original review — verbatim

## Adversarial review — Treehouse delivery roadmap (`b9ea8bc`)

Read-only review. No files were edited, no commands run.

### Coverage

| Reviewed | Depth |
|---|---|
| `plans/roadmaps/treehouse-delivery-2026-09-04.md` | complete, all 524 lines |
| `plans/roadmaps/treehouse-delivery-2026-09-04.html` | complete, all 104 lines incl. CSS/JS behavior |
| `AGENTS.md`, `CLAUDE.md` | complete |
| `plans/README.md` | index rows, parked-areas header, promotion blocker, Round 5/5b/5c sections |
| Plans 158, 175 (via index + 179), 177, 178, 179 | 158 targeted (decisions, isolation contract, dependency map, catalog, WSS, Treehouse route, waves); 177/178 complete; 179 through step 2a plus full step list, scope, non-goals, STOPs |
| `TOWNSHIP_BUILD_MAP.md` §4a | targeted |
| Source seams | `apps/lattice_core/test/treehouse/contract_test.exs` (11 tests, scan scope), `apps/lattice_carrier_server/test/relay_reseed_test.exs` (2 tests), `.../township/{audit_bundle,read_model}_test.exs` pinned strings, `LatticeCarrierServer.Manifest` `@max_instances 64`, `clients/lattice-mobile-core/products.json`, all four `package.json` script names, existence of every linked plan/doc |

**Independently verified as correct** (do not re-litigate): all 34 IDs and all 77 unconditional dependency edges match between MD and HTML; the graph is acyclic; every relative link resolves (including `plans/0007-co-signed-consent.md`, which really does live there); all seven npm scripts in the verification block exist verbatim; the `mix verify`/`mix check` asdf+OTP-28 prefix matches `AGENTS.md`; the "2 tests + 11 tests = 13" baseline claim is accurate; the 12-Thread / 20-Tool / 64-route / 4-socket numbers are Plan 158 Decision 8 and the 64 bound is real code; the 5,000-op benchmark profile and the Sobelow/`lattice_server` promotion-blocker guidance are accurate. The "under 150 → inclusive 150" framing correctly quotes Plan 177:19. Hosted-plaintext, no-scores, rollover and deferral language is correctly presented as recorded policy, not shipped function.

---

## Confirmed findings

### F01 — blocker · R04's stated fallback is unreachable under its own dependency graph
`md:125` — "If no bounded design passes, block the antifragile pilot and **preserve completed chat work as an engineering preview**." But R10 is blocked by R04 (`md:174`), R12 by R10 (`md:194`), R13 by R12, R14 by R13, R15 by R14. At the moment R04 could fail, the only merged work is R01 and the R05–R09 hardening packets: there is no chat work to preserve, and no packet in the program can proceed except R21's operator prep. The roadmap's single biggest risk (a new group-authority semantic) is also the gate on 100% of product value.
**Correction:** either (a) drop the R04 edge from R10 and let the domain land against root-only authority with witnessed continuation added in a follow-up parity packet, or (b) delete the fallback sentence and state plainly that R04 failure stops the program. Option (a) is the recommendation: `create space` needs the witnessed *succession* policy shape (already merged, Plan 145), not R04's continuation policy.

### F02 — blocker · No packet establishes the genesis-pinned witness set
Everything AF-2 rests on a witness set pinned in a root-authored genesis (`plan179:98-106`, `md:61`, `md:101`). But members generate their own keys when they join (`md:206`, Plan 178 "Invitations"), so at Space creation time the founder is the only key in existence. The only in-bounds repair is Plan 179's explicitly permitted path — "a later valid root-authored genesis **may** add `:__beacon__` where there was none, and **may** replace an existing `:__beacon__` with a different witness set" (`plan179:666-670`) — which is available **only while the founder key lives**. The roadmap never mentions this path, and no packet owns the workflow. R12 creates the Space, R13 enrolls members, R14 handles roles; none pins witnesses. R17 is the *signing* ceremony, not set establishment. R18/R22/R23 then assume a functioning quorum.
**Correction:** add an explicit "enroll, then pin" workflow to R14 (or a new packet between R13 and R17): after members join, the founder authors a second root genesis carrying `:__beacon__` and the succession witness set, with app affordances, a "witnesses not yet pinned / AF-2 not available" state, and a hard warning that the window closes with the founder's key. R02 must specify it; R12's genesis must record which profile fields are still unset. The same applies per-Thread (each Thread replica has its own genesis and its own root) — R02's matrix bullet (`md:103`) covers the *design*, nothing covers the *workflow*.

### F03 — high · Thread creation and rollover silently require an operator
Plan 158 Decision 2: "There is **no public carrier-admin API** in the first beta" (`plan158:162-164`), and provisioning is `pilotctl add-replica` / `reconcile`, explicitly "operator-only" (`plan158:346-347`). The client saga's `carrier_pending → listed` transition therefore needs a human on the host. The roadmap builds three member-facing workflows on top of that without disclosing it: R15's rollover "durable, recoverable workflow" (`md:226`), R18's post-founder-loss "create/roll over a Thread" using "only retained member evidence" (`md:256`), and R23's 14-day pilot where 12 people are expected to roll busy threads (`md:306`). R11 says only "assisted provisioning" (`md:186`).
**Correction:** decide in R01/R11 whether the beta (i) accepts the operator as a liveness dependency for every new/archived Thread — then say so in R15, R18, R23 and the disclosure copy, and add the operator to R23's on-call list — or (ii) amends Decision 2 with a narrowly authorized self-service provisioning path, which is a new authority surface needing its own review. R18's "no hidden … dependency supplies authority" bullet must explicitly exempt or name the operator's transport action.

### F04 — high · The mobile witness ceremony is promoted onto the critical path against an explicit Plan 158 deferral, with an unlisted external blocker
Plan 158: "its mobile ceremony is **hidden and deferred in the first beta**, so the device gate exercises manual role transfer only. Unfinished Plan 146 is reusable witness-artifact work, **not a dependency** for this mobile candidate" (`plan158:783-786`), and "Genesis-pinned witnessed succession remains domain/replay evidence, **not this device claim**" (`plan158:832-833`). Plan 178's frozen contract agrees: "the mobile ceremony is hidden in the first beta." The roadmap makes R17 a hard blocker of R18, R18 of R22, and requires "enough independent witness devices to meet the approved quorum after founder loss" on physical phones (`md:296`). Plan 146 is `IN PROGRESS … blocked on macOS codesigning` (`README:189`), and Plan 146's protected-presence work is macOS `LAContext`; Android protected-key witness custody is a separate, unbuilt platform surface that R17 does not name.
**Correction:** record this as an explicit amendment to Plan 158 in R01 (with the reasoning: the AF-2 device claim requires it). Add the Plan 146 codesigning blocker and the Android-vs-macOS platform gap to the operator-inputs table before R17, and state R17's per-platform scope.

### F05 — high · Seven packets plan work inside the still-in-force parked list
`plans/README.md:13-14`: "**Parked areas — do not plan new work here** (see `TOWNSHIP_BUILD_MAP.md` §4a): iOS, QR camera onboarding, LAN discovery, physical-device behavior, cross-device pairing state exchange." §4a itself: "**Do not write new plans, probes, smokes, or 'one more variant' proofs in these areas**" (`TOWNSHIP_BUILD_MAP.md:343-345`). Plan 177 kept it live: "The `TOWNSHIP_BUILD_MAP.md` §4a parked list is unchanged, and Plan 152's proposed §4a un-parking edit is withdrawn" (`plan177:46-47`). The only un-parking authority is Plan 158's Shared Beta Contract exit (`plan158:270`), and Plan 158 is `TODO`. R13 (camera QR + permission regrant), R17, R20, R22, R27 (three physical phones), R31, R32 are all inside those areas. The roadmap's R01 retires only Plan 152 (`md:95`) and never mentions §4a.
**Correction:** make the §4a un-parking sign-off an explicit R01 deliverable and an operator-inputs row needed before R13, naming which §4a bullets are un-parked (physical Android, QR camera, cross-device pairing) and which stay parked (LAN discovery, iOS until R32). Note that §4a edits must preserve the strings pinned by `audit_bundle_test.exs:145-148` and `read_model_test.exs:111-113` — see F08.

### F06 — high · Sizing is not calibrated against this repo's own history
R10 is "**L/atomic** … one domain/parity PR" covering the entire frozen 14-command vocabulary, Space + Thread semantics, the archive extension, effects arrays, application-denial precedence, and reciprocal BEAM/TS vectors (`md:172-180`). This repo rated a *single* versioned action handoff as **XL** (`README` rows 135–139: clerk status, field edit, roster, delegation grant, revocation — five XL plans for five actions), and Plan 179's one new `:authority` body is **L / risk HIGH** with a 1,759-line plan. R19 introduces a comparable new cross-runtime semantic and is sized "**M** decision then **M**/atomic build". R12–R15 are "M" each, covering ground that took Plans 118–120, 129–130, 134–138.
**Correction:** re-size R10 to XL and pre-declare its split points at behavior boundaries (its own (a)–(d) work packets are the right seams, but the roadmap forbids enabling any of them before full integration, so the merge unit is XL either way). Re-size R19 build to L. State the sizing basis ("calibrated against Plans 135–139 and 179") so the envelope is falsifiable rather than aspirational.

### F07 — high · No packet owns amending the frozen command vocabulary or its test
Plan 178 freezes the command set "to exactly the following commands, in exactly this order" and pins it (`contract_test.exs:157` "plan 178 freezes the exact ordered command vocabulary"), with "Later Treehouse plans … may not widen it without amending this file" (`plan178:38-39`). The roadmap adds `archive thread` (R10, `md:60`), a group-scoped continuity attestation and re-admission (R19/R20), and possibly a versioned dispute payload (R25). R01 says only "Specify archive semantics and new vocabulary" (`md:91`) — and R01 runs *before* R19's and R25's designs exist, so it cannot enumerate them.
**Correction:** give R01 an explicit deliverable list (amend `plans/178`, amend the ordered vocabulary in `contract_test.exs`, record the widening rationale) for `archive thread` only, and add an equivalent contract-amendment sub-deliverable to R19 and R25 as a precondition of their build PRs. Also state the frozen-roles interaction: R19's "current members" quorum is not a fourth role and must not become one.

### F08 — high · R01's prose-pin guidance will break green tests as written
`md:91`: "reconcile plan status **without treating prose pins as immutable product requirements**." Three of those pins are hard test assertions, not soft prose: `plans/README.md` rows 121, 122 and 178 must match byte-for-byte (`audit_bundle_test.exs:150-151`, `read_model_test.exs:115-116`, `contract_test.exs:227-241` which also asserts *exactly one* line starting `| 178 |`); the Plan 178 status paragraph inside Plan 158 (`contract_test.exs:243-251`); `plans/121`/`plans/122` `## Status DONE` sentences; and `TOWNSHIP_BUILD_MAP.md` strings including `"plans 023-133"` and `"Phase G's audit surface is implemented by Plan 121"`. Plan 177's STOP condition is also live: "Any edit to an existing prose-pinned row or sentence in `plans/README.md` or `TOWNSHIP_BUILD_MAP.md`." R01 additionally proposes moving "historical Township-first text into a clearly labeled archive," which puts Plan 158's structure at risk of the same pins.
**Correction:** replace the sentence with the explicit untouchable list above, and make "these five suites stay green with no fixture edit" an R01 acceptance checkbox. Distinguish the two claims the current wording conflates: prose pins do not *define product requirements*, but they are *immutable strings*.

### F09 — high · Nobody is assigned to advance the signed epoch
Epoch advancement is the sole driver of lease lapse (`plan179:420-424`) and Plan 179 explicitly ships "no beacon frequency requirement" (`plan179:407`). Toolshed due dates are a "root-only foreground ceremony" (`plan158:172-175`). Yet R04 requires renewal "across at least two expiry cycles" (`md:123`), R18 requires "lease renewal/removal across two grant lifetimes" (`md:258`), R24 binds a "due epoch", R28 reports "open requests with root/witness-signed epoch age" (`md:356`), and R30 must exercise an "overdue return" (`md:376`). None of that happens unless a human performs signing ceremonies on a cadence throughout the 14-day and 7–14-day pilots.
**Correction:** add a beacon/epoch operations item: who emits, at what cadence, what the app shows when the epoch is stale, what happens when a witness quorum is unreachable at renewal time, and how R23/R30 schedule it. Add a row to the operator-inputs table before R18. R28's "unknown/stale coverage" display (`md:359`) is the right *display* answer but is not an operational answer.

### F10 — high · Rollover leaves invitations, admissions and archived-thread access undefined
Plan 178 pins invitations as "scoped to the Space and the **current Thread catalog**" and `admit member` as signing "the exact-audience Space and **current-Thread** membership grants." R15 archives a Thread and provisions a successor (`md:222-230`) but no packet says what happens to: an invitation issued before the rollover and accepted after; a member admitted after rollover (do they get read grants on the 11 archived Threads, or a history gap?); the grant fan-out cost of admitting one member across up to 12 Threads; or whether an archived Thread keeps its route and consumes one of the 4 foreground sockets. R13 tests "revoked/rebound invitation" but not a stale-catalog invitation. The roadmap's own trap section covers only *late posts* (`md:69`), not the membership half.
**Correction:** add an explicit rollover/membership interaction table to R01's archive contract and matching acceptance bullets in R14, R15 and R13 (pending invitation across rollover; post-rollover admission and archive read scope; archived-thread routing/socket policy).

### F11 — medium · The 12-slot cap is a terminal lifetime bound, and the only unblocking work has no packet
12 Threads × 4,000 ops is roughly 48,000 ops for the entire life of a Space; the roadmap correctly refuses to promise "months of capacity" (`md:60`) and stops at slot exhaustion. But the Destination promises "goal up to 150" (`md:11`) and M6 promises "tested capacity toward 150" (`md:42`), while the only thing that makes either survivable — a capacity-policy change — is a conditional bullet inside R33 with no packet, owner, size or dependency edge: "If archives exhaust the current catalog, design and test a capacity-policy change before widening" (`md:410`). At 150 members that budget is ~320 ops per person for the group's whole existence.
**Correction:** state the arithmetic in the Destination and in R33, and promote the capacity-policy change to a named packet (R35) that blocks any supported-capacity declaration above 12 members. Also state whether an exhausted Space is migrated (new Space, new genesis, history exported) or is simply end-of-life.

### F12 — medium · M1 requires a packet blocked on M2 work; R19 is double-assigned
`md:37` puts R19 in M1's required chunks; `md:39` puts R19 in M3; R19's blockers are `R01, R02, R04, R10` (`md:264`) and R10 is an M2 chunk (`md:38`). M1 therefore cannot close until part of M2 closes. R19 is described as two PRs but carries one blocker set.
**Correction:** split the blockers — decision PR blocked by R01/R02, build PR blocked by R04/R10 — and list only the decision PR under M1. The HTML says "AF-3 contract in R19" for M1 (`html:32`), which is already the right framing; the MD should match it.

### F13 — medium · One Plan 158 dependency reversal is declared, another is not
The roadmap declares that it amends Plan 158's deployment-first dependency (`md:186`). It does not declare that it reverses `catalog --> treehouseDomain` (`plan158:244`; Plan 158's Treehouse Domain ticket lists "Replica Catalog and Lifecycle" as a dependency at `plan158:751-752`): the roadmap has R10 → R11 instead. The justification exists — "Catalog inputs are signed test fixtures at this stage; live provisioning is R11" (`md:176`) — but Plan 158's merge protocol says "No dependent implementation branch may merge before the parent ticket's merge-result `main` workflow is green" (`plan158:259-260`), so this needs to be an explicit amendment, not an inference.
**Correction:** add the inversion to R01's amendment list with its rationale.

### F14 — medium · The recommended initial frontier collides with the roadmap's own one-owner rule
`md:76`: "Give one owner each shared authority/codec/carrier file and generated vector corpus." R07 owns `clients/lattice-client/src/codec.ts`; Plan 179 (R03) requires `codec.ts` for the beacon-claim bytes **and** step 6b's leased-delegation authoring, plus `authority.ts`, `carrier.ts`, `township.ts`, `conformance.ts`, `township_authoring.ts` and the full regenerated vector corpus (`plan179:326-352`). R09 then adds negative vectors and R10 adds a new corpus. The roadmap's only treatment is "R03/R04 and R07 share codec/authority areas, so sequence integration even when design work overlaps" (`md:424`) — which names the collision without resolving it, while simultaneously recommending both start immediately.
**Correction:** assign `codec.ts` and the vector corpus to R03 for the duration, and either sequence R07 after R03's merge or scope R07 to `canonical.ts`-adjacent strictness that does not touch the encoders Plan 179 exports. Note explicitly that Plan 179's STOP list requires eight named vectors to stay byte-identical, so R07's fixture amendments must be checked against it.

### F15 — medium · R07 depends on an unidentified artifact and carries session-scoped text
`md:149`: "Review and reuse **recoverable Plan 172 work** only after comparison with current main; do not interact with the separate agent producing a roadmap," and `md:152`: "no branch/stash is deleted." A fresh implementation session — which `md:73` says every packet must be executable by — cannot locate work identified only as "recoverable." The agent-coordination clause, and `md:426` ("This planning run does not coordinate with or consume the other agent's duplicate roadmap"), are facts about one authoring session embedded in a durable artifact.
**Correction:** name the branch/stash/SHA or delete the reference and treat Plan 172 as unstarted. Remove both agent-coordination sentences; if file contention is the real concern, it belongs in F14's ownership rule.

### F16 — medium · Catalog signing-key custody is missing from R11 and the operator table
Plan 158: "A dedicated per-product Ed25519 catalog key … the operator generates it, the founder reviews its public key and service fingerprint, and a product-root-signed bootstrap op commits that key **before the first replica is provisioned**. The private key exists only in the carrier secret mount and encrypted signing-key backup" (`plan158:326-330`). R11 lists no operator gate, and the operator-inputs table's first infrastructure row is "Needed before **R21** field gate" (`md:489`). The bootstrap op is also a creation-time, root-signed act, which puts it in the same window as F02.
**Correction:** add an operator row for catalog key generation, review and encrypted backup before R11 packet A, and state in R11 whether local proof uses a throwaway key (fine) while R16/R18/R21/R22 use the real one.

### F17 — medium · The Toolshed one-pager's D1 correction is owed and unscheduled
Plan 177 item 5: "`plans/toolshed_one_pager.html` carries the same 'nothing hosted' phrase and falls under D1 **when Toolshed copy is next touched**" (`plan177:193-194`), and Plan 177's STOP forbids any doc "saying 'nothing hosted' or 'serverless' while any relay persists plaintext." That file still contains two matches. R26 is the next time Toolshed copy is touched; it says nothing about the one-pager, and R30 mentions only its "90-day/two-neighborhood claim" (`md:380`).
**Correction:** make the toolshed one-pager D1 correction (and a matching prohibited-phrase scan, reusing the Plan 178 pattern) an R26 deliverable.

### F18 — medium · No packet implements lease expiry or renewal in the app
Plan 179's Non-goals make it explicit that post-founder-loss removal of a founder-granted member exists **only** if every founder-issued grant was leased at issue, "a creation-time decision with no later repair" (`plan177:160-165`, `plan179:436-448`). If the roadmap adopts that mitigation — and R02/R04 assume it — then in the pilot every member's authority expires on a schedule. R12, R13, R14, R15, R22 and R23 never mention renewal UX, pre-expiry warnings, what a member sees when their grant lapses mid-conversation, or what happens if renewal requires a witness quorum that is asleep.
**Correction:** add app-side lease state (issued/expiring/lapsed), renewal affordance and a renewal-failure state to R14, with a corresponding R23 acceptance bullet ("no member silently loses authority to a lapse without a visible warning and a renewal path").

### F19 — medium · Plan 151 is never reconciled
R01 retires "the additional Plan 152 LAN/CD1 program" (`md:95`), but Plan 152 is `BLOCKED (needs 150+151 …)` and **Plan 151** (App-owned instrument, CD1 track, `TODO`) is not mentioned anywhere in either document. R31 revives Plan 150 as an optional packet. If the Treehouse app supersedes Plan 151, that is a status decision R01 should make; if it does not, Plan 151 is unowned work sitting between R31 and R12.
**Correction:** add Plan 151 to R01's status reconciliation with an explicit disposition (superseded by R10/R12, or retained under R31).

### F20 — medium · The roadmap creates a second work ledger with no entry in the first
`plans/README.md` is the ledger executors are told to read ("read `plans/README.md` first"; "update your row below when done"). The roadmap introduces R01–R34 with no README row, no pointer, and no plan number. Its traceability table maps packets → plans (`md:498-512`) but nothing maps plans → packets, so an executor opening Plan 172 will not learn it is now R07.
**Correction:** add one README row for the roadmap (or assign it a plan number) as part of R01, plus a back-reference line in each source plan it consumes — appended only, per F08's constraints.

### F21 — medium · R17 has no defined outcome when the platform guarantee is unavailable
`md:246`: "If the required custody/presence guarantee is unavailable, **resolve** the claim or platform constraint before R18." That is not a decision procedure, and R18 → R22 → R23 sit behind it. Given F04's Plan 146 blocker, "unavailable" is the likely branch.
**Correction:** name the downgrade explicitly: software-only witness signing at a stated claim tier, with the AF-2 device copy narrowed accordingly, and a rule for whether R18 may proceed on that tier. R17's third bullet already separates the three evidence classes (`md:250`) — make the fallback select one of them rather than leaving it open.

### F22 — low · Two milestone labels read as survival claims
`md:39` titles M3 "**the group survives the three losses**"; the HTML section header is "Three losses. Three observable recoveries" (`html:30`) with a hero line "Make the group outlast its devices" (`html:26`). Plan 179's STOP condition is broad: "Any doc, plan, one-pager or UI sentence claims founder loss is survived … before the AF-2 test of step 2c is green and merged" (`plan179:491-493`). Both documents are clearly labelled as proposals and the HTML badges AF-2 as "Design; production still fails," so this is a wording risk, not a false claim — and no test scans these files (`contract_test.exs:8-11` covers only Plan 178, the one-pager, README and Plan 158).
**Correction:** retitle M3 "the group is proven against the three losses" / "must survive"; add "target" to the HTML section eyebrow. Cheap insurance against the STOP being read literally by a later reviewer.

### F23 — low · R01's acceptance criteria are soft for a packet that gates nine others
`md:94`: "Archive/rollover contract, proposed 150 limit and Toolshed namespace/key contract **are reviewable**." Reviewability is not a completion criterion, and R01 blocks R02, R03, R10, R12, R19 and R26.
**Correction:** convert to an artifact list — exact files changed, exact amendments recorded (with F05/F07/F13 added), the untouchable-string list from F08, and "these five test suites green."

### F24 — low · Minor MD/HTML divergences
(a) HTML badges R08 "M · protocol" (`html:45`) where MD says "M/atomic for pagination" (`md:156`); the HTML has no atomic-group list at all, so a reader who only sees the HTML can miss the strongest merge rule in the plan. (b) `data-lane` carries a ten-value taxonomy (`contract/authority/hardening/group/carrier/loss/operations/pilot/toolshed/later`) that no control reads — the filter is purely numeric (`html:87`) — and it contradicts the MD's three-lane staffing model (`md:426`). (c) MD's claim-tier table has six rows; the HTML evidence strip merges "Pilot" and "Capacity" into one (`html:74`).
**Correction:** add "atomic" to R08's badge and a one-line atomic-group note to the HTML workflow section; either wire `data-lane` to a filter or drop it; optionally split the last evidence row.

### F25 — low · R22's benchmark numbers read as contradicting R15's hard stop
R15 stops new posts at 4,000 ops / 8 MiB (`md:228`); R22 benchmarks "5,000 ops/10 MiB" (`md:300`). Plan 158 explains it — a separately named disposable benchmark profile, "this leaves headroom because production compaction is not integrated" (`plan158:837-843`) — and R22 does say "separate synthetic benchmark profile," but not why the number is higher.
**Correction:** one clause in R22: "5,000/10 MiB is deliberate headroom above the 4,000/8 MiB product stop, per Plan 158."

### F26 — low · A headline product limit is buried in R29's third bullet
D2 requires the subject to sign the verifier challenge "with the same key that signed those receipts" (`plan177:78-81`). Combined with AF-3, a member who loses their phone can never again present their pre-loss custody receipts — stated only at `md:370`. That is a user-visible consequence of two accepted policies interacting, and it belongs where people will read it.
**Correction:** surface it in the policy paragraph (`md:13`) and in R23/R30's disclosure materials; add an R30 observation item (does anyone hit it?).

---

## Material open questions

- **Q1 (F02).** Is the intended sequence "create Space → enroll members → founder authors a second root genesis pinning witnesses"? If so, which packet builds it and what does the app show in the interim window? If not, how does a genesis authored before members exist name real member keys?
- **Q2 (F03).** Does the beta accept an operator in the loop for every Thread creation and rollover, or does R11 build an authorized self-service provisioning path (a Plan 158 Decision 2 amendment)?
- **Q3 (F09).** Who advances the epoch, how often, during R23 and R30 — and what does the product do when the quorum is unreachable at renewal time?
- **Q4.** Does R26's "one Shed and up to 20 Tools" fit the same 64-route host budget as one Space + 12 Threads? That is 34 replicas per group; two groups plus a Shed exceed the manifest's `@max_instances 64`. R33 keeps the 64 bound — is the supported topology one group per host?
- **Q5.** Under the one-app decision, does the Toolshed module use the Treehouse row of `clients/lattice-mobile-core/products.json` exclusively, leaving the `toolshed` row dormant? That file is normative and pinned by both a TS and a Rust contract test; who updates them, and when?
- **Q6 (F10).** Are archived Threads still routed and synced, or delisted? This determines both the 4-socket round-robin behavior and whether "history is device-held and replayable" survives a route being reclaimed.
- **Q7.** R16 exports "necessary public pairing/admission/catalog trust state" for AF-1 while R21 rehearses same-identity restore from encrypted backups. Which is the pilot's declared relay-loss procedure, and does R23 rehearse both?

## Optional improvements

1. Add a per-packet "explicitly not in this packet" line. Several packets carry exclusions in prose; making it structural prevents the scope creep the roadmap otherwise guards well against.
2. Add a packet → source plan → pinned-test matrix (extending `md:498-512` with the third column). It would have caught F07 and F08 mechanically.
3. Consider demonstrating an offline-only, single-device local group after R10 but before R11/R13 — it is the cheapest hedge against F01 and gives M2 an earlier observable.
4. The claim-tier table (`md:469-476`) is the strongest part of the document; reference the required tier explicitly in each packet's Finish line rather than leaving it implicit.
5. R11's three PRs, R17's two, R19's two, R21's build/field split and R32's build/gate split deserve their own sub-IDs (R11a/b/c). The filter and dependency graph would then express what the prose already promises.

---

## Verdict: **REVISE**

The document is unusually honest, its dependency graph is internally sound, its self-validation claims check out against the repository, and its non-claims are consistently correct. It is not READY because four findings would stop a fresh executor cold rather than merely slow them: F01 (the fallback for the program's highest-risk packet cannot happen), F02 (the AF-2 witness set has no establishment workflow, and the window to create one closes with the founder's key), F03 (member-facing rollover silently requires an operator that Plan 158 forbids exposing), and F05 (seven packets are planned into a parked list that Plan 177 deliberately left in force). F04, F06, F07, F08, F09 and F10 each cost a session or a broken green suite. None of these require restructuring the roadmap — they are additions to R01's deliverable list, three declared amendments, one dependency-edge change, and re-sizing.

## Primary-agent dispositions

All changes below are planning corrections, not implementation or contract adoption. The revised roadmap remains proposed. “Addressed” means the missing requirement, sequencing or explicit decision gate is now represented; the future packet still needs its own evidence.

| Finding | Disposition and correction |
| --- | --- |
| F01 blocker | Addressed using option (a): R10 no longer depends on R04; R10/R12 deliver a root-only offline preview. R11/recovery/pilot still require R04. The preview issues no non-root member grants, and R14 audits lease readiness before enabling recovery. |
| F02 blocker | Addressed: R02 specifies enroll-then-root-pin; R12 shows unset fields; R14 implements per-replica witness/profile establishment, partial-readiness checks and pre-pinning loss refusal. R17 signs only after that establishment workflow. |
| F03 high | Addressed by retaining Plan 158's assisted operator, not introducing a public admin API. R11/R15/R18/R23 and the destination disclose transport liveness dependence and operator actions separately from semantic authority. |
| F04 high | Addressed: R01 must explicitly amend the deferred-mobile-ceremony contract; R17 is Android-specific native verification/protected signing plus physical proof. Plan 146 macOS codesigning is listed as a conditional external gate, not an Android prerequisite or substitute. |
| F05 high | Addressed: R01 requires scoped Shared Beta Contract/§4a approval for Android, QR camera and pairing. LAN stays parked; iOS and any newly parked host scope need separate gates. These edits do not themselves un-park anything. |
| F06 high | Addressed: sizing is calibrated against Plans 135–139/179; R10 and R14 are XL integrations, R12/R13/R15 and R19 build are L. Behavior preparation and composite stage boundaries are named. |
| F07 high | Addressed: R01 owns the archive-only Plan 178 vocabulary/test amendment; R19a owns later continuity-command changes and forbids a fourth role; R25 owns custody/dispute wire amendments and changes the group vocabulary only if its actual command surface changes. |
| F08 high | Addressed with qualification: the protected strings and three concrete pin suites are named, plus AF-1 and applicable product-manifest gates. The review's “five suites” was not accompanied by five pin-suite paths, so no nonexistent suite is invented. Adopted vocabulary assertions may change; unrelated status assertions/fixtures may not. |
| F09 high | Addressed: a proposed signed-epoch operations table names daily group quorum and Tool-root day ceremonies, separate units, lease windows, unavailable-quorum/stale-clock behavior, and the R18/R23/R30 operators. Exact parameters remain an R02 adoption gate. |
| F10 high | Addressed: R01's membership/rollover table covers stale invites, fresh reviewed grants, new-member archive scope, fan-out, retained routes and four-socket scheduling; R13–R15 carry matching tests. |
| F11 medium | Addressed with calibrated scope: new R35 blocks R33 expansion beyond the observed 9–15-person pilot cohort, rather than literally above 12 (which would contradict the pilot's 15-person upper bound). Lifetime arithmetic and explicit readable-but-closed exhaustion are visible. R35 must prove an adopted lifecycle or stop expansion. |
| F12 medium | Addressed: R19a has R01/R02 entry gates and supplies M1's decision; R19b additionally needs R04/R10 and completes the parent in M3. Composite-stage dependencies are explicit in MD and HTML. |
| F13 medium | Addressed: R01 explicitly owns both catalog/domain and deployment/catalog ordering amendments, with fixture/local-proof rationale and live/physical gates retained. |
| F14 medium | Addressed with the opposite valid serialization: small R07 merges before R03, and R03 now depends on it. Codec/vector ownership and reservations, including Plan 179's eight legacy vectors, are explicit. No second vector writer is allowed concurrently. |
| F15 medium | Addressed: no unidentified recovery artifact is a prerequisite; reuse needs a named SHA/equivalence proof. Session-specific duplicate-agent instructions were removed from the durable roadmap. |
| F16 medium | Addressed: R11a and the operator table require real catalog-key generation, living-root bootstrap review/signature and encrypted backup before real provisioning. Disposable local/test profiles are distinguished from field pilot credentials. |
| F17 medium | Addressed: R26 owns the Toolshed one-pager D1 correction and a focused copy-boundary gate, together with Tool-clock and lost-key limitations. Existing one-pager text is not represented as fixed today. |
| F18 medium | Addressed: R14c supplies lease states/warnings/renewal/failure UX and causal-time rules; R23 rehearses unavailable quorum and visible lapse/renewal failures. |
| F19 medium | Addressed: R01 records Plan 151 as superseded for this Treehouse delivery by R10–R15; reusable code is retained and any separate Township instrument remainder goes to R34. |
| F20 medium | Addressed: an informational, append-only README pointer now links the roadmap, HTML and this review. R01 owns adopted source-plan backlinks and status reconciliation, without rewriting historical rows or creating competing DONE ledgers. |
| F21 medium | Addressed without the recommended default downgrade: unproved Android native guarantees explicitly block physical AF-2/pilot gates. Software-only witnesses can support an engineering preview only. A weaker physical claim would need a separate operator-approved threat/contract change. |
| F22 low | Addressed: M3 and the HTML loss section explicitly say target/proof-to-be-earned. Existing failure badges and proposal status remain. |
| F23 low | Addressed: R01 has named amendment artifacts, actual approval/merge criteria, a protected-string inventory and concrete gates; “reviewable” no longer closes it. |
| F24 low | Addressed: HTML marks R08 atomic and lists atomic groups; unused data-lane taxonomy is removed; Pilot and Capacity have separate evidence rows. The previous taxonomy was not an execution lane, but removing it avoids the ambiguity. |
| F25 low | Addressed: R22 explicitly states that 5,000 ops/10 MiB is disposable benchmark headroom above the product's 4,000-op/8-MiB stop. |
| F26 low | Addressed with precise wording: key loss prevents new same-key challenge presentations, not reading or independently verifying old receipts. The destination and R23/R30 disclose it and the pilot rehearses the interaction. |

### Open-question dispositions

| Question | Proposed answer / execution gate |
| --- | --- |
| Q1 | Create a root-only preview; enroll real keys; living root explicitly pins each required profile in R14. Before pinning or after partial pinning, recovery_not_ready is visible. A lost root cannot retrofit the profile. |
| Q2 | Retain assisted, operator-only provisioning. No new public admin API. The operator is on call for R23 and is a disclosed liveness dependency, never a semantic signer. |
| Q3 | R02 adopts separate group/Tool units and the proposed daily ceremony/lease schedule. R14 shows stale time and renewal failure; missed quorum does not create a fallback clock. R23/R30 record actual human ceremonies. |
| Q4 | Initial topology is one group per host: 1 Space + 12 Threads + 1 Shed + 20 Tools = at most 34 routes. The existing 64-route ceiling remains; a second full group is outside that supported topology. |
| Q5 | R01 adopts exclusive use of the Treehouse app/key/database row for the module; the legacy Toolshed row stays dormant/reserved. R26 updates both TS and Rust manifest contracts; no automatic key migration. |
| Q6 | Archives retain routes, slots and authorized readability. They participate in bounded foreground round-robin sync; no silent delisting or reclamation. R35 owns any later adopted change. |
| Q7 | Member-retained AF-1 is the group-survival procedure; same-identity encrypted-backup restore is the additional operator procedure. R23 rehearses both and labels their different retained-data assumptions. |

### Optional-improvement dispositions

| Suggestion | Handling |
| --- | --- |
| O1 explicit exclusions | Added the per-packet evidence-tier/exclusions table for all 35 packets. |
| O2 pinned-test matrix | Added contract-test traceability for historical pins, vocabulary, manifest collision, legacy vectors, AF-1, custody, copy and lifecycle gates. |
| O3 cheap offline preview | Adopted through R10/R12 without R04/R11; not an antifragile release. |
| O4 explicit claim tier | Added each packet's finish tier in the same table; design, core, packaged, physical, pilot and capacity are distinct. |
| O5 composite sub-IDs | Added named R11a–c, R17a–c, R19a–b, R21a–b, R22a–b, R31a–b, R32a–b and R35a–b stage gates. Parent dependencies wait for final stages; HTML explains the early decision exceptions. |

Additional primary-agent corrections made while applying the review: an independently keyed third Toolshed auditor must be deliberately admitted and granted read scope; group-witness epochs do not silently replace Tool-root day assertions; an AF-3 link cannot close an old-key loan; malformed percent-encoded HTML fragments no longer throw before navigation initialization.

## Focused re-review — verbatim

Round 2 completed successfully using the same read-only `claude -p --model opus --effort high` invocation (resolved `claude-opus-5`), session `e1a6d7ff-8fb9-42c7-9886-e54540eb7163`, approximately seven minutes. It reviewed the 35-packet remediation revision, before the corrections below and before R36 existed. Its line references refer to that intermediate revision.

## Scope of this re-review

Read-only. I read the review/disposition record, the revised roadmap MD (all 680 lines), the revised HTML (all 105 lines including the JS), and the appended `plans/README.md` pointer. I opened source only to adjudicate two concrete questions: whether the appended README pointer can break the pinned suites, and what those suites actually assert (`contract_test.exs`, `audit_bundle_test.exs`, `read_model_test.exs`).

**Independently verified (do not re-litigate):**
- All 35 packet IDs and all 77 unconditional dependency edges are identical between MD blockers/stage table and HTML `data-deps`; the graph is acyclic (topological order R01/R05–R08 → R02/R03/R09 → R04/R10 → R11/R12 → R13 → R14 → R15 → R16/R17/R21 → R18 → R19b/R20 → R22 → R23 → R24–R32/R34/R35 → R33).
- The appended README pointer (`README.md:1420-1430`) cannot break a pin: all three README assertions are substring/prefix checks (`contract_test.exs:227-241`, `audit_bundle_test.exs:150-151`, `read_model_test.exs:115-116`), rows 121/122/178 are intact and there is still exactly one `| 178 |` line.
- `data-lane` is gone; R08 badges `M · atomic` (`html:45`); the evidence strip has six rows including separate Pilot and Capacity (`html:75`); `decodeURIComponent` is wrapped (`html:90`).
- Arithmetic checks: 12×4,000 = 48,000; 48,000/150 ≈ 320; 3,200/6.4 MiB = 80% of 4,000/8 MiB; 1+12+1+20 = 34 ≤ 64.

## F01–F26 disposition

| ID | Verdict | Evidence / note |
|---|---|---|
| F01 blocker | Resolved (qualified by N01) | R10 deps are `R01, R07, R09` (`md:202`, `html:47`); R12 is `R01, R05, R06, R10`; fallback restated at `md:153`. Fallback prose understates the actual blast radius — see N01. |
| F02 blocker | Resolved | Enroll-then-root-pin frozen in Decision 4 (`md:65`), specified in R02 (`md:129`), surfaced in R12 (`md:228`), built in R14a with pre-pinning-loss and partial-pinning refusals (`md:251`, `md:256-257`). |
| F03 high | Resolved | Operator liveness disclosed in the Destination (`md:15`), R11 (`md:216`), rollover table (`md:83`), R18 (`md:299`), R23 (`md:354`, `md:358`), HTML policy card (`html:34`). Decision 2 retained; no admin API. |
| F04 high | Resolved | R01 amendment register (`md:114`); R17 is Android-specific with macOS/Plan 146 as a conditional external gate only (`md:285`); operator row (`md:626`). |
| F05 high | Resolved | Scoped §4a sign-off is an R01 deliverable with named in/out scope (`md:116`), an operator row (`md:623`) and a "until recorded, those stages remain parked" rule. |
| F06 high | Resolved | Sizing basis stated (`md:102`); R10 XL/atomic, R14 XL, R12/R13/R15 L, R19b L. |
| F07 high | Resolved | R01 owns archive-only vocabulary amendment (`md:112`, `md:114`); R19a (`md:311`) and R25 (`md:377`) own their own later amendments; "not a fourth role" stated in both. |
| F08 high | Qualified | Protected-string inventory and pin suites are explicit (`md:121`) and the prose-pin/immutable-string distinction is correct (`md:112`). The list is still incomplete for Plan 178 amendment work — see N04. |
| F09 high | Resolved | Signed-epoch operations section (`md:86-90`), R14c, R18 runbook (`md:299`), R23 (`md:358`), R30 (`md:433`), operator row (`md:627`). Stale-clock semantics are self-consistent (no epoch advance ⇒ no lapse). |
| F10 high | Resolved | Rollover/membership contract table (`md:77-84`) with matching acceptance in R13 (`md:243`), R14 (`md:254-258`), R15 (`md:269`). |
| F11 medium | Resolved | R35 exists, gates R33 (`md:461`, `md:479-489`); lifetime arithmetic in Destination (`md:17`), R33 (`md:463`) and HTML policy card. Fresh-Space-is-not-migration stated. |
| F12 medium | Resolved | M1 names R19a only (`md:41`, `html:32`); stage table splits R19a `R01,R02` / R19b `R19a,R04,R10` (`md:511-512`). |
| F13 medium | Resolved | Both inversions in R01's register (`md:114`) and restated at R11 (`md:214`). |
| F14 medium | Resolved (opposite serialization) | R03 ← R07 (`md:137`); ownership and handoff at `md:177` and `md:493`; Plan 179's eight legacy vectors reserved. |
| F15 medium | Resolved | "Treat Plan 172 as unstarted unless an exact prior SHA is named" (`md:177`); no agent-coordination text remains anywhere in the MD. |
| F16 medium | Resolved | Catalog bootstrap ceremony in R11 (`md:214`) plus an operator row before real provisioning (`md:625`); disposable local keys distinguished. |
| F17 medium | Resolved (see N09) | R26 owns the Toolshed one-pager D1 correction and a focused copy-boundary test (`md:391`). |
| F18 medium | Resolved | R14c lease states/warnings/renewal-failure (`md:251`), acceptance at `md:258`, pilot bullet at `md:358`. |
| F19 medium | Resolved | Plan 151 dispositioned as superseded, remainder to R34 (`md:116`). |
| F20 medium | Resolved | Appended, informational, pin-safe pointer (`README.md:1420-1430`); R01 owns backlinks and one ledger (`md:112`). |
| F21 medium | Resolved as an accepted divergence | Native-guarantee failure blocks R17b/c and R18/R22/R23; software-only is preview-tier only and a downgrade needs separate operator approval (`md:287`, tier row `md:546`). Blast radius understated — see N02. |
| F22 low | Resolved | M3 titled "target: prove…" (`md:43`); HTML eyebrow "Target loss gates · not yet proved" (`html:30`); AF-2 badge unchanged. |
| F23 low | Resolved | R01 has named artifacts, real approval criteria and "draft/blocked, not DONE" (`md:112-121`). |
| F24 low | Resolved | All three sub-items fixed (`html:45`, no `data-lane`, six evidence rows). |
| F25 low | Resolved | `md:346` states the headroom rationale explicitly. |
| F26 low | Resolved | Destination (`md:15`), R20 (`md:325`), R23 (`md:354`), R30 (`md:433`) with the correct "new presentation, not readability" wording. |

No disposition claims implementation or authorization it does not have; "waiting for operator adoption" is used correctly throughout (R01, R02, R35, §4a, iOS).

## New findings

**N01 — medium · R04's failure branch still understates its blast radius**
`md:153` says R04 failure blocks "R11's recovery-enabled lifecycle and R18/R22/R23." But R11's blockers are `R02, R04, R06, R10` (`md:212`, `html:48`) and the stage table puts R04 on **R11a** and therefore R11b (`md:505-506`), while R11's own prose cites R04 only for **R11c** ("R11c proves replacement service/catalog identity through R04's pre-authorized trust path", `md:214`). Under the graph as drawn, R04 failure stops all provisioning, hence R13, R16, R21, R24, R26, R27 and R31 — i.e. everything except the R10/R12 preview and the hardening lane. This is the same prose/graph mismatch class as F01, one layer down.
**Correction:** either move the R04 edge to R11c (updating `md:212`, `md:505-507`, `html:48`), or keep it and rewrite `md:153` to name the real stop set ("no live provisioning, no two-app sync, no packaged AF-1, no WSS, no custody v2").

**N02 — medium · R17's failure branch names only its immediate consumers**
`md:287` blocks "R17b/c and R18/R22/R23." Because R23 gates R26, R30, R32, R34 and R35 (`md:385`, `md:429`, `md:451`, `md:471`, `md:481`) and R35 gates R33, an unproved Android native guarantee halts M3 through M6 entirely — including the Toolshed module and Township resumption.
**Correction:** state in R17's failure branch (and mirror in `html:54`) that failure leaves only the root-only preview and the hardening lane, and say explicitly whether any Toolshed/Township work may proceed at preview tier or must also stop.

**N03 — medium · The proposed lease cadence creates an unsized recurring renewal fan-out**
`md:90` proposes seven signed day-epochs for admission leases with a two-epoch warning window; `md:65` leases every founder-issued grant needing future removal; `md:80` requires per-replica exact-audience grants. For 12 members across a Space plus up to 12 Threads that is on the order of 150+ authority-signed renewals per week, performed by a human coordinator, for the whole 14-day pilot and beyond. The membership table sizes admission fan-out (`md:80`) but nothing sizes renewal fan-out, and R14c only requires the states to be visible (`md:251`).
**Correction:** make the fan-out arithmetic (members × replicas ÷ lease window) an explicit R02 adoption input alongside the expiry arithmetic, and require R14c to supply a batched/scoped renewal action or a longer default window; add a pilot-load bullet to R23.

**N04 — medium-low · R01's protected-string list misses two live `contract_test` invariants**
R01 must amend Plan 178 (`md:112`) and protects status rows, DONE sentences and build-map strings (`md:121`), permitting change only to "explicitly approved vocabulary assertions." Two other assertions bind Plan 178's body: exactly one paragraph may start with the prohibited-phrase prefix (`contract_test.exs:183-191`) and no prohibited phrase may appear outside exempt regions (`contract_test.exs:193-202`). Appended amendment prose that discusses hosting claims can break either, and neither is a vocabulary assertion or a status pin.
**Correction:** add to `md:121`: appended Plan 178 amendment text must not introduce a second prohibited-phrase paragraph or an unexempted `nothing hosted`/`serverless` occurrence, and must preserve the required-sentence set (`contract_test.exs:147-155`).

**N05 — low · Several build stages are gated on a parent's field/recovery final stage**
`md:501` sets "a dependency on a parent R-number requires its final listed stage," which contradicts `md:497` ("do not keep a code session waiting for hardware or a two-week pilot") in three places: R22a ← R21 resolves to R21b's named-host field restore (`md:515`, `md:514`); R24 ← R11 resolves to R11c replacement-trust recovery for a pure semantics/wire packet (`md:363`); R31a ← R11 likewise (`md:517`).
**Correction:** cite the exact sub-stage on these three edges (R22a ← R21a, R24 ← R11a, R31a ← R11a/b) and keep the field stages on the field consumers.

**N06 — low · R14's merge unit is stated two ways**
`md:247` gives R14 one "governance/profile/renewal workflow PR" and `md:501` calls R14a–c "the atomic integration sequence," but the atomic-groups lists omit R14 (`md:497`, `html:75`).
**Correction:** add R14 to both atomic-group lists, or downgrade `md:501`'s wording for R14a–c to "sequenced sessions in one merge."

**N07 — low · A load-bearing safety sentence is ambiguous**
`md:228` "This preview issues no non-root member grants" can be read as "no grants to non-root members" or "no grants not issued by the root." This sentence is the primary structural guard against F01's preview drifting toward AF-2 readiness.
**Correction:** "This preview issues no member grants of any kind, leased or unleased."

**N08 — low · R15's successor Thread has no profile-pinning acceptance bullet**
Decision 4 (`md:65`) and R14 (`md:256`) require new Threads to pin the approved profile at creation, but R15's acceptance (`md:266-269`) never asserts it for the rollover successor; the guard is only R14's readiness computation.
**Correction:** add one R15 bullet — the successor Thread is created with the approved beacon/succession profile pinned, or the Space shows partial-pinning/`recovery_not_ready`.

**N09 — low · R01's "current one-pager wording" artifact is unscoped against R26**
`md:112` lists "current one-pager wording" among R01's artifacts; `md:391` assigns the Toolshed one-pager's D1 correction to R26 (blocked by R23). If R01's edit touches `plans/toolshed_one_pager.html`, Plan 177 item 5's "when Toolshed copy is next touched" trigger fires at R01, not R26.
**Correction:** name the file in R01 (`plans/treehouse_one_pager.html`) and state that any Toolshed one-pager edit pulls the full D1 correction forward from R26.

## Accepted limitations (not defects)

- R17's no-automatic-downgrade stance and R07-before-R03 are deliberate, coherent choices that diverge from the reviewer's recommendations; both are recorded as such.
- The revised documents carry no rerun browser/print validation; `md:670-679` labels the 2026-09-04 Chromium/`mix verify` evidence as historical and the review record says re-verification is pending. My graph-parity check above discharges the MD/HTML consistency dimension only. Note the coincidence that the revised graph is also 77 edges (35 nodes), so `md:672`'s historical number reads as if unchanged — `md:679`'s disclaimer is what keeps it honest.
- Plan 177's index row still reads `TODO` while the roadmap calls it merged; R01 owns status reconciliation and `md:96` instructs executors to trust evidence over stale rows.

## Verdict

**READY FOR PROPOSAL ADOPTION.**

Every F01–F26 disposition holds at the planning level; F08 and F21 are qualified rather than open, and the two blockers (F01, F02) are structurally resolved — the preview path is genuinely reachable without R04, and the enroll-then-root-pin workflow now has an owner, a visible unready state, a grant audit and a pre-pinning loss refusal. Nothing new reopens a blocker. N01, N02 and N03 are single-paragraph corrections inside existing packets (R04, R17, R02) that should land before an executor picks up those packets, because each currently understates a consequence an executor would rely on; N04–N09 are editorial. This is a verdict on the proposal document, not on product readiness: no packet's evidence gate has been passed and no operator approval, un-parking or contract change has been granted here.

## Follow-up dispositions and additional sequencing correction

| Finding | Disposition |
| --- | --- |
| N01 medium | Addressed conservatively: R04 still gates all of R11. R04 and HTML now state the full provisioning, live-sync, packaged recovery, WSS, custody and downstream release stop set, while preserving root-only preview. |
| N02 medium | Addressed: R17 explicitly blocks all downstream M3–M6 release gates on native failure. Already-authorized fixture/core work may proceed only at its true prerequisites; neither the Toolshed module nor Township release is silently downgraded. R36 additionally blocks supported pinning when custody itself is unavailable. |
| N03 medium | Addressed: R02 must size up to 156 grants per seven signed days at 12 members/13 replicas, plus extra-role and signature/prompt overhead. R14c provides bounded exact-scope reviewed renewal batches or R02 adopts a longer measured window; R23 records actual workload/log growth across two cycles. No general signing or daily renewal of every grant is implied. |
| N04 medium-low | Addressed: R01 additionally preserves Plan 178's required sentences, single prohibited-phrase paragraph and forbidden-claim scan boundaries, with the exact test ranges. |
| N05 low | Addressed with an explicit retained dependency: R22a uses R21a and R22b retains full R21; R24 uses R11a; R31a names R11b. R31 deliberately still consumes R16's completed packaged export/reseed workflow and therefore transitively full R11, documented as required host-recovery evidence rather than pretending the field gate disappeared. Security-relevant physical prerequisites likewise remain intentional release gates. |
| N06 low | Addressed: R14 is in both atomic-merge lists. Its a–c sessions are preparation slices in one enabled merge. |
| N07 low | Addressed in both documents: the preview issues no member grants of any kind, leased or unleased. |
| N08 low | Addressed: R15 explicitly tests approved successor beacon/succession pinning or partial recovery_not_ready. |
| N09 low | Addressed: R01 names only the Treehouse one-pager; any earlier Toolshed copy edit pulls the entire D1 correction/test forward from R26. |
| P01 high — primary-agent finding | Addressed by new R36: existing governance witness keys are distinct from carrier/member keys, so their native provisioning cannot wait for R17b after R14 pins them. R36 follows R17a/R12, provisions the protected key and reviewed public binding, then R14 pins it; R17b later implements exact witness claim authorization. Carrier aliasing, seed export, generic signing and automatic witness rotation are forbidden. Native source evidence: `ensure_governance_witness_key`, `governance_witness_public_key`, `reject_governance_carrier_alias` in `clients/township-tauri-shell/src-tauri/src/lib.rs`. |

R36 is a native identity-bootstrap gate, not a second member identity or an AF-2 physical claim. The revised HTML supports stage-anchor dependency navigation and places R36 in the first-chat lane despite its append-only packet number. All 36 packets remain planned. The original F02/Q1 dispositions above are strengthened by this bootstrap step; their historical review text is unchanged.

## Final delta review — verbatim

Round 3 completed successfully with `claude -p --model opus --effort high` (resolved `claude-opus-5`), session `5edaef3d-8efb-407b-ad05-c00aea2d945a`, approximately four minutes. It checked N01–N09 and P01 against the 36-packet revision and source seams. Its line references identify that revision before the two editorial notes below were applied.

I read the review tail, the changed packets and stage table in both documents, and spot-checked the two source claims.

## N01–N09 / P01 verification

| ID | Status | Evidence |
| --- | --- | --- |
| N01 | Resolved | `treehouse-delivery-2026-09-04.md:153` blocks "all of R11 (including R11a provisioning)" plus the full stop set (live provisioning, two-app sync, packaged AF-1, WSS, custody v2, pilot/module/expansion) and keeps the root-only preview; stage row `R11a \| R02, R04, R06, R10` (`:520`) agrees; HTML `:41` mirrors ("blocks all R11 provisioning and downstream live sync, packaged recovery, WSS, custody and release paths"). |
| N02 | Resolved | `:288` failure branch stops M3–M6 including Toolshed module/pilot, iOS, expansion, Township; R24/R25 allowed only via R11a + core gates, which matches `R24` deps `R03, R09, R11a` (`:365`); R36 clause blocks supported pinning when custody is unproved (`:503`); HTML `:54` mirrors. |
| N03 | Resolved | `:90` sizes 12 × 13 = 156 renewals/seven signed days, 312 over two cycles, before role overhead; R14c bounded exact-recipient batch or longer window (`:251`); "a batch is not a general signing permission… does not renew every grant daily"; R23 records across two cycles (`:359`); HTML `:39`, `:51`, `:60` mirror. |
| N04 | Resolved | `:121` names Plan 178's required-sentence set, the single prohibited-phrase paragraph and `contract_test.exs:147–155,183–202`. Verified in source: `147–155` is the required-sentence test; `183–191` is the exactly-one-prohibited-paragraph assertion; `193–202` is the forbidden-claim scan. HTML `:38` carries the invariant without line numbers. |
| N05 | Resolved (with intended retention) | Stage table `:530–532`: `R22a \| …R21a`, `R22b \| R22a, R21`, `R24 \| R11a`, `R31a \| R08, R11b, R16`; `:516` states R31a deliberately keeps R16's full-R11 host-recovery gate. HTML deps strings match exactly (`R22 → R21a` with "R22b also requires full R21", `R24 → R11a`, `R31 → R11b R16` plus the explicit "transitive full-R11 recovery gate" sentence at `:68`). |
| N06 | Resolved | Atomic groups include R14 in md `:512` and HTML `:76`; R14a–c described as preparation slices of one merge (`:251`). |
| N07 | Resolved | `:228` "issues no member grants of any kind, leased or unleased"; HTML `:49` identical. |
| N08 | Resolved | `:269` successor created with the approved beacon/succession profile pinned, else partial `recovery_not_ready`; HTML `:52` "Pin the approved profile on the successor or show partial recovery_not_ready". |
| N09 | Resolved | `:112` R26 retains Toolshed one-pager ownership; any earlier Toolshed copy edit pulls the full D1 correction and focused test into the same PR; R26 `:393` unchanged; HTML `:38` mirrors. |
| P01 | Resolved | New R36 (`:493–504`) blocked by R01/R12/R17a; R14 blocked by `R13, R04, R36` (`:247`) and R14a pins R36's reviewed public bindings; R17b (`:286`, stage row `:524`) still owns exact claim verification. Scope limits present: no carrier alias, seed export, macOS key import, generic signing IPC, no rotation without separate policy (`:497–504`, exclusion row `:580`). No cycle: R36 → R17a only. Source verified in `clients/township-tauri-shell/src-tauri/src/lib.rs`: `ensure_governance_witness_key:678`, `governance_witness_public_key:715`, `reject_governance_carrier_alias:870` (called on the carrier signing paths at `:650–665`), a distinct key purpose. HTML `:73` mirrors deps and finish text; stage anchors `#R11a/#R11b/#R17a/#R21a` all exist (`:48`, `:54`, `:58`), so no broken dependency link. |

Graph sanity: 36 packet IDs in both documents, HTML `data-deps` matches every markdown "Blocked by" line I inspected, stage table covers all 18 sub-IDs of the eight composite parents, and M2 lists R36 in both files.

## New material findings

None that change the verdict. Two low-severity observations:

- **L1 — R13 consumes R36's binding but neither depends on nor mentions it.** R36 states "R13/R14 consume an explicit member-reviewed binding between member identity and witness public key" (`:499`), yet R13 (`:236–243`) is blocked only by R08/R11/R12 and its body never mentions conveying a witness public key during enrollment. R14 (blocked by both) can absorb the gap, but an executor taking R13 first has no instruction to carry the binding. A one-clause note in R13, or listing R13 as a downstream consumer only, would remove the ambiguity. Adding R36 to R13's blockers is also cycle-free if you prefer that.
- **L2 — §4a operator-input row omits R36.** The un-parking row's "Needed before" column (`:639`) lists R13, R17b/c, R20, R22, R27 but not R36, whose acceptance test asks for "independent devices" producing distinct keys. It is not an actual authorization hole — R36 is blocked by R01, and R01 is not DONE until the scope approval is recorded — so this is column completeness only.

Also non-material: R01's cited range `183–202` starts mid-test at line 183; the same test's quoted-old-claim exemption assertion (`177–181`) sits just outside it. Running the file, as R01 requires, covers it.

**READY FOR PROPOSAL ADOPTION.**

All nine N-findings and the P01 native-witness-key sequencing correction are resolved in both the markdown and the HTML mirror, with the two source claims (native governance-key functions, Plan 178 test line ranges) verified against the tree. This is a verdict on the proposal document only: the product remains unimplemented, no packet evidence gate has been passed, and no operator countersign, un-parking or contract change is granted here.

### Final-note dispositions

| Note | Correction |
| --- | --- |
| L1 low | R13 now explicitly enrolls member/carrier identity only; R14 consumes the reviewed R36 witness binding later. R36 names R14, not R13, as that binding's consumer. HTML mirrors the clarification. No dependency or authority behavior changed. |
| L2 low | Added R36 to the §4a operator-input row. R36 already depended on R01 adoption; this makes the existing gate visible in the summary too. |
| Unnumbered test-range note | R01 explicitly preserves the quoted-old-claim exemption and expands the cited range to 177–202. The entire contract-test file remains the gate. |

All 37 numbered Opus findings (F01–F26, N01–N09, L1–L2), seven questions and five optional suggestions have dispositions above; P01 is an additional primary-agent correction. No finding is omitted or represented as product implementation. The final two editorial clarifications were applied after the READY verdict; they do not change the reviewed dependency graph or contract choices.

## Revision verification

Completed locally on 2026-09-05:

- `git diff --check` and explicit trailing-whitespace checks pass, including the new untracked review record.
- Markdown/HTML agree on all 36 packet IDs and 81 entry dependency edges, including stage-qualified edges. Expanded composite graph: 54 nodes (36 parents + 18 stages), 105 edges, acyclic. Composite parents resolve to final-stage completion; there are no unresolved dependency IDs.
- All 55 HTML IDs are unique; every fragment link resolves. All 30 relative artifact/source file links resolve. Inline JavaScript parses.
- Chromium controls: all/ready/chat/Toolshed/later filters show 36/6/24/7/5 respectively; search, empty result, reset, expand/collapse and hidden-target stage navigation pass. R36 appears in the first-chat lane, not the optional lane.
- No page overflow at 320, 390, 768 or 1,440 pixels. Desktop, mobile and print-media screenshots were inspected. Print opens all 36 packets and restores the prior filter/open state afterward. Without JavaScript all 36 disclosures remain readable and R36 opens natively. Malformed percent-encoded hashes do not break controls.
- `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" /Users/nicholas/.asdf/shims/mix verify` passed after the 36-packet changes: format plus full default suite, seed `325596`, 27 properties and 663 reported tests, zero failures, three existing exclusions. The subsequent L1/L2/range and review-record edits are documentary only. No implementation, test fixture or lockfile changed.
- All original and follow-up returned review text is retained verbatim. Ignored raw review streams, test logs, screenshots and browser diagnostics remain in `output/playwright/`; named browser session closed. No other agent/worktree was changed.

This is documentation/local-baseline evidence, not hosted CI, native physical release, product readiness or operator approval. The resulting proposal has 36 planned packets, not 36 completed packets. This review revision is local and uncommitted; the previously published roadmap commit remains `b9ea8bcd675a1109621f6c1e4fa62dad74d80bbb`.
