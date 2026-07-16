# Township — Agent Team Orientation & Build Map

**Read this first.** It is the single entry point for an agent team tasked with taking the
Township vision to *100% tested and working*. It is a **map, not a spec**: every section
points at the asset that carries the real detail, states what is proven vs. stubbed vs.
blocked, and fixes the build order so nothing is attempted before its prerequisites exist.

> **Prime directive — Sim is the oracle.** `Lattice.Sim` is the source of truth for what
> "correct" means. Every implementation (Elixir engine, TS client, the carrier) must
> reproduce Sim's materialized state, quarantine set, and canonical order. Any divergence
> between two implementations of the same reduction is the **V-01 drift bug** and is a STOP
> condition, not a patch-the-test situation.

> **Grounding rule.** Verify against the real branch `claude/beautiful-gould-6b25d2`, never
> against this document's summaries. Where a claim here disagrees with the branch, the branch
> wins — and fixing this map is then a task. A hand-authored test vector is *not* the oracle
> until it is regenerated from Sim.

---

## 0. The vision in one paragraph

Township is a town-scale (≤10k) civic coordination instance on the Lattice substrate:
self-certifying identities on residents' own devices deliberate in durable threads, grant and
revoke real roles, and settle local matters with attestations no one can be forced to prove —
with **no server to seize**. It is the M5 application pilot that stress-tests the substrate
end-to-end. The full architecture, adversary model (A1 coercion / A2 faction / A3 state), and
roadmap live in the program doc below.

---

## 1. Asset inventory (what exists, and what each is for)

### 1.1 Vision & program docs (read to understand *why*)

| Asset | Type | What it is | Trust level |
|---|---|---|---|
| `lattice_program_doc.html` (**PD-001**) | HTML | The master program doc: big picture, the stack (L1 Lattice → L4 Cadence), the roadmap DAG (M0–M6), the Township stretch spec (§5), and the road-to-M1 questions (§6, Q-01…Q-08, V-01…V-04, R-01…R-06). | Canonical vision. Roadmap = dependencies, not dates. |
| `township_poc_addendum.html` (**PD-001-A**) | HTML | The POC execution plan: the **minimal cut** (prove W0–W3 on the real substrate, stub W4 attestation behind an interface), the five workflows, the exit gate G1–G5. | Canonical POC plan. |

### 1.2 The application track — Township overlay (drop onto the 2.0 branch)

`township_poc_overlay.zip` → unzips into the repo; paths already match.

| Path | What it is | Status |
|---|---|---|
| `apps/lattice_core/lib/township/matter.ex` | `Township.Matter` — the civic Replica (LWW title/summary, causal-list posts, OR-set members, authority-gated `clerk_locked?`). Built only from primitives that exist today. | **Real and compiled**; W0–W2, W3's current dump/restore survival behavior, and the W4 stub workflow/property suites pass against the branch. Legacy tick succession remains Sim-exported and TS-conformance-gated with untrusted provenance. A separate opt-in valid-genesis-pinned m-of-n witnessed recovery path is independently verified by BEAM and TypeScript, but it authorizes governance recovery rather than proving dormancy; no user-facing ceremony exists. |
| `apps/lattice_core/lib/township/read_model.ex` | `Township.ReadModel` — structured Threads, Roles, Members, Attest, trust-graph, and causal op-DAG inputs for the one-screen instrument boundary. | **Real and tested**; four panels and graph evidence derive from `matter.log`, W4 vouches remain caller-held and stub-labeled, and no renderer is claimed. |
| `apps/lattice_web_socket` | Dependency-light home of `Lattice.Transport.WebSocket.Client`, the shared JSON envelope codec, and `Lattice.Carrier.WebSocket`. | **Real and carrier-tested**; generic and Township second-process convergence, session security, batching, telemetry, and server transport suites use the promoted client. Plan 132 adds active-once incremental frame parsing, lifetime-exclusive streaming versus atomic request modes, one-envelope streaming prefetch with TCP backpressure, typed owner-preallocated subscriptions, bounded notification-type reservation, and request/notification demultiplexing. Plan 142 adds an atomic server-first nonce receive and carrier session v2 while leaving operation wire v1 unchanged; exact challenge replay on a new connection is rejected. Cowboy peer/server fixtures remain in their boundary apps; the Township projection consumes this client without taking listener ownership. |
| `apps/lattice_carrier_server` | Dedicated supervised Cowboy boundary that serves one configured signed log to trusted carrier realms. | **Real and server-tested**; Plan 127 adds authenticated frontier and pull, fail-closed source reload, fixed-port supervision, second-BEAM projection recovery, and a browser fresh/stale/fresh proof. Plan 128 adds the opt-in durable client-signed relay for selected trusted realms on path-backed sources: changed signed logs are persisted before acknowledgement and survive restart for a distinct observer. Plan 129 proves the actual packaged desktop Tauri app can use that boundary through native key custody, persisted capability evidence, and explicit one-op relay mode, then converge with a fresh pull-only observer after server restart. Plan 130 drives that same boundary from a LiveView-prepared, app-authored post and proves exact Sim convergence before and after restart. Plan 131 makes both packaged macOS convergence proofs CI-enforced on a hosted runner. Plan 132 adds an authenticated bounded `ops_available` hint after durable change, monitored subscribe/unsubscribe, restart-stable generation, and holder-level one-outstanding flow control whose acknowledgment returns the latest durable generation. Plan 142 adds per-connection server freshness, re-auth subscription reset, temp-file sync before rename, and fail-closed startup orphan cleanup. Here and below, carrier "durable" means process-crash/restart durable only, not power-loss durable: the parent directory is not synced and macOS `F_FULLFSYNC` is not requested. Plan 142 is `DONE`; hosted run `29358809212` is green. Plan 139 adds an opt-in authenticated read-only Township state report with accepted operation ids plus structural and BEAM-authority quarantine; unconfigured servers still return `read_only`, and relay acceptance is unchanged. Hosted run `29373501735` is green across all three jobs. The server key remains a transport identity, not participant custody or semantic authority; verified pull remains the only materialization path, and no direct pushed operation, production ingress, or deployment is claimed. |
| `apps/township_web` | Dedicated Phoenix 1.8.9 / LiveView 1.1.32 instrument boundary over the shared read model. | **Real and browser-tested**; a connected `/township` LiveView defaults to the verified bundle and, when configured, receives a supervised carrier projection with explicit fresh, stale, connecting, and unavailable states. Plan 132 replaces fast polling as the normal convergence trigger in opt-in `server_push` mode: a newer authenticated generation wakes the existing verified pull and rendered provenance records the trigger/generation. The owner records a secret pending ref before a connect worker starts, so first-connect/reconnect hints queue one trailing pull instead of racing ref installation; stale workers cannot resurrect or orphan their connection. Vue 3.5 progressively enhances server-derived replay frames. Plan 130 lets only a fresh carrier-backed instrument prepare one unsigned post request for explicit review and authoring in the Tauri app. Plan 135 adds a fresh-only, state-derived v2 close/reopen request while clearing prepared status requests on stale state, replica replacement, or the opposing matter state. Plan 136 adds separate fresh-only v3 title and summary requests whose server handlers fix the command and clear prepared field requests on stale state or replica replacement. Plan 137 adds separate fresh-only v4 admit and remove-member requests in one shared roster slot, with server-fixed commands and replica-scoped validation feedback. Plan 138 adds a separate fresh-only v5 resident-grant request whose server handler owns the fixed public policy and accepts only the recipient public key. Plan 143 consolidates those six prepared-intent slots behind descriptor-driven prepare/retain/clear paths and one panel component; local TDD, full OTP 28 verification, and hosted run `29358809212` are green. Plan 139 adds a fresh-only v6 request containing only a canonical delegation selector; invalid input, stale state, and replica replacement clear or refuse it. Hosted run `29373501735` is green across all three jobs. Phoenix receives no participant key, capability, dependency frontier, or authoring authority; no succession control is added, and no operation is materialized directly from a pushed hint. |
| `apps/lattice_core/lib/township/election.ex` + `township/election/` | Research-safe `Township.Election` facade, immutable spec/link/artifact types, pure board projection, unanimous-box close evidence, structured non-claims, and deterministic offline replay. | **Foundation implemented (migration steps 3–4); no cryptographic profile or coercion-resistance claim.** |
| `apps/lattice_core/lib/township/election_board.ex` | Dedicated capability-gated election bulletin-board schema with service-authored public commands and no voter identity field. | **Real schema and role-boundary tests; anonymous ingress remains a gate.** |
| `apps/lattice_core/lib/lattice/attestation.ex` | Frozen legacy `Lattice.Attestation` behaviour + non-receipt-free `Stub`; `M4Placeholder` is an empty migration tombstone. | Stub **legacy plumbing only**; `receipt_free?` remains `false`. |
| `apps/lattice_core/test/support/attestation_contract.ex` | Legacy Stub contract. The M4 election path has distinct board, projection, close, replay, and future cryptographic conformance contracts. | **Real legacy guardrail; not an M4 swap contract.** |
| `apps/lattice_core/test/township/workflows_test.exs` | W0–W4 as falsifiable ExUnit tests driving `Sim`, each with its ASSERT line. | **Real and green** against the branch; quarantine-shape inferences were reconciled. |
| `scripts/township_demo.exs` | Narrated end-to-end demo (the §5 storyline) over `Sim`. | **Real and replay-gated**; emits the seven-file Plan 121 audit bundle and names its fresh-process verifier. |
| `apps/lattice_core/lib/township/audit_bundle.ex` | Log-rooted state, authority, causal op-DAG, and delegation-graph projection for the outsider evidence surface. | **Real**; clean bundles verify in a fresh process, authoritative and display-only corruption fail, and `matter.log` is byte-stable across VMs. |
| `CLAUDE.md` (in the zip; also `CLAUDE.md` standalone) | Agent working notes for the overlay: acceptance criteria, real API signatures, the "do-not-implement" boundary, the parallel-tracks pointer. | **Start here for the app track.** |

### 1.3 The substrate track — plans (drop into `plans/`)

| Asset | What it is | Status |
|---|---|---|
| `010a-carrier-township-acceptance.md` | Seam between plan `010` (real carrier) and Township: binds 010's convergence GATE to W1/W3, and pins the **coupling finding** — a Vue/JS browser realm cannot emit `:erlang.term_to_binary`, so **canonical CBOR (ADR-P08)** is a hard prerequisite the moment a non-BEAM realm joins. | **Plan.** Builds on the repo's existing `plans/010-real-carrier-spike.md`. |
| `011-ts-client-realm.md` | Work package for the TS client realm: two-tier structure, Sim-as-oracle, GATE/STOP, parallel worktrees. | **Plan.** |

> The repo already contains `plans/000`–`009` (foundation & hardening) and `010`–`013`
> (direction spikes). **Plan 001 (CI gates the full property suite) is a prerequisite for
> trusting any M1 property claim** — including Township's — because CI currently runs only a
> few flagship files. Treat 001 as a gate before believing "M1 is green."

### 1.4 The client realm — TypeScript library (`ts_client_realm_overlay.zip`)

Framework-agnostic; the shared spine both the Expo and Tauri shells consume.

| Path | What it is | Status |
|---|---|---|
| `clients/lattice-client/src/{op,dag,schema,crdt/reducers,quarantine,materialize,sync,carrier}.ts` | **Tier A** — the reducer (DAG, 3 CRDTs, the single V-01 quarantine predicate, materialize, sync) plus the carrier-frame/session adapter and carrier-term delegation extraction. Encoding-independent for op ids; carrier session bytes are signed through an injected shell/key-custody signer. | **Real & verified**: strict typecheck clean, Sim-generated conformance green, carrier W1 vector check green, live TS↔BEAM WebSocket W1 green. Plan 142 mirrors server-first carrier session v2 with independent operation-wire/session-version checks and fail-closed nonce validation; all local `carrier:*` gates, packaged convergence, and hosted run `29358809212` are green. Plan 139 introduced external authority quarantine before local revocation parity; hosted run `29373501735` is green across all three jobs. Plan 147 now locally enforces Sim-equal capability/revocation decisions from retained verified evidence and leaves the carrier report only as an equal-evidence fail-closed cross-check; hosted run `29525397708` is green across all three jobs at exact implementation tip `b2ad50629d1867dab71f0de50c038480bb5fe3b7`. Plan 145 independently decodes and verifies genesis-pinned witnessed succession policy/claim bytes and Ed25519 certificates during reduction; it adds no TypeScript authoring helper or shell custody. Hosted implementation run `29399176176` is green across all three jobs. Plan 148 now locally reproduces BEAM's valid-genesis acquisition timeline, current holder epoch, and effective witnessed recovery-policy provenance from verified local operations; F2 is hosted-pending, and F3/F4 remain open. |
| `clients/lattice-client/src/{codec,identity,township,local_log,tauri_bridge}.ts` | **Tier B/E1 bridge** — canonical `lattice-cbor-v1` bytes + Ed25519 signing. `codec.ts` verifies carrier-frame op bytes/hashes/signatures against BEAM and can author/sign frames; `township.ts` builds `Township.Matter` command body/cap terms, selects a matching local delegation cap extracted from carrier frames, derives deps from the local op frontier, and exposes author-and-persist workflows; `local_log.ts` persists semantic ops and pending carrier-frame outbox entries through shell key-value seams; `tauri_bridge.ts` adapts Tauri-style `invoke` commands to storage, async native signing, and native public-key discovery. | **Partially real** — Tier B/E1 custody coverage through Plan 138 is tracked per plan in `plans/README.md` (each plan states its own gate and non-claims); parked gaps are listed in §4a. Plan 129 adds explicit one-op relay transport and causally ordered, acknowledged-only relay draining while preserving generic push as the default; Plan 130 reuses those app-owned authoring seams unchanged; Plan 131 adds CI enforcement without changing runtime behavior; and Plan 132 adds the BEAM feed path. Plan 133 adds the direct typed TypeScript availability subscription. Plan 134 requires canonical hash and Ed25519 verification for every shared-sync pull before conversion or submission. Plan 138 reuses the established delegation authoring and persistence seam for one fixed resident grant and recipient-use proof; Sim/source projection owns the semantic authority oracle, while Plan 140 owns broader TypeScript V-01 remediation. Plan 141 leaves this public seam and persisted format unchanged while the shell serializes its whole-store workflows. Plan 139 reuses the same author-and-persist boundary for one revoke after fail-fast local issuer, evidence, and replica checks; it retains delegation evidence and never publishes before explicit Sync. |
| `clients/township-tauri-shell` | **E1 Tauri shell** — Vue 3.5 frontend plus Rust native command core for shell-side storage/signing/discovery commands (`lattice_kv_get`, `lattice_kv_set`, `lattice_ensure_carrier_key`, `lattice_public_key`, `lattice_sign_carrier`, `lattice_discover_pairing_adverts`, `lattice_advertise_pairing_handoff`, `lattice_log_probe`). | **Partially real** — completed shell coverage through Plan 138 is tracked per plan in `plans/README.md`. Plan 129 connects packaged desktop onboarding to the stable relay; Plan 130 stages a strict unsigned action intent and retains explicit Use request, Post, and Sync controls; Plan 131 makes both packaged proofs mandatory in CI; Plans 132-133 add the authenticated and direct TypeScript hint substrates. Plan 134 adds the packaged Tauri/Vue reactive availability feed. Plan 135 extends the same inert ingress and native-custody path to replica-bound clerk close/reopen requests. Plan 136 extends that fail-closed seam to replica-bound `set_title` and `set_summary`. Plan 137 extends it to replica-bound `admit` and `remove_member`. Plan 138 adds fixed-profile resident-grant review/signing, no-parent refusal before signing or KV writes, separate explicit Sync, and same-bundle recipient pull/use with isolated keys and stores. Plan 141 adds a namespace-scoped process writer, post-network reload/union, acknowledged-only outbox compaction, guarded submit/sign/sync entry points, fail-loud corrupt KV loading, and temp-file fsync. Plan 143 consolidates v1-v5 shell state, review rendering, and development routing behind one composable/runtime descriptor path while preserving native-event refusal, per-slot status, explicit signing, and explicit Sync. Both plans are `DONE`; full local packaged convergence and hosted run `29358809212` are green. Plan 139 is `DONE`: v6 ingress and Use are inert, Sign rechecks issuer/evidence/replica before native custody, evidence remains persisted, Sync stays separate, and the recipient feed renders the exact Sim-authority result. Hosted run `29373501735` is green across all three jobs. The mobile secure-store strategy remains unchanged; parked gaps remain in §4a. |
| `clients/lattice-client/test/conformance.ts` + `test/vectors/*.json` | The harness that pins the TS reducer to Sim. | **Real**; W0, W1/W2 + perspectives, W3, five seeded randomized vectors, and adversarial succession/genesis boundaries are generated by `lattice.export_vectors`. `township_succession_unproven_tick` pins accepted author-asserted tick behavior, not trustworthy dormancy. `township_succession_witnessed_recovery` independently pins policy identity, holder-epoch binding, threshold signatures, root-mismatched policy-injection refusal, BEAM quarantine parity, and reducer-load-bearing Ed25519 verification; it proves governance authorization only. `township_genesis_projection_parity` pins two honored valid same-root acquisitions, later-epoch/effective-policy provenance, policy identity, delivery-order independence, and signed impostor refusal without consuming a carrier authority report. |
| `clients/lattice-client/test/carrier.ts` | The C3 carrier-vector harness: BEAM-compatible session transcript/signature check, full carrier-frame decoding, and W1 merge/materialization against the Sim oracle. | **Real**; `npm run carrier:township` is wired in CI. |
| `clients/lattice-client/test/carrier_relay*.ts` | One-op relay wire and drain contracts: explicit relay envelope, stable causal order, no push fallback, report aggregation, duplicate re-advertisement, and retry-safe acknowledgement. | **Real**; `carrier:relay` and `carrier:relay-sync` are wired in flagship CI. |
| `clients/lattice-client/test/live_carrier.ts` | The live C3 harness: spawns the BEAM Township peer process, authenticates over WebSocket, pulls/pushes carrier frames, and compares both TS materialization and BEAM peer state to the Sim oracle. | **Real**; `npm run carrier:township:live` is wired in CI. |
| `clients/township-tauri-shell/test/{township_stable_relay,township_carrier_feed,township_feed,tauri_stable_relay_onboarding_smoke,tauri_action_handoff_smoke,tauri_clerk_action_handoff_smoke,tauri_field_action_handoff_smoke,tauri_roster_action_handoff_smoke,tauri_delegation_grant_handoff_smoke,tauri_revoke_access_handoff_smoke,tauri_carrier_feed_smoke}.ts` + `test/support/packaged_action_handoff.ts` | Production stable-server, direct/reactive TypeScript feed, and packaged-app convergence gates. | **Real locally and hosted through Plan 139** — existing packaged gates remain CI-enforced, including the direct-TypeScript gate CI-enforced by Plan 133. Plan 134 adds the headless verified refresh/controller lifecycle contract and a third fresh-build packaged macOS smoke. The real app authenticates as a read-only observer, renders Sim-derived base/first/restart projections from verified pulls, retains the last projection during same-path reconnect, and never invokes automatic Sync or authors an observer operation. Full local Plan 134 regression is green. Hosted Plan 134 run `29210581826` is green across the flagship artifact, unit/property, and packaged macOS jobs, including all three hard packaged convergence steps. The Plan 135 clerk smoke is green locally and hosted through Sim-equal Open -> Locked -> Open. Plan 136 adds a no-build field smoke that proves explicit-Sync contested-summary and title convergence. Plan 137 adds a no-build roster smoke that proves Sim add-wins and repeats the admit ceremony. Plan 138 adds a no-build two-identity grant smoke: the issuer publishes an exact Sim grant, an isolated recipient pulls it and publishes a Sim-identical post, and a later over-broad grant reduces as `not_attenuated` with no usable authority. Hosted Plan 138 run `29248868666` is green across flagship, unit/property, and packaged macOS. Plan 141 adds RED/GREEN sync, feed, contention, re-entrancy, and corrupt-KV regressions. Plan 142 reruns the complete chain with the server-nonce handshake. Plan 143 extracts the common process/trace/deep-link/KV/cleanup harness and executes its support and wiring contracts before the packaged smokes. Hosted run `29358809212` is green across all three jobs, including stable-relay onboarding, every v1-v5 handoff, and reactive feed. Plan 139 adds a no-build two-identity revocation smoke and hard CI step: the issuer publishes an exact Sim revoke, the recipient cannot revoke as a nonissuer, then one causally later retained-cap post is reported as `revoked_capability` and absent from matter state across source, app, and LiveView. The shared harness now confirms the prior bundle process exits before the next smoke. Full local `app:convergence` and hosted run `29373501735` are green across all three jobs. |
| `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` | Elixir task that emits conformance vectors *from Sim* — makes the oracle literal. | **Real** for Phase B1/B2 and C3a; emits fixed, randomized, and carrier W1 vectors with grant-quarantine, revocation lifecycle, unproven-succession-tick, genesis-pinned witnessed-recovery, and valid-genesis holder/policy-projection fixtures. |
| `ts-client-CLAUDE.md` | Agent working notes for the client library. | **Start here for the client track.** |

> **Plan 147 is DONE (2026-07-16):** Tier A now retains command caps and
> revoke facts, derives verified delegation/root/effective-revoke evidence once, and locally emits
> Sim-equal capability/revocation quarantine reasons through the single reducer path. Nine new
> corpus-stable adversarial vectors and three deliberate semantic mutations defend that port. The
> Tauri shell materializes the durably persisted retained-frame set locally; a carrier authority
> report is consulted only when its op-id set matches that evidence, and then only as a fail-closed
> `revoked_capability` set cross-check. Carrier IDs and attributions are never adopted. Full local
> client/carrier, packaged convergence, OTP 28, security, and Claude gates are green. Hosted run
> `29525397708` passed all three jobs at exact implementation tip
> `b2ad50629d1867dab71f0de50c038480bb5fe3b7`. F2/F3/F4 remain open.

> **Plan 148 is IN PROGRESS (2026-07-16):** one additive Sim vector now pins two causally
> ordered valid same-root clerk genesis acquisitions, the later holder epoch and witnessed policy
> source, exact policy identity, stable root, and signed root-mismatched policy-injection refusal.
> TypeScript independently reproduces those facts from verified local operations and exposes the
> witnessed policy plus conferring genesis operation through its existing authority analysis. The
> old first-genesis-only mutation fails, all 30 pre-existing vectors remain byte-identical, and
> local client/carrier, OTP 28, security, generated-dist, formatting, diff, and Claude gates are
> green. Exact-tip hosted Unit + property, flagship artifact, and packaged macOS closure are pending;
> no v7, shell custody, artifact, participant authoring, or user-facing ceremony is claimed.

### 1.5 Observability & design prototypes (the UI direction, verified logic)

Three standalone HTML prototypes, all sharing one design system (PD-001 tokens) and one
scenario (zoning-variance-24), each with headless-verified logic:

| Asset | What it is | Status |
|---|---|---|
| `duality_canvas.html` | Materialized state ⇄ op-DAG, bidirectional cross-highlight, frontier scrubber, per-realm perspective, op-authoring. | **Verified** (10 reducer assertions). |
| `constellation.html` | Location-transparent realms; edges = **frontier gap**; partition/heal/seize + live succession. | **Verified** (gossip/succession assertions). |
| `adversary_console.html` | A1/A2/A3 attacks vs. defenses with honest **proven / stubbed / leaky** status per verdict. | **Verified** (attack-logic assertions). |

> These are **interaction-design prototypes**, not the production UI. The real UI is Phoenix
> LiveView 1.1 (live-pushed state/feeds) + **Vue 3.5** islands (the direct-manipulation
> canvases), consuming the same data the LiveView reduction and the TS client expose.

---

## 2. Status legend — what "done" means per layer

- **Proven** — a real mechanism with a passing test/oracle today.
- **Stubbed** — bounded legacy or test plumbing exists without the hard property. A stub does
  not imply that its interface can host the eventual mechanism (for example, the frozen
  attestation Stub remains `receipt_free? = false` and M4 uses a different protocol).
- **Blocked** — cannot be built correctly until a prerequisite lands. The original blockers were
  **CBOR/ADR-P08** and **M4**; the tracked non-BEAM canonical path has landed, while M4's
  profile, operational, review, and scale gates remain open.

Nothing here is "assumed done." If it is not a passing gate, it is not done (PD-001 invariant V).

---

## 3. Dependency graph (what unblocks what)

```
plans/001 (CI gates full suite) ─┐
                                 ├─▶ trust M1 property claims ──▶ Township W0–W3 assertions credible
M1 2.0 core (branch) ────────────┘
                                        │
Township overlay (Matter, Attestation, workflows) ──▶ POC on Sim (G2,G3,G5 reachable)
                                        │
plan 010 carrier (Lattice.Carrier + WS realm) ──▶ 010a ──▶ Township G1 (physical convergence)
                                        │                        │
                                        │                        └─▶ TS client sync over wire (011 D3)
ADR-P08 CBOR ───────────────────────────┴─▶ non-BEAM realms (browser/phone) ──▶ Tier B of TS client
                                                                     │
                                                                     ├─▶ Expo shell   (phone)
                                                                     └─▶ Tauri v2 shell (desktop+mobile, Vue 3.5)
M4 redesign foundation (Election + dedicated board + pure replay) ──▶ profile/operations/review gates
                                                                          │
                                                                          └─▶ read/audit migration ──▶ W4 switch; retire legacy Stub last
```

The graph preserves the original two-blocker dependency shape. The tracked non-BEAM plans have
since landed the canonical client/wire path; **M4's profile, operational, independent-review, and
scale gates remain the hard endgame blocker**.

---

## 4. Known gaps & honesty caveats (do not skip)

1. **M1 "green" is unverified in CI.** Memory says 19 behaviors pass; the branch still shows a
   V1-shaped facade beside the 2.0 core, and CI gates only a few files. **Gate plan 001 first.**
2. **The Township workflow tests were written against an *inferred* `Sim` return shape** (esp.
   `quarantined/3` → `{true, reason} | false`, `transfer/5`, `holder/3`). First `mix test` may
   surface shape mismatches in the authority/quarantine assertions — treat red there as "the
   inference was slightly off," not "the design is wrong."
3. **The TS conformance vectors are now Sim-generated for Phase B1/B2** (`township_join_w0`,
   `township_zoning_variance_24`, `township_succession_w3`, plus five seeded
   `township_random_*` scenarios). CI regenerates the corpus and runs TS typecheck +
   conformance. The randomized corpus already caught and fixed the TS OR-set observed-remove
   drift. The corpus also includes `township_carrier_w1`, which carries full BEAM carrier
   frames for the first C3 adapter check. W3 proves deterministic reduction of author-signed
   heartbeat/succession ticks; it does **not** prove those ticks represent elapsed logical time.
   Legacy `at_tick` is successor-supplied and is not bound to `Lattice.Clock`, carrier evidence,
   or a quorum. Plan 144 pins that limitation with a Sim-generated, independently
   frame-verified adversarial vector: an immediate successor-authored `at_tick: 1_000_000` is
   accepted and explicitly labeled `author_asserted_untrusted`. Plan 144 is `DONE`: full local OTP
   28/security gates and Claude's final publication audit are green, and hosted run `29387808442`
   passed all three jobs at exact implementation tip `2be253eeed7074e39cf1a86c915496794404f170`.
   Plan 145 adds a separate opt-in valid-genesis-pinned m-of-n Ed25519 recovery certificate bound
   to the exact replica, role, holder acquisition epoch, designated successor, and policy. BEAM and
   TypeScript independently verify its five-frame policy-injection/threshold oracle; hosted
   implementation run `29399176176` is green. Witnesses authorize governance recovery, not absence,
   elapsed time, liveness, independence, honesty, non-coercion, consensus, or receipt-freeness.
   No v7/user-facing succession authoring may start before a separate review, witness-collection,
   custody, and publication ceremony is reviewed.
4. **`township_demo.exs` and the overlay now run against the branch.** Plan 121 adds the
   outsider-replayable Township audit bundle: state, authority verdict, op-DAG, and trust graph are
   independently checked through `mix lattice.township.verify_bundle`. Plan 122 adds the Township
   instrument read model as the shared structured read-model foundation for five panels. Plan 123 adds the
   Township LiveView instrument as a connected,
   read-only verified snapshot. Plan 124 adds the Vue 3.5 causal-replay island from server-derived
   frames. Plan 125 promotes the real WebSocket carrier client into a reusable app boundary. Plan
   126 adds the supervised pull-only carrier projection: periodic request/response polling produces
   arrival-verified fresh or stale snapshots through `TownshipWeb.PubSub` for the connected
   LiveView. Plan 127 adds the stable supervised read-only carrier server: it owns a configurable
   Cowboy listener, authenticates trusted transport realms, and serves authenticated frontier and
   pull requests from a configured signed log. Plan 128 adds the opt-in durable client-signed relay:
   a selected transport realm may submit one already-signed operation to a path-backed source, the
   server structurally verifies and persists the changed log before acknowledgement, and a distinct
   observer can pull the same Sim-derived result after server-process or OS-process restart. The
   client signs and the server relays; the server has no participant private key or separate cap
   store and does not decide semantic authority. At the Plan 128 checkpoint this was request/response
   relay, not server push, and both broader participant controls and a server-push carrier feed were
   still open; production deployment remains, as do
   complete G1/Phase G and receipt-free W4. Plan 128 does not change or newly prove Tauri onboarding/cap persistence,
   mobile secure-store custody, or real app convergence; those established gates and their narrower
   non-claims remain recorded in plans 054-120. Plan 129 connects the packaged desktop Tauri onboarding ceremony
   to the stable relay: a public pairing selects one-op relay, the app pulls and persists capability
   evidence, its native key authors the exact Sim-generated operation, acknowledged-only draining
   empties the outbox, and a fresh distinct observer matches Sim after server OS-process restart.
   The mobile secure-store strategy remains unchanged, and this desktop proof adds no mobile relay,
   server push, `/township` write path, participant custody, deployment, Phase G completion, or real W4.
   Plan 130 adds the first participant post handoff. A fresh `/township` projection prepares an
   **unsigned request** containing only public text, target replica, and a diagnostic intent id. The
   Tauri app validates the replica against saved pairing and keeps capability selection, dependency
   derivation, native signing, persistence, and relay under app custody behind separate Use request,
   Post, and Sync actions. The Ubuntu flagship gate drives the real LiveView link through the built
   app surface, stable relay, and pull projection to exact Sim equality before and after restart; a
   packaged macOS LaunchServices gate repeats the native-custody path locally. This adds no server
   push, broader participant controls, production deployment, mobile/device result, Phase G
   completion, or receipt-free W4.
   Plan 131 changes no runtime or custody behavior. It makes the packaged stable-relay onboarding
   and action-handoff smokes mandatory in a hard-failing `macos-15-intel` flagship job. Hosted run
   `29180961767` passed both real app bundles, LaunchServices action delivery, native custody,
   stable relay, restart recovery, and Sim comparisons. This CI enforcement adds no server push,
   broader participant control, deployment, mobile/device result, Phase G completion, or real W4.
   Plan 132 adds the authenticated availability feed above the durable relay. A monitored BEAM
   subscriber receives only a bounded generation/frontier hint after successful persistence; the
   hint wakes atomic request/notification demultiplexing and the unchanged verified pull path. The
   packaged gate proves the first pushed generation before its 60-second poll, recovers after a
   same-path server restart, and proves the replacement subscription with a second pushed
   generation. Plan 133 adds the direct typed TypeScript availability subscription: notifications
   cannot satisfy atomic requests, a pre-baseline hint is retained in a latest-only mailbox, and a
   real stable-server gate verifies pulled hashes/signatures and Sim op ids before and after
   restart. At the Plan 133 checkpoint, Reactive Tauri/Vue feed consumption remains separately gated.
   Plan 134 adds the packaged Tauri/Vue reactive availability feed. The saved public
   pairing opens one authenticated observer subscription, its baseline and later hints wake a
   verified pull, one active refresh retains only the latest trailing generation, and Vue replaces
   the matter only after verified persistence. Same-path restart preserves the last rendered
   projection and establishes a replacement subscription before a second Sim-derived post.
   The packaged DOM oracle compares ordered SHA-256 commitments to rendered proceedings without
   recording raw action or post content in native trace. Full local Plan 134 regression is green.
   Reactive refresh never submits or compacts the authored outbox. Post and Sync remain explicit
   participant controls. This adds no mobile secure-store change, broader participant controls,
   production deployment, complete G1/Phase G claim, or receipt-free W4.
   Plan 135 adds the versioned clerk status action handoff.
   A fresh LiveView derives close or reopen from verified state, the packaged app preserves the
   existing post-only v1 contract, and v2 follows Use request, Sign close/reopen, and separate Sync outbox.
   The standalone packaged gate is locally green through Sim-equal Open -> Locked -> Open across
   the stable source, Tauri feed, and LiveView projection. No automatic authored-frame publication,
   mobile secure-store change, complete G1/Phase G claim, or receipt-free W4 is added.
   Full local Plan 135 regression is green at 378 tests plus 25 properties, complete shell and
   browser/flagship convergence, warning-free compiles, static/security gates, and 23 Rust tests.
   Hosted Plan 135 run `29216789652` is green across flagship, unit/property, and packaged macOS,
   including the no-rebuild clerk step between the unchanged action handoff and reactive feed.
   Plan 135 status is `DONE`.
   Plan 136 adds the versioned field-edit action handoff. A fresh LiveView prepares an exact v3
   `set_title` or `set_summary` request, while the packaged app preserves v1/v2, rechecks the saved
   replica, selects local capability evidence, signs through native custody, and retains separate
   Use request, Sign edit, and Sync outbox controls. The stronger summary gate signs from the base
   frontier, admits a concurrent clerk summary while the exact resident frame remains pending, and
   then proves source, Tauri feed, and LiveView equality with Sim after explicit Sync; the same app
   repeats the title ceremony. No automatic publication, mobile secure-store change, complete
   G1/Phase G claim, or receipt-free W4 is added. Full local Plan 136 regression is green at 383
   tests plus 25 properties, complete shell/browser/flagship convergence, warning-free compiles,
   static/security gates, and 23 Rust tests. Hosted Plan 136 run `29223172342` is green across
   flagship, unit/property, and packaged macOS, including the no-build field-edit step between the
   no-build clerk handoff and the reactive feed. Plan 136 status is `DONE`.
   Plan 137 adds the versioned roster action handoff. A fresh LiveView prepares an exact v4 `admit`
   or `remove_member` request, while the packaged app preserves v1-v3, rechecks the saved replica,
   selects persisted local capability evidence, signs through native custody, and retains separate
   Use request, Sign roster action, and Sync outbox controls. The stronger gate signs an observed
   remove from a shared base, relays a concurrent authorized peer admit while the exact remove frame
   remains pending, and then proves source, Tauri feed, and LiveView equality with Sim's add-wins
   result after explicit Sync; the same app repeats the admit ceremony. No automatic publication,
   mobile secure-store change, authority-role proof, complete G1/Phase G claim, or receipt-free W4
   is added. Full local Plan 137 regression is green at 389 tests plus 25 properties, complete
   shell/browser/flagship convergence, warning-free compiles, static/security gates, and 23 Rust
   tests. Hosted Plan 137 run `29233959489` is green across flagship, unit/property, and packaged
   macOS, including the no-build roster step between the no-build field handoff and reactive feed.
   Plan 137 status is `DONE`.
   Plan 138 adds the versioned delegation grant handoff. A fresh LiveView prepares one exact v5
   fixed-profile resident-grant request from only a public audience key. The issuer app preserves
   v1-v4, stages and reviews the request inertly, rechecks the replica, selects persisted parent
   evidence, signs through native custody, and retains separate Use request, Sign grant, and Sync
   outbox controls. A no-parent participant stops as `missing_delegation` before native signing or
   KV writes. The stronger packaged gate uses the same app executable with isolated issuer and
   recipient keys/stores: the recipient pulls and persists the issued delegation, authors a
   Sim-identical post citing it, and converges the stable source, Tauri feed, and LiveView only after
   explicit Sync. A later structurally relayed over-broad grant reduces as `not_attenuated`, its use
   is invalid, and the matter remains open. Sim/source projection owns that authority oracle; this
   is not a general TypeScript or structural-relay authority claim. No automatic publication,
   cross-device custody transfer, mobile secure-store change, complete G1/Phase G claim, or
   receipt-free W4 is added. Full local Plan 138 regression is green at 394 tests plus 25 properties,
   complete shell/browser/flagship convergence, warning-free compiles, static/security gates, and
   23 Rust tests. Hosted Plan 138 run `29248868666` is green across flagship, unit/property, and
   packaged macOS, including the no-build delegation-grant step between roster and reactive feed.
   Plan 138 status is `DONE`.
   Plan 143 changes no action envelope, capability, custody boundary, or publication ceremony. It
   consolidates the Phoenix prepared-intent lifecycle, Vue accepted-intent state/review/dev routing,
   and five packaged-smoke harnesses while preserving v1-v5 behavior. Replacement behavior,
   runtime-API, config/workflow, and shared-support contracts landed before brittle source/prose
   pins were removed or demoted. Full local OTP 28 verification and `npm run app:convergence` are
   green, Claude's correction review returned `PROCEED`, and hosted run `29358809212` passed all
   three jobs. Plan 143 is `DONE`.
5. **G1 (physical BEAM carrier) is now reachable outside `Sim`** — plan 017 runs W0–W3
   across two BEAM OS processes over the real WebSocket carrier, with `Sim` as oracle.
   Everything proven since — TS client Tier B, the Tauri shell, the Android release
   probes, the onboarding gates, and the Phase G instrument work — is tracked **per plan
   in `plans/README.md`**; coverage and enforcement through plans 023-138 carry their own gates and
   non-claims, so read
   the plan before trusting a claim repeated anywhere else. Areas parked as
   blocked-on-external-factors are listed in §4a and must not accrete new probe
   variants.
6. **Receipt-freeness is not real** (W4). `Attestation.Stub` is permanently
   `receipt_free? = false`; the implemented `Township.Election` foundation is
   research-only with every security claim `:not_claimed`. Do not describe W4 as real until
   all Phase F gates pass and the read/audit surface migrates.
7. **AtomVM has distribution now but no iOS/Android target** — so a phone is a TS client, not a
   BEAM node. Re-check this if AtomVM ships a mobile target (STOP condition in plan 011).

---

## 4a. Parked — do not pick up (2026-07-11)

These areas are parked because they are blocked on **external factors** (toolchain,
hardware, research) — not on missing effort. Emulator-side probe permutations against
them add no new information. **Do not write new plans, probes, smokes, or "one more
variant" proofs in these areas** — in particular, no new `tauri:android:release:*`
probe variants (plans 083–117 exhausted the useful emulator-provable surface). If one
starts looking necessary, question the requirement, not the boundary (`CLAUDE.md`).

- **iOS beyond local process relaunch** — stable Xcode 26.6 (Build 17F113) now builds the
  entitlement-enabled simulator archive. Plan 077's local iOS 18.6 simulator smoke proves two
  independently named protected keys differ and both survive process relaunch. It does not prove
  simulator or device reboot, physical-device behavior, iOS BEAM convergence, or CI enforcement;
  those remaining iOS gates stay parked.
- **QR camera onboarding** — capture-to-draft is proven (plan 071); the rest is
  physical-device behavior.
- **LAN discovery** — bounded UDP receive/advertise with loopback smoke is proven
  (plans 073/075); the rest is a physical multi-device smoke.
- **Physical-device behavior** — requires hardware this environment does not have.
- **Cross-device pairing state exchange** — requires a second physical device; the
  loopback state-exchange probes (plans 110–112) are the emulator ceiling.

Plan 126 supplies the read-only periodic carrier projection into `/township`, Plan 127 gives that
projection a supervised non-fixture listener, Plan 128 adds a real durable source-change
producer through client-signed request/response relay, Plan 129 proves that the actual packaged
desktop app can author through it and converge after restart, Plan 130 connects one fresh LiveView
post request to that app-owned path, Plan 131 makes both packaged macOS proofs mandatory in CI, and
Plan 132 replaces fast instrument polling with authenticated server-initiated availability hints
that wake verified pull. Plan 133 adds the direct typed TypeScript availability subscription and a
real stable-server feed gate while preserving verified pull as the only materialization path.
Plan 135 closes the first clerk-status slice, Plan 136 closes the field-edit slice, Plan 137 closes
the roster slice, and Plan 138 closes delegation issuance toward **complete G1/Phase G**. Hosted run
`29358809212` closes Plans 141-143, and run `29373501735` closes Plan 139 across all three jobs,
including full v1-v6 packaged convergence; Claude's final review has no P0-P2 finding. Legacy
Township succession reduction exists for author-asserted ticks, whose provenance remains untrusted.
Plan 144 is `DONE`: its cross-oracle vector and load-bearing mutation proof make the accepted
inflated-tick limitation executable, its full local gates plus Claude final audit are green, and
hosted run `29387808442` passed all three jobs. Plan 145 is `DONE`: its opt-in genesis-pinned
witnessed recovery implementation and BEAM/TypeScript cross-oracle are green at hosted run
`29399176176`, and hosted claim-documentation run `29400665837` passed all three jobs. It authorizes
a configured governance recovery event and does not supply dormancy proof or a user-facing
ceremony.
Production deployment and receipt-free W4 are also not supplied by the current work. At the
milestone level, a reviewed user-facing succession ceremony,
production deployment, and receipt-free W4 remain.
Per-plan status lives in
`plans/README.md`.

---

## 5. The build order to 100% tested and working

Each milestone lists its **gate** (how you know it's done) and the **asset** that carries the detail.

### Phase A — Trust the substrate (foundation)
- **A1.** Land `plans/001` — CI gates the full property suite (19 behaviors, properties, 6 seeds).
  *Gate:* full suite green in CI, not just flagship files. *Asset:* repo `plans/000`–`006`.
- **A2.** Compile the Township overlay against the branch; get `workflows_test.exs` W0–W3 green on
  `Sim`; reconcile the §4.2 shape mismatches. *Gate:* W0–W3 + the four M1 properties green over
  `Township.Matter`. *Asset:* overlay `CLAUDE.md`.
- **A3.** Run `scripts/township_demo.exs` clean; emit trust-graph + audit artifacts.
  *Gate:* POC G2, G3, G5. *Asset:* PD-001-A §A5.
  **Status:** done for the Sim demo and G5 evidence contract in Plan 121: the demo emits a
  deterministic seven-file bundle, and a fresh process re-derives every authoritative claim from
  `matter.log` while corruption fails verification.

### Phase B — Make the oracle portable (client realm, Tier A)
- **B1.** Wire `lattice.export_vectors` to real `Sim` calls (plan 011 Deliverable 1); regenerate
  the vector. *Gate:* the TS conformance vector is Sim-generated, not hand-authored.
  **Status:** done for W0, W1/W2 + perspectives, and W3 named vectors.
- **B2.** Grow conformance to N randomized StreamData scenarios; both sides in CI.
  *Gate:* TS reducer reproduces Sim on every generated scenario; drift fails the build.
  *Asset:* `011-ts-client-realm.md`, `ts-client-CLAUDE.md`.
  **Status:** done for N=5 deterministic seeded Sim scenarios and CI wiring in plan 020;
  expand the corpus later without changing the artifact contract.

### Phase C — Real carrier (the physical proof)
- **C1.** Execute repo `plans/010` — define `Lattice.Carrier`, two BEAM processes over WS.
  *Gate:* 010's own GATE (byte-identical convergence, idempotent sync, tamper rejection).
- **C2.** Run Township **W1/W3 over the real carrier** (plan 017/010a). *Gate:* Township
  **G1** for two BEAM nodes is green; non-BEAM carrier peers remain gated on ADR-P08.
  *Asset:* `010a-carrier-township-acceptance.md`.
- **C3.** Connect the TS client `sync.ts` to the WS realm; converge W1 client↔BEAM (Tier A, no
  CBOR). *Gate:* plan 011 Deliverable 3.
  **Status:** done for Tier A W1 in plans 021–022 — the TS client signs/verifies
  carrier-session bytes through injected shell key custody, syncs with
  `LatticeNodeSpike.WsHandler` over a real WebSocket, and converges to the Sim oracle.
  Follow-on client/shell/onboarding and instrument coverage (plans 023-133) is tracked per plan in
  `plans/README.md`; parked areas are listed in §4a.

### Phase D — Cross the runtime boundary (CBOR, the first hard blocker)
- **D1.** Land **ADR-P08**: canonical CBOR for `Lattice.Op`, replacing the ETF pin.
  *Gate:* one op hashes byte-identically Elixir↔TS (Tier-B vector). *Asset:* 010a coupling section.
  **Status:** done for the current `lattice-cbor-v1` carrier-frame suite in plan 023:
  `township_carrier_w1` exports canonical bytes from `Lattice.Op.canonical_encoding/1`, and
  `npm run canonical` proves every W1 carrier op hashes byte-identically in TS.
- **D2.** Implement the TS `codec.ts` CBOR encoder; enable client-side op authoring + local verify.
  *Gate:* plan 011 Deliverable 4; `codec.ts` no longer throws.
  **Status:** partial. `codec.ts` reproduces BEAM canonical bytes/op ids from carrier
  frames and authors BEAM-accepted W1 frames. The full progression from there —
  Township command authoring, persistence seams, the Tauri shell, Android debug/release
  probes, onboarding gates, and the Phase G instrument work (plans 024–133) — is
  tracked per plan in `plans/README.md`; each plan file states its own gate and
  non-claims. Parked areas: §4a.

### Phase E — The shells (apps)
- **E1.** **Tauri v2 shell** (recommended spine): Vue 3.5 frontend + Rust core (key custody, CBOR,
  optional BEAM sidecar on desktop) consuming `@treetopdevs/lattice-client`. *Gate:* a desktop +
  mobile build converges a Township matter against a BEAM realm.
  **Status:** started and deep — desktop and Android-release convergence, onboarding,
  and pairing proofs exist through plan 120, Plan 129 proves the packaged desktop app can
  use the stable durable relay through native custody and persisted cap state, and Plan 130 proves
  a packaged macOS action handoff into that same explicit native-custody path. Plan 131 makes the
  stable-relay onboarding and action-handoff packaged proofs mandatory in hosted macOS CI. Plan 132
  adds push-triggered LiveView convergence and post-restart subscription recovery without changing
  the shell's key/capability custody. Plan 141 serializes shell persistence, reloads and unions
  current state before post-network saves, guards submit/sign/sync re-entry, and fails loudly on
  malformed native KV. Plan 143 consolidates the v1-v5 action ladder and packaged-smoke harness.
  Both are `DONE`; full local convergence and hosted run `29358809212` are green. Plan 139 adds the
  v6 issuer revocation ceremony, authenticated BEAM-authority feed overlay, isolated recipient
  proof, and mandatory no-build packaged gate; hosted run `29373501735` is green across all three
  jobs. See
  `plans/README.md` for per-plan status and non-claims. Plan
  077 now has a stable-Xcode iOS simulator archive and bounded native protected-key process-relaunch
  proof; reboot, physical-device, iOS BEAM convergence, and CI gates remain open. QR camera
  onboarding, LAN discovery, physical-device behavior, and cross-device pairing state exchange are
  parked (§4a) — do not add new probe variants for them.
- **E2.** **Expo shell** (if phone-only is wanted): SDK 56+, RN 0.85, New Arch; same library, key
  custody via secure-store/native keystore. *Gate:* a phone build converges a Township matter.
  *Asset:* `docs/township_mobile_secure_store_strategy.md` plus the app-shell analysis (this
  conversation's §Expo-vs-Tauri) — decision deferred, reversible.

### Phase F — Close the coercion gap (M4, the remaining hard blocker)
- **F1. Foundation — implemented, research-safe.** Migration steps 1–4 from the M4 interface
  brief are present: corrected legacy boundaries; a frozen false Stub; authorized Matter link,
  versioned configuration and artifact references; a dedicated role-gated board; pure projection;
  unanimous-box close evidence; and deterministic complete offline replay. *Gate:* focused
  board/projection/close/replay adversary suites pass. This is not a cryptographic-election or
  coercion-resistance claim.
- **F2. Profile and operations — open blocker.** Prove anonymous ingress and private registration;
  pin one exact reviewed construction, revision, parameter set, codecs, and dependencies; then add
  durable registrar, box, close, and trustee runners with secret/randomness handling. *Gate:* the
  operational threat model and official conformance vectors pass without any secret-bearing value
  entering a Lattice or operational transcript.
- **F3. Independent assurance and scale — open blocker.** Complete the formal composition mapping,
  independent cryptographic review, artifact-availability design, and measured 100/1,000/10,000
  participant runs. *Gate:* every blocking gate in the M4 brief is cleared and the structured
  security manifest names only reviewed conditional claims.
- **F4. Migrate W4 last.** Change `Township.ReadModel` and the audit bundle from caller-held legacy
  vouches to verified election projection. Only then switch W4 and retire `M4Placeholder`, the Stub,
  and the legacy contract. W0–W3 keep their semantics; W4 and its read/audit surface intentionally
  change.

### Phase G — The full instrument (UI)
- **G1.** Build the production UI: Phoenix LiveView 1.1 (state/feeds) + Vue 3.5 islands (canvases),
  reusing the three prototypes' interaction grammar and verified logic. *Gate:* the five POC
  assertions are observable + an outsider-replayable audit surface. *Asset:* the three `*.html`
  prototypes + Duality/Constellation/Console design notes.
  **Status:** Phase G's audit surface is implemented by Plan 121, Plan 122 adds the shared read
  model, Plan 123 renders it through the dedicated Phoenix/LiveView boundary, Plan 124 adds the Vue
  3.5 causal-replay island, Plan 125 extracts the reusable carrier client boundary, Plan 126
  feeds the connected instrument through a supervised pull-only projection and PubSub, Plan 127
  supplies that projection with a stable supervised carrier server, Plan 128 adds an opt-in
  durable client-signed relay that persists one structurally verified signed operation before
  acknowledgement for later observer pulls, Plan 129 proves a separately packaged Tauri app
  pulls the cap prefix, authors the byte/id-identical Sim operation through its native key, drains
  only durable acknowledgements, and converges with a fresh observer after server restart. Plan 130
  adds the first participant post handoff: a fresh LiveView prepares only an unsigned request, the
  paired Tauri app keeps all authoring custody behind explicit review/post/sync controls, and the
  Ubuntu and packaged macOS gates prove exact Sim convergence and restart durability. Plan 131
  makes both packaged macOS proofs mandatory in a hard-failing hosted CI job. Plan 132 adds a
  bounded authenticated `ops_available` feed: the first pushed generation triggers verified
  LiveView/Vue convergence before a 60-second poll, restart recovery clears and replaces the
  subscription, and a second pushed generation again matches Sim. A real
  LiveSocket connects at `/township`; verification failure withholds authoritative values; stale
  carrier state remains labeled; and the canvas scrubs only server-derived frames. The browser
  feed gate rules out polling as the cause of changed-log convergence. Operations and state still
  arrive only through verified request/response pull; the pushed frame is a liveness hint, not
  materialization or G1 completion. Plan 133 adds the shared direct TypeScript subscription and
  headless real-socket gate: it retains only the latest hint, verifies pulled frames before Sim
  comparison, and replaces the subscription after restart. Plan 134 adds the packaged reactive
  Tauri/Vue feed loop: the saved pairing drives verified read-only refresh, latest-only coalescing,
  rendered Sim-equal state, and replacement-subscription recovery after restart without automatic
  outbox submission. Plans 135-138 extend the same explicit ceremony through clerk status, field,
  roster, and delegation-grant actions. Plan 139 adds strict v6 revocation review/sign/sync and a
  Sim-equal recipient proof; hosted run `29373501735` is green across all three jobs. Plan 147 then
  ports capability/revocation decisions into TypeScript reduction and makes the shell's locally
  materialized retained-frame result authoritative, with equal-evidence carrier reporting retained
  only as a fail-closed divergence check. Local implementation, mutation, packaged, OTP 28,
  security, and Claude gates are green; hosted run `29525397708` passed all three jobs at exact
  implementation tip `b2ad50629d1867dab71f0de50c038480bb5fe3b7`. Plan 148 now has a locally
  green valid-genesis holder/policy parity candidate; exact-tip hosted closure remains pending.
  The F3/F4 state-ordering gaps remain open. Legacy succession tick
  provenance, user ceremony, production deployment, and the receipt-free W4 blocker remain.
  Plan 144 is a
  `DONE` adversarial characterization with focused RED/GREEN, mutation, full local, Claude final
  audit, and hosted run `29387808442` green; it is not a v7 action handoff or a provenance fix.
  Plan 145 adds a separate genesis-pinned witnessed governance floor with independent BEAM/TS
  certificate verification and hosted implementation run `29399176176` green; it adds no absence
  proof, witness custody/collection ceremony, or user-facing action.

**Definition of 100% done:** every gate A1→G1 green in CI; the POC exit gate (PD-001-A §A5)
met with W4 *real*; Township converges across BEAM + browser/phone realms over the real carrier;
and every claim is a passing test with `Sim` as oracle.

---

## 6. How to run the two (three) parallel worktrees

- **Substrate worktree** — Elixir engine: Phases A, C, D1, F. Owns `Sim`, the carrier, CBOR, and
  the gated `Township.Election` protocol foundation. `Lattice.Attestation` remains legacy-only.
  Delegated at milestone level via the overlay `CLAUDE.md` + plans 010a/011.
- **Client worktree** — TS library: Phases B, C3, D2. Owns the reducer/sync/conformance. Delegated
  via `ts-client-CLAUDE.md` + plan 011. No Elixir changes for Tier A.
- **Shell/UI worktree** (later) — Phases E, G. Vue 3.5 + LiveView; consumes the client library and
  the LiveView reduction. Starts once Phase C/D make a real realm reachable.

The worktrees meet at **conformance vectors** (substrate emits from Sim; client must pass) and at
the **carrier seam** (010a Deliverable 3 / 011 Deliverable 3). Those two handshakes are the whole
coordination surface — keep them green and the tracks stay honest.

---

## 7. One-line pointers (paste targets)

- Vision: `lattice_program_doc.html` · POC plan: `township_poc_addendum.html`
- App track start: `CLAUDE.md` (overlay) · Client track start: `ts-client-CLAUDE.md`
- Carrier seam: `010a-carrier-township-acceptance.md` · Client plan: `011-ts-client-realm.md`
- Overlays: `township_poc_overlay.zip`, `ts_client_realm_overlay.zip`
- UI direction: `duality_canvas.html`, `constellation.html`, `adversary_console.html`
- Branch of record: `treetopdevs/lattice @ claude/beautiful-gould-6b25d2`
- Oracle: `Lattice.Sim` · Remaining hard blocker: **M4 profile/operations/review gates**
