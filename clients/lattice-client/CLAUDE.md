# TS Client Realm — Agent Working Notes

`@treetopdevs/lattice-client` is the **framework-agnostic** TypeScript half of a Lattice
realm. It is the piece that unblocks BOTH the Tauri (desktop+mobile, Vue 3.5) and Expo
(phone, React Native) shells — because on a phone/browser the realm is a JS/TS client
speaking the sync protocol, not a BEAM node.

## The one idea: Sim is the oracle

This library is a **second implementation** of the reducer that `Lattice.Sim` runs in
Elixir. Two implementations of the same reduction is exactly the drift V-01 warns about,
so the library only earns the right to exist because `test/conformance.ts` pins it to Sim:
for every scenario, the TS `materialize()` must reproduce Sim's **state, quarantine set,
and canonical order** exactly. The vectors are emitted by the Elixir mix task
`lattice.export_vectors` (`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`),
which runs the SAME Sim calls as `workflows_test.exs`. Do not hand-maintain vectors.

## Two tiers — this is what makes the work parallelizable

- **Tier A — semantics (buildable NOW).** op model, DAG (ancestors/concurrency/lamport/
  canonical order), the three CRDT reducers, the shared quarantine predicate, materialize,
  and sync reconciliation. All of it works with op ids as **opaque handles** supplied by the
  server realm, so it needs no encoding and is conformance-tested against Sim today. This is
  ~80% of the library and it is DONE in scaffold form (typechecks strict, conformance green).

- **Tier B — byte-identical.** `codec.ts`, `identity.ts`, and `township.ts`. The substrate now
  exposes `Lattice.Canonical` / `lattice-cbor-v1` bytes, and `npm run canonical` proves TS can
  reproduce BEAM carrier-frame op bytes, hashes, and signatures for W1. `npm run
  township:authoring` proves TS can build the `Township.Matter` command body/cap terms, select a
  matching local delegation cap extracted from carrier frames, derive deps from the local op
  frontier, save/reload local ops and pushable carrier frames through JSON key-value seams, run a
  shell-facing author-and-persist workflow that signs a BEAM-accepted W1 command frame, and route
  storage/signing through a Tauri-style async `invoke` bridge. The honest remaining seam is shell
  integration: native command implementations and app wiring.

Do not try to unblock Tier B by inventing a client-side hash. That reintroduces the exact
cross-runtime divergence plan 010a is about.

## What exists vs what's left

Done (scaffold, verified): `src/op.ts`, `src/dag.ts`, `src/schema.ts`, `src/crdt/reducers.ts`,
`src/quarantine.ts`, `src/materialize.ts`, `src/sync.ts`, `src/carrier.ts`, `src/index.ts`;
the conformance harness + Sim-generated W0, W1/W2 with perspectives, W3, five seeded
randomized vectors, and the C3 carrier W1 vector.

Carrier slice done (plan 021): `npm run carrier:township` proves TS can sign the BEAM carrier
session transcript through an injected signer, decode full BEAM carrier frames, and converge
the W1 carrier-frame merge to the Sim oracle.

Live carrier slice done (plan 022): `npm run carrier:township:live` spawns the BEAM Township
peer, authenticates over WebSocket, pulls/pushes carrier frames through `syncCarrierOnce`, and
checks both TS materialization and the BEAM peer report against the Sim oracle.

Canonical parity slice done (plan 023): `npm run canonical` checks every W1 carrier-frame op
against Sim-exported BEAM canonical bytes from `Lattice.Op.canonical_encoding/1`, including
base64url SHA-256 op ids.

Local verification slice done (plan 024): `npm run canonical` also verifies every W1
carrier-frame Ed25519 signature with real crypto and rejects tampered signatures/bodies.

Authoring primitive slice done (plan 025): `authorCarrierOp` hashes and signs real carrier body/cap
terms through an injected signer and reproduces the W1 resident `post` frame accepted by BEAM.

Township command authoring slice done (plan 026): `src/township.ts` builds command body/cap terms
for every declared `Township.Matter` command, `npm run township:authoring` checks them, and the
live carrier test now pushes a frame authored through `authorTownshipCommand`.

Township cap-selection slice done (plan 027): `selectTownshipCapId` chooses a local delegation by
audience, command op, and required `clerk` role; the authoring test covers resident/clerk cases and
the live carrier test uses the selected W1 resident post cap.

Township frontier-deps slice done (plan 028): `authorTownshipCommandFromLog` derives deps from the
existing TS `frontier(localOps)` helper. The authoring and live carrier tests now reproduce the W1
resident post frame from the local pre-post op set instead of fixture deps.

Local log persistence slice done (plan 029): `createJsonLocalOpLogStore` persists semantic ops via
an injected key-value store. The authoring test saves/reloads the W1 local op set, authors from the
persisted log, and verifies append is idempotent.

Carrier frame outbox slice done (plan 030): `createJsonCarrierFrameStore` persists pushable
`CarrierOpFrame`s via the same key-value seam. The authoring test proves idempotent append and the
live carrier test pushes a frame loaded from the persisted outbox.

Carrier delegation extraction slice done (plan 031): `carrierDelegationsFromFrames` recovers
delegation terms from loaded carrier frames. The authoring test proves W1 cap ids are extracted and
the live carrier test uses those extracted delegations for cap selection before BEAM accepts the
authored post.

Township author-and-persist workflow slice done (plan 032): `authorAndPersistTownshipCommand`
loads semantic ops and carrier frames from injected stores, extracts delegations, selects the cap,
signs the command, appends the semantic op, appends the push frame, and rejects missing-cap
commands. The authoring test checks the persisted store effects and the live carrier test pushes the
workflow-authored resident post to BEAM.

Tauri bridge slice done (plan 033): `CarrierSigner.sign` can now be async for native key custody,
`signCarrierChallenge` awaits that signer, and `tauri_bridge.ts` exposes invoke-backed key-value and
carrier signer adapters. `npm run tauri:bridge` proves the bridge command wiring and uses the Tauri
signer through `authorAndPersistTownshipCommand`.

Native command core slice done (plan 034): `clients/township-tauri-shell/src-tauri` contains the
first Tauri v2 Rust command core for `lattice_kv_get`, `lattice_kv_set`, `lattice_public_key`, and
`lattice_sign_carrier`. `cargo test` proves key-value semantics, missing-key/error handling, and the
same W1 carrier-session Ed25519 public key/signature as the TS bridge.

Left to do (the real work package — see `plans/011-ts-client-realm.md`):
1. Expand the randomized Sim corpus beyond the current N=5 seeded scenarios when a broader
   generator is useful; keep the same vector contract and CI gate.
2. Tier B/E1 shell integration: replace the dev-key helper with secure platform key persistence,
   register the Tauri commands in a builder, and wire an app shell around the authoring functions
   proven in plans 025–034.

## Toolchain (prefer latest)

Latest TypeScript (5.9+), ESM, `moduleResolution: bundler`, full strict incl.
`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Run: `npm run typecheck`,
`npm run conformance`, `npm run canonical`, `npm run township:authoring`, `npm run tauri:bridge`.
Shell signer deps when needed: `@noble/ed25519` (audited, RN/browser/Node) behind `identity.ts`, or
native key custody through `tauri_bridge.ts`.

## Shell consumption (do NOT put UI in this library)

The core stays framework-neutral. The shells import it:
- **Tauri v2 (recommended spine):** Vue 3.5 frontend + Rust core. Key custody and (later)
  the CBOR codec can live in Rust behind IPC; desktop can additionally host a real BEAM
  sidecar realm. One codebase → desktop + iOS + Android.
- **Expo (SDK 56+, RN 0.85, New Arch):** import the same library; key custody via
  expo-secure-store / native keystore module. Phone-only.

Picking the shell is secondary and reversible; this library is the shared, load-bearing part.

## First move

`npm ci && npm run typecheck && npm run conformance && npm run canonical && npm run township:authoring && npm run carrier:township && npm run carrier:township:live` — confirm the generated Sim and carrier vectors are still green. If the oracle changes, regenerate them with `mix lattice.export_vectors --out clients/lattice-client/test/vectors` from the repo root using the local asdf shim rule.
