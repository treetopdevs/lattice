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
| `apps/lattice_core/lib/township/matter.ex` | `Township.Matter` — the civic Replica (LWW title/summary, causal-list posts, OR-set members, authority-gated `clerk_locked?`). Built only from primitives that exist today. | **Real**, parses; needs `mix compile` against branch. |
| `apps/lattice_core/lib/lattice/attestation.ex` | `Lattice.Attestation` behaviour + `Stub` + `M4Placeholder`. **The seam** that lets W4 be honest. | Stub **proven-plumbing**; receipt-freeness **stubbed** (M4). |
| `apps/lattice_core/test/support/attestation_contract.ex` | The contract suite the Stub AND the future M4 primitive must both pass. `flunk`s if a module claims `receipt_free?` without proving it. | **Real guardrail.** |
| `apps/lattice_core/test/township/workflows_test.exs` | W0–W4 as falsifiable ExUnit tests driving `Sim`, each with its ASSERT line. | **Real**; run against branch — see §4 caveat on quarantine-shape assertions. |
| `scripts/township_demo.exs` | Narrated end-to-end demo (the §5 storyline) over `Sim`. | **Real**; syntax-checked, not yet run against branch. |
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
| `clients/lattice-client/src/{codec,identity,township,local_log,tauri_bridge}.ts` | **Tier B/E1 bridge** — canonical `lattice-cbor-v1` bytes + Ed25519 signing. `codec.ts` verifies carrier-frame op bytes/hashes/signatures against BEAM and can author/sign frames; `township.ts` builds `Township.Matter` command body/cap terms, selects a matching local delegation cap extracted from carrier frames, derives deps from the local op frontier, and exposes author-and-persist workflows; `local_log.ts` persists semantic ops and pending carrier-frame outbox entries through shell key-value seams; `tauri_bridge.ts` adapts Tauri-style `invoke` commands to storage, async native signing, and native public-key discovery. | **Partially real**: Phase D1 parity, received-op verification, W1 command-frame authoring, Township command body/cap composition, carrier delegation extraction, local delegation cap selection, local frontier deps, JSON local-log persistence, pending carrier-frame outbox persistence with ack compaction and a legacy evidence fallback, TS delegation issuance for a BEAM-matching W1 grant frame, shell-facing author-and-persist workflows for commands, grants, and pending-sync revokes, async carrier-session signing, invoke-backed Tauri storage/signer bridges, native Rust command registration, native key lifecycle discovery, the desktop keyring persistence seam, platform-secure app builder/construction helpers, a compile-checked Tauri runtime/config entrypoint, a Vite/Vue frontend asset shell that consumes the reducer, a Vue native-invoke storage/signing probe, cap-gated Vue post, summary, close, reopen, admit, remove-member, grant-access, and revoke-access actions, cap-aware Vue action availability, a Vue carrier sync action over the existing carrier sync contract with carrier-accepted revoke-frame acknowledgement, authority blocked revoked-cap command surfacing, and delegation attribution when blocked command-frame evidence is known, WebSocket carrier peer config/session wiring, runtime persisted carrier pairing config, one-shot carrier connection-health UI, copy-paste/deep-link-safe carrier pairing handoff import/export with peer fingerprint surfacing, QR rendering, QR image import, live camera QR capture, same-origin discovery candidate channel, bounded native UDP local-network pairing advert receive/advertise with OS loopback delivery smoke, draft-only pairing deep-link ingress parsing, static Tauri deep-link plugin/config/capability wiring through a lazy source adapter, macOS installed-app `township://pairing` delivery smoke, generated Tauri iOS/Android target scaffolds, iOS simulator-readiness config for deployment target 15.0, generated Xcode script entrypoint, protected Keychain feature gating, Android debug APK build readiness through Tauri/Gradle, Android emulator native carrier key reuse plus W1-transcript signing through the platform keyring store, Android debug APK pre-signed-frame BEAM convergence through a restart-and-sync smoke, live BEAM peer sync through the shell workflow, a smoke-only live Tauri window launch against a configured BEAM peer, a mobile secure-store strategy contract, cold-start replay of sync state, a named desktop app convergence gate, a Sim-anchored live BEAM proof that a validly signed but non-attenuated grant is authority-quarantined, and a Sim-anchored revocation lifecycle proof that covers issuer revoke, revoked-cap use, and non-issuer revoke rejection are proven; Android emulator native carrier key reuse is proven, Android debug APK pre-signed-frame BEAM convergence is proven for the W1 debug smoke with host-authored frames, on-device Android op authoring remains unproven, iOS mobile key-reuse remains unproven, release mobile BEAM convergence remains unproven, the iOS archive remains locally blocked by an Xcode 27 beta Tauri Swift-package failure, and a physical multi-device LAN discovery smoke remains. |
| `clients/township-tauri-shell` | **E1 Tauri shell** — Vue 3.5 frontend plus Rust native command core for shell-side storage/signing/discovery commands (`lattice_kv_get`, `lattice_kv_set`, `lattice_ensure_carrier_key`, `lattice_public_key`, `lattice_sign_carrier`, `lattice_discover_pairing_adverts`, `lattice_advertise_pairing_handoff`). | **Partially real**: Rust Ed25519 command core matches the W1 TS carrier-session public key/signature and key-value command semantics; a Tauri builder helper registers those commands and is proven through mock IPC; native state can create/reuse an OS-random carrier key by ID without exposing private key material to TS; a `keyring`-backed seed store gives desktop shells a secure persistence seam; platform-secure builder and app-construction helpers wire those commands to the desktop keyring-backed state through a stable service name and supplied Tauri context; `tauri.conf.json`, Tauri build-script wiring, `run()`, and a binary entrypoint compile against the real Tauri Wry runtime; the Vue asset shell renders a reducer-backed zoning-variance matter preview, calls native invoke-backed storage/signing through a tested device-key probe, exposes a generic command submission path plus cap-gated post, summary, close, reopen, admit, remove-member, grant-access, and revoke-access actions that persist signed W1-compatible frames when local delegation evidence exists, renders tested cap-aware action availability from local delegation evidence, exposes a tested carrier sync control that can push/pull through an injected carrier client while persisting the merged local log, retaining delegation evidence, replaying cold-start state from carrier frames, compacting accepted or peer-known pending outbox frames, surfacing carrier-accepted revoke-frame acknowledgement without claiming effective access removal, surfacing carrier authority blocked commands that tried to use revoked caps, and attributing those blocks to cited delegation ids when command-frame evidence is known, can parse Vite or runtime-persisted peer config, authenticate a WebSocket carrier session with the native signer, verify the peer hello through WebCrypto Ed25519, run a one-shot carrier status health probe without syncing data, export/load copy-paste/deep-link-safe pairing handoffs without transferring device-local identity, render that same public handoff as a QR code, import a supplied QR image or live camera QR frame as draft pairing metadata, receive same-origin public discovery candidates through a manual channel, receive and advertise local-network public pairing adverts through bounded native UDP commands/sources with OS loopback delivery smoke, parse `township://pairing` URLs into the same draft-only handoff path, compile-check and bundle Tauri's static `township` scheme/plugin/capability wiring, prove macOS installed-app OS delivery of `township://pairing` into the draft-only path through a packaged `.app` smoke, generate Tauri iOS/Android target projects, pin iOS simulator-readiness config for deployment target 15.0, the generated Xcode script entrypoint, protected Keychain support, Android debug APK build readiness through Tauri/Gradle, Android emulator native carrier key reuse plus W1-transcript signing through the platform keyring store, Android debug APK pre-signed-frame BEAM convergence through a restart-and-sync smoke, sync once against a real BEAM Township peer through that configured shell workflow, launch the real Tauri window in a smoke harness that proves auto-sync opens and closes a carrier session, and run the named `app:convergence` gate; Android emulator native carrier key reuse is proven, Android debug APK pre-signed-frame BEAM convergence is proven for the W1 debug smoke with host-authored frames, on-device Android op authoring remains unproven, iOS mobile key-reuse remains unproven, release mobile BEAM convergence remains unproven, the iOS archive remains locally blocked by an Xcode 27 beta Tauri Swift-package failure, and a physical multi-device LAN discovery smoke remains. |
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
4. **`township_demo.exs` and the overlay are syntax-/parse-checked, not compiled** against the
   branch. Expect minor reconciliation on first `mix compile`.
5. **G1 (physical BEAM carrier) is now reachable outside `Sim`** — plan 017 runs W0–W3
   across two BEAM OS processes over the real WebSocket carrier, with `Sim` as oracle.
   TS can now verify `lattice-cbor-v1` carrier-frame op hashes/signatures for W1, compose
   `Township.Matter` command body/cap terms, extract carrier-frame delegations, select a matching
   local delegation cap, derive deps from the local op frontier, persist/reload the local semantic op log and pushable carrier-frame
   outbox through shell storage seams, run a shell-facing author-and-persist workflow that signs
   a BEAM-accepted W1 command frame, delegate storage/signing through a Tauri-style async
   `invoke` bridge, and match the bridge with a registered Rust native command core that can create,
   reuse, and persist native carrier keys through a desktop keyring seam, expose
   platform-secure builder/app-construction helpers for app bootstrap, compile a real Tauri
   runtime/config entrypoint, build a Vue asset shell that materializes a Township matter through
   the reducer, exercise native invoke-backed storage/signing from the Vue screen through a
  probe, persist cap-gated post and summary actions when local delegation evidence exists, render
  cap-aware command availability from the same local delegation evidence with a legacy
  carrier-frame fallback when the split evidence store is empty, run a Vue sync action
   that pushes/pulls the persisted outbox through the carrier contract with an injected carrier
   client, build a WebSocket carrier session from Vite or runtime-persisted peer config, run a
   one-shot carrier status health probe without syncing data, sync that shell workflow against
   a live BEAM peer, smoke-launch the real Tauri window against a configured peer with
   debug-seeded key custody, issue and persist a Tauri grant-access cap ceremony, document the
   mobile secure-store boundary, replay sync state from cold-start carrier frames, and run the
   named desktop app convergence gate, prove concrete seed bytes stay out of current desktop app KV
   stores, surface reported authority-quarantined grant frames in the sync result, save a
   pending-sync Tauri revoke-access frame for locally issued delegations without removing local
   evidence before carrier confirmation, surface carrier-accepted revoke-frame acknowledgement
   without claiming effective access removal, surface carrier authority blocked commands that used
   revoked caps as carrier-wide authority-quarantine observations, attribute those blocks to
   cited delegation ids when command-frame evidence is known, prove over a
   live BEAM peer that a validly signed but non-attenuated grant is structurally accepted yet
   authority-quarantined as `not_attenuated`, and prove a clerk-issued delegation can be revoked
   such that a later command citing it is authority-quarantined as `revoked_capability` while a
   non-issuer revoke is `unauthorized_revoke` and leaves the delegation usable, and load
   copy-paste/deep-link-safe pairing handoffs as draft peer metadata without transferring
   device-local identity, render those handoffs as QR codes, import supplied QR images, capture
   live camera QR frames, receive same-origin discovery candidates and bounded native UDP
   local-network adverts, advertise those same public handoff packets with OS loopback smoke, parse `township://pairing` URLs through the same draft-only path, compile-check Tauri's static
   `township` scheme/plugin/capability wiring, and prove macOS installed-app delivery through
   a packaged `.app` smoke, generate Tauri iOS/Android target scaffolds, pin repo-side iOS
   simulator-readiness config for deployment target 15.0, the generated Xcode script entrypoint,
   protected Keychain support, assemble an Android debug APK through the real Tauri/Gradle
   path, prove Android emulator native carrier key reuse plus W1-transcript signing through the
   native command boundary, and prove Android debug APK pre-signed-frame BEAM convergence through a
   restart-and-sync smoke using host-authored frames. Non-BEAM phone shells still need release mobile BEAM convergence before
   they are user-facing equivalent carrier peers. On this machine, the iOS simulator archive is
   blocked by the selected Xcode 27 beta Tauri Swift-package failure. A physical multi-device LAN
   discovery smoke remains separate from the proof.
6. **Receipt-freeness is not real** (W4). `Attestation.Stub` is `receipt_free? = false` by
   design; do not let anything claim otherwise before M4.
7. **AtomVM has distribution now but no iOS/Android target** — so a phone is a TS client, not a
   BEAM node. Re-check this if AtomVM ships a mobile target (STOP condition in plan 011).

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
  **Status:** done for Tier A W1 in plans 021–022. The TS client signs/verifies carrier-session
  bytes through injected shell key custody, talks to `LatticeNodeSpike.WsHandler` over a real
  WebSocket, pulls/pushes carrier frames, and converges to the Sim oracle. Received carrier-frame
  verification, the first author/sign primitive, Township command body/cap composition, carrier
  delegation extraction, local delegation cap selection, local frontier dep derivation, JSON
  local-op-log persistence, carrier-frame outbox persistence, the author-and-persist command
  workflow, async carrier-session signing, Tauri-style invoke storage/signing bridges, a
  registered Rust native command core, native key lifecycle discovery, a desktop keyring-backed
  persistence seam, platform-secure app builder/construction helpers, a compile-checked Tauri
  runtime/config entrypoint, first Vue frontend asset shell, native-invoke UI probe, cap-gated
  post, summary, close, and reopen actions, cap-aware action availability, Vue carrier sync outbox action,
  WebSocket peer config/session wiring, live BEAM peer sync through the shell workflow, and a
  smoke-only live Tauri window launch, cap-gated member-management actions, pending-outbox ack
  compaction, TS delegation issuance, the Tauri grant-access persistence ceremony, the mobile
  secure-store strategy contract, cold-start replay guard, the named desktop app convergence
  gate, current desktop app-KV no-secret checks, reported grant-authority-quarantine surfacing,
  a Sim-anchored live BEAM proof that a non-attenuated grant is authority-quarantined, a
  Sim-anchored live BEAM revocation lifecycle proof with non-issuer rejection, the Tauri
  pending-sync revoke-access ceremony, carrier-accepted revoke-frame acknowledgement UI, runtime
  persisted carrier pairing config, one-shot carrier connection-health UI, authority
  revoked-capability quarantine surfacing, delegation attribution for known blocked command
  frames, copy-paste/deep-link-safe pairing handoff import/export, QR rendering, QR image
  import, draft-only pairing deep-link ingress parsing, static Tauri deep-link
  plugin/config/capability wiring, live camera QR capture, the same-origin discovery candidate
  channel, bounded native UDP local-network pairing advert receive/advertise, macOS installed-app
  deep-link delivery smoke, generated Tauri iOS/Android target scaffolds, repo-side iOS
  simulator-readiness config, Android debug APK build readiness, Android emulator native carrier
  key reuse, and Android debug APK pre-signed-frame BEAM convergence are covered by plans 023–080.
  On-device Android op authoring and release mobile BEAM convergence remain Tier B/application-shell work. The iOS archive path is
  locally blocked by the selected Xcode 27 beta Tauri Swift-package failure.

### Phase D — Cross the runtime boundary (CBOR, the first hard blocker)
- **D1.** Land **ADR-P08**: canonical CBOR for `Lattice.Op`, replacing the ETF pin.
  *Gate:* one op hashes byte-identically Elixir↔TS (Tier-B vector). *Asset:* 010a coupling section.
  **Status:** done for the current `lattice-cbor-v1` carrier-frame suite in plan 023:
  `township_carrier_w1` exports canonical bytes from `Lattice.Op.canonical_encoding/1`, and
  `npm run canonical` proves every W1 carrier op hashes byte-identically in TS.
- **D2.** Implement the TS `codec.ts` CBOR encoder; enable client-side op authoring + local verify.
  *Gate:* plan 011 Deliverable 4; `codec.ts` no longer throws.
  **Status:** partial. `codec.ts` can reproduce BEAM canonical bytes and op ids from carrier
  frames, plan 024 verifies received W1 carrier-op Ed25519 signatures locally with tamper
  rejection, plan 025 proves `authorCarrierOp` can sign a resident W1 `post` command frame that
  is byte-for-byte equal to the Sim-exported fixture and accepted by the live BEAM carrier, and
  plan 026 proves `authorTownshipCommand` builds the `Township.Matter` command body/cap terms for
  all declared commands and is accepted on the live W1 path, and plan 027 proves
  `selectTownshipCapId` chooses a local delegation by audience/op/role and feeds the live W1
  authoring path, plan 028 proves `authorTownshipCommandFromLog` derives deps from a local
  semantic op frontier before BEAM accepts the authored W1 frame, plan 029 proves the local
  semantic op log can save/reload through an injected JSON key-value store before authoring, plan
  030 proves pushable carrier frames can persist/reload from an outbox before BEAM accepts them,
  plan 031 proves shell-neutral extraction of delegation caps from loaded carrier frames, and plan
  032 proves a single author-and-persist workflow can load local state, choose the cap, sign, append
  the semantic op, append the carrier frame, and reject missing-cap commands before the live BEAM
  carrier accepts the authored frame, and plan 033 proves async carrier-session signing plus a
  dependency-free Tauri `invoke` adapter for key-value storage and native signing, plan 034 proves
  the Rust command core can store values and produce the same Ed25519 W1 carrier-session public
  key/signature as TS, plan 035 proves a Tauri builder can register those commands and route mock
  IPC through native state, plan 036 proves Rust can create or reuse a native carrier key by ID and
  hand TS only the public key, and plan 037 proves those native seeds can persist through a key-store
  seam with a desktop keyring-backed implementation, plan 038 proves a production-default
  platform-secure builder helper with a stable desktop keyring service name, and plan 039 proves
  the same platform-secure path can build a Tauri app from a supplied builder/context, and plan 040
  proves a generated Tauri context plus binary entrypoint compile against the real Wry runtime, and
  plan 041 proves a Vue/Vite frontend asset shell can consume the client reducer and render a
  Township matter preview, plan 042 proves that Vue code reaches native invoke-backed storage
  and signing through a device-key probe, plan 043 proves a cap-gated Vue post action persists
  the exact signed W1 frame when local delegation evidence exists, plan 044 proves a carrier sync
  outbox action over the existing sync contract, plan 045 proves Vite-configured WebSocket
  carrier session wiring, plan 046 proves the configured shell sync workflow against a live BEAM
  Township peer, and plan 047 proves the real Tauri window can launch against a configured peer and
  auto-sync far enough to open and close a carrier session, plan 048 generalizes the shell
  authoring wrapper and proves a cap-gated Vue summary action against the exact W1 summary frame,
  and plan 049 proves a Vue action-availability model that derives command-level caps from
  persisted carrier-frame delegation evidence, plan 050 proves cap-gated Vue close/reopen
  matter-status actions against the clerk delegation path, and plan 051 proves cap-gated Vue
  admit/remove-member actions against resident and clerk delegation paths, plan 052 splits
  delegation evidence from the pending outbox, keeps a legacy fallback for pre-split local stores,
  and compacts accepted or peer-known carrier frames, plan 053 authors a BEAM-matching Township
  grant frame for TS-side delegation issuance, plan 054 wires that grant path into a Tauri
  onboarding/cap persistence ceremony, plan 055 documents and contract-tests the mobile
  secure-store boundary while proving cold-start replay from carrier frames, plan 056 adds
  the named desktop `app:convergence` gate, plan 057 adds concrete seed-byte app-KV checks plus
  typed surfacing for reported authority-quarantined grant frames, plan 058 adds a
  Sim-generated authority-unsound grant fixture plus a live BEAM peer proof that the same
  validly signed non-attenuated grant is structurally accepted but authority-quarantined, and plan
  059 adds Sim-generated revocation lifecycle fixtures plus live BEAM peer proofs that a later
  command citing a revoked delegation is structurally accepted but authority-quarantined as
  `revoked_capability`, while a non-issuer revoke is `unauthorized_revoke` and leaves the
  delegation usable, plan 060 adds the Tauri pending-sync revoke-access ceremony for locally
  issued delegations, plan 061 surfaces carrier-accepted revoke-frame acknowledgement without
  treating peer-known compaction as acceptance or claiming effective access removal, plan 062
  adds runtime persisted carrier pairing config with env fallback, plan 063 adds a
  one-shot carrier status health probe without syncing data, plan 064 surfaces
  carrier authority entries where commands using revoked caps were blocked as
  `revoked_capability` without attributing that carrier-wide count to a specific local delegation.
  Plan 065 attributes blocked commands to cited delegation ids when those command frames are in
  known shell evidence. Plan 066 adds copy-paste/deep-link-safe carrier pairing handoff
  import/export as draft peer metadata, strips device-local identity fields, and surfaces the peer
  fingerprint before save. Plan 067 renders that same public handoff as a deterministic QR code
  without adding scanner, OS registration, or discovery behavior. Plan 068 decodes supplied QR
  images into the same draft-only handoff import path without adding live camera capture. Plan 069
  parses `township://pairing` URLs and an injected URL source into that same draft-only handoff path
  without adding Tauri plugin/config scheme registration. Plan 070 adds static Tauri deep-link
  plugin/config/capability wiring plus a lazy Tauri source adapter while keeping bundle packaging
  inactive and installed-app delivery unproven. Plan 071 captures live camera QR frames into the
  same draft-only handoff path without saving, syncing, connecting, or discovering peers. Plan 072
  adds a same-origin discovery candidate channel for public handoff adverts without auto-pairing or
  claiming LAN discovery. Plan 073 adds a bounded native UDP receive path and Tauri source for
  local-network public pairing adverts without transferring local identity, auto-pairing, or
  claiming a production advertiser/multi-device smoke. Plan 074 activates app bundling and proves
  macOS installed-app `township://pairing` delivery through a packaged `.app` smoke without saving,
  syncing, connecting, or marking trust. Plan 075 adds the native UDP advertise command, TypeScript
  adapter, Vue "Advertise handoff" ceremony, and OS loopback delivery smoke for public pairing
  packets without saving, syncing, connecting, or marking trust. Plan 076 generates Tauri iOS and
  Android target projects and adds a readiness contract while preserving the no-phone-grade claim
  boundary. Plan 077 pins iOS simulator-readiness config for deployment target 15.0, the generated
  Xcode script entrypoint, and protected Keychain support, then records the remaining local Xcode 27
  beta Tauri Swift-package archive blocker. Plan 078 pins the Android debug APK build command, Rust
  mobile library crate types, and Tauri mobile entrypoint marker, then proves the generated Android
  target assembles a debug APK through Tauri/Gradle. Plan 079 adds the Android emulator native-key
  smoke: platform-specific keyring default-store setup, Android NDK context initialization, backup
  disabled for the carrier identity app, W1-transcript native signing, public-key reuse after
  force-stop/relaunch, and a `pm clear` negative guard that changes the key. Plan 080 adds the Android debug-APK BEAM convergence smoke: the installed debug APK reloads persisted native KV
  after restart, syncs host-authored, pre-signed W1 carrier frames with a real BEAM Township peer over
  `ws://10.0.2.2`, verifies local KV convergence, and checks the peer `stateReport`; release mobile
  BEAM convergence remains unproven. The remaining shell gaps are iOS simulator key-reuse proof,
  on-device Android op authoring, release mobile BEAM convergence, and a physical multi-device LAN discovery smoke.

### Phase E — The shells (apps)
- **E1.** **Tauri v2 shell** (recommended spine): Vue 3.5 frontend + Rust core (key custody, CBOR,
  optional BEAM sidecar on desktop) consuming `@treetopdevs/lattice-client`. *Gate:* a desktop +
  mobile build converges a Township matter against a BEAM realm.
  **Status:** started: the TS bridge, Rust command core, Tauri command registration, native
  carrier-key lifecycle, desktop keyring persistence seam, platform-secure builder/app-construction
  helpers, compile-checked Tauri runtime/config entrypoint, first Vue frontend asset shell,
  native-invoke UI probe, cap-gated post, summary, close, reopen, admit, and remove-member actions, cap-aware action availability,
  injected-carrier sync outbox action, WebSocket carrier peer config/session wiring, runtime persisted carrier pairing config, one-shot carrier connection-health UI, live BEAM
  peer sync through the configured shell workflow, smoke-only live Tauri window launch against a
  configured BEAM peer, Tauri grant-access ceremony, Tauri pending-sync revoke-access ceremony,
  mobile secure-store strategy contract, cold-start replay guard, named desktop `app:convergence` gate, concrete seed-byte app-KV checks,
  typed reported-grant-quarantine surfacing, carrier-accepted revoke-frame acknowledgement,
  authority revoked-capability quarantine surfacing with known-frame delegation attribution,
  copy-paste/deep-link-safe carrier pairing handoff import/export with peer fingerprint surfacing,
  pairing handoff QR rendering, QR image import, live camera QR capture, same-origin discovery
  candidate channel, bounded native UDP local-network pairing advert receive/advertise with OS loopback smoke, draft-only pairing deep-link ingress parsing, static Tauri deep-link plugin/config/capability wiring, macOS installed-app deep-link delivery smoke, generated Tauri iOS/Android target scaffolds, iOS simulator-readiness config for deployment target 15.0 plus protected Keychain support, Android debug APK build readiness, Android emulator native carrier key reuse and W1-transcript signing through the platform keyring store, and the
  shared live BEAM authority-unsound grant and revocation lifecycle proofs, including non-issuer
  revoke rejection, exist and are
  vector-/mock-IPC/browser-smoke/live-peer/window-smoke/emulator-smoke-tested; Android debug APK
  pre-signed-frame BEAM convergence is proven for the W1 debug smoke with host-authored frames, on-device Android op authoring remains unproven, release mobile BEAM
  convergence remains unproven, iOS mobile key-reuse remains unproven, the iOS archive remains
  locally blocked by the selected Xcode 27 beta Tauri Swift-package archive failure, and a physical
  multi-device LAN discovery smoke is not done.
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
