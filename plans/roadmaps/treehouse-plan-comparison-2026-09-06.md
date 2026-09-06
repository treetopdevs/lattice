# Comparison: Treehouse delivery roadmap and Plan 180

Prepared 2026-09-06. Deliverable: [unified delivery plan](treehouse-unified-2026-09-06.md).

## Recommendation

Use the revised delivery roadmap as the execution backbone and Plan 180 as the source of precise semantic rules, narrow claims and integration boundaries. Keep a useful offline preview early; require complete packaged and physical loss proofs before the community pilot. Do not combine the two schedules by executing every row from both.

The delivery roadmap is the stronger complete release program. Plan 180 is the more compact guide to the existing contracts and immediate substrate work. Their central difference is the release promise: Plan 180 allows its assisted phone pilot before the full three-loss destination is closed, with manual role transfer on devices; the delivery roadmap requires a stronger recovery-capable candidate and therefore explicitly proposes changing the deferred mobile-witness contract.

Neither is implementation evidence. Both use `af84459bfc066b4ed405b99a02046b4f2c6315ee` as their reference baseline. The reviewed delivery file includes its 2026-09-05 revisions, including R35/R36; comparing only the original committed 34-packet version would miss material fixes.

## Side-by-side

| Dimension | Delivery roadmap, revised September 5 | Plan 180, current working file | Choice in the synthesis |
| --- | --- | --- | --- |
| Product sequence | Treehouse pilot, Toolshed module, later Township; optional iOS/host/capacity lanes | Same group-first direction; four-slot wave schedule | Keep one program and one dependency ledger; staffing is optional |
| First useful result | Explicit root-only offline domain/native preview can proceed if continued-authority work stalls | Domain/TS/catalog land together after catalog and Plan 179; substantial unmerged prework | Keep the preview, with an explicit Plan 158 dependency amendment; both runtimes still merge together |
| Founder-loss proof | Bounded successor, surviving renewal issuers, two expiry cycles, new child roots, native witness ceremony and combined founder/relay loss | Precise Plan 179 stages and a separate successor-bound repair; lease default with operator decision | Keep Plan 180's bounded semantic scope and the delivery roadmap's full lifecycle proof |
| First community pilot | Packaged AF-1/AF-2/AF-3 plus combined loss are hard release blockers | E1 can complete separately from E2; AF-3 may run alongside candidate work; mobile witnessed succession remains hidden | Choose the stronger recovery-capable release. This increases scope and requires the stated ceremony/scope amendments |
| Witness bootstrap | Separate protected witness key R36; enroll member keys, then living-root pinning R14, then claim/presence ceremony R17 | Describes genesis witness/lease shape and defers mobile ceremony; no equivalent complete native bootstrap workflow | Preserve the explicit bootstrap order and visible partial readiness |
| Lease operability | Names coordinator, proposed cadence/window, fan-out, warnings, batches and missed-quorum behavior | Explains why leases cannot lapse without a beacon; recommends long founder leases and admin renewal | Require both the causal-time explanation and a measured surviving renewal path; no assumed seven-day policy |
| Relay/catalog loss | Verifies outsider input early; tests retained-client replacement trust and combined founder/catalog-key loss; distinguishes backup restore | Solid local catalog saga and AF-1 export path, but Plan 171 is later and comparable combined-loss proof is absent | Move verified restore before reseed; test replacement without dead signer/old disk/injected trust |
| Thread archive semantics | Strong volume/lifecycle and membership/fan-out acceptance; some detailed rules remain in source plans | Explicit Thread-local moderator field, denial ordering, concurrent post behavior, moderator tombstone exception | Copy those precise semantic requirements into the consolidated contract |
| Capacity and lifetime | Twelve archived/live slots; roughly 48,000 Thread ops; R35 must resolve lifetime before R33 expansion | Enforces per-Thread thresholds and counts archive slots, but no complete exhaustion/expansion program | Keep R35 and readable/exportable end-of-life; supported count must include lifetime/device envelope |
| Operator dependence | Explicit on-call provisioning, root/bootstrap ceremony, quorum/renewal coordinator, supported backup recovery | Lists hosting/secrets/devices/decisions, but does not carry provisioning latency and signer independence through every loss path | Make each operator's transport action and each member's semantic signature visible in evidence |
| AF-3 and custody interaction | New-key possession, competing links, old-phone return, lost receipt-key presentation and unresolved old-key loans | Useful vouch-spike questions and founder-present/absent core tests | Keep the core negatives and full cross-feature lost-key consequences |
| Toolshed | Detailed exact-loan semantics, scoped third-device audit, zero-write ledger, selected-receipt disclosure, module pilot | Clear three custody slices, no aggregate reputation, subject-present flow, one-pager correction | Preserve both, with R19a now an explicit dependency of lost-signer dispute semantics |
| Execution discipline | Explicit stages, risk-bearing XL packets, exact candidate and evidence tiers | Compact size/risk/dependency/exit table, one-owner hot files, atomic parity merges | One table with all these fields, plus co-located behavior/claim rules |
| Approval load | R01 bundles core amendments, physical scope, module countersign and inclusive-150 target | D4–D7 are separate decisions, although shell packaging can wait on D5 | Split core, Android/witness and module adoption; move capacity-boundary decision to expansion |

## Material changes beyond either source

1. **One release promise.** There is an internal offline preview and a stronger community candidate. The roadmap does not silently turn a failed recovery design into a pilot with weaker claims. Conversely, failed native/authority research does not block the root-only offline preview.
2. **Three independent adoption stages.** R01a adopts the core contract; R01b adopts Android/ceremony scope after its native design is concrete; R01c supplies the module countersign only before module enablement. Treehouse retains its existing product identity while that module decision waits. The proposed inclusive-150 amendment moves to R35a.
3. **A complete dependency graph.** Substages are executable IDs. R25 explicitly waits for R19a's lost-signer contract. R36 waits for native architecture and scoped approval, and precedes R14 pinning. Optional host implementation waits until after R23, keeping it off the pilot's resource priority as Plan 180 recommends.
4. **Ownership is not semantic dependency.** R07/R08 can proceed independently; R09 requires both. R03/R10 integration shares a reservation queue, preferably beacons first when ready, while the offline preview is not falsely blocked on founder continuation.
5. **One exact archival contract.** The combined file states the causal denial reasons and moderator exception directly. It also handles exhausted slots before rollover and a failed operator provisioning step after archive, with an explicit pending successor and idempotent retry.
6. **Loss gates test shared failure causes.** Separate AF tests can all pass while depending on the same founder or catalog signer. The combined case destroys both and requires retained-client trust, a surviving authorized signer and recorded transport-only provisioning.
7. **Renewal must fit people and history.** The plan measures grant/signature/prompt load and authority-log consumption before adopting a lease duration. A longer window does not count as two observed pilot cycles; controlled acceleration is isolated to test profiles, or the observation window extends.
8. **Pilot success is behavior.** Every participant onboards and completes offline-post/heal. Before enrollment, the pilot lead records usage/support targets; the report measures completion, failure, wait time and growth without message telemetry. Hard correctness failures stop the affected workflow and require new candidate evidence.

## Costs and remaining decisions

The strongest release is materially larger than Plan 180's earliest assisted chat pilot: Android native witness custody/verification, surviving renewal authority and replacement catalog trust are real high-risk work. They cannot be resolved by better roadmap prose. R02 and R17a are prioritized to discover an infeasible design before the app depends on it. The exact threshold, lease cadence, successor policy and social-attestation contract remain proposed until their concrete probes and amendments are adopted.

The finite 12-Thread policy and operator-assisted routing are consciously retained. They make the first pilot bounded, but do not support unlimited history, unattended rollover or 150-member capacity by assertion. Toolshed retains its own Tool-root clock and lost-receipt-key limitations. No source's old DONE claim, local test result or successful HTML review is promoted to evidence for these future gates.

## Traceability

Original source files were read in full and left unchanged. The links below now resolve to
committed, byte-identical snapshots; their original worktree provenance is recorded alongside them:

| Source | Reviewed working-file identity | Load-bearing portions |
| --- | --- | --- |
| [Delivery roadmap](sources/treehouse-delivery-2026-09-04.md) | SHA-256 `0f19d9f9cd31c2ad677d5cdad3db241c2bf63da2d084ce62f8478d7bacd2b8fe`; dirty worktree based on `b9ea8bcd675a1109621f6c1e4fa62dad74d80bbb` | Destination, R01–R36, composite stages, signed-epoch and membership tables |
| [Plan 180](sources/180-group-first-roadmap.md) | SHA-256 `06f340581f0ae589b061265b62df0d6161ab95d37a656a46c4bc4ae7b2468c92`; untracked in checkout `9601f146db889f98c36bc3b203b6cb7ade8a4bc4` | Decisions R1–R6; 0.3 archive; 1.x Plan 179; 2.1 successor bound; 3.x AF-3; A2b/A2c; claims ledger |
| [Prior delivery review](sources/treehouse-delivery-2026-09-05-opus-review.md) | Historical review/disposition record, not a review of this synthesis | Earlier bootstrap, scope, lease, catalog, capacity and evidence corrections; its findings do not constitute approval of this document |

Source snapshots and their [hash manifest](sources/SHA256SUMS) make this comparison reproducible
without the original worktrees. They are historical inputs, not competing execution ledgers;
[the archive note](sources/README.md) explains their unchanged relative-link context. The unified
executor plan uses repository-relative current source-plan links.

Current-baseline checks were made against immutable `af84459b`: causal policy context and expiry in [authority.ex](../../apps/lattice_core/lib/lattice/authority.ex), the [Plan 158 domain/catalog and mobile-ceremony contract](../158-real-device-beta-poc-program-map.md), [Plan 179 later-root-genesis policy](../179-witnessed-beacons-af2-founder-loss.md), and the separate governance/carrier key boundary in [native code](../../clients/township-tauri-shell/src-tauri/src/lib.rs). This was a targeted consistency check, not a new security or hosted-readiness audit.

### Source-to-packet crosswalk

| Plan 180 chunks | Consolidated packet |
| --- | --- |
| 0.1/0.2/0.3 | R01a; R01b/R01c isolate actual operational/module adoption |
| 1.1–1.6 | R03, preserving Plan 179's single atomic implementation merge |
| 1.7 | R03/R04/R19b claims gates; exact contract amendments only after their evidence |
| 2.1/2.2 | R02/R04/R14; no assumed new global plan number |
| 3.1/3.2 | R19a/R19b/R20, with native/combined-loss release gates |
| A2b/A2c/A3 | R11a–c/R21a–b/R13; R17/R36 supply the separate witness scope |
| 4.1/4.2/4.3 | R10 plus R11; domain-before-catalog is an explicit proposed amendment |
| 5.1/5.2/5.3/5.4 | R10/R12–R16 |
| 6.1/6.2 | R22/R23, strengthened by R18/R20 and exact physical loss tests |
| 7.1–7.6 | R01c/R24–R30 |
| 8.1/8.2 | R31 plus R16 and the Plan 167 product-explanation gate |
| 9.x | R05–R09; optional 164/166/167; platform-specific 146/174 |

R01–R36 from the delivery roadmap are retained; R01 is split into adoption stages and the graph makes additional constraints explicit. R35 owns both lifetime and the later proposed inclusive member-count boundary. This is one proposed successor schedule, not a directive to complete the original and consolidated versions twice.

## Validation of the original proposal (historical, before execution authorization)

Completed locally on 2026-09-06 in the isolated synthesis worktree:

- Structural check: 36 retained packet identities, 48 executable stage rows and 103 unconditional dependency edges; no duplicate stages, unknown prerequisites or cycles. Initial ready set matches the written schedule. Conditional iOS-with-Toolshed and Township-pilot gates are stated explicitly outside that edge count.
- Every local link in both new documents resolves; no trailing whitespace. `git diff --check` passes. The only tracked change is an eight-line, append-only README pointer; the two new documents are untracked deliverables pending publication. Existing status rows and source contracts are unchanged.
- `mix verify`, invoked with the required asdf/OTP 28 prefix, exited 0: formatting and the full default umbrella suite passed. ExUnit reported 663 tests and 27 properties, zero failures, with three existing exclusions; browser/load/packaged-release exclusions remain in force. Cached dependencies/build outputs were copied into this worktree, and its lockfile matches the baseline.
- After the final README addition, the three protected Township/Treehouse contract suites passed again: 15 tests, zero failures, seed `977465`.
- Both original Markdown source hashes still match the identities recorded above. No original roadmap, source HTML, source-worktree README or production code was edited.
- A second consistency pass checked the preview fallback, witness-key bootstrap order, living-root/catalog signer custody, atomic parity boundaries, cadence versus observation length, cross-feature lost-key dependency, finite capacity and exact-candidate evidence. This was a local self-review; the historical Opus review did not review this synthesis.

No implementation packets, operator decisions, hosted CI, deployment, native candidate or pilot have been completed by this documentation change. The files are ready for review as a proposal; no commit or push was made.
