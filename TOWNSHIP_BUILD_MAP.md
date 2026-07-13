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
| `apps/lattice_core/lib/township/matter.ex` | `Township.Matter` — the civic Replica (LWW title/summary, causal-list posts, OR-set members, authority-gated `clerk_locked?`). Built only from primitives that exist today. | **Real and compiled**; W0–W4 workflow and property suites pass against the branch. |
| `apps/lattice_core/lib/township/read_model.ex` | `Township.ReadModel` — structured Threads, Roles, Members, Attest, trust-graph, and causal op-DAG inputs for the one-screen instrument boundary. | **Real and tested**; four panels and graph evidence derive from `matter.log`, W4 vouches remain caller-held and stub-labeled, and no renderer is claimed. |
| `apps/lattice_web_socket` | Dependency-light home of `Lattice.Transport.WebSocket.Client`, the shared JSON envelope codec, and `Lattice.Carrier.WebSocket`. | **Real and carrier-tested**; generic and Township second-process convergence, session security, batching, telemetry, and server transport suites use the promoted client. Plan 132 adds active-once incremental frame parsing, lifetime-exclusive streaming versus atomic request modes, one-envelope streaming prefetch with TCP backpressure, typed owner-preallocated subscriptions, bounded notification-type reservation, and request/notification demultiplexing. Cowboy peer/server fixtures remain in their boundary apps; the Township projection consumes this client without taking listener ownership. |
| `apps/lattice_carrier_server` | Dedicated supervised Cowboy boundary that serves one configured signed log to trusted carrier realms. | **Real and server-tested**; Plan 127 adds authenticated frontier and pull, fail-closed source reload, fixed-port supervision, second-BEAM projection recovery, and a browser fresh/stale/fresh proof. Plan 128 adds the opt-in durable client-signed relay for selected trusted realms on path-backed sources: changed signed logs are persisted before acknowledgement and survive restart for a distinct observer. Plan 129 proves the actual packaged desktop Tauri app can use that boundary through native key custody, persisted capability evidence, and explicit one-op relay mode, then converge with a fresh pull-only observer after server restart. Plan 130 drives that same boundary from a LiveView-prepared, app-authored post and proves exact Sim convergence before and after restart. Plan 131 makes both packaged macOS convergence proofs CI-enforced on a hosted runner. Plan 132 adds an authenticated bounded `ops_available` hint after durable change, monitored subscribe/unsubscribe, restart-stable generation, and holder-level one-outstanding flow control whose acknowledgment returns the latest durable generation. The server key remains a transport identity, not participant custody or semantic authority; verified pull remains the only materialization path, and no direct pushed operation, production ingress, or deployment is claimed. |
| `apps/township_web` | Dedicated Phoenix 1.8.9 / LiveView 1.1.32 instrument boundary over the shared read model. | **Real and browser-tested**; a connected `/township` LiveView defaults to the verified bundle and, when configured, receives a supervised carrier projection with explicit fresh, stale, connecting, and unavailable states. Plan 132 replaces fast polling as the normal convergence trigger in opt-in `server_push` mode: a newer authenticated generation wakes the existing verified pull and rendered provenance records the trigger/generation. The owner records a secret pending ref before a connect worker starts, so first-connect/reconnect hints queue one trailing pull instead of racing ref installation; stale workers cannot resurrect or orphan their connection. Vue 3.5 progressively enhances server-derived replay frames. Plan 130 lets only a fresh carrier-backed instrument prepare one unsigned post request for explicit review and authoring in the Tauri app. Plan 135 adds a fresh-only, state-derived v2 close/reopen request while clearing prepared status requests on stale state, replica replacement, or the opposing matter state. Plan 136 adds separate fresh-only v3 title and summary requests whose server handlers fix the command and clear prepared field requests on stale state or replica replacement. Phoenix receives no participant key, capability, dependency frontier, or authoring authority; broader participant controls remain, and no operation is materialized directly from a pushed hint. |
| `apps/lattice_core/lib/lattice/attestation.ex` | `Lattice.Attestation` behaviour + `Stub` + `M4Placeholder`. **The seam** that lets W4 be honest. | Stub **proven-plumbing**; receipt-freeness **stubbed** (M4). |
| `apps/lattice_core/test/support/attestation_contract.ex` | The contract suite the Stub AND the future M4 primitive must both pass. `flunk`s if a module claims `receipt_free?` without proving it. | **Real guardrail.** |
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
| `clients/lattice-client/src/{op,dag,schema,crdt/reducers,quarantine,materialize,sync,carrier}.ts` | **Tier A** — the reducer (DAG, 3 CRDTs, the single V-01 quarantine predicate, materialize, sync) plus the carrier-frame/session adapter and carrier-term delegation extraction. Encoding-independent for op ids; carrier session bytes are signed through an injected shell/key-custody signer. | **Real & verified**: strict typecheck clean, Sim-generated conformance green, carrier W1 vector check green, live TS↔BEAM WebSocket W1 green. |
| `clients/lattice-client/src/{codec,identity,township,local_log,tauri_bridge}.ts` | **Tier B/E1 bridge** — canonical `lattice-cbor-v1` bytes + Ed25519 signing. `codec.ts` verifies carrier-frame op bytes/hashes/signatures against BEAM and can author/sign frames; `township.ts` builds `Township.Matter` command body/cap terms, selects a matching local delegation cap extracted from carrier frames, derives deps from the local op frontier, and exposes author-and-persist workflows; `local_log.ts` persists semantic ops and pending carrier-frame outbox entries through shell key-value seams; `tauri_bridge.ts` adapts Tauri-style `invoke` commands to storage, async native signing, and native public-key discovery. | **Partially real** — Tier B/E1 coverage through plan 134 is tracked per plan in `plans/README.md` (each plan states its own gate and non-claims); parked gaps are listed in §4a. Plan 129 adds explicit one-op relay transport and causally ordered, acknowledged-only relay draining while preserving generic push as the default; Plan 130 reuses those app-owned authoring seams unchanged; Plan 131 adds CI enforcement without changing runtime behavior; and Plan 132 adds the BEAM feed path. Plan 133 adds the direct typed TypeScript availability subscription. Plan 134 requires canonical hash and Ed25519 verification for every shared-sync pull before conversion or submission, while retaining semantic authority in the materializer. |
| `clients/township-tauri-shell` | **E1 Tauri shell** — Vue 3.5 frontend plus Rust native command core for shell-side storage/signing/discovery commands (`lattice_kv_get`, `lattice_kv_set`, `lattice_ensure_carrier_key`, `lattice_public_key`, `lattice_sign_carrier`, `lattice_discover_pairing_adverts`, `lattice_advertise_pairing_handoff`, `lattice_log_probe`). | **Partially real** — completed shell coverage through Plan 136 is tracked per plan in `plans/README.md`. Plan 129 connects packaged desktop onboarding to the stable relay; Plan 130 stages a strict unsigned action intent and retains explicit Use request, Post, and Sync controls; Plan 131 makes both packaged proofs mandatory in CI; Plans 132-133 add the authenticated and direct TypeScript hint substrates. Plan 134 adds the packaged Tauri/Vue reactive availability feed. Plan 135 extends the same inert ingress and native-custody path to replica-bound clerk close/reopen requests. Plan 136 extends that fail-closed seam to replica-bound `set_title` and `set_summary`, with separate Use, Sign, and Sync controls and no-cap refusal before signing or KV writes. The mobile secure-store strategy remains unchanged; parked gaps remain in §4a. |
| `clients/lattice-client/test/conformance.ts` + `test/vectors/*.json` | The harness that pins the TS reducer to Sim. | **Real**; W0, W1/W2 + perspectives, W3, and five seeded randomized vectors are generated by `lattice.export_vectors`. |
| `clients/lattice-client/test/carrier.ts` | The C3 carrier-vector harness: BEAM-compatible session transcript/signature check, full carrier-frame decoding, and W1 merge/materialization against the Sim oracle. | **Real**; `npm run carrier:township` is wired in CI. |
| `clients/lattice-client/test/carrier_relay*.ts` | One-op relay wire and drain contracts: explicit relay envelope, stable causal order, no push fallback, report aggregation, duplicate re-advertisement, and retry-safe acknowledgement. | **Real**; `carrier:relay` and `carrier:relay-sync` are wired in flagship CI. |
| `clients/lattice-client/test/live_carrier.ts` | The live C3 harness: spawns the BEAM Township peer process, authenticates over WebSocket, pulls/pushes carrier frames, and compares both TS materialization and BEAM peer state to the Sim oracle. | **Real**; `npm run carrier:township:live` is wired in CI. |
| `clients/township-tauri-shell/test/{township_stable_relay,township_carrier_feed,township_feed,tauri_stable_relay_onboarding_smoke,tauri_action_handoff_smoke,tauri_clerk_action_handoff_smoke,tauri_field_action_handoff_smoke,tauri_carrier_feed_smoke}.ts` | Production stable-server, direct/reactive TypeScript feed, and packaged-app convergence gates. | **Real locally and hosted through Plan 136** — existing packaged gates remain CI-enforced, including the direct-TypeScript gate CI-enforced by Plan 133. Plan 134 adds the headless verified refresh/controller lifecycle contract and a third fresh-build packaged macOS smoke. The real app authenticates as a read-only observer, renders Sim-derived base/first/restart projections from verified pulls, retains the last projection during same-path reconnect, and never invokes automatic Sync or authors an observer operation. Full local Plan 134 regression is green. Hosted Plan 134 run `29210581826` is green across the flagship artifact, unit/property, and packaged macOS jobs, including all three hard packaged convergence steps. The Plan 135 clerk smoke is green locally and hosted through Sim-equal Open -> Locked -> Open. Plan 136 adds a no-build field smoke that keeps the resident summary frame byte-identical while a concurrent clerk branch reaches the source, then proves explicit-Sync contested-summary and title convergence across the source, Tauri feed, and LiveView against Sim. Hosted Plan 136 run `29223172342` is green across flagship, unit/property, and packaged macOS. |
| `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` | Elixir task that emits conformance vectors *from Sim* — makes the oracle literal. | **Real** for Phase B1/B2 and C3a; emits fixed, randomized, and carrier W1 vectors with grant-quarantine and revocation lifecycle fixtures. |
| `ts-client-CLAUDE.md` | Agent working notes for the client library. | **Start here for the client track.** |

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
- **Stubbed** — plumbing works behind an interface; the hard property lands at a named milestone. Honestly labelled (e.g. `receipt_free? = false`).
- **Blocked** — cannot be built correctly until a prerequisite lands. The only blockers in this program are: **CBOR/ADR-P08** (non-BEAM realms) and **M4 research** (receipt-freeness).

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
M4 research (JCJ/composition) ──▶ real receipt-free primitive ──▶ Attestation swap (W4 becomes real)
```

Two hard blockers gate the endgame: **CBOR/ADR-P08** (everything non-BEAM) and **M4 research**
(receipt-freeness). Everything else is engineering that can proceed in parallel behind them.

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
   frames for the first C3 adapter check.
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
5. **G1 (physical BEAM carrier) is now reachable outside `Sim`** — plan 017 runs W0–W3
   across two BEAM OS processes over the real WebSocket carrier, with `Sim` as oracle.
   Everything proven since — TS client Tier B, the Tauri shell, the Android release
   probes, the onboarding gates, and the Phase G instrument work — is tracked **per plan
   in `plans/README.md`**; coverage and enforcement through plans 023-134 carry their own gates and
   non-claims, so read
   the plan before trusting a claim repeated anywhere else. Areas parked as
   blocked-on-external-factors are listed in §4a and must not accrete new probe
   variants.
6. **Receipt-freeness is not real** (W4). `Attestation.Stub` is `receipt_free? = false` by
   design; do not let anything claim otherwise before M4.
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

- **iOS** — archive path blocked by the Xcode 27 beta Tauri Swift-package failure
  (plan 077). Revisit only when the toolchain unblocks.
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
Plan 135 closes the first clerk-status slice and Plan 136 closes the first field-edit slice toward
**complete G1/Phase G**. Broader participant controls beyond close/reopen and title/summary edits,
production deployment, and receipt-free W4 are not supplied by the current work. The remaining
frontier still includes broader participant controls, production deployment, and receipt-free W4.
The remaining participant-control work specifically includes roster and capability-lifecycle
controls.
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
  the shell's key/capability custody; see `plans/README.md` for per-plan status and non-claims. iOS,
  QR camera onboarding, LAN discovery,
  physical-device behavior, and cross-device pairing state exchange are parked (§4a) —
  do not add new probe variants for them.
- **E2.** **Expo shell** (if phone-only is wanted): SDK 56+, RN 0.85, New Arch; same library, key
  custody via secure-store/native keystore. *Gate:* a phone build converges a Township matter.
  *Asset:* `docs/township_mobile_secure_store_strategy.md` plus the app-shell analysis (this
  conversation's §Expo-vs-Tauri) — decision deferred, reversible.

### Phase F — Close the coercion gap (M4, the second hard blocker)
- **F1.** Land the receipt-free primitive per the research verdict (JCJ survival, composition —
  PD-001 §6 R-02/R-03). *Gate:* the `Attestation.Contract` passes with `receipt_free? = true`
  (real indistinguishability, not the `flunk` placeholder). *Asset:* `attestation.ex`, contract suite.
- **F2.** Swap `Stub` → real primitive; W4 becomes real with **no change** to W0–W3.
  *Gate:* POC W4 receipt-free; Township exit gate fully met.

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
  outbox submission. Broader participant controls, production deployment, and the receipt-free W4
  blocker remain.

**Definition of 100% done:** every gate A1→G1 green in CI; the POC exit gate (PD-001-A §A5)
met with W4 *real*; Township converges across BEAM + browser/phone realms over the real carrier;
and every claim is a passing test with `Sim` as oracle.

---

## 6. How to run the two (three) parallel worktrees

- **Substrate worktree** — Elixir engine: Phases A, C, D1, F. Owns `Sim`, the carrier, CBOR, the
  attestation primitive. Delegated at milestone level via the overlay `CLAUDE.md` + plans 010a/011.
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
- Oracle: `Lattice.Sim` · Two hard blockers: **ADR-P08 (CBOR)**, **M4 (receipt-freeness)**
