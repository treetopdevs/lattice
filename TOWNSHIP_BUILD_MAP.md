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
| `apps/lattice_web_socket` | Dependency-light home of `Lattice.Transport.WebSocket.Client`, the shared JSON envelope codec, and `Lattice.Carrier.WebSocket`. | **Real and carrier-tested**; generic and Township second-process convergence, session security, batching, telemetry, and server transport suites use the promoted client. Cowboy peer/server fixtures remain in their boundary apps, and no live instrument producer is wired. |
| `apps/township_web` | Dedicated Phoenix 1.8.9 / LiveView 1.1.32 instrument boundary over the verified bundle and shared read model. | **Real and browser-tested**; a connected `/township` LiveView renders the read-only snapshot, refuses authoritative values when verification fails, and progressively enhances verified replay frames through a Vue 3.5 canvas island. Live controls and carrier/PubSub feeds remain. |
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
| `clients/lattice-client/src/{codec,identity,township,local_log,tauri_bridge}.ts` | **Tier B/E1 bridge** — canonical `lattice-cbor-v1` bytes + Ed25519 signing. `codec.ts` verifies carrier-frame op bytes/hashes/signatures against BEAM and can author/sign frames; `township.ts` builds `Township.Matter` command body/cap terms, selects a matching local delegation cap extracted from carrier frames, derives deps from the local op frontier, and exposes author-and-persist workflows; `local_log.ts` persists semantic ops and pending carrier-frame outbox entries through shell key-value seams; `tauri_bridge.ts` adapts Tauri-style `invoke` commands to storage, async native signing, and native public-key discovery. | **Partially real** — Tier B/E1 coverage through plan 126 is tracked per plan in `plans/README.md` (each plan states its own gate and non-claims); parked gaps are listed in §4a. |
| `clients/township-tauri-shell` | **E1 Tauri shell** — Vue 3.5 frontend plus Rust native command core for shell-side storage/signing/discovery commands (`lattice_kv_get`, `lattice_kv_set`, `lattice_ensure_carrier_key`, `lattice_public_key`, `lattice_sign_carrier`, `lattice_discover_pairing_adverts`, `lattice_advertise_pairing_handoff`, `lattice_log_probe`). | **Partially real** — shell coverage through plan 120 is tracked per plan in `plans/README.md`; parked gaps (iOS, QR camera onboarding, LAN discovery, physical-device behavior, cross-device state exchange) are listed in §4a. |
| `clients/lattice-client/test/conformance.ts` + `test/vectors/*.json` | The harness that pins the TS reducer to Sim. | **Real**; W0, W1/W2 + perspectives, W3, and five seeded randomized vectors are generated by `lattice.export_vectors`. |
| `clients/lattice-client/test/carrier.ts` | The C3 carrier-vector harness: BEAM-compatible session transcript/signature check, full carrier-frame decoding, and W1 merge/materialization against the Sim oracle. | **Real**; `npm run carrier:township` is wired in CI. |
| `clients/lattice-client/test/live_carrier.ts` | The live C3 harness: spawns the BEAM Township peer process, authenticates over WebSocket, pulls/pushes carrier frames, and compares both TS materialization and BEAM peer state to the Sim oracle. | **Real**; `npm run carrier:township:live` is wired in CI. |
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
4. **`township_demo.exs` and the overlay now run against the branch.** Plan 121 makes the
   resulting state, authority verdict, op-DAG, and trust graph independently replayable through
   `mix lattice.township.verify_bundle`. Plan 122 adds the shared structured read-model foundation
   for the five-panel instrument. Plan 123 adds the Township LiveView instrument as a connected,
   read-only verified snapshot. Plan 124 adds server-derived causal replay through a Vue 3.5 canvas
   island. Plan 125 promotes the real WebSocket carrier client into a reusable app boundary while
   keeping live controls and carrier/PubSub feeds separate.
5. **G1 (physical BEAM carrier) is now reachable outside `Sim`** — plan 017 runs W0–W3
   across two BEAM OS processes over the real WebSocket carrier, with `Sim` as oracle.
   Everything proven since — TS client Tier B, the Tauri shell, the Android release
   probes, the onboarding gates, and the Phase G instrument work — is tracked **per plan
   in `plans/README.md`**; each plan file carries its own gate and non-claims, so read
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

The active frontier is the POC exit gate: **complete G1** (live read-only carrier feed
into the `/township` instrument — plan 126 lineage) and the remaining Phase G instrument
work. Per-plan status lives in `plans/README.md`.

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
  Follow-on client/shell/onboarding coverage (plans 023–126) is tracked per plan in
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
  probes, onboarding gates, and the Phase G instrument work (plans 024–126) — is
  tracked per plan in `plans/README.md`; each plan file states its own gate and
  non-claims. Parked areas: §4a.

### Phase E — The shells (apps)
- **E1.** **Tauri v2 shell** (recommended spine): Vue 3.5 frontend + Rust core (key custody, CBOR,
  optional BEAM sidecar on desktop) consuming `@treetopdevs/lattice-client`. *Gate:* a desktop +
  mobile build converges a Township matter against a BEAM realm.
  **Status:** started and deep — desktop and Android-release convergence, onboarding,
  and pairing proofs exist through plan 120; see `plans/README.md` (plans 033–120) for
  per-plan status and non-claims. iOS, QR camera onboarding, LAN discovery,
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
  model, Plan 123 renders it through the dedicated Phoenix/LiveView boundary, and Plan 124 adds the
  Vue 3.5 causal-replay island. The production instrument is a read-only verified snapshot: a real
  LiveSocket connects at `/township`, verification failure withholds authoritative panel values,
  and the canvas scrubs only server-derived frames. This is not G1 completion: Live controls and
  carrier/PubSub feeds remain, as does the receipt-free W4 blocker.

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
