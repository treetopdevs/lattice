# Plan 011 (work-package): TypeScript client realm — the shared spine for Expo & Tauri

> **What this is.** The scoping doc for `@treetopdevs/lattice-client`, a
> framework-agnostic TypeScript Lattice realm. It is the single highest-leverage
> artifact for mobile/desktop because a phone or browser realm is a **JS/TS client
> that speaks the sync protocol, not a BEAM node** — so this one library unblocks
> *both* the Expo (React Native) and Tauri (Vue 3.5) shells. Read alongside
> `010-real-carrier-spike.md` (the carrier it syncs over) and
> `010a-carrier-township-acceptance.md` (the CBOR prerequisite it inherits).
>
> **Drift check (run first):**
> `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/{op,sim,log,replica}.ex`
> The TS reducer mirrors these; if the DSL, mutation set, or Sim surface moved,
> reconcile the mirror before extending it.
>
> **Toolchain:** latest TypeScript (5.9+), ESM, `moduleResolution: bundler`, full
> strict. Elixir side runs via `~/.asdf/shims/mix`.

## Status

- **Priority**: P1 (unblocks all non-BEAM realms; nothing about the app ships without it)
- **Effort**: L (it is a second implementation of the reducer + a sync client)
- **Depends on**: `Lattice.Sim` (the oracle, exists); `010` (the carrier it syncs over,
  for the wire milestone); `010a` / **ADR-P08 CBOR** (hard prerequisite for Tier B only)
- **Category**: client library / cross-track
- **Planned at**: against commit `81b9bfd`

## Why this exists — the relationship in one paragraph

"Build an Expo or Tauri app" decomposes, on inspection, into "finish plan 010a plus write
the client realm in TypeScript." Neither shell can run Elixir in-process on a phone (iOS
forbids spawned sidecars; AtomVM has no iOS/Android target). So the realm on the device is
this TS library, and the shell (Expo or Tauri) is a thin consumer of it. Because the
library re-implements the reduction that `Lattice.Sim` already defines, it is a **second
implementation** — and the program's V-01 rule says two implementations of one predicate
will drift unless pinned. This plan's spine is therefore the conformance harness that makes
**Sim the oracle**: the TS reducer must reproduce Sim's state, quarantine set, and canonical
order for every scenario, in CI.

## The two-tier structure (the load-bearing decision)

Splitting the library into two tiers is what lets it proceed **in parallel** with the CBOR
migration instead of blocking on it:

- **Tier A — semantics.** Reduction is encoding-independent: it needs op ids, deps, kind,
  author, field, mutation, value, and an integer tiebreak — not the canonical bytes. So the
  entire reducer + sync reconciliation is buildable and conformance-tested against Sim **now**,
  with op ids treated as opaque handles the server realm supplies. This is ~80% of the library.
- **Tier B — byte-identical.** Client-side op *authoring* and local verification need the
  canonical hash. The BEAM side now speaks `Lattice.Canonical` / `lattice-cbor-v1`, and
  plan 023 proves TS can reproduce carrier-frame canonical bytes and op ids, and plan 024
  proves local Ed25519 signature verification for received W1 carrier ops. The remaining
  Tier-B work is semantic authoring: build the real body/cap term, sign it, and send a
  BEAM-accepted frame.

This mirrors 010's light-path/heavy-path split: the client can converge against a server
realm (Tier A) long before it can mint its own ops (Tier B).

## What already exists (scaffold, verified)

A working scaffold is in `clients/lattice-client/` — typechecks under full strict mode and passes
conformance on Sim-generated vectors:
- `src/`: `op`, `dag` (ancestors/concurrency/lamport/canonical-order), `schema`,
  `crdt/reducers` (lww/or_set/causal_list), `quarantine` (the ONE V-01 predicate),
  `materialize`, `sync`, `carrier` (Tier-A carrier frame/session adapter), `codec`
  (carrier-frame canonical byte/hash/signature verification; semantic authoring seam still
  throws),
  `identity` (signer interface).
- `test/conformance.ts` + `test/vectors/*.json` — W0, W1/W2 plus mid-partition perspectives,
  W3, five seeded randomized vectors, and the carrier W1 vector generated from the live Sim
  oracle.
- `test/carrier.ts` — validates carrier-session transcript/signature bytes, decodes full BEAM
  carrier frames to semantic ops, and proves the W1 carrier-frame merge materializes to Sim.
- `test/live_carrier.ts` — spawns the BEAM Township peer process and proves the TS client can
  authenticate, pull/push carrier frames, and converge W1 over a real WebSocket.
- `test/canonical.ts` — proves every `township_carrier_w1` carrier op reproduces BEAM
  `Lattice.Op.canonical_encoding/1` bytes, base64url SHA-256 ids, and Ed25519 signatures in
  TypeScript, with tampered signature/body rejection.
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` — the oracle exporter for
  Deliverables 1, 2, C3, and the first D1 parity slice.

## Deliverables

1. **Wire the oracle exporter.** Implement `lattice.export_vectors` `township_scenario/0` +
   `to_vector/2` against the real Sim API (the exact calls from `workflows_test.exs`), so
   vectors are generated, not hand-authored. Add W0 (join), W3 (partition/succession), and
   per-perspective vectors (realm C vs R mid-partition). **Status:** done in plan 019 for
   W0, W1/W2 with clerk/resident perspectives, and W3.
2. **Grow conformance to randomized scenarios.** Reuse the M1 StreamData generators to emit
   N scenarios through Sim; the TS reducer must reproduce all. Wire both into CI (the TS
   `conformance` script + the Elixir export) so drift fails the build. **Status:** done in
   plan 020 for N=5 deterministic seeded Sim scenarios; the corpus exposed and fixed the
   TS OR-set observed-remove drift.
3. **Sync over the real carrier.** Connect `sync.ts` to plan 010's WS server realm and prove a
   TS client realm converges the Township **W1** scenario against a BEAM realm over the wire —
   Tier A, no CBOR needed (ids are opaque). **Status:** done for Tier-A W1 in plans 021–022:
   TS signs/verifies carrier-session bytes through injected key custody, decodes BEAM carrier
   frames, and converges with `LatticeNodeSpike.WsHandler` over a live WebSocket.
4. **Tier B.** Implement the canonical codec, prove it byte-identical to the Elixir encoder
   via a Tier-B vector (canonical bytes + hash per op), then enable client-side op authoring
   (`identity.ts` signer over `codec.ts` bytes) and local verification. **Status:** D1 parity
   is done in plan 023 for all W1 carrier-frame ops, and local signature verification is done
   in plan 024 for received W1 carrier ops. Semantic authoring remains.

## GATE criteria (this work package succeeds iff)

- **Tier A conformance is generated and green:** vectors come from `lattice.export_vectors`
  (Sim), and `npm run conformance` reproduces Sim's state + quarantine + order for every
  scenario, including the current N=5 randomized corpus, in CI.
- **A TS client realm converges over the real carrier:** running Township W1 with one realm
  as the TS client and one as a BEAM realm reaches the same converged `Township.Matter` state
  Sim asserts — the mobile/desktop analogue of 010a's G1. Plans 021–022 satisfy this for
  Tier A W1; client-side op authoring/local verification remain Tier B.
- **The Tier-B seam is honest:** carrier-frame canonical bytes/hash/signature verification is
  proven by `npm run canonical`; semantic client authoring stays formally blocked until TS can
  build the real body/cap term, sign it, and the BEAM side accepts it.

## Scope

**In scope**: the framework-agnostic reducer + sync library, the Sim-oracle exporter and
conformance suite, carrier integration for read/sync, and the Tier-B codec once unblocked.

**Out of scope** (named on purpose):
- **The Expo and Tauri shells themselves.** This library is the shared spine; the shells are
  separate, thin, and reversible. Do not fold Vue or React Native into the core — that couples
  the two shells and breaks the "same artifact both places" property.
- **Receipt-free attestation crypto** (M4) — the client calls the `Attestation` interface; the
  stub stays until M4.
- **Choosing Expo vs Tauri.** Recommendation stands (Tauri v2 as the spine: one Vue codebase
  desktop+mobile, Rust core for key custody/CBOR, optional BEAM sidecar on desktop), but the
  decision is deferred and does not block this library.

## STOP conditions

- The TS reducer cannot reproduce a Sim vector without special-casing → a real semantic gap
  between the two implementations; report it, reconcile the predicate, do not patch the vector.
- Tier A reduction turns out to need canonical bytes after all → the id-as-handle assumption is
  wrong; STOP and re-examine, because it means Tier A is not actually CBOR-independent.
- AtomVM ships a first-class iOS/Android target with distribution → reconsider: a real on-device
  BEAM realm would change this library from "the realm" to "a client of a local realm." (As of
  now AtomVM has distribution but only ESP32/Pico/WASM/Unix targets — so this stays hypothetical.)

## Parallel worktrees

- **Worktree 1 (substrate):** `010` carrier + `010a` CBOR + this plan's exporter (Deliverable 1)
  and Tier-B (Deliverable 4). Owns the Elixir side and the oracle.
- **Worktree 2 (client):** grow the TS reducer/sync + conformance (Deliverables 2–3) against Sim
  vectors — no Elixir changes needed for Tier A.
- **Handshake:** the conformance vectors. Worktree 1 emits them from Sim; worktree 2's library
  must pass them. Same pattern as 010a's Deliverable-3 handshake, one layer up the stack.

## Maintenance notes

- `Lattice.Sim` is the oracle for this library **and** for 010/010a. All three must reproduce
  the simulator; the TS client is never its own source of truth.
- When CBOR lands, `materialize.ts` and the CRDT reducers should need **no change** — only
  `codec.ts` gains a real body. If reduction has to change, the encoding leaked into semantics
  and the `Op` boundary needs revisiting. That non-change is the proof the tiers held.
