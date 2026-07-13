# Plan 140: Restore the V-01 guarantee in the TS client (authority semantics + list ordering)

## Status

IN PROGRESS

## Stop-gap already in place (2026-07-13)

A fail-closed guard landed ahead of this plan so the forged-authority inversion cannot be
exploited in the interim. `materialize` now throws `V01UnvalidatedAuthorityError`
(`clients/lattice-client/src/materialize.ts`) when a log writes an authority role beyond its
establishing genesis — i.e. it refuses any transfer/succession it cannot validate rather than
guess a holder. Covered by `clients/lattice-client/test/v01_authority_guard.ts`
(`npm run v01:guard`, wired into flagship CI). The conformance, `carrier`, and `live_carrier`
harnesses now assert this refusal for the three authority-transition scenarios
(`township_carrier_w1`, `township_zoning_variance_24`, `township_succession_w3`) instead of a
state comparison.

**This plan REPLACES the refusal with validated reduction**: as each scenario's real authority
semantics are ported (or the honored-authority pass lands), remove its name from
`REFUSED_PENDING_PLAN_140` in `conformance.ts` and restore the state/quarantine assertions in
`carrier.ts` / `live_carrier.ts`. The stop-gap is not the fix — it converts silent divergence
into a loud refusal; finding 2 (causal-list ordering), 3 (dangling-dep base), and 4 (holder
definitions) are untouched by it and remain this plan's work.

## Execution checkpoint: valid W1 transfer and branch-tip recovery

The first vertical slice is green locally but does not complete this plan:

- The existing Sim-exported `township_carrier_w1` state, quarantine, and winner assertions first
  failed at the blanket second-authority-write refusal. Carrier decoding now retains delegation
  facts, and one shared authority timeline honors the valid clerk transfer only after checking its
  causal holder, current holder, role, parent chain, and attenuation. The direct and live carrier
  gates again compare every W1 state field and authority quarantine against Sim. The zoning and
  succession vectors remain fail-closed.
- Hosted closure run `29250801527` exposed the same blanket-refusal regression at
  `npm run feed:app:contract`. The exact command now passes. Reactive refresh also materializes
  before either store write; a separate RED proved an unsupported authority history previously
  wrote both stores before refusing, and the GREEN leaves both byte-unchanged with zero saves.
- Focused client and shell typechecks, conformance, the fail-closed guard, direct carrier, live
  carrier, and reactive feed gates are green. Exact-diff Claude RED and GREEN reviews returned
  `PROCEED` for this fenced slice.
- This checkpoint makes no general V-01 restoration claim. Claude's GREEN review retains a high
  gate on forged-genesis root commitment and delegation-signature proof, plus missing adversarial
  non-holder/double-transfer coverage. The original checkpoint wording incorrectly said Sim rejects
  a fabricated self-issued non-genesis delegation: Sim accepts that delegation structurally and
  rejects a forged non-holder transfer as `:transfer_not_holder`. The separate bound-root gap was a
  forged *genesis*, which the next checkpoint isolates. Delegation proof, causal-list ordering,
  dangling-dependency height, holder unification, and succession remain below. Plan 140 stays
  `IN PROGRESS`.

## Execution checkpoint: bound-root impostor genesis

The bound-root half of the authority trust anchor is green locally but does not complete this plan:

- A standalone Sim-exported `township_authority_forged_root` adversarial vector binds the replica
  to clerk's public key, then introduces a validly Mallory-signed Mallory genesis. Sim quarantines
  the op as `:impostor_genesis`, leaves `clerk` unassigned, and emits the exact carrier frame and
  realm map needed by the TS public decoder. Exporter guards fail if that oracle behavior changes.
- The conformance harness now decodes any vector carrying `oracleCarrierOps` and `realmByPubkey`.
  Before reduction, this scenario independently proves the carrier op hash/signature and embedded
  delegation hash/signature, so the expected rejection cannot pass because of malformed evidence.
- `analyzeAuthority` checks a `#root:` commitment only for genesis evidence, using exact-pinned
  browser-compatible synchronous SHA-256 over the raw audience key. Legacy unbound replicas and
  self-issued non-genesis delegations retain Sim's behavior; the valid bound W1 genesis remains
  honored. An authority field with no honored write now materializes as JSON-stable `null`, matching
  Sim's `nil`, rather than disappearing as JavaScript `undefined`.
- Regenerating the checked-in corpus changed no pre-existing vector bytes; only the new adversarial
  fixture was added. Focused exporter tests, formatting, and TS conformance are green.
- This slice does **not** introduce an Ed25519 acceptance policy or complete delegation id/signature
  validation in persisted semantic reduction. Plan 140 stays `IN PROGRESS`.

## Execution checkpoint: outer-replica root anchor

The second bound-root tracer bullet is green locally but does not complete this plan:

- A separate Sim-exported `township_authority_embedded_replica_bypass` vector places a validly
  Mallory-signed genesis in an outer clerk-bound op while the embedded delegation names a different
  Mallory-bound replica. Exporter guards prove both signatures and ids are valid, then pin Sim's
  `:impostor_genesis` quarantine and unassigned clerk result. The previous TS path trusted the
  embedded replica and honored Mallory, producing an exact three-assertion RED.
- Carrier decoding now retains the outer frame replica on the semantic `Op`, and genesis root
  eligibility uses that outer commitment. It deliberately does **not** require equality with
  `delegation.replica`: direct oracle probes proved Sim honors a differently named embedded replica
  when both ids commit to the same root key, so an equality rule would create a new V-01 divergence.
- Authority evidence without a retained outer replica fails closed. The field is additive and
  optional for the existing Tier-A vector shape, but authority-bearing semantic JSON persisted
  before this checkpoint must be re-decoded from retained carrier evidence rather than treating the
  embedded replica as a fallback trust anchor.
- Existing corpus bytes remain unchanged; only the new adversarial vector was added. Focused
  exporter tests, conformance, typecheck, the V-01 refusal guard, and canonical parity are green.
  Delegation id/signature proof remains the next trust-anchor work before additional authority
  scenarios leave fail-closed. Plan 140 stays `IN PROGRESS`.

## Priority

**P0 — STOP-condition remediation.** This plan blocks Plan 139 (revocation handoff) and any
further versioned-action or feed work. The build map's prime directive says any divergence
between two implementations of the same reduction is the V-01 drift bug and a STOP condition.
An independent code review on 2026-07-13 confirmed two such divergences by source inspection
and executed counterexamples. They are invisible to the current conformance corpus because it
contains only well-formed, happy-path vectors.

## Findings this plan fixes (evidence)

1. **CRITICAL — TS honors forged authority ops the oracle rejects.**
   `clients/lattice-client/src/carrier.ts:944-987` (`payloadFromBody`) converts **any**
   structurally valid `transfer`/`succeed` into a holder write with no validation that the
   author is the current holder, that the delegation is valid/attenuated, or that it is not a
   double transfer. `clients/lattice-client/src/quarantine.ts:20-52` only ever quarantines
   *gated commands* (`gatedBy` returns null for authority fields), so authority ops are never
   candidates. The Elixir oracle rejects all of these
   (`apps/lattice_core/lib/lattice/authority.ex:528-546` `:transfer_not_holder` /
   `:double_transfer`, `:341-382` delegation-chain validation, `:688-709` cap checks).
   Executed counterexample: genesis(clerk=clerk) + forged transfer authored by a non-holder,
   concurrent with a real clerk command → TS reports the forger as holder and quarantines the
   *legitimate* clerk command; Elixir reports the exact opposite. Reachable via the Plan-128
   relay, which is structural-only by design.

2. **HIGH — `causal_list` ordering drifts under concurrent appends.**
   TS orders appends by position in `canonicalOrder` (Kahn topo sort with ascending-hash
   ready-queue tiebreak, `clients/lattice-client/src/dag.ts:50-88`,
   `crdt/reducers.ts:65-71`). Elixir orders by `{height, op_id}`
   (`apps/lattice_core/lib/lattice/reduce.ex:155-168`,
   `apps/lattice_core/lib/lattice/crdt/causal_list.ex` `entries/1`). These are different
   total orders: for the shape g←m←a plus g←z, TS can emit `a` before `z` (when the hashes
   of m and a sort below z) while `{height,id}` always puts `z` (height 1) before `a`
   (height 2). Reachable with an ordinary partition — two posts on one side, one on the
   other. Current vectors contain only 1–2 appends each, which is the only reason
   conformance passes.

3. **MEDIUM — dangling-dep height base mismatch.** `dag.ts:35-43` gives a dep absent from
   `byId` depth 0 so the op gets depth 1; Elixir `dag.ex:116-126` gives missing deps −1 so
   the op gets height 0. Flips LWW winners on pruned/partial logs.

4. **MEDIUM — three inconsistent "current holder" definitions.**
   `quarantine.ts:54-77` picks max `(depth, hash)` among visible authority writes;
   `materialize.ts:62-68` picks the last authority op in canonical order; the oracle picks
   the last **honored** acquire in canonical order (`authority.ex:755-763`). Unify on the
   oracle's definition.

## Objective

The TS client reproduces `Lattice.Sim`'s materialized state, quarantine set, and canonical
list order on an **adversarial** conformance corpus generated from Sim — including forged
and double transfers, unsound delegations, concurrent-append partition shapes, and
partial/pruned logs — with the existing corpus unchanged and green.

## Why this increment

- The vector harness (`clients/lattice-client/test/conformance.ts`,
  `mix lattice.export_vectors`) is exactly the right mechanism and already runs in CI; the
  gap is corpus coverage, not machinery.
- Plan 058 already built a Sim-generated **unsound-grant** fixture and proved live-BEAM
  `not_attenuated` handling. This plan extends that precedent to unsound
  transfer/succeed shapes so the red test comes first.
- Fixing TS without the adversarial corpus would leave the guarantee resting on code review;
  fixing the corpus without TS changes documents the defect but ships it. TDD order: corpus
  first (red), then TS (green).

## Scope

### Included

- Extend `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (or a sibling task)
  with adversarial vectors: (a) forged transfer by non-holder, (b) double transfer,
  (c) transfer with an unsound/unattenuated delegation (Plan 058 fixture shape),
  (d) ≥3 concurrent appends across a partition in the g←m←a / g←z class,
  (e) a partial-log vector exercising the dangling-dep height base,
  (f) LWW concurrent writes at heights affected by (e).
- TS: implement authority validation for materialization — a transfer/succeed is honored
  only if its author is the current holder at the op's own frontier and its delegation
  passes the same structural checks the codec already performs for cap extraction;
  otherwise the op contributes **no** holder write and gated-command quarantine treats it
  as absent. Matching Sim on the corpus is the contract; the implementation seam is
  `payloadFromBody`/`materialize`/`quarantine` and may introduce a shared
  `honoredAuthority(ops)` pass used by all three (fixing finding 4 by construction).
- TS: switch `causalList` ordering to `{height, op_id}` and fix the dangling-dep base to
  match `dag.ex` (−1 base).
- Regenerate all vectors; the pre-existing named and seeded vectors must be byte-identical
  (no BEAM-side behavior change).

### Explicitly deferred

- Codec acceptance-asymmetry hardening (duplicate map keys, strict base64, bool/int shape,
  big-int precision, pinned Ed25519 profile) — file as its own follow-up plan; it partitions
  accepted-op sets but does not invert state.
- Revocation/succession TS semantics beyond what the corpus requires (Plan 139 territory).
- Any `lattice_core` semantic change. Sim is the oracle; if Sim looks wrong, STOP.

## TDD sequence

1. Restore one existing valid transfer through the real carrier-decoded public seam. Keep every
   other named authority-change conformance scenario fail-closed until its evidence and semantics
   land.
2. Add one Sim-exported adversarial authority scenario at a time: forged non-holder transfer,
   double transfer, then invalid/unattenuated delegation. Each vector must fail before its matching
   authority-pass increment and pass without weakening the fallback refusal.
3. Prove the authority trust anchor in persisted, recomputable slices: the bound-root commitment
   and outer-replica checkpoints above land first; delegation id/signature proof remains before any
   additional scenario leaves fail-closed. Do not add a caller-controlled trust boolean.
4. Add one concurrent-list Sim vector and fix `{height, id}` ordering; then add one partial-log/LWW
   vector and fix the dangling-dependency base. Existing vector files remain byte-identical.
5. Unify every holder lookup on the honored pass, restore each existing scenario's state and
   quarantine assertions only when supported, then run the unchanged direct/live carrier gates.

## Required gates

- `npm run conformance` green including the new adversarial corpus.
- Existing named/seeded vectors regenerate byte-identically.
- `mix test apps/lattice_core/test/township/` unchanged and green.
- Flagship CI green.

## STOP conditions

- If reproducing the oracle requires porting substantially all of `authority.ex` (~800
  lines) rather than a bounded honored-authority pass, STOP and surface the alternative:
  the TS client **fails closed** (refuses to materialize a log containing an authority op
  it cannot validate) — a smaller, honest contract that preserves V-01 by refusal instead
  of divergence. That is a product decision for the human.
- If any existing vector changes bytes, STOP — that means a BEAM-side behavior change.

## Non-claims

- No claim that the TS client implements full delegation-graph analysis, revocation
  timelines, or succession; only that it does not *diverge silently* on the corpus shapes.
- No change to server relay semantics, custody boundaries, or the versioned intent ladder.
- No G1/Phase G completion or receipt-free W4 claim.

## Likely files

- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`
- `apps/lattice_core/test/support/` (unsound-authority fixture helpers, per Plan 058)
- `clients/lattice-client/src/{carrier,quarantine,materialize,dag}.ts`,
  `src/crdt/reducers.ts`
- `clients/lattice-client/test/conformance.ts`, `test/vectors/*.json`

## Completion claim

Complete for this scoped increment when all gates pass; the V-01 guarantee is then defended
by the corpus rather than by review.
