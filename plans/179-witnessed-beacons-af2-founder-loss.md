# Plan 179: Witnessed beacons pinned at genesis (AF-2 founder-loss clock)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP conditions"
> section occurs, stop and report; do not improvise.
>
> **This plan is two pull requests, not one.** Step 1 is a code-free documentation PR (S effort)
> that merges on its own, before any work on steps 2 onward begins. It is the Plan 175 step 5
> obligation, whose maintenance note says the non-claim sentence "belongs in `CLAUDE.md` regardless
> of what this spike decides", so it must not wait on an L-effort HIGH-risk build. The
> parity-atomic rule applies to steps 2 onward only: the BEAM change, the TypeScript mirror and the
> regenerated vectors land together in the second PR. Update the status row for this plan in
> `plans/README.md` after each PR.
>
> **Drift check (run first)**. The pathspec is the complete declared scope, corrected in review
> round ci-1: an earlier draft omitted the prospective new certificate module, the conformance
> runner and the compaction GATE test, so a change landing in one of those after the planning base
> would have left the check empty while the executor proceeded on stale assumptions. Review round
> ci-2 added the two TypeScript files that carry the canonical bytes and the authoring path:
> `clients/lattice-client/src/codec.ts`, where every canonical encoder used by
> `canonicalBytesForWitnessedSuccessionClaim` (206-221) is module private, and
> `clients/lattice-client/test/township_authoring.ts`, the gate over `authorTownshipGenesis`.
>
> ```sh
> git diff --stat 8200c38d..HEAD -- \
>   apps/lattice_core/lib/lattice/authority.ex \
>   apps/lattice_core/lib/lattice/authority/beacon_certificate.ex \
>   apps/lattice_core/lib/lattice/authority/succession_certificate.ex \
>   apps/lattice_core/lib/lattice/canonical.ex \
>   apps/lattice_core/lib/lattice/log.ex \
>   apps/lattice_core/lib/lattice/op.ex \
>   apps/lattice_core/lib/lattice/sim.ex \
>   apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex \
>   apps/lattice_core/lib/toolshed/read_model.ex \
>   apps/lattice_core/test/support/compaction_spike.ex \
>   apps/lattice_core/test/lattice2/compaction_spike_test.exs \
>   apps/lattice_core/test/lattice2/lease_lapse_test.exs \
>   apps/lattice_core/test/lattice2/witnessed_succession_test.exs \
>   apps/lattice_core/test/toolshed/read_model_test.exs \
>   clients/lattice-client/src/authority.ts \
>   clients/lattice-client/src/capability.ts \
>   clients/lattice-client/src/carrier.ts \
>   clients/lattice-client/src/codec.ts \
>   clients/lattice-client/src/op.ts \
>   clients/lattice-client/src/township.ts \
>   clients/lattice-client/test/conformance.ts \
>   clients/lattice-client/test/township_authoring.ts \
>   clients/lattice-client/test/vectors
> ```
>
> `apps/lattice_core/lib/lattice/authority/beacon_certificate.ex` does not exist at `8200c38d`; it
> is listed on purpose so that a module claiming that path before this plan starts shows up here
> instead of being discovered mid-build. An empty stat line for it is the expected result. The
> remaining paths are every file whose live behaviour a "Current state" pointer, a STOP condition or
> a done criterion depends on, so the check covers the declared scope rather than a subset of it.
> If any in-scope file changed since this plan was written, reconcile the "Current state" line
> numbers against the live code before writing anything; on a semantic mismatch, treat it as a
> STOP condition. The line numbers below were read at `8200c38d` and are load-bearing only as
> pointers, never as a diff target.

## Status

- **Priority**: P1. This is the only in-bounds path to Plan 177 AF-2, and Plans 158, 177 and 178
  all route the AF-2 decision here.
- **Effort**: S for step 1, which is its own PR; L for steps 2 onward.
- **Risk**: HIGH. A new authority body variant lands in two runtimes, the vector corpus is
  regenerated, and the compaction mirror must move in lockstep.
- **Depends on**: `plans/145-genesis-pinned-witnessed-succession.md` (threshold-certificate
  pattern), `plans/149-delegation-lease-epoch-beacons.html` (beacons, leases),
  `plans/162-authority-root-binding.md` (DONE; its shape guards and its byte-identical succession
  vectors), `plans/177-group-first-antifragile-reaim.md` (AF-2 definition, D1 hosting rule, the
  "no new op kinds" non-goal), `plans/178-treehouse-contract-correction.md` (the frozen contract
  sentence this plan may not edit), and the spike verdict in
  `docs/research/succession_tick_provenance.md`.
- **Category**: security / direction.
- **Planned at**: `origin/main` `8200c38d`, 2026-09-03, from the Plan 175 spike conclusion.
- **Lands with**: PR 1 is step 1 alone (`CLAUDE.md`, `README.md`, and at most the
  `Township.Matter` moduledoc). PR 2 is `apps/lattice_core/lib/lattice/authority.ex`,
  `apps/lattice_core/lib/lattice/authority/beacon_certificate.ex`,
  `apps/lattice_core/lib/lattice/log.ex`
  (`known_dump_policy_atoms/0` only), `apps/lattice_core/lib/lattice/sim.ex`, the vector exporter
  and its regenerated output, `clients/lattice-client/src/{authority,carrier,op,township}.ts`,
  `clients/lattice-client/test/conformance.ts`, new BEAM tests, the compaction mirror, and the two
  claim-boundary documents `docs/adr/0004-succession-validation.md` and
  `docs/lattice_poc_status.md`.

## Objective

Build the decision-4 outcome of the Plan 175 spike
(`docs/research/succession_tick_provenance.md` sections 6.6, 8, 8.1, 8.2, 9 and 11): a witness set
with a threshold pinned at genesis that may emit epoch beacons after the founder's root key is
gone, so that Plan 177 AF-2 ("admit a member, revoke a delegation, advance the beacon" after
founder loss) can be tested in `Lattice.Sim` and mirrored byte-for-byte in both runtimes. Nothing
about founder loss may be claimed until that test is green and merged. Root-only beacons remain the
default. Delegated single-key beacon power is rejected. The witnessed branch carries two bounds, a
genesis-pinned per-step bound (`max_epoch_step`, a policy field) and an absolute epoch horizon (a
fixed protocol constant in both runtimes, never a policy field), because epoch advancement lapses
leases and an unbounded jump to the canonical ceiling is a permanent mass revocation plus a
permanently stopped clock (spike sections 6.6 and 8.1).

Two limits on what AF-2 can prove, stated up front so no step reads as more than it is. First,
AF-2's "revoke a delegation" clause covers only delegations whose issuer survives:
`revoke_authorized?/4` honors a revoke from the issuer or the replica root and nobody else, so
every founder-issued delegation is irrevocable once the founder realm is gone, and the only exit is
a witnessed epoch past its `expires_epoch`, which exists only if the grant was leased. Step 2c
proves the narrowing with a negative control instead of implying the general clause. Second, this
plan does not bound what a witness-succeeded holder may grant itself: `decide_succeed/8` checks the
successor's identity and role, never the `ops` on the root-less delegation the successor
self-issues. That is succession semantics, out of scope here and under Plan 162's byte-identical
STOP, and it is recorded as the next open gate (spike section 8.3).

**What "pinned at genesis" means here**, corrected in review round ci-2 against the live policy
fold. It means the beacon policy is conferred only by a genesis op authored by the replica root,
which `collect_policies/3` (`authority.ex` 492-507) already lets the root reissue: that fold
`Map.merge`s the policies of **every** valid root-authored genesis in topo order, so a later valid
root genesis may add or replace `:__beacon__`. It does not mean the first genesis wins. The bound
that matters is who, not when: no witness, holder or member can ever change the policy, and once
the founder realm is gone no root key exists to author another genesis, so after founder loss the
policy is frozen in fact. Step 2a makes that rule explicit and tests it rather than leaving a
contradiction between the plan's prose and the fold both runtimes implement.

Decision 1 of the spike is settled as option D: the legacy self-asserted succession tick stays
frozen and characterized. **This plan must not touch the dormancy arithmetic.** Its only
succession-adjacent work is the documentation in step 1.

## Why

- Plan 177 AF-2 fails by design today. `docs/research/succession_tick_provenance.md` section 6.5
  reproduces it: a non-root beacon is `:unauthorized_beacon` on every replica, a root beacon is
  honored, a repeated epoch is `:stale_beacon`. When the root key is gone the epoch stops
  advancing, so leases (Plan 149) can never lapse and no beacon-bound mechanism can ever fire.
- The spike found that every candidate repair of the legacy tick (its options A, B and C) makes
  succession fail closed in exactly the founder-loss case succession exists for, because they all
  bind succession to a clock only the root can advance. So the emitter question has to be answered
  before any clock question, whichever way decision 1 is eventually settled.
- A witness set pinned at genesis is inside the beta boundary. The root key stays dead, nothing is
  re-signed, no root-equivalent authority is minted after loss, no new op kind is introduced (same
  `:authority` kind, new body), and one replica's genesis witness set is not federation. It is
  also the governance shape Treehouse already pins for succession
  (`plans/158-real-device-beta-poc-program-map.md` "Treehouse Domain and Cross-Runtime Parity"),
  so it composes with the frozen contract instead of widening it.
- Delegated root powers through a capability were considered and rejected: a single delegated
  beacon key becomes the clock and must itself be witness-succeeded, so it is a strictly more
  fragile version of the witness set.

## Current state

Read at `8200c38d`. Every pointer below was re-verified by the Plan 175 spike; see
`docs/research/succession_tick_provenance.md` section 4 for the reconciliation table.

### BEAM (`apps/lattice_core/lib/lattice/authority.ex`)

- `collect_beacons/3` at 719-732 folds ops in topo order, matching only
  `%Op{kind: :authority, body: {:beacon, epoch}}`, and returns `{[%{op_id, epoch}], quarantine}`.
- `classify_beacon/6` at 734-748 is the whole policy: `op.author != root` gives
  `:unauthorized_beacon`, a non-monotonic epoch relative to the op's own causal ancestry gives
  `:stale_beacon`, otherwise the beacon is valid. `valid_epoch?/2` is at 750-751.
- `collect_beacons/3` has **two** callers, not one. `analyze/2` computes `{beacons, beacon_q}` at
  313 and passes beacons only into `cap_ok/9` (1123-1179, consumed at the `expired_as_of?` clause
  at 1169; `expired_as_of?/5` at 1238-1248). The second is the live-path `expired?/2` at 254-277,
  which calls `collect_beacons(ordered, ancestors, root)` at 264 and never calls
  `collect_policies/3` at all. It is production-consumed: `apps/lattice_core/lib/toolshed/read_model.ex`
  line 90 computes `overdue?: borrow_cap != nil and Authority.expired?(log, borrow_cap.id)`, and
  `apps/lattice_core/test/toolshed/read_model_test.exs` line 73 pins it. Threading the beacon
  policy through `analyze/2` alone would ship an internal BEAM divergence in which a witnessed
  beacon lapses a lease through `analyze/2` while `expired?/2` still reports `false`, with the
  Toolshed "overdue is computed, not asserted" test green and wrong. Step 3 changes both.
  `build_role_timeline/6` (762-805) is called at 322-324 without beacons, and
  `decide_transfer` (871), `decide_succeed` (892), `decide_succession_proof/7` (913-920),
  `decide_heartbeat` (964) and `last_active_from/3` (988-994) take no beacons. That separation is
  what keeps this plan clear of decision 1.
- `valid_tick?/1` at 466-468 and `role_event/3` at 815-844 are Plan 162's shape guards. Untouched
  here.
- The witnessed succession precedent is
  `apps/lattice_core/lib/lattice/authority/succession_certificate.ex` plus the
  `%{mode: :witnessed, version: 1, witnesses: [...], threshold: n}` genesis policy shape, whose
  fail-closed cases (duplicate witnesses, threshold greater than the witness count, an unpinned
  signer, a non-canonically ordered **certificate signature list**, a corrupted signature) are
  already pinned by `apps/lattice_core/test/lattice2/witnessed_succession_test.exs` lines 88-135.
  Note what is *not* in that list: the **policy's** witness list is normalized, not rejected, on
  non-canonical order. `normalize_policy/1` returns `{:ok, %{policy | witnesses: Enum.sort(witnesses)}}`
  (`succession_certificate.ex` 52), so a reordered witness list is the same policy with the same
  policy id. Step 2a follows the same split for beacons.

### TypeScript (`clients/lattice-client/src`)

- `authority.ts` `collectBeacons` at 1339-1380 mirrors `collect_beacons/3` exactly, including the
  root-author rule and the ancestry-scoped monotonicity. Its `validBeacons` output is consumed
  only by `capability.ts` line 130 (lease lapse).
- `authority.ts` `verifyWitnessedSuccessionCertificate` at 830 is the certificate-verification
  mirror to reuse.
- Policy **decoder**: `carrier.ts` near 1684-1693, inside `successionPolicies` 1667-1690, which
  `continue`s past any entry lacking a 32-byte `successor`.
- Policy **encoder**, corrected in review round ci-2: `township.ts` near 392 is not a decoder. It is
  the body of `townshipGenesisPoliciesTerm` (381-397), the production genesis-policy encoder, which
  emits exactly `successor` and `dormant_ticks` per role; `townshipGenesisBody` (112-118) calls it
  and `authorTownshipGenesis` (210) is the public authoring entry point the Tauri and Expo shells
  use. Its `TownshipGenesisPolicy` type (40-43) declares only `successorPubkey` and `dormantTicks`.
  Teaching the decoder alone would let TypeScript replay a BEAM-authored beacon policy while still
  making it impossible for a TypeScript client to create a replica carrying one, which is a
  one-directional parity that BEAM-generated conformance vectors cannot detect. Step 6 changes the
  type, the encoder and `clients/lattice-client/test/township_authoring.ts` (run by
  `npm --prefix clients/lattice-client run township:authoring`), which is the only gate over the
  authoring path.
- Canonical bytes: `codec.ts`. `canonicalBytesForWitnessedSuccessionClaim` (206-221) hard-codes the
  succession separator `witnessedSuccessionClaimDomain` (line 95) and the seven-field succession
  claim, and every encoder it composes (`encodeArray` 330, `encodeCanonicalMap` 318, `encodeAtom`
  334, `encodeBinaryString` 338, `encodeBytes` 342, `encodeUint` 346) is module private, exported
  from nothing. So the five-field beacon claim cannot be encoded from `authority.ts` without either
  editing `codec.ts` or duplicating canonical encoding, and the duplicate is exactly the BEAM and
  TypeScript signature divergence this plan names a STOP. `codec.ts` is in scope for step 6.
- Beacon body decode: `carrier.ts` 1500-1511, producing the `op.ts` line 124 `AuthorityEvidence`
  arm `| { type: "beacon"; epoch: number | null };`. A non-safe-integer epoch decodes to `null` on
  purpose so the reducer can still reach `:stale_beacon`.

### Dump vocabulary (`apps/lattice_core/lib/lattice/log.ex`)

`restore/1` (241-251) calls `ensure_dump_vocabulary/0` and then
`:erlang.binary_to_term(bin, [:safe])`, which refuses any atom the running VM has not interned.
`known_dump_policy_atoms/0` (276-302) is the literal list that keeps a fresh VM able to decode a
dump, and it currently holds exactly the Plan 145 certificate atoms: `:claim`, `:signatures`,
`:witness`, `:signature`, `:holder`, `:holder_epoch`, `:policy_id`, `:role`, `:replica`, `:mode`,
`:witnessed`, `:recovery`, `:witnesses`, `:threshold`, `:successor`, `:version`, `:dormant_ticks`,
`:beacon`, plus the four op kinds. There is no `:epoch` and no prior-binding atom.

### Sim and compaction

- `sim.ex` `beacon/3` at 161-163 appends `{:beacon, epoch}` as an `:authority` op from the named
  realm. Succession proof generation is at 316-350 and is the model for building a certificate
  inside the harness.
- **The beacon policy cannot be constructed through `Sim` today.** `create_replica/3` (66-71) maps
  every value of its `policies:` option through `resolve_policy/2`, whose three clauses (264-314)
  all pattern match on a `:successor` key: `%{successor, dormant_ticks, recovery}`,
  `%{successor, dormant_ticks}` and `%{successor, recovery}`. There is no catch-all and no reserved
  beacon clause, so `policies: %{__beacon__: %{mode: :witnessed, ...}}` raises `FunctionClauseError`
  before any authority code runs. Every RED assertion in step 2 and the AF-2 scenario in 2c depend
  on this construction path existing, so adding it is in scope and is proved by its own test, not
  assumed.
- `apps/lattice_core/test/support/compaction_spike.ex` mirrors the authority fold; its
  `last_active_tick` seeding is at 205-222 and `seeded_succession_proof` at 538-544. Beacons must
  flow through the compaction mirror under the same rule, but **the GATE as it stands cannot detect
  a failure to do so**, corrected in review round ci-2: neither `compaction_spike.ex` nor
  `apps/lattice_core/test/lattice2/compaction_spike_test.exs` contains the string `beacon`,
  `lease` or `expires_epoch` anywhere, and the GATE at `compaction_spike_test.exs` line 121 covers
  only transfer, stale holder, revocation and succession straddles. An implementation whose
  compacted reducer silently drops witnessed-beacon evidence therefore passes the required gate
  today while disagreeing with full replay for leased commands. Step 7 extends the scenario rather
  than assuming the gate already bites.

### Existing logs that carry no beacon

Every replica whose genesis carries no beacon policy keeps today's behavior exactly: beacons are
honored from the replica root and from nobody else, and a replica with no beacon at all has no
epoch, so nothing that depends on an epoch (Plan 149 lease lapse) ever fires. Adding this plan
changes no verdict on such a log, which is why the whole existing vector corpus must regenerate
byte-identically (step 5).

## Scope

**In scope** (the only files this plan may modify):

- `apps/lattice_core/lib/lattice/authority.ex`
- `apps/lattice_core/lib/lattice/authority/beacon_certificate.ex`, a **new sibling module**. The
  reuse branch an earlier draft offered is deleted, because it is not implementable:
  `succession_certificate.ex` `normalize_policy/1` hard-guards
  `%{mode: :witnessed, version: @version, witnesses: ..., threshold: ...} = policy when map_size(policy) == 4`,
  and its `@type claim` is `%{version, replica, role, holder, holder_epoch, successor, policy_id}`.
  The beacon policy carries five keys (step 2a) and the beacon claim is
  `(version, replica, epoch, author, deps)` (step 3), so neither the normalizer nor the claim can be
  reused. What is shared is the **shape**, copied not called: `Canonical`-encoded, domain-separated
  claim hashing in the style of `signing_payload/1`, Ed25519 verification, and threshold and
  duplicate-signer counting. What is duplicated is policy normalization and the claim struct. The
  new module carries its own two separators, pinned here so the executor does not choose:
  `"lattice-beacon-witness-v1"` for the claim and `"lattice-beacon-policy-v1"` for the policy id,
  distinct from the existing `"lattice-succession-witness-v1"` and `"lattice-recovery-policy-v1"`.
  A certificate accepted for both purposes is a STOP.
- `apps/lattice_core/lib/lattice/log.ex`, `known_dump_policy_atoms/0` only (276-302). That literal
  list is the `:safe` restore vocabulary: `restore/1` (241-251) calls `ensure_dump_vocabulary/0`
  then `:erlang.binary_to_term(bin, [:safe])`, which refuses any atom the VM has not interned. The
  list today contains exactly the Plan 145 certificate atoms and no `:epoch`, so a dump of a log
  holding a witnessed beacon fails `:unsafe_dump` on a freshly booted VM unless every new policy
  and certificate atom is added here. Township W3 (`workflows_test.exs` 244) is a dump and restore
  and `township_succession_w3.json` must stay byte-identical, so missing this surfaces as a late,
  confusing failure rather than a design signal.
- `apps/lattice_core/lib/lattice/sim.ex`: a `witnesses:` option on `beacon/3`, **and** a
  `resolve_policy/2` clause plus whatever `create_replica/3` needs so a reserved `:__beacon__`
  policy can actually be built. The existing three clauses all require `:successor` and there is no
  catch-all, so without this the harness raises before any RED assertion can run. Keep the three
  existing clauses byte-identical in behaviour: the new clause matches the reserved key's value
  shape only, and resolves witness realm names to public keys the way the recovery clauses do.
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (new scenarios only)
- `clients/lattice-client/test/vectors/*.json` (regenerated output, never hand-edited)
- `clients/lattice-client/src/authority.ts`, `carrier.ts`, `township.ts`, and
  `clients/lattice-client/src/op.ts`. `op.ts` line 124 declares the `AuthorityEvidence` beacon arm
  as `| { type: "beacon"; epoch: number | null };`, and `carrier.ts` 1500-1511 is the decoder that
  builds it. A witnessed beacon body carries a certificate, so both must change. The directly
  analogous Plan 145 lists `op.ts` in its Expected Files for the same reason; omitting it here
  would make an executor hit a false STOP against the "no modified file outside the In-scope list"
  done criterion.
- `clients/lattice-client/src/codec.ts`, added in review round ci-2, for **one** new exported
  function beside `canonicalBytesForWitnessedSuccessionClaim` (206-221): the beacon-claim canonical
  bytes, under the `"lattice-beacon-witness-v1"` separator, over the five-field claim
  `(version, replica, epoch, author, deps)`. It is required, not optional. The existing function
  hard-codes the succession separator (`witnessedSuccessionClaimDomain`, line 95) and the
  seven-field claim, and every canonical encoder it composes (`encodeArray`, `encodeCanonicalMap`,
  `encodeAtom`, `encodeBinaryString`, `encodeBytes`, `encodeUint`, 318-350) is module private, so
  without this the executor must either violate the in-scope list or reimplement canonical encoding
  inside `authority.ts`. The second is the BEAM and TypeScript divergence this plan names a STOP,
  and it would be invisible until a signature failed. Do not generalize the existing function to
  take a separator and a field list; add a sibling, so a certificate can never be encoded for both
  purposes by passing a different argument.
- `clients/lattice-client/test/conformance.ts` and
  `clients/lattice-client/test/township_authoring.ts` (the authoring gate, run by
  `npm --prefix clients/lattice-client run township:authoring`)
- `clients/lattice-client/dist/**` (regenerated by `npm run build`, never hand-edited)
- new tests: a beacon policy and witnessed-beacon suite, and the AF-2 founder-loss Sim test, under
  `apps/lattice_core/test/lattice2/` or `apps/lattice_core/test/treehouse/`
- `apps/lattice_core/test/support/compaction_spike.ex` and
  `apps/lattice_core/test/lattice2/compaction_spike_test.exs` (parity only)
- `CLAUDE.md` and `README.md` (step 1, the one non-claim sentence)
- `apps/lattice_core/lib/township/matter.ex` moduledoc only, if step 1c takes the relabel branch
- `docs/adr/0004-succession-validation.md` and `docs/lattice_poc_status.md`, as a post-GREEN
  documentation step mirroring `plans/145-genesis-pinned-witnessed-succession.md` "GREEN 4 -
  claim-boundary documents", which requires both when the governance authorization model changes.
  A second beacon emitter is that class of change: ADR 0004 today records root-signed beacons as
  the only admissible clock, and `docs/lattice_poc_status.md` 221-229 carries the
  untrusted-provenance label this plan's spike cites. `TOWNSHIP_BUILD_MAP.md` is deliberately
  excluded even though Plan 145 lists it, because its rows are pinned by `audit_bundle_test.exs`
  and `read_model_test.exs`.
- `plans/README.md` (status row), `plans/158-real-device-beta-poc-program-map.md` and
  `plans/177-group-first-antifragile-reaim.md` (appended status lines only)

**Out of scope** (do not touch, even though they look related):

- `apps/lattice_core/lib/lattice/canonical.ex`. The uint64 integer bound and the encoding are
  frozen; this is a Plan 175 STOP condition inherited verbatim.
- The dormancy arithmetic: `decide_succession_proof/7` (913-920), `last_active_from/3` (988-994),
  `decide_transfer` (871), `decide_succeed` (892), `decide_heartbeat` (964),
  `build_role_timeline/6` (762-805) as a tick consumer, and the dormancy comparison in
  `compaction_spike.ex` 538-544. Decision 1 is settled as option D.
- `apps/lattice_core/test/treehouse/contract_test.exs` and the Plan 178 founder-loss sentence.
  This plan does not edit that sentence; a later Plan 178-style slice does, and only after this
  plan is green and merged.
- `TOWNSHIP_BUILD_MAP.md` rows pinned by `apps/lattice_core/test/township/audit_bundle_test.exs`
  and `apps/lattice_core/test/township/read_model_test.exs`.
- `Lattice.Attestation` and `Township.Election`, frozen per `CLAUDE.md`.
- `apps/lattice_carrier_server/**`. The carrier is transport-only and must not decide semantic
  authority; a beacon is semantic and is judged in `authority.ex`.

## Non-goals

Everything in the `CLAUDE.md` boundary, and specifically:

- No key rotation, recovery, re-keying of genesis, re-signing of any existing artifact, and no
  witness-minted top-level grant. A dead root key stays dead. That is M3 and stays excluded.
  "Re-keying of genesis" means changing which key is the root; a further genesis op authored by the
  same live root is not that, and the existing fold already accepts one (see the witness-rotation
  bullet below).
  "Top-level grants pinned at genesis" means grants issued at genesis, never grants a witness set
  issues later.
- No federation, cross-town identity or universal tally (M6). A witness set inside one replica's
  genesis is not a cross-replica witness set.
- No production compaction. The compaction mirror is touched for parity only.
- No coercion resistance. `Lattice.Attestation.Stub` stays frozen and false.
- No change to `Lattice.Canonical`'s integer bound.
- No new op kinds. The witnessed beacon is a new body of the existing `:authority` kind.
- No epoch-based dormancy, no `dormant_epochs` policy, and no beacon input to the role timeline.
  Those are the spike's recorded but deferred policy-gated option B.
- No witness rotation mechanism, and no beacon frequency requirement. Stated precisely, corrected
  in review round ci-2: this plan adds no way for a witness, a holder or a member to change the
  witness set, and it adds nothing at all to the genesis policy fold. It does not forbid what that
  fold already does, because it cannot without diverging from it in two runtimes: a later genesis
  authored by the replica root may add or replace `:__beacon__` through `collect_policies/3`
  (`authority.ex` 492-507), exactly as it may replace a succession policy today. That is a root
  power under the root's existing genesis authority, not a rotation ceremony and not M3 re-keying:
  the root key is unchanged, nothing is re-signed, and once the founder key is gone no genesis can
  be authored at all. Step 2a permits and tests it.

  Separately, on what a beacon itself confers. It confers epoch advancement, and it confers no
  operation authority and no role. It is **not** true that epoch
  advancement carries nothing else, and an earlier draft of this plan said so: epoch advancement is
  the sole driver of Plan 149 lease lapse in both runtimes (`authority.ex` `expired_as_of?/5`
  1238-1248, consumed by `cap_ok/9` at 1169; `capability.ts` line 130), so whoever may advance the
  epoch may expire every expiring delegation on the replica. Today only the replica root can, and
  the root already holds issuer-side revocation, so nothing is widened. This plan widens it: a
  threshold subset of the pinned witnesses gains mass lease revocation, and
  `docs/research/succession_tick_provenance.md` section 6.6 reproduces the worst case, one beacon
  at `2^64-1` that lapses every expiring lease, makes every later lease dead on arrival unless it
  expires at exactly the ceiling, and renders `:stale_beacon` every subsequent beacon that carries it
  in ancestry, because `2^64` cannot be authored. Read that scope exactly: spike section 6.8
  reproduces a beacon on deps that fork from before the high one still being honored, so the lockout
  is descendant scoped rather than replica wide, on the witnessed branch as well as the root one. Step 3 must therefore carry **both** bounds, the
  genesis-pinned per-step `max_epoch_step` policy field and the absolute `2^53-1` horizon that is a
  fixed protocol constant rather than a policy field, and any product surface describing
  the witness set must say in the same sentence as the grant that a threshold of witnesses can
  expire leased delegations. Neither bound removes that power inside the step; they bound its reach
  and keep the canonical ceiling out of the witnessed branch.
- No revocation of founder-issued delegations after founder loss. `revoke_authorized?/4` honors a
  revoke only from the delegation issuer or the replica root, so once the founder realm is gone
  every delegation it issued is permanently irrevocable and the only exit is a witnessed epoch past
  its `expires_epoch`, which exists only for a leased grant. AF-2's revoke clause is proved here
  for delegations whose issuer survives, and step 2c's negative control pins the narrowing. A group
  wanting post-loss removal of a founder-granted member must lease every founder-issued grant at
  genesis. If that is unacceptable for the beta it is the next open gate, not something this plan
  closes.
- No bound on what a witness-succeeded holder grants itself. `decide_succeed/8` checks the
  successor's identity and role and never inspects the `ops` on the root-less delegation the
  successor self-issues, so genesis bounds who may succeed, not what the successor may do. Fixing
  that is succession semantics, out of scope here and under Plan 162's byte-identical-vector STOP.
  It is recorded as an open gate in `docs/research/succession_tick_provenance.md` section 8.3.
- No delegated single-key beacon power.
- No server push, no participant custody change and no hosting change. If any sentence written by
  this plan names a member-operated relay or a witness device that serves the log, that sentence
  must name who can read (the device, its OS and administrator, its backups and every admitted
  transport peer) and who can withhold availability (the host), per Plan 177 D1.

## STOP conditions

Stop and report back if:

- Any diff appears in `Lattice.Canonical`'s integer bound or encoding.
- Any byte changes in `township_succession_w3.json`, `township_succession_unproven_tick.json`,
  `township_succession_witnessed_recovery.json`, `township_beacon_unauthorized.json`,
  `township_lease_valid_causal.json`, `township_lease_expired.json`,
  `township_lease_expired_chain.json`, `township_lease_renewed.json`, or in any other pre-existing
  vector.
- Any edit lands in the dormancy arithmetic or the role timeline fold as listed in "Out of scope".
- Any mechanism mints root-equivalent authority after loss by issuing to a third party: a
  witness-issued top-level grant to someone other than a genesis-named successor, a re-signed
  genesis, or a certificate that is accepted both as a beacon certificate and as a succession
  certificate. Witnessed succession's existing root-less self-issue to the genesis-named successor
  is Plan 145 behaviour and is not this condition.
- The certificate claim omits `deps` or `author`, or the phrase "the prior valid beacon op id" or a
  `(replica, epoch)`-only claim appears in the diff. Step 3 pins the binding and spike section 8.2
  records the lifted-certificate attack that a weaker binding opens.
- A same-author, same-deps, same-epoch duplicate beacon turns out to change the lapse set or the
  materialized state on any replica. Step 3 documents that duplication as permitted and inert; if it
  is not inert, the binding is wrong and needs re-pinning, not a tie-break chosen in code.
- Any replica module in the tree declares a role named `:__beacon__`, or the beacon policy is
  validated against anything other than its own five-key shape. Step 2a deletes the schema-dependent
  collision rule precisely because `expired?/2` has no schema context, and reintroducing one puts the
  two beacon consumers back out of step.
- A beacon policy validates with a `max_epoch_step` outside `1..65_535`, or a witnessed epoch above
  `9_007_199_254_740_991` is honored in either runtime. Either makes the bound vacuous and puts the
  canonical ceiling back in reach of one threshold subset.
- BEAM and TypeScript diverge: `npm run conformance` fails, or a reason atom is spelled
  differently in the two runtimes.
- Any doc, plan, one-pager or UI sentence claims founder loss is survived, or claims "nothing
  hosted", "serverless", E2EE, guaranteed availability or safe unbounded history, before the AF-2
  test of step 2c is green and merged. Plan 178's pinned sentence stays true until then.
- Any private key, seed or capability secret appears in a doc, fixture, vector or test output.
- Any em-dash appears in a Markdown file this plan writes.
- A witness policy turns out to require a change to the genesis policy encoding that is not
  backward compatible with every existing vector. Report the encoding rather than regenerating.
- The epoch bound turns out to be unimplementable in the genesis policy layer, or the only way to
  bound it appears to be a change to `Lattice.Canonical`. Report it; the canonical bound is a Plan
  175 STOP condition inherited verbatim.
- The step 2d partition and heal case produces different quarantine sets or different materialized
  state on two replicas. That is the G2 property failing and it means the prior binding is not
  deterministic; stop and re-pin it rather than choosing a tie-break in code.

## Steps

### Step 0: Drift check and reconciliation

Run the drift check above. Re-read the "Current state" pointers against the live tree
(`authority.ex` 466-468, 719-751, 762-805, 815-844, 871, 892, 913-920, 964, 988-994, 1123-1179,
1238-1248; `log.ex` 241-251 and 276-302; `authority.ts` 466-487, 637-723, 830, 1339-1380;
`capability.ts` 130; `carrier.ts` 1500-1511 and 1684-1693; `op.ts` 124;
`compaction_spike.ex` 205-222 and 538-544; `sim.ex` 66-71, 161-163 and 316-350). Record any shift
in your report. A moved line is fine; a changed rule is a STOP.

### Step 1: Documentation, code free, first

This is the spike's option-D obligation. It is **its own S-effort pull request**, merged before
work on step 2 begins, so the honest sentence is in the tree whatever happens to the build. Do not
fold it into the parity-atomic PR: Plan 175's maintenance note requires the sentence regardless of
the spike's decision, and gating it behind an L/HIGH build would be exactly the hostage-taking the
"much smaller documentation plan" branch of Plan 175 step 5 was written to avoid.

1a. Add to `CLAUDE.md` beside the Replica DSL line (currently line 160) and to `README.md` the
sentence: "`after: {:dormant_ticks, n}` means a designated successor may claim the role once it
asserts a sufficiently large tick, not a time-based control".

1b. Do not touch `TOWNSHIP_BUILD_MAP.md`. Its rows are pinned by `audit_bundle_test.exs` and
`read_model_test.exs`.

1c. Reconsider `apps/lattice_core/lib/township/matter.ex` line 66
(`succession(:clerk, to: "realm:successor", after: {:dormant_ticks, 3})`). Take exactly one
branch and say which in the PR:

- relabel it decorative in the module doc (the moduledoc at line 31 already says the default "only
  documents intent"), or
- defer moving it to a witnessed shape to a later Township plan.

Either way the doc must state plainly that under this configuration a holder can pin
`last_active` at `2^64-1`, that every encodable succession tick then quarantines
`:premature_succession`, that `2^64` cannot be authored at all, and that the lockout is therefore
reachable and unrecoverable through the legacy path for the life of the replica; the only exits
are a voluntary transfer by the pinning holder or a new replica. See
`docs/research/succession_tick_provenance.md` section 6.2 for the reproduction.

1d. Run the prose-pinning suites (`audit_bundle_test.exs`, `read_model_test.exs`,
`treehouse/contract_test.exs`) and confirm they are green and unchanged.

### Step 2 (RED): Failing oracle probes

**The witnessed beacon body, pinned here and not chosen by the executor.** It is the three-element
tuple `{:beacon, epoch, certificate}`, a new body of the existing `:authority` kind. The root body
stays the two-element `{:beacon, epoch}` verbatim, so every existing beacon and lease vector keeps
its bytes, and `epoch` stays at `body.values[1]` for the TypeScript decoder (`carrier.ts`
1500-1511), with the certificate arriving at `body.values[2]`.

**What the RED commit may contain, so this step is executable.** Every case below needs a witnessed
beacon op to exist, and today nothing can author one: `Sim.beacon/3` (`sim.ex` 161-163) takes no
`witnesses:` option, and `Sim.create_replica/3` cannot even build the policy (see Current state).
So the RED commit lands the **authoring** half: the `Sim.beacon/4` `witnesses:` path, the
`resolve_policy/2` clause for the reserved key, and the test-side certificate assembly. It changes
nothing in `authority.ex`, `authority.ts` or the compaction mirror. Step 4 keeps only the harness
cleanup, and step 3 is where the judge changes. Do not attempt to write these assertions before
landing the authoring half; that ordering is what made an earlier draft of this step unrunnable.

**What RED evidence actually looks like, corrected in review round ci-1.** An earlier draft said
RED evidence is "the judge returning `:unauthorized_beacon` for a certificate valid at or above
threshold". That verdict is not producible without changing `authority.ex`, so the assertion would
have been unrunnable. `collect_beacons/3` (`authority.ex` 719-732) matches exactly one body,
`%Op{kind: :authority, body: {:beacon, epoch}}`, and sends everything else to its `_ ->` catch-all,
which returns the accumulator untouched. A three-element beacon body therefore reaches
`classify_beacon/6` never, so the root-author check is never evaluated and the op gets **no beacon
verdict at all**: not honored, and not quarantined either.

So the RED assertion is the weaker, producible one: the witnessed beacon is **not honored**. Assert
the epoch does not advance, that a lease whose `expires_epoch` sits below the witnessed epoch does
not lapse through `analyze/2` or through `Authority.expired?/2`, and that the carrying op holds no
beacon reason. Do not assert a reason atom in RED.

The reason atom is a **step 3 requirement**, not RED evidence, and the difference is the point of
the step: today a witnessed body is silently ignored, and after step 3 the same op under an absent
or invalid policy must carry the explicit `:unauthorized_beacon` verdict. Silence and an explicit
rejection are the same materialized state and a different audit trail, and the second is what this
plan is buying. Every verdict named in 2a through 2d is a post-step-3 expectation; in the RED commit
each of those assertions fails because the body carries no verdict at all, and that failure output
is the RED evidence to keep.

2a. Beacon policy validation.

**Where the policy lives, pinned here so the RED assertions can be written.** The genesis policies
map is role keyed: `collect_policies/3` (`authority.ex` 492-507) blindly `Map.merge`s each valid
genesis `policies` map, every consumer reads it by role (`build_role_timeline/6` at 762 is called
once per member of `all_roles/1` at 1332-1340), and `carrier.ts` `successionPolicies` 1667-1690
silently `continue`s past any entry without a 32-byte `successor`. A beacon entry dropped in beside
the roles would therefore be inert on the BEAM and invisible in TypeScript, which is the
conformance divergence this plan names a STOP. So the beacon policy goes under one **reserved
non-role key**, fixed in this plan and not chosen by the executor: `:__beacon__`. Both runtimes
decode the reserved key explicitly, before the role loop, never through `successionPolicies`.

**Validation is by shape alone, and it consults no schema, corrected in review round ci-1.** An
earlier draft made the reserved key collide with `all_roles/1` (`authority.ex` 1332-1340) and
required `analyze/2` to discard the beacon policy when the replica module declares a role of that
name. That rule is not implementable in both consumers. `analyze/2` receives the module;
`expired?/2` (`authority.ex` 254-277) receives only a `Log` and a delegation id and has no schema
context at all, so it structurally cannot reproduce a module-dependent rejection. Two consumers
computing different beacon sets from the same log is exactly the internal divergence this plan
already names for the missing `expired?/2` threading, so the collision rule is deleted rather than
half-implemented.

The rule is therefore: read `policies[:__beacon__]`; use it as the beacon policy if and only if its
value matches the exact five-key beacon shape below; otherwise ignore it entirely. Nothing else is
consulted, so `analyze/2` and `expired?/2` reach the identical beacon policy by construction, and
so do both runtimes. Threading the module into `expired?/2` was the alternative and is rejected:
`expired?/2` is public API, `apps/lattice_core/lib/toolshed/read_model.ex` line 90 and
`apps/lattice_core/test/lattice2/lease_lapse_test.exs` lines 148 and 155 call it at arity two, and
that last file is in this plan's "green and unchanged" list.

**What "ignored" means, pinned to one reading.** It means the beacon policy is discarded and
witnessed beacons are `:unauthorized_beacon`, never that the genesis op is quarantined.
`collect_policies/3` (`authority.ex` 492-507) blindly `Map.merge`s the policies of every valid
genesis, and that same genesis op is what `resolve_root/4` consumes, so quarantining it would move
root resolution and every holder timeline that hangs off it, which is the class of change this
plan's byte-identical-vector STOP forbids. Discard and fall back to root-only, never quarantine the
genesis. That holds for every invalid policy, not just this case.

**Root-authorized replacement is permitted, through the existing fold, corrected in review round
ci-2.** An earlier draft of this plan and of the spike said a replica whose genesis pinned no beacon
policy could not adopt one later, and that the witness set had to be chosen at creation time. That
contradicts the live fold. `collect_policies/3` (`authority.ex` 492-507) reduces the topologically
ordered ops and, for every `{:genesis, %Delegation{} = d, policies}` op that passes its four guards
(the delegation validates, it is parentless, it is genuinely introduced by that op, and
`op.author == audience`), does `Map.merge(acc, policies)`. Later merges win by construction, and the
existing `township_genesis_projection_parity` exporter scenario
(`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` 509-608) already demonstrates it: a
second root-authored genesis replaces the first `:clerk` policy, the scenario asserts
`effective_policy == second_policy` and `first_analysis.policies.clerk != effective_policy`, and
both genesis ops stay unquarantined while a third genesis from a non-root realm is
`:impostor_genesis`. So the rule this plan adopts is the fold's rule, stated:

- A later valid root-authored genesis **may** add `:__beacon__` where there was none, and **may**
  replace an existing `:__beacon__` with a different witness set, threshold, version or
  `max_epoch_step`. The replacement is validated by exactly the same five-key shape as an initial
  one **before** it replaces anything, and an invalid replacement is discarded under the "what
  ignored means" rule above, leaving the previously resolved valid policy in force rather than
  overwriting it and rather than quarantining the genesis. Validate first, then replace; the beacon
  judge must never take a value it has not validated, which is one of the two reasons step 3 does
  not accept a pre-merged policy map.
- A witness can never change it. Policy is conferred only by a genesis op whose author is the
  replica root; `validate_rootless_delegation/4` and the `op.author == audience` guard are what make
  a forged genesis confer nothing, and that path is unchanged here.
- The replacement takes effect **from that genesis op's causal position**, under the same
  descendant-scoped reading the rest of this plan uses: a witnessed beacon is judged against the
  latest valid `:__beacon__` resolved from the genesis ops in **its own** ancestry, so a beacon that
  predates the second genesis, or forks around it, is still judged under the first policy, and two
  concurrent replacements resolve identically on every replica because the fold walks the shared
  topological order. Step 3 pins the resolution, and it is a beacon-judge fold that is **not** the
  global `collect_policies/3` merge: that global merge stays exactly as it is at 492-507 and keeps
  feeding the role timelines unchanged. Handing the beacon judge the globally merged map would judge
  a pre-replacement or forked beacon under the final policy, which is the bug this bullet exists to
  prevent.
- After founder loss the policy is therefore frozen in fact, not by rule: no root key survives to
  author another genesis. Say it that way; do not write that the policy cannot change.
- Do **not** implement a first-genesis-wins special case for `:__beacon__`. It would make the
  beacon key behave unlike every other policy key in the same map, and it would have to be
  reimplemented identically in `carrier.ts` `successionPolicies` or the two runtimes diverge, which
  is this plan's STOP. The reserved key follows the fold.

Six tests are required, not one. Three cover who may replace: an **add** (a genesis with no beacon
policy, then a later root genesis that adds one, and a witnessed beacon honored only in the second
genesis's descendants); a **replace** (a first witness set, then a root genesis replacing it, and a
certificate from the old witness set refused in the replacement's descendants while it stays honored
in ops that predate it); and a **non-root attempt** (a genesis from a non-root realm carrying a
`:__beacon__` policy is `:impostor_genesis`, confers nothing, and the previously resolved policy is
unchanged on every replica).

Three more cover the ancestry scoping of the resolution itself, added in review round ci-3, and they
are the cases a globally merged policy would get wrong:

- **A beacon before the replacement.** Under a first policy, a witnessed beacon whose ancestry
  carries only the first genesis is judged under the first policy and stays honored after the second
  genesis is appended and every replica has synced. Its verdict must not move when the replacement
  arrives.
- **A beacon forking around the replacement.** A witnessed beacon whose `deps` exclude the second
  genesis is judged under the first policy on every replica, even though the second genesis is
  present in the log, so a certificate from the superseded witness set is honored on that branch
  while a certificate from the same set is `:unauthorized_beacon` in the replacement's descendants.
- **An invalid replacement.** A second root genesis carrying a `:__beacon__` value that fails the
  five-key shape (say a sixth key, or a `max_epoch_step` of `65_536`) leaves the first policy in
  force for its descendants, so a certificate from the first witness set is still honored there, the
  second genesis op is not quarantined, and nothing falls back to root-only. This is the case a
  merge-then-validate implementation silently breaks.

**The residual the deleted collision rule leaves, stated rather than hidden.** If a replica module
ever declares a role literally named `:__beacon__`, the same map value is visible to the role loop
as well. A beacon-shaped value carries no `:successor`, so it is not a usable succession policy, and
the plan's test plan pins that the genesis and transfer verdicts for such a role are exactly what
they are at `8200c38d`. It also surfaces a **pre-existing** hazard that this plan does not create
and may not fix: `decide_succeed/8` (`authority.ex` 892-910) evaluates `op.author != policy.successor`
on any non-nil role policy with no shape guard, so a role policy lacking `:successor` raises
`KeyError` rather than rejecting. That is reachable today from a hand-crafted genesis, it is
independent of beacons, and repairing it moves succession verdicts, which Plan 162's
byte-identical-vector STOP forbids. Record it as an open gate in the PR; do not fix it here. No
replica module in the tree declares `:__beacon__`, and if the executor finds one that does, that is
a STOP.

**The verdict when the policy is absent or invalid: a post-step-3 requirement, not today's
behaviour, corrected in review round ci-2.** After step 3, a witnessed beacon under a genesis with
no `:__beacon__` entry, or with an entry that fails any validation below, must carry
`:unauthorized_beacon`. That is a verdict this plan adds. It is **not** "exactly as today", which an
earlier draft of this section claimed: `collect_beacons/3` (`authority.ex` 719-732) matches only the
two-element `{:beacon, epoch}` body and routes a three-element one to its `_ ->` catch-all, so today
such an op reaches `classify_beacon/6` never and carries no beacon verdict at all, neither honored
nor quarantined. What is preserved unchanged across step 3 is the **materialized outcome**, not the
audit trail: root-only stays the default, an invalid policy never widens who may beacon, and the
witnessed beacon is not honored either way. Fail closed to the pre-change materialized behaviour and
add the explicit reason. In the RED commit every assertion in this section fails because there is no
verdict to read; that failure output is the RED evidence.

**The cases.** A policy `%{mode: :witnessed, version: 1, witnesses: [...distinct public keys...],
threshold: n, max_epoch_step: m}` with exactly those five keys is accepted; duplicate witnesses,
`threshold` greater than the witness count, `threshold` of zero, a witness entry that is not a
32-byte binary, an unknown `mode`, an unknown `version`, a missing key and any sixth key each fail
closed. Model the case **structure** on `witnessed_succession_test.exs` 88-135; do not copy its
reason atoms, see 2b.

**Policy witness order normalizes, it does not fail closed, corrected in review round ci-1.** An
earlier draft listed "a non-canonical witness order" among the policy failures and cited
`witnessed_succession_test.exs` as precedent. The precedent says the opposite.
`SuccessionCertificate.normalize_policy/1` (`succession_certificate.ex` 36-56) ends with
`{:ok, %{policy | witnesses: Enum.sort(witnesses)}}`, so a reordered witness list is the same
policy and yields the same `policy_id`. The test at 118-133 that does fail closed on
`:noncanonical_recovery_signatures` reorders the **certificate's signature list**, not the policy's
witness list. The beacon policy follows the same split, and the two rules are separate cases in
separate steps: the policy sorts its witness list, so a reordered list is the same policy and the
same policy id (2a); the certificate's signature list must arrive in canonical order or the
certificate fails closed (2b). Write a test for each so neither rule can be silently swapped for the
other.

**`max_epoch_step` needs its own ceiling, and the number is pinned here.** "Positive" is not a
bound: `Lattice.Canonical.max_integer/0` is positive, so a genesis pinning
`max_epoch_step: 18_446_744_073_709_551_615` would validate, one witnessed beacon would reach the
canonical ceiling, and this plan's done criterion would call that policy bounded while it
reproduces `docs/research/succession_tick_provenance.md` section 6.6 in full. The rule is
`max_epoch_step` must be an integer in `1..65_535` inclusive. A witness set exists to keep a clock
running, not to fast-forward it, and a group needing a larger jump beacons twice. RED cases: a
missing `max_epoch_step`, zero, negative, non-integer, `65_536`, `2^53`,
`Lattice.Canonical.max_integer/0`, and a sixth key attempting to pin the horizon, each fail the
policy closed, so root-only is preserved and witnessed beacons on that genesis are not honored. The
`:unauthorized_beacon` reason on those same ops is the step 3 expectation, per the correction above;
in the RED commit assert only the non-honoring, and keep the missing-verdict failure as evidence.
Two of those cases are **BEAM-side probes only and must never be exported as vectors**, noted in
review round ci-3: a genesis whose `max_epoch_step` is `2^53` or `Lattice.Canonical.max_integer/0`
carries an integer term TypeScript cannot decode at all (`parseCarrierInteger`, `carrier.ts`
2117-2133), so that runtime quarantines the **whole genesis op** `malformed_term` while the BEAM
decodes the genesis and merely fails the policy closed. The two verdicts differ because the inputs
are outside the corpus's portable range, exactly as `docs/research/succession_tick_provenance.md`
section 4 records; keep them in ExUnit, where the oracle is the BEAM, and pin the cross-runtime
horizon story with the `township_beacon_witnessed_horizon` vector instead.

**The absolute horizon, also pinned here, and it is not a policy field.** The two bounds are not the
same kind of thing, and review round ci-1 found the earlier draft calling both "genesis-pinned".
`max_epoch_step` is the fifth and last key of the beacon policy, chosen at genesis per replica, read
from the log and enforced in the beacon judge. The absolute horizon is a **fixed protocol
constant**: a module attribute in `beacon_certificate.ex`, mirrored in `authority.ts` by an exported
`const` whose value is `Number.MAX_SAFE_INTEGER` and which a unit assertion pins equal to
`9_007_199_254_740_991`. It is identical for every replica, not configurable, and not expressible at
genesis. That is why the accepted policy shape above has exactly five keys and why a sixth key fails
closed: a genesis that tries to pin its own horizon is rejected rather than honored. Neither runtime
reads the horizon from the log, and neither bound is a log-configurable genesis field.

A per-step bound does not bound the total, because repeated legitimate increments accumulate, so the
witnessed branch also refuses any epoch above `9_007_199_254_740_991` (`2^53-1`) regardless of the
step.

**The cross-runtime contract for an above-horizon epoch, decided here in one sentence, corrected in
review round ci-3: both runtimes reject it structurally, before the beacon judge runs, with the same
reason `:malformed_term`, for the epoch in the witnessed beacon body and for the epoch in the
certificate claim alike.** The alternative the reviewer offered, preserving an explicit
above-horizon representation through the TypeScript decoder so its judge could return
`:unauthorized_beacon`, is rejected: it changes more and it can drift, because it means widening
`parseCarrierInteger` (`carrier.ts` 2117-2133), the `AuthorityEvidence` epoch type and every
consumer of that type to carry a value no honored op may hold. The structural contract needs no new
TypeScript decoding logic at all.

Why that contract is the one both runtimes can actually reach, checked against the live tree rather
than assumed. On the TypeScript side an integer term above `Number.MAX_SAFE_INTEGER` already throws
inside `parseCarrierInteger` (`carrier.ts` 2118-2121 for the numeric form, 2130-2132 for the string
form); that throw happens inside `decodeCarrierTerm`'s `"int"` arm (1310-1324), and
`carrierOpToSemanticOp` catches it at 1215-1219 and marks the **whole op** `structuralError:
"malformed_term"`, which `materialize.ts` 136-138 turns into the quarantine reason `malformed_term`,
overwriting any authority reason. `collectBeacons` (`authority.ts` 1343-1379) never sees such an op,
because it carries no `authority` evidence to match at 1354-1356, so it is neither honored nor
`stale_beacon`. An earlier draft of this paragraph cited `nonNegativeInteger` (1870-1871) and the
beacon body decode (1500-1511) as the sites that refuse the value; that citation was wrong, because
both read an **already decoded** term and the throw above happens first. The BEAM has the mirror-image
machinery already: `valid_tick?/1` (`authority.ex` 466-468) and `malformed_tick_body?/1` (483-487)
exist precisely so an out-of-range integer in an `:authority` body quarantines `:malformed_term`
rather than reaching the judge, and the comment at 470-473 gives the reason in the plan's own terms,
that the TypeScript decoder refuses the term before it consults any schema, so the BEAM must
quarantine structurally or the two runtimes diverge.

So step 3 extends that existing structural fold rather than adding a policy-layer horizon check:
`malformed_tick_body?/1` gains a clause for the **witnessed** beacon body, rejecting an epoch outside
`0..9_007_199_254_740_991` in the body or in the certificate claim, and `malformed_tick_ops/1`
(474-481) then quarantines the op `:malformed_term`. No precedence rule is needed on either side,
because `tick_q` is merged last into `base_reasons` (`authority.ex` 346-352) and `materialize.ts`
136-138 writes `malformed_term` after copying the authority reasons. `collect_beacons/4` must also
refuse to honor a body its structural predicate rejects, or the op would be quarantined and still
lapse leases. One new vector, `township_beacon_witnessed_horizon`, pins the verdict on both sides: a
witnessed beacon at `9_007_199_254_740_992` (`2^53`) whose certificate claim carries the same epoch
is `:malformed_term` on the BEAM and `malformed_term` in TypeScript, is honored by neither, and
lapses no lease.

The root branch is untouched by all of this. The two-element `{:beacon, epoch}` body keeps today's
bytes and today's verdicts, so `township_beacon_unauthorized.json` and the four lease vectors do not
move, and the **pre-existing** BEAM-versus-TypeScript range gap on root beacons stays exactly where
`docs/research/succession_tick_provenance.md` section 4 records it. This plan does not close that
gap and must not claim to. `Lattice.Canonical` is untouched and its uint64 bound stays frozen; the
step bound lives in the beacon judge and the horizon in the structural layer that runs before it,
and neither is read from a genesis policy field.

2b. Witnessed beacon verdicts. Under a pinned policy: a beacon carrying a certificate at or above
threshold is honored and advances the epoch; a subthreshold certificate, a certificate signed by a
key outside the policy, a certificate over a different replica or a different epoch, a certificate
whose prior binding does not match the rule step 3 pins, a duplicate signer counted twice, and an
op authored by a realm that step 3's author rule does not admit, are each `:unauthorized_beacon`; a
non-monotonic epoch on an otherwise valid certificate is `:stale_beacon`.

**The lifted-certificate case, which is the reason step 3 pins the binding it does.** One RED case
covers it and it must not be dropped: a realm that **is** in the witness list, acting alone and
below threshold, takes an already-honored witnessed certificate for epoch `E` and re-publishes it
verbatim in a fresh op whose `deps` exclude the original beacon. Assert two things. The lifted op is
`:unauthorized_beacon` on every replica. And a leased op that was causally before the original
beacon, and was honored, stays honored on every replica: the lifted op must not lapse it. Without
the deps binding this case passes the judge, because `classify_beacon/6` computes `prior_max` over
the candidate op's own ancestry (so a pruned-deps op sees no prior beacon and looks monotonic) and
`expired_as_of?/5` lapses any op the beacon does not carry in its ancestry. That is a revocation
vector strictly worse than today's, since a fresh certificate costs `t` signatures and a lifted one
costs one author, and a root beacon cannot be lifted at all because the op signature covers `deps`
and only the root can sign a root beacon. The lapse half of this is already reproducible against
the tree at `8200c38d`, root-authored, in
`docs/research/succession_tick_provenance.md` section 6.7: a second beacon at the same epoch with
`deps` pruned to genesis is honored on every replica and turns an already-honored leased post into
`:lease_expired`. Read 6.7 and 8.2 before writing this case. With no beacon policy in
genesis a witnessed beacon is `:unauthorized_beacon` (root-only stays the default), and a root
beacon stays honored under a policy.

**Reason collapse is deliberate, and this is the only place it is decided.**
`witnessed_succession_test.exs` 88-135 pins `:unknown_recovery_witness`,
`:duplicate_recovery_witness` and `:noncanonical_recovery_signatures` as three distinct reasons for
the same certificate shape, so 2a's instruction to model those cases refers to their **structure**
only. Every witnessed-beacon certificate failure collapses to `:unauthorized_beacon` here, because
a new reason atom is a cross-runtime contract that has to be mirrored in `authority.ts` and pinned
by a vector in the same PR. If a reviewer wants the audit granularity the recovery path has, that
is the cost, and it is paid in this PR or not at all. Do not add a reason atom to one runtime.

**Epoch bound cases, required by the Non-goals correction and spike section 6.6.** Under a pinned
policy: a witnessed certificate for `prior_max + max_epoch_step` is honored; one for
`prior_max + max_epoch_step + 1` is `:unauthorized_beacon`, which is the step bound and is decided in
the beacon judge. The two above-horizon cases carry the **other** reason, per the cross-runtime
contract pinned in 2a: a witnessed certificate for `9_007_199_254_740_992` (`2^53`) is
`:malformed_term` even from a prior epoch that the step bound alone would allow, and one for
`Lattice.Canonical.max_integer/0` is `:malformed_term` unconditionally. Both are structural, decided
before the judge, and they hold with or without a pinned policy. Assert in the same test that
neither op is honored, that neither lapses a lease, and that the epoch in the certificate claim is
judged by the same rule as the epoch in the body, so a claim carrying `2^53` under a body carrying an
in-range epoch is `:malformed_term` too. `township_beacon_witnessed_horizon` is the vector that pins
the `2^53` pair on both runtimes.
Add one scenario proving the bounds are load bearing: with them removed, a single witnessed beacon
at `2^64-1` lapses a lease whose `expires_epoch` is far below it, and every later beacon at every
encodable epoch that carries it in ancestry is `:stale_beacon`. Add a second: a genesis pinning
`max_epoch_step: Lattice.Canonical.max_integer/0` fails the 2a policy validation closed, so the
bound cannot be made vacuous by the policy that is supposed to enforce it. The root branch keeps today's unbounded behavior and today's
bytes; the bound is witnessed-branch only, or `township_beacon_unauthorized.json` and the four
lease vectors move, which is a STOP.

2c. The AF-2 founder-loss scenario. One Sim test: genesis pins an admin role with delegable
admission ops, an issuer-side revocation path, witnessed succession for the admin role, and the
beacon witness policy. The founder realm is then dropped from the simulation and authors nothing
further. The remaining realms then (i) admit a member through an existing grant under a
pre-granted capability, (ii) revoke a delegation **whose issuer is a surviving member**, through
the existing revoke, (iii) advance the beacon through a witnessed certificate, and (iv) let a Plan
149 lease lapse against the witnessed epoch. Every replica materializes byte-identically and agrees
on the quarantine set. A negative control with a subthreshold beacon certificate is
`:unauthorized_beacon` on every replica. No new op kinds appear anywhere in the scenario.
Succession of the admin role uses the existing witnessed `succeed`, never the dormancy path.

**The revoke clause is narrower than AF-2's words, and this test must show the narrowing rather
than paper over it.** `revoke_authorized?/4` (`authority.ex` 705) honors a revoke iff
`author == d.issuer or author == root`. With the founder realm gone, no surviving realm can satisfy
either arm for a delegation the founder issued, including the genesis-time top-level grants this
design depends on. Add a **negative control** to this test: a surviving member revoking a
founder-issued delegation is quarantined `:unauthorized_revoke` (`unauthorized_revokes/3` at
`authority.ex` 687-689) on every replica, and the delegation stays live. Then state in the PR, in
these terms, what AF-2 actually proved: revocation after founder loss covers delegations whose
issuer survives, plus leased founder grants that a witnessed epoch advance can lapse. An unleased
founder grant is permanent, and `Sim.grant` leaves `expires_epoch` `nil` by default (`sim.ex`
90-97), so a group that wants post-loss removal of a founder-granted member has to lease every
founder-issued grant at genesis. If that is unacceptable for the beta, it is the next open gate
after this plan, not something this plan closes. See
`docs/research/succession_tick_provenance.md` section 8.3.

**One more assertion, cheap and load bearing.** In the same test, take the lease that lapsed in
(iv) and assert `Lattice.Authority.expired?(log, deleg_id)` is `true` as well. `expired?/2`
(`authority.ex` 254-277) is the second `collect_beacons/3` caller and the one Toolshed's read model
uses in production; without this assertion a witnessed beacon can lapse a lease through `analyze/2`
while `expired?/2` reports `false`, and `apps/lattice_core/test/toolshed/read_model_test.exs` stays
green while being wrong.

2d. Witness partition and heal, the case a witness set exists for. This is the scenario the
Maintenance-note reviewer focus names as the divergence risk, and it must be a test, not a
paragraph. Under a pinned policy with at least four witnesses and a threshold two disjoint subsets
can each meet: `Sim.partition` the realms into two groups, have each group assemble and append a
witnessed certificate for the **same** next epoch concurrently, `Sim.heal`, then `Sim.sync_all`.
Assert that every replica agrees on the quarantine set, that materialized state is byte-identical
across replicas (the G2 property), and that the next witnessed beacon after the heal has one
deterministic verdict on every replica under step 3's pinned prior binding. Note why this cannot
happen today: `classify_beacon/6` computes `prior_max` over the candidate op's own causal ancestry,
and the root is a single realm with a single log, so its beacons are totally ordered. A witness set
is the first thing that makes two valid beacons at one epoch reachable. Export this scenario as a
fourth vector, `township_beacon_witnessed_concurrent`.

Keep the failing output as RED evidence.

### Step 3 (GREEN): BEAM

Add the witnessed arm. `collect_beacons/3` learns the new body variant and becomes
`collect_beacons/4`; `classify_beacon/6` gains the witnessed branch and keeps the same two reasons
and the same ancestry-scoped monotonicity rule as the root branch.

**The new argument is the ordered beacon-policy sources, never one merged policy, corrected in
review round ci-3.** An earlier draft of this step said `collect_beacons/4` takes "the genesis
beacon policy", already in hand at `analyze/2` 313 one line after `collect_policies/3` at 310. Once
the policy is root-replaceable that is wrong in two separate ways. `collect_policies/3`
(`authority.ex` 492-507) folds `Map.merge(acc, policies)` over **every** valid root genesis in the
whole topological order with no ancestry filter, so its result would judge a beacon that predates
the replacement, or forks around it, under the final policy; and because the merge happens before
any beacon-policy validation, an invalid replacement would overwrite a prior valid value instead of
being ignored. Both answers converge across replicas and both are the wrong answer.

The rule is therefore: `collect_beacons/4` takes the **ordered beacon-policy sources**, a list of
`{genesis_op_id, value_under_the_reserved_key}` built in one pass over the same topologically
ordered ops and under the same four guards `collect_policies/3` applies (the delegation validates,
it is parentless, it is genuinely introduced by that op, and `op.author == audience`), keeping only
the genesis ops that carry `:__beacon__`. `classify_beacon/6` then resolves the policy **per
candidate beacon**, from that candidate's own causal ancestry:

- Take the sources whose `genesis_op_id` is in `Map.get(ancestors, op.id, MapSet.new())`, the same
  strict ancestor set the monotonicity rule at 735-741 already uses. `Dag.all_ancestors/1`
  (`dag.ex` 134-147) excludes the op itself, which is the right reading here: a beacon cannot
  introduce the policy that authorizes it.
- Fold that subsequence left to right in the topological order `Dag.topo_sort/1` already fixes
  (`dag.ex` 23-52, ties broken by op id through a `:gb_sets` ready set, so every replica walks the
  same order and two concurrent replacements resolve identically everywhere).
- Start at "no policy" and **validate each candidate value against the exact five-key shape of 2a
  before it replaces anything**. A valid value replaces the previously resolved one; an invalid
  value is ignored and the previously resolved valid value stays. The result is the latest valid
  `:__beacon__` in that beacon's own ancestry, or "no policy", in which case the witnessed beacon is
  `:unauthorized_beacon` and root-only survives.

This is a **beacon-judge concern, distinct from the global fold**. `collect_policies/3` is not
touched: it keeps its blind `Map.merge` over every valid root genesis, and `analyze/2` keeps handing
that merged map to `build_role_timeline/6` (310, 322-324) for every role timeline exactly as at
`8200c38d`. The two folds answer two different questions and the diff must show both: the global
fold answers "what is this replica's current policy map", the beacon fold answers "which beacon
policy was in force at this op's causal position". Do not make either call the other, and do not add
a `:__beacon__` special case to `collect_policies/3`, which the drift check greps for.

**Both callers change, not one.** In `analyze/2` at 313 the sources are built beside
`collect_policies/3` at 310, from the same `ordered` and the same `deleg_valid`. The second caller
is the live-path `expired?/2` at 254-277, which calls `collect_beacons(ordered, ancestors, root)` at
264 and does **not** call `collect_policies/3` at all: it must now build the identical source list
and pass it in. Missing this ships an internal BEAM divergence, since
`apps/lattice_core/lib/toolshed/read_model.ex` line 90 computes `overdue?` from `expired?/2`, so a
lease that a witnessed beacon lapsed would read as not overdue in the Toolshed read model while
`analyze/2` quarantines its ops `:lease_expired`, with
`apps/lattice_core/test/toolshed/read_model_test.exs` line 73 green throughout. Step 2c asserts
both paths agree.

Three more things this step must pin explicitly rather than leave to the executor:

**The author rule.** `classify_beacon/6` branches first on `op.author != root -> :unauthorized_beacon`
(`authority.ex` 745), so the author is today's gate and the witnessed branch has to state its own.
The rule is: the op carrying a witnessed certificate must be authored by the replica root **or** by
a realm whose public key is in the policy's witness list. Any other author is
`:unauthorized_beacon`, before the certificate is verified. Without this, a valid certificate can
be lifted verbatim into a fresh op by any realm; ancestry-scoped monotonicity would usually catch
the replay as `:stale_beacon`, but that is an accident of ordering and not a stated rule, and it
does not hold in the concurrent case of 2d.

**The prior binding, pinned, not chosen.** Do not write "the prior valid beacon op id": in the 2d
concurrent case there are two valid beacons at the maximum epoch and that phrase has no referent,
so two replicas could resolve it differently and break G2. The binding is: the claim covers
`(version, replica, epoch, author, deps)`, where `author` is the public key that will author the
carrying op and `deps` is exactly that op's dependency list, and verification is structural equality
against `op.author` and `op.deps`. `Lattice.Op.new/6` normalizes and sorts deps before hashing and
signing (`op.ex` 59, 66), so the list is canonical by construction and this step adds no ordering
rule of its own. The cost is that the author proposes `(epoch, author, deps)` and the witnesses sign
that exact triple, which is the ordinary shape of a threshold signature over a message.

**The author field was added in review round ci-1, and the property claim is narrower than the
earlier draft's.** The earlier draft bound `(version, replica, epoch, deps)` and claimed "a
certificate is valid for exactly one op, because moving it anywhere else changes `deps`". That is
false twice over. Without the author field, any realm the author rule admits copies a valid
certificate into its own op with the same `epoch` and the same `deps`; that op's ancestry is
identical, so `prior_max` is identical, `valid_epoch?/2` passes, and a second valid beacon is minted
without re-acquiring threshold. The author field closes that. What survives after it is the narrow
claim, and the plan states only this: **the certificate is bound to one author and one ancestry, so
it cannot be moved to a different author or a different dependency list.** It is still not unique to
one op id, because `Lattice.Op.new/6` hashes `cap` as well (`op.ex` 59-66) and the beacon judge
never inspects `cap`, so the named author can mint duplicate valid beacons at the same epoch over
the same deps. That duplication is **permitted and bounded**: identical ancestry and identical epoch
means `expired_as_of?/5` reaches exactly the ops the original reached, so a duplicate confers
nothing the original did not, and its whole cost is log space and audit noise. Pin it with a test
rather than a sentence: construct a same-author, same-deps, same-epoch duplicate, assert both are
honored, and assert the quarantine set and materialized state are identical on every replica and
identical to the single-beacon run. If the duplicate turns out to change the lapse set, the binding
is wrong and that is a STOP, not a tie-break to choose in code.

The `(replica, epoch)`-only shape an earlier draft made the default is **rejected**, and the reason
is the 2b lifted-certificate case: with no author or dep binding, a single listed witness below threshold
re-publishes an honored certificate in an op with pruned deps, `classify_beacon/6` sees no prior
beacon in that op's ancestry and honors it, and `expired_as_of?/5` then lapses every leased op the
new beacon does not carry in its ancestry, including ops that were honored under the original. One
author would gain what a fresh certificate costs `t` signatures to obtain. The set-valued
alternative (bind to the canonically sorted set of valid maximum-epoch beacon ids in the op's
ancestry) is convergent and is recorded as the fallback, but it has a residual the deps binding
does not: the first witnessed beacon on a replica has an empty prior set, so its certificate is
still liftable. See `docs/research/succession_tick_provenance.md` section 8.2.

**The epoch bounds, both of them, and the two layers they live in.** The witnessed branch rejects
`epoch > prior_max + max_epoch_step` as `:unauthorized_beacon` **in the beacon judge**, where
`max_epoch_step` is resolved from the beacon policy in force at that op's causal position and 2a has
already refused any policy whose step is outside `1..65_535`. Independently, and regardless of the
step, an `epoch > 9_007_199_254_740_991` (`2^53-1`) in the witnessed body or in its certificate
claim is `:malformed_term` **in the structural layer that runs before the judge**, through the
`malformed_tick_body?/1` clause 2a pins. The step bound alone is not enough: it is vacuous if the
policy may pin an arbitrary positive step, and it bounds one jump rather than the accumulated total,
so only the absolute horizon keeps the canonical ceiling out of reach on this branch. The horizon is
`Number.MAX_SAFE_INTEGER`, and TypeScript already enforces exactly that bound in
`parseCarrierInteger` (`carrier.ts` 2117-2133) with the same `malformed_term` outcome
(`materialize.ts` 136-138), so the new body variant needs no new TypeScript decoding logic for it and
the two runtimes cannot reach different verdicts. Neither bound is a log-configurable genesis field:
one is a policy value the judge reads, the other a constant compiled into both runtimes.
`Lattice.Canonical` is untouched and its uint64 bound is a STOP condition; the horizon is a rule
about one new body variant, not a change to what `Lattice.Canonical` admits.

The root branch is not bounded, so root beacons keep their exact current bytes and verdicts. State
the consequence at exactly its real width, corrected in review round ci-1. A root beacon above the
horizon ends witnessed advancement **for every op that carries that beacon in its ancestry**, which
is every op built on the frontier after it. It does not end witnessed advancement globally, because
`classify_beacon/6` computes `prior_max` over the candidate op's own ancestry: a witnessed beacon
whose `deps` fork off before the high root beacon sees a low `prior_max` and is honored below the
horizon, and the certificate for it is legitimately obtainable because the witnesses sign over those
exact `deps`. `docs/research/succession_tick_provenance.md` section 6.8 reproduces the mechanism
root-authored against the tree at `8200c38d`. Add a fork test for it in 2b, in **two** arms. The
root arm: pin a policy, author a root beacon above the horizon, then have the witness set assemble a
certificate over `deps` that exclude that root beacon, and assert the witnessed beacon is honored,
that every replica agrees, and that a descendant of the root beacon carrying a witnessed certificate
is still refused. The witnessed arm, added in review round ci-3 because the same reading applies to
the witnessed branch and an earlier draft claimed a lifetime lockout there: reach the horizon on the
witnessed branch by honoring a witnessed beacon **at** `9_007_199_254_740_991` (`2^53-1`), then have
the witness set certify a lower epoch over `deps` that fork from before it. That op's `prior_max`
excludes the horizon beacon, so it is honored at the lower epoch on every replica, while a witnessed
beacon that carries the horizon beacon in its ancestry is `:stale_beacon` at any epoch. The PR states
the descendant-scoped reading for both branches and does not imply the horizon prevents the root
from stopping the clock on the main history; that is the existing root power recorded in spike
section 6.6.

The certificate is domain separated. A witnessed beacon confers epoch advancement, which per the
Non-goals correction includes lapsing every expiring lease on the replica. Root-only behavior is
unchanged when no policy is pinned.

### Step 4: Sim helpers

Most of this landed in the RED commit, because step 2 cannot run without it. What remains here is
cleanup and the proof that the construction path is real:

- `Sim.beacon/4` carries a `witnesses:` option that assembles the certificate the way `sim.ex`
  316-350 does for succession, binding the claim to the op's `deps` per step 3. The existing
  three-argument root beacon behaviour stays byte-identical.
- `resolve_policy/2` has a clause for the reserved `:__beacon__` value shape, and
  `create_replica/3` routes it. The three existing clauses (264-314) all require a `:successor`
  key and there is no catch-all, so before this a `policies: %{__beacon__: ...}` genesis raised
  `FunctionClauseError` in the harness. One test asserts the reachability directly: a
  `create_replica` with a reserved beacon policy returns a genesis whose decoded policy map carries
  the witness list and threshold, on both runtimes. Do not treat "the test compiles" as proof the
  path exists.

### Step 5: Exporter scenarios and vector regeneration

Add scenarios producing `township_beacon_witnessed_advance`,
`township_beacon_witnessed_subthreshold`, `township_beacon_witnessed_founder_loss`,
`township_beacon_witnessed_concurrent` (step 2d) and `township_beacon_witnessed_horizon` (the
above-horizon parity vector pinned in 2a: a witnessed beacon at `2^53` whose certificate claim
carries the same epoch, `:malformed_term` on both runtimes and honored by neither). Regenerate with
`MIX_ENV=test`, then prove the
Plan 145 and Plan 149 "regenerate, diff is empty" result: every pre-existing vector is
byte-identical. Check the five beacon and lease vectors first, because they are the ones this
step's `collect_beacons/4` change touches most directly and the only ones that pin today's
root-only rule: `township_beacon_unauthorized.json` (exporter 2602-2634, pinning
`:unauthorized_beacon` for a non-root beacon, `:stale_beacon` for a repeated epoch, and a leased
post that stays honored), `township_lease_valid_causal.json` (2481-2505),
`township_lease_expired.json` (2506-2539), `township_lease_expired_chain.json` (2540-2569) and
`township_lease_renewed.json` (2570-2601). Then the three Plan 162 succession vectors, then the
rest. Enumerate the added files in the PR and state that nothing else changed.

One scenario carries extra payload, added in review round ci-2 so step 6 can prove parity in the
authoring direction: `township_beacon_witnessed_advance` also exports the exact BEAM-computed
beacon-claim **preimage bytes** for its honored certificate, and the exact canonical bytes of the
genesis op carrying the beacon policy. Those two blobs are what
`clients/lattice-client/test/township_authoring.ts` compares its own `codec.ts` and
`authorTownshipGenesis` output against. Without them the TypeScript side can only replay
BEAM-written bytes, which cannot detect an encoder that writes different ones.

### Step 6: TypeScript mirror

`authority.ts` `collectBeacons` gains the witnessed arm with the same reasons, the same author
rule, the same author-and-deps claim binding, the **same ancestry-scoped policy resolution** and the
**same two** epoch bounds as step 3; reuse the
`verifyWitnessedSuccessionCertificate` verification shape at 830 with the beacon domain separator.

**The policy resolution mirrors step 3, not `collectPolicies`.** `collectPolicies` (`authority.ts`
999-1042) is the mirror of the BEAM's global fold: it walks every valid root genesis and last write
wins per role, with no ancestry filter, and it stays that way for the role timelines. `collectBeacons`
must instead resolve, for each candidate beacon, the latest valid `:__beacon__` among the genesis ops
in that candidate's own ancestry, using the `ancestors(op.id, byId, ancCache)` set it already computes
at 1355 for `priorMax`, folded in the same visible-op order, validating each value before it replaces
the previous one. Carrying the genesis op id beside the policy is the shape this file already uses:
`recoveryPoliciesByRole` keeps `genesisOperationId` at 1033-1035 for exactly this reason. A
TypeScript side that reads one globally merged beacon policy is a divergence from step 3 on any log
with two beacon-policy geneses, and this plan's STOP list names conformance divergence.

**The horizon needs no new decoding logic here, per the 2a contract.** `parseCarrierInteger`
(`carrier.ts` 2117-2133) already refuses any integer term above `Number.MAX_SAFE_INTEGER`,
`carrierOpToSemanticOp` already marks the whole op `structuralError: "malformed_term"` at 1215-1219,
and `materialize.ts` 136-138 already writes that reason over any authority reason, which is the
verdict step 3's structural clause produces on the BEAM. What step 6 adds is one exported
module-level `const` for the horizon, set to `Number.MAX_SAFE_INTEGER`, with `conformance.ts`
asserting beside the new horizon vector that it equals `9_007_199_254_740_991`, so the constant is
named and greppable and cannot silently drift from the BEAM module attribute. Do **not** widen `parseCarrierInteger`, the `AuthorityEvidence` epoch
type or its consumers to carry an above-horizon value: that was the rejected alternative in 2a.
**Five** sites change, not three, and two of them are encoders rather than decoders. A decoder-only
step 6 would let TypeScript replay a BEAM-authored witnessed beacon while making it impossible for
a TypeScript client to author one or to compute its claim bytes, and BEAM-generated conformance
vectors cannot see that gap because every byte in them was produced by the BEAM:

- `carrier.ts` 1500-1511, the beacon **body** decoder. Today it reads
  `body.values[1]` and emits `{ type: "beacon", epoch }`, with a non-integer epoch term decoding to
  `null` so the reducer can still reach `:stale_beacon`. It must carry the certificate under the
  same fail-open-to-the-reducer discipline. Note what that `null` does and does not cover: an
  integer term above the horizon never arrives here at all, because `parseCarrierInteger` threw
  during `decodeCarrierTerm` and the whole op is already `malformed_term`. Do not describe this site
  as the horizon check.
- `op.ts` line 124, the `AuthorityEvidence` beacon arm, currently
  `| { type: "beacon"; epoch: number | null };`. It gains the certificate field.
- `carrier.ts` 1684-1693, the genesis **policy decoder**, which learns the reserved `:__beacon__`
  key. Decode it before the role loop in `successionPolicies` (1667-1690), never through it: that
  function `continue`s past any entry without a 32-byte `successor`, so a beacon entry routed
  through it is silently invisible in TypeScript while the BEAM honors it, which is the divergence
  this plan names a STOP.
- `township.ts` 40-43 and 381-397, the genesis **policy encoder** and its authoring type, corrected
  in review round ci-2. `townshipGenesisPoliciesTerm` is the production encoder reached from
  `townshipGenesisBody` (112-118) and `authorTownshipGenesis` (210), and today it emits exactly
  `successor` and `dormant_ticks` for every entry while `TownshipGenesisPolicy` declares only
  `successorPubkey` and `dormantTicks`. Both must accept the beacon policy under the reserved key,
  encoded so the resulting genesis op is byte-identical to the BEAM-authored one, or the shells
  that author through this client can never create a replica with a witness set. Extend the type
  rather than widening it to an open record, so an unknown policy key stays a type error.
- `codec.ts`, a new exported beacon-claim canonical-bytes function beside
  `canonicalBytesForWitnessedSuccessionClaim` (206-221), under the `"lattice-beacon-witness-v1"`
  separator over `(version, replica, epoch, author, deps)`. The existing function is
  succession-shaped and its canonical encoders are private, so `authority.ts` cannot build the
  beacon payload without it.

`conformance.ts` gains the five new vectors, and
`clients/lattice-client/test/township_authoring.ts` gains two cases: a genesis authored through
`authorTownshipGenesis` with a beacon policy, and the **canonical payload parity** check below.

**Canonical payload parity, a required gate.** Conformance vectors prove that TypeScript reads what
the BEAM wrote. They do not prove that TypeScript writes what the BEAM would write, because the
BEAM produced every byte in them. So step 5 exports the exact beacon-claim preimage bytes and the
exact beacon-policy-bearing genesis op bytes from the BEAM into the new vectors, and step 6 asserts
in TypeScript that the new `codec.ts` function returns bytes equal to the BEAM's claim preimage for
the same five-field claim, and that `authorTownshipGenesis` with the same beacon policy produces
the same canonical genesis bytes. Both assertions must fail if either the field order, the
separator or the policy encoding differs by one byte. `capability.ts` line 130 keeps consuming
`validBeacons` unchanged: a witnessed beacon lapses a lease exactly as a root beacon does, which is
precisely the power the Non-goals correction names.

### Step 7: Compaction parity

Carry beacons through `apps/lattice_core/test/support/compaction_spike.ex` under the same rule as
`authority.ex`. Do not touch the dormancy comparison at 538-544.

**Extend the GATE first, and confirm it bites.** As written at `8200c38d` the GATE at
`compaction_spike_test.exs` line 121 cannot go red for this plan: the words `beacon`, `lease` and
`expires_epoch` appear nowhere in either file, and `straddle_scenario/0` builds only transfer,
stale-holder, revocation and succession straddles. So add to that scenario, before changing the
mirror:

- a genesis carrying a valid `:__beacon__` policy;
- a leased delegation whose `expires_epoch` sits **between** the epoch of a beacon below the
  compaction frontier F and the epoch of a witnessed beacon above F, so the lapse verdict depends
  on beacon evidence that compaction must summarize rather than discard;
- a witnessed beacon straddling F in each direction: one beneath F, whose epoch must survive into
  the snapshot's authority summary, and one retained above it;
- a command citing that leased chain on each side of the lapse, so both the `:lease_expired`
  quarantine and the still-honored case are asserted from the compacted side.

Then run the extended GATE against the **unchanged** mirror and record that it is red, and against
the changed mirror and record that it is green. A GATE that is green before the mirror changes is
not evidence and is a STOP: it means the beacon straddle is not actually reaching the compacted
reducer.

### Step 7b: Dump vocabulary and a fresh-VM restore

Add every atom the beacon policy and the beacon certificate introduce to
`Lattice.Log.known_dump_policy_atoms/0` (`log.ex` 276-302). The list today holds exactly the Plan
145 certificate atoms and has no `:epoch` and no prior-binding atom. Then prove it the only way
that is meaningful: write a dump of a log containing a witnessed beacon, and restore it in a
**freshly booted** VM (a separate `mix run`, not the test VM that already interned the atoms
by compiling the modules). `restore/1` must return `{:ok, log}`, not `{:error, :unsafe_dump}`.
Township W3 (`workflows_test.exs` 244) is the existing dump and restore path and
`township_succession_w3.json` must stay byte-identical, so a miss here surfaces late and reads as
an unrelated failure.

### Step 8: Full gate

`mix format`, the full `mix test`, `scripts/township_demo.exs`, the TypeScript typecheck,
conformance, canonical and build gates, and the CI vector-regeneration check pinned by
`apps/lattice_core/test/township/export_vectors_test.exs` line 1099.

### Step 8b: Claim-boundary documents, after GREEN

Mirror `plans/145-genesis-pinned-witnessed-succession.md` "GREEN 4 - claim-boundary documents",
which requires these two whenever the governance authorization model changes. A second beacon
emitter is that class of change.

- `docs/adr/0004-succession-validation.md`: record that a genesis-pinned witness threshold may emit
  beacons alongside the replica root, both epoch bounds and why each exists (the `1..65_535`
  `max_epoch_step` ceiling that keeps the step bound from being vacuous, and the `2^53-1` horizon
  that keeps accumulated steps out of the canonical ceiling and holds the two runtimes to the same
  range, which of the two is genesis-pinned versus a fixed protocol constant, and at which layer each
  is enforced: the step in the beacon judge as `:unauthorized_beacon`, the horizon structurally
  before it as `:malformed_term` in both runtimes), the
  author-and-deps claim binding and the lifted-certificate attack it closes, the author rule, and the
  non-claims that survive: still no live clock, still no absence proof, still no founder-loss
  survival claim beyond what the merged AF-2 test shows, and specifically no claim that
  founder-issued delegations become revocable after founder loss.
- `docs/lattice_poc_status.md` 221-229: that bullet today says legacy succession ticks are
  untrusted and witnessed recovery is governance authorization. Extend it with the beacon emitter
  and the lease-lapse power a witness threshold gains, in the same sentence as the grant, per Plan
  177 D1.
- Do **not** touch `TOWNSHIP_BUILD_MAP.md`, which Plan 145 also lists: its rows are pinned by
  `audit_bundle_test.exs` and `read_model_test.exs`.

### Step 9: Index updates, appended only

Update the `plans/README.md` row for 179 (after PR 1 as well as after PR 2), and append (never
reword) an AF-2 status line to
`plans/158-real-device-beta-poc-program-map.md` and `plans/177-group-first-antifragile-reaim.md`
recording that AF-2 now passes in Sim with the founder removed. Only after this plan is merged may
a separate Plan 178-style slice revise the frozen founder-loss contract sentence.

## Test plan

**Added**

- A reachability test for the construction path itself (step 4): `Sim.create_replica` with a
  reserved `:__beacon__` policy produces a genesis whose decoded policy carries the witness list
  and threshold. Without it the whole suite is unwritable, because `resolve_policy/2`'s three
  clauses all require `:successor`.
- Beacon policy validation cases (step 2a): the absent or invalid policy falling back to
  `:unauthorized_beacon`, which is a **post-step-3** expectation, so the RED form of this case
  asserts only that the witnessed beacon is not honored and that its op carries no beacon reason;
  `max_epoch_step` outside `1..65_535` including zero, negative, non-integer, `65_536`, `2^53` and
  `Lattice.Canonical.max_integer/0`; a sixth key, including one attempting to pin the horizon; a
  witness that is not a 32-byte binary; and a **reordered policy witness list yielding the same
  policy id**, which is the normalization case, not a failure case.
- The three root-authorized policy replacement cases (step 2a), which follow the existing fold
  rather than a special case: an **add** (a genesis with no beacon policy, a later root genesis that
  adds one, and a witnessed beacon honored only in that genesis's descendants), a **replace** (a
  root genesis replacing the witness set, with a certificate from the superseded set refused in the
  replacement's descendants and still honored in ops that predate it), and a **non-root attempt**
  (a `:__beacon__` policy in a genesis authored by a non-root realm is `:impostor_genesis`, confers
  nothing, and leaves the resolved policy unchanged on every replica). The third mirrors the impostor
  arm of `township_genesis_projection_parity` (`lattice.export_vectors.ex` 509-608).
- The three ancestry-scoped resolution cases (step 2a, added in review round ci-3), which are the
  cases one globally merged policy gets wrong: a witnessed beacon whose ancestry carries **only the
  first** genesis keeps its verdict after the replacement is appended and synced; a witnessed beacon
  whose `deps` **fork around** the replacement is judged under the first policy on every replica even
  though the replacement is in the log; and an **invalid replacement** leaves the first policy in
  force for its descendants without quarantining the second genesis and without falling back to
  root-only. Each is asserted on every replica after a heal.
- The certificate signature ordering case, separate from the policy case above and matching the
  precedent at `witnessed_succession_test.exs` 118-133: a certificate whose signature list is not in
  canonical order fails closed.
- Witnessed beacon verdict cases: honored, subthreshold, foreign signer, wrong replica, wrong
  epoch, deps binding mismatch, author binding mismatch, duplicate signer, non-monotonic,
  non-witness and non-root author, no policy pinned, at the epoch step bound, and one past the step
  bound, all of which carry a beacon-judge reason; plus the two structural above-horizon cases, at
  `2^53` (refused as `:malformed_term` even from a prior epoch the step bound alone would allow, in
  the body and in the certificate claim) and at the canonical ceiling (step 2b).
- The lifted-certificate case (step 2b): a listed witness below threshold re-publishes an honored
  certificate in an op with pruned deps. The op is `:unauthorized_beacon` on every replica, and a
  leased op honored before the original beacon stays honored on every replica.
- The permitted-duplicate case (step 3): the **same** author re-publishes its own honored
  certificate in a second op with the same epoch and the same deps. Both are honored, and the
  quarantine set and materialized state on every replica are identical to the single-beacon run, so
  the duplicate is inert. If it is not inert, that is a STOP.
- The horizon fork case (step 2b, from review round ci-1), in two arms. The **root** arm: under a
  pinned policy, a root beacon above the horizon, then a witnessed certificate over deps that exclude
  it. The witnessed beacon is honored below the horizon on every replica, while a witnessed beacon
  whose deps carry the high root beacon is refused. The **witnessed** arm, added in review round
  ci-3: a witnessed beacon honored **at** `2^53-1`, then a witnessed certificate at a lower epoch over
  deps that fork from before it, honored on every replica, while a witnessed beacon carrying the
  horizon beacon in its ancestry is `:stale_beacon` at any epoch. Together these are the executable
  form of the descendant-scoped lockout claim on both branches, and the witnessed arm is what forbids
  writing that reaching the horizon stops the clock for the life of the replica.
- The reserved-key residual case (step 2a): with no replica module in the tree declaring
  `:__beacon__`, pin that a genesis carrying a beacon-shaped `:__beacon__` value leaves the genesis
  op and every role verdict exactly as they are at `8200c38d`, and that a succession-shaped value
  under `:__beacon__` is not read as a beacon policy, so root-only survives.
- The AF-2 founder-loss Sim test with its subthreshold negative control (step 2c), plus the
  revoke negative control (a surviving member's revoke of a founder-issued delegation is
  `:unauthorized_revoke` on every replica and the delegation stays live) and the
  `Authority.expired?/2` agreement assertion for the lease that lapsed under the witnessed epoch.
- The witness partition and heal convergence test (step 2d).
- A dump and restore of a log holding a witnessed beacon, in a freshly booted VM (step 7b).
- Vectors `township_beacon_witnessed_advance`, `township_beacon_witnessed_subthreshold`,
  `township_beacon_witnessed_founder_loss`, `township_beacon_witnessed_concurrent` and
  `township_beacon_witnessed_horizon`, their exporter scenarios and their `conformance.ts` checks.
  The last one is the cross-runtime parity vector for the horizon, added in review round ci-3: a
  witnessed beacon at `9_007_199_254_740_992` (`2^53`) whose certificate claim carries the same
  epoch, `:malformed_term` on the BEAM and `malformed_term` in TypeScript, honored by neither and
  lapsing no lease.
- **Canonical payload parity, both directions** (step 6, added in review round ci-2), in
  `clients/lattice-client/test/township_authoring.ts`: the new `codec.ts` beacon-claim function
  returns bytes **equal** to the BEAM's claim preimage for the same five-field claim
  `(version, replica, epoch, author, deps)` exported in the new vectors, and
  `authorTownshipGenesis` with the same beacon policy produces canonical genesis bytes equal to the
  BEAM-authored ones. A conformance vector alone cannot cover this: every byte in one was written by
  the BEAM, so it proves reading and not writing. Both assertions must fail on a one-byte difference
  in field order, separator or policy encoding.
- The compaction straddle cases (step 7): a witnessed beacon beneath the frontier F whose epoch must
  survive into the snapshot's authority summary, a witnessed beacon retained above F, and a leased
  delegation whose `expires_epoch` sits between the two, asserted from the compacted side for both
  the `:lease_expired` quarantine and the still-honored case.

**Must remain byte-identical**

Every existing vector. Two groups deserve naming, and the first is the one this plan actually
touches.

The five beacon and lease vectors, which exercise `collect_beacons/3` and `collectBeacons`
directly and are the executable proof that a replica with no beacon policy behaves exactly as at
`8200c38d`: `township_beacon_unauthorized` (the root-only rule plus both reason atoms),
`township_lease_valid_causal`, `township_lease_expired`, `township_lease_expired_chain`,
`township_lease_renewed`. Check these first.

The eleven tick-bearing vectors listed in `docs/research/succession_tick_provenance.md` section
5.2, which this plan must not touch at all because decision 1 is settled as option D:
`township_succession_w3`, `township_succession_unproven_tick`,
`township_succession_witnessed_recovery`, `township_authority_succession_genesis_poisoning`,
`township_authority_succession_capability_laundering`,
`township_authority_cross_role_succession_transfer`, `township_authority_rooted_grant_as_genesis`,
`township_authority_malformed_heartbeat`, `township_authority_undeclared_role_tick`,
`township_carrier_w1`, `township_authority_replayed_genesis`. (`township_foreign_replica_injection`
and `township_zoning_variance_24` also carry tick or policy content and must not move.)

**Regression gates, green and unchanged**

- `apps/lattice_core/test/lattice2/succession_time_travel_test.exs`,
  `witnessed_succession_test.exs`, `root_binding_test.exs`, `lease_lapse_test.exs`
  (52 tests green at the `8200c38d` baseline). `lease_lapse_test.exs` is the densest beacon
  consumer in the tree, with root beacons at 41, 65, 80, 93, 95, 106, 131 and 151 including V3's
  `:unauthorized_beacon` and `:stale_beacon` pins; those eight cases are the executable proof that
  the root branch did not move.
- `apps/lattice_core/test/township/lease_property_test.exs`, whose generators emit valid root
  beacons at 31 and 68-69 and forged non-root beacons at 71-74 and assert identical
  `:unauthorized_beacon` and `:lease_expired` verdicts across replicas. It is the property-level
  version of the root-only rule and it must stay green unchanged.
- `apps/lattice_core/test/lattice2/compaction_spike_test.exs` including the GATE at line 121,
  which step 7 **extends** before the mirror changes. At `8200c38d` that GATE contains no `beacon`,
  `lease` or `expires_epoch` anywhere, so passing it unchanged is not evidence that witnessed-beacon
  evidence survives compaction. Record it red against the unchanged mirror and green after.
- `apps/lattice_core/test/township/workflows_test.exs` and
  `apps/lattice_core/test/township/export_vectors_test.exs`.
- The Toolshed beacon and lease consumers, which the spike's blast radius missed on its first pass:
  `apps/lattice_core/test/toolshed/workflows_test.exs` (root beacons at 65, 166, 196),
  `apps/lattice_core/test/toolshed/read_model_test.exs` (root beacon at 73, the "overdue is
  computed, not asserted" test, and the named gate for the `expired?/2` threading in step 3: it is
  green today and would stay green under a half-threaded change, so step 2c's `expired?/2`
  assertion is what actually protects it), and
  `apps/lattice_core/test/toolshed/custody_consent_test.exs`.
- `apps/lattice_core/test/township/workflows_test.exs` line 79, a root beacon lapsing a lease
  inside W2. Already covered by the whole-file gate above and called out because the spike's blast
  radius missed it until review round 2.
- `apps/lattice_core/test/treehouse/contract_test.exs`, untouched.
- `apps/lattice_stress/test/adversarial_authority_test.exs` and
  `property_authority_invariant_test.exs`.

**Mutation evidence**

Each new predicate must be shown load-bearing. Three of these were unsatisfiable as written in an
earlier draft and are corrected here; each correction says what it replaced, so nobody restores the
broken form.

- Remove the threshold comparison and confirm the subthreshold case is honored.
- Remove the witness-membership check and confirm the foreign-signer case is honored.
- **Domain separation, corrected in review round ci-1.** Do not write "remove the domain separator
  and confirm a succession certificate is accepted as a beacon certificate". That mutation cannot
  pass: the succession claim has seven fields (`version, replica, role, holder, holder_epoch,
  successor, policy_id`) and the beacon claim has five, so the shapes never match and the separator
  is not the variable under test. Instead, pin the beacon signing payload directly: build a
  beacon-shaped claim, hash and sign it under the **succession** separator
  `"lattice-succession-witness-v1"`, and confirm the beacon judge refuses it while the separators
  differ and accepts it once the two separators are collided to the same string. Identical canonical
  payload, one variable, satisfiable.
- Remove the replica binding and confirm the wrong-replica case passes.
- Remove the author rule and confirm a realm outside the witness list can carry a valid certificate.
- Remove the `deps` field from the claim and confirm the 2b lifted-certificate case is honored and
  retroactively lapses a lease that was honored before the original beacon, which is the revocation
  vector the binding exists to close.
- Remove the `author` field from the claim and confirm a second listed witness can copy an honored
  certificate into its own op with the same `epoch` and `deps` and mint a second valid beacon
  without re-acquiring threshold.
- **The two epoch-bound mutations, corrected in review round ci-1.** The earlier draft had both of
  them reaching `Lattice.Canonical.max_integer/0`, which the independent horizon check blocks, so
  neither could produce its stated outcome. Test them at their real reach instead. Remove the
  `max_epoch_step` comparison and confirm a witnessed beacon at `prior_max + max_epoch_step + 1`,
  chosen **below** the `2^53-1` horizon, is honored and lapses a lease whose `expires_epoch` sits
  between the two. Separately, remove the `1..65_535` policy ceiling and confirm only what follows
  from it: a genesis pinning `max_epoch_step: Lattice.Canonical.max_integer/0` now validates, so the
  step bound has become vacuous. Do not assert that this reaches the canonical ceiling; the horizon
  still caps the honored epoch at `2^53-1`, and reaching the ceiling needs **both** mutations at
  once. Record that pairing as its own case, which is the evidence that the two bounds are
  independent rather than redundant.
- Remove the `malformed_tick_body?/1` horizon clause and confirm a witnessed epoch above
  `Number.MAX_SAFE_INTEGER` is honored on the BEAM while TypeScript reports `malformed_term` for the
  same op, which is the conformance divergence this plan names a STOP and the reason the horizon is
  enforced structurally rather than in the judge.
- Replace the ancestry-scoped beacon-policy resolution with the globally merged map from
  `collect_policies/3` and confirm all three ci-3 cases fail: a beacon predating the replacement is
  judged under the final policy, a beacon forking around it is too, and an invalid replacement
  overwrites the prior valid policy so a certificate from the first witness set stops being honored.
- Pass `nil` for the beacon policy in `expired?/2` only and confirm a witnessed beacon lapses a
  lease through `analyze/2` while `expired?/2` reports `false` and `toolshed/read_model_test.exs`
  stays green.
- Remove the new atoms from `known_dump_policy_atoms/0` and confirm the fresh-VM restore fails
  `:unsafe_dump`.

Restore each and record the named failure.

## Verification

| Command | Expected |
|---|---|
| `~/.asdf/shims/mix format --check-formatted` | exit 0 |
| `~/.asdf/shims/mix test` | all pass |
| `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` | all pass, including the new beacon suites and the GATE |
| `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors` | exit 0 |
| `git status --short clients/lattice-client/test/vectors` | exactly five new files, no modified file |
| `npm --prefix clients/lattice-client run typecheck` | exit 0 |
| `npm --prefix clients/lattice-client run conformance` | exit 0, all PASS |
| `npm --prefix clients/lattice-client run township:authoring` | exit 0, including the beacon-policy authoring case and both canonical payload parity assertions |
| `grep -n 'lattice-beacon-witness-v1' clients/lattice-client/src/codec.ts apps/lattice_core/lib/lattice/authority/beacon_certificate.ex` | the separator appears once in each, spelled identically |
| `grep -n 'export function canonicalBytesFor' clients/lattice-client/src/codec.ts` | a new beacon-claim function beside the succession one, not a widened succession function taking a separator |
| `grep -nc 'beacon\|expires_epoch' apps/lattice_core/test/lattice2/compaction_spike_test.exs` | greater than 0, where it is 0 at `8200c38d` |
| `npm --prefix clients/lattice-client run canonical` | exit 0 |
| `npm --prefix clients/lattice-client run build` | exit 0, regenerated `dist/**` committed |
| `~/.asdf/shims/mix run scripts/township_demo.exs` (from the repository root, where the script lives) | narrates W0 to W4 clean |
| `git diff 8200c38d -- apps/lattice_core/lib/lattice/canonical.ex` | empty |
| a fresh `mix run` that calls `Lattice.Log.restore/1` on a dump holding a witnessed beacon | `{:ok, _}`, never `{:error, :unsafe_dump}` |
| `grep -rn 'dormant_ticks' apps/lattice_core/lib/lattice/authority.ex` | unchanged from `8200c38d` |
| `grep -rn 'prior valid beacon op id' apps clients` | no match |
| `grep -rn 'expired?(log' apps/lattice_core/lib` | every caller reaches a policy-aware `collect_beacons/4` |
| `grep -n 'def expired?' apps/lattice_core/lib/lattice/authority.ex` | still arity two, no module argument, so `read_model.ex` and `lease_lapse_test.exs` are untouched |
| `grep -rn 'all_roles' apps/lattice_core/lib/lattice/authority.ex` | unchanged from `8200c38d`; no beacon-policy call site |
| `git diff 8200c38d -- apps/lattice_core/lib/lattice/authority.ex \| grep -n 'collect_policies'` | no first-genesis-wins special case for `:__beacon__`; the merge fold is unchanged |
| `grep -rn '9_007_199_254_740_991\|9007199254740991' apps clients` | the BEAM module attribute and the TypeScript equality assertion only; the exported `const` itself is `Number.MAX_SAFE_INTEGER`, and neither is a genesis policy field |
| `git diff 8200c38d -- clients/lattice-client/src/carrier.ts \| grep -n 'parseCarrierInteger'` | empty; the horizon adds no TypeScript decoding logic |
| `git diff 8200c38d -- apps/lattice_core/lib/lattice/authority.ex \| grep -n 'collect_beacons'` | the new argument is the ordered beacon-policy sources, not the `collect_policies/3` result |
| `grep -c $'\xe2\x80\x94' plans/179-witnessed-beacons-af2-founder-loss.md` | `0` |

## Done criteria

Machine-checkable. ALL must hold:

- [ ] The `CLAUDE.md` and `README.md` non-claim sentence from step 1a is present.
- [ ] `Township.Matter` line 66 is either relabelled decorative in its moduledoc or explicitly
      deferred in this plan's PR text, and the `2^64-1` lockout is stated plainly in whichever
      place the branch chose.
- [ ] `TOWNSHIP_BUILD_MAP.md` is untouched; `audit_bundle_test.exs` and `read_model_test.exs` pass.
- [ ] A genesis beacon witness policy lives under the reserved `:__beacon__` key, validates, and
      fails closed on duplicate witnesses, a witness that is not a 32-byte binary, threshold greater
      than count, threshold zero, a missing or out-of-range `max_epoch_step`, unknown mode, unknown
      version, a missing key and any sixth key. Its witness list is normalized by sorting, so a
      reordered list is the same policy with the same policy id, matching
      `SuccessionCertificate.normalize_policy/1`; non-canonical order fails closed on the
      certificate's signature list, not on the policy. An absent or invalid policy yields
      `:unauthorized_beacon` for a witnessed beacon, preserving the root-only default.
- [ ] Root-authorized replacement is permitted through the existing fold and tested six ways (add,
      replace, non-root attempt, a beacon before the replacement, a beacon forking around it, and an
      invalid replacement). `collect_policies/3` keeps its `Map.merge` over every valid root-authored
      genesis with no `:__beacon__` special case in either runtime, the replacement applies from its
      genesis op's causal position, an invalid replacement is discarded rather than quarantining the
      genesis, and no sentence in the plan, the spike or a product surface says the beacon policy
      cannot be changed after creation. What is said instead: only the replica root can change it,
      and no root genesis is possible once the founder key is gone.
- [ ] The beacon judge resolves its policy from **each candidate beacon's own causal ancestry** (the
      latest valid `:__beacon__` among the genesis ops in that ancestry, in the shared topological
      order, validated before it replaces the previous value), never from one globally merged policy.
      `collect_beacons/4` takes the ordered beacon-policy sources rather than the `collect_policies/3`
      result; the global fold is unchanged and still feeds every role timeline; `collectBeacons` in
      `authority.ts` resolves the same way from the ancestor set it already computes, so the two
      runtimes agree on a log carrying two beacon-policy geneses.
- [ ] The policy is validated by its own shape and nothing else: no `all_roles/1` call and no schema
      context, so `analyze/2` and `expired?/2` build the identical beacon-policy sources from the
      same log and therefore resolve the identical policy for every op, and `expired?/2` keeps its
      `(Log, delegation_id)` arity with `read_model.ex` and `lease_lapse_test.exs` unchanged.
- [ ] `max_epoch_step` is a genesis-pinned policy field validated against the `1..65_535` ceiling,
      so a policy pinning `Lattice.Canonical.max_integer/0` fails closed and the step bound cannot be
      made vacuous by the policy that enforces it. The `2^53-1` horizon is **not** a policy field: it
      is a fixed protocol constant in both runtimes, a genesis attempting to pin it is rejected as a
      sixth key, and no log content can raise or lower it. Neither bound is read from a
      log-configurable genesis field for the horizon or from anywhere but the resolved policy for the
      step.
- [ ] The two bounds are enforced at the two layers this plan pins, and the reasons match across
      runtimes. The step bound is a beacon-judge verdict: an epoch above
      `prior_max + max_epoch_step` is `:unauthorized_beacon`. The horizon is structural and runs
      before the judge: an epoch above `9_007_199_254_740_991` (`2^53-1`), in the witnessed body or in
      the certificate claim, is `:malformed_term` on the BEAM through the extended
      `malformed_tick_body?/1` and `malformed_term` in TypeScript through the existing
      `parseCarrierInteger` path, honored by neither runtime and lapsing no lease. So neither one jump
      nor accumulated jumps can reach `Lattice.Canonical.max_integer/0` on that branch, and
      `township_beacon_witnessed_horizon` pins the `2^53` verdict on both sides. No TypeScript
      decoder was widened to carry an above-horizon value.
- [ ] The root branch keeps its current unbounded behavior and its current bytes, and the PR states
      the descendant-scoped reading on **both** branches: a beacon at or above the horizon ends
      witnessed advancement only for ops that carry it in ancestry, never for the life of the
      replica, and the step 2b fork test proves it in two arms, a witnessed beacon on deps that
      exclude a high root beacon and a witnessed beacon on deps that fork from before a witnessed
      beacon honored at `2^53-1`, each honored at the lower epoch on every replica while a descendant
      of the high beacon is refused.
- [ ] A `Sim.create_replica` carrying a reserved `:__beacon__` policy actually builds, proved by
      its own test; the three existing `resolve_policy/2` clauses are unchanged in behaviour.
- [ ] `Lattice.Authority.expired?/2` computes the genesis policies and passes the beacon policy
      into `collect_beacons/4` exactly as `analyze/2` does, and one witnessed beacon lapses the
      same lease through both paths, with `apps/lattice_core/test/toolshed/read_model_test.exs`
      green.
- [ ] The author rule is stated in the PR and enforced: only the replica root or a realm in the
      policy's witness list may author a witnessed beacon op.
- [ ] The certificate claim is `(version, replica, epoch, author, deps)`, verified by structural
      equality against `op.author` and `op.deps`, and the 2b lifted-certificate case is
      `:unauthorized_beacon` on every replica while a lease honored before the original beacon stays
      honored. The `(replica, epoch)`-only shape appears nowhere in the diff, and no sentence claims
      the certificate is valid for exactly one op: the PR states the narrow property (bound to one
      author and one ancestry) and pins the permitted same-author duplicate with its own test showing
      an identical lapse set.
- [ ] The step 2d partition and heal test shows every replica agreeing on the quarantine set and
      materializing byte-identically.
- [ ] The AF-2 revoke narrowing is stated in the PR and proved by the 2c negative control: a
      surviving member's revoke of a founder-issued delegation is `:unauthorized_revoke` on every
      replica, and no sentence anywhere implies founder-issued delegations are revocable after
      founder loss.
- [ ] A witnessed beacon is honored in BEAM and TypeScript under the same monotonicity rule and
      with the same `:unauthorized_beacon` and `:stale_beacon` reasons, and an above-horizon epoch
      carries the same structural `malformed_term` verdict in both.
- [ ] TypeScript can **author** as well as replay: `codec.ts` exports a beacon-claim canonical-bytes
      function under its own separator beside the succession one (which is unchanged, not
      generalized), `township.ts`'s `TownshipGenesisPolicy` and `townshipGenesisPoliciesTerm` accept
      the beacon policy, `authorTownshipGenesis` produces a genesis whose canonical bytes equal the
      BEAM-authored one, and canonical encoding is not duplicated inside `authority.ts`.
      `npm --prefix clients/lattice-client run township:authoring` is green and carries both
      parity assertions.
- [ ] A replica with no beacon policy behaves exactly as at `8200c38d`: root-only beacons, and a
      witnessed beacon is `:unauthorized_beacon`.
- [ ] The AF-2 Sim test is green with the founder realm removed: a member is admitted, a
      delegation is revoked, the beacon advances, a lease lapses, every replica materializes
      byte-identically, and the subthreshold negative control is `:unauthorized_beacon`
      everywhere.
- [ ] No new op kind exists: the beacon is a body of the existing `:authority` kind.
- [ ] The five new vectors exist and pass conformance, including
      `township_beacon_witnessed_horizon`; every pre-existing vector is byte-identical, enumerated in
      the report, with `township_beacon_unauthorized` and the four lease vectors checked first and
      named explicitly.
- [ ] `known_dump_policy_atoms/0` carries every new atom and a dump holding a witnessed beacon
      restores in a freshly booted VM.
- [ ] `Lattice.Canonical` is unchanged.
- [ ] The dormancy arithmetic and the role timeline fold are unchanged.
- [ ] The compaction GATE was **extended** to carry a witnessed beacon and a lease whose
      `expires_epoch` straddles the frontier, recorded red against the unchanged mirror and green
      after, so the gate can detect a compacted reducer that drops witnessed-beacon evidence. Passing
      the `8200c38d` GATE unchanged does not satisfy this criterion.
- [ ] `treehouse/contract_test.exs` passes unchanged, and no sentence anywhere claims founder-loss
      survival, "nothing hosted", "serverless", E2EE, guaranteed availability or safe unbounded
      history.
- [ ] Every mutation in the test plan produces a named failure, recorded in the report.
- [ ] Step 1 merged as its own PR before step 2 began; BEAM and TypeScript then land together in
      the second PR with the regenerated vectors.
- [ ] ADR 0004 records the witness-set beacon emitter, the epoch bound, and the remaining
      non-claims; `docs/lattice_poc_status.md` 221-229 is updated in the same PR, mirroring Plan
      145 "GREEN 4 - claim-boundary documents". `TOWNSHIP_BUILD_MAP.md` stays untouched.
- [ ] `plans/README.md` row 179 updated; Plan 158 and Plan 177 carry appended AF-2 status lines
      with no reworded line.
- [ ] `git status` shows no modified file outside the In-scope list. Note that the list includes
      `clients/lattice-client/src/op.ts`, `clients/lattice-client/src/codec.ts`,
      `clients/lattice-client/test/township_authoring.ts`,
      `apps/lattice_core/lib/lattice/log.ex`, `docs/adr/0004-succession-validation.md` and
      `docs/lattice_poc_status.md`.

## Maintenance notes

- **Reviewer focus**: the domain separator. A beacon certificate and a succession certificate must
  not be interchangeable, or a witness set pinned for one purpose silently gains the other. The
  second focus is everything the judge reads from ancestry: the witnessed branch must reuse the exact
  `classify_beacon/6` prior-max computation, not a global maximum, or two concurrent witnessed
  beacons diverge across replicas, and it must resolve its **policy** from the same candidate's
  ancestry rather than from the globally merged `collect_policies/3` map, or a beacon that predates a
  root replacement, or forks around it, is judged under the wrong policy and an invalid replacement
  silently overwrites a valid one. Step 2d is that focus made executable, and step 3's
  author-and-deps binding is what it tests; a reviewer who sees the phrase "the prior valid beacon
  op id" anywhere in the diff should reject it, because in the concurrent case there are two. A
  reviewer who sees a claim that omits `deps` or `author` should also reject it, and so should a
  reviewer who sees the claim described as valid for exactly one op, which it is not: the third
  focus is the 2b lifted-certificate case,
  where one listed witness below threshold re-publishes an honored certificate with pruned deps and
  retroactively lapses leases that were honored. That is a revocation vector this plan creates if
  the binding is weakened, and it is the reason the `(replica, epoch)`-only shape is rejected
  rather than offered.
- **What the witness set is really being handed.** Read the Non-goals bullet on beacon power and
  spike sections 6.6 and 8.1 before reviewing step 3. The epoch is not a decorative counter: it is
  the only thing that lapses a Plan 149 lease, so this plan gives a threshold of witnesses the
  ability to expire other members' delegations, and without the `max_epoch_step` bound it gives
  them a one-shot permanent version of that plus a permanently stopped clock. Any product surface
  or one-pager describing the witness set must name that power in the same sentence as the grant,
  per Plan 177 D1.
- **The reason atoms are a cross-runtime contract.** `:unauthorized_beacon` and `:stale_beacon`
  are reused deliberately so no new atom has to be mirrored; if a reviewer wants a distinct reason
  for a failed certificate, it must be added to both runtimes and to a vector in the same PR.
- **What this plan does not settle.** Decision 1 of the spike stays at option D. If Township ever
  needs automatic dormancy, the designated shape is the spike's policy-gated option B, an opt-in
  `%{successor, dormant_epochs: n}` comparing beacon epochs, with a new field name so every plain
  `dormant_ticks` vector stays byte-identical and a policy carrying both fields is invalid. That
  is a separate plan and it depends on this one.
- **Who may set the beacon policy, and when.** Corrected in review round ci-2; an earlier version
  of this note said a replica whose genesis pinned no beacon policy could not adopt one later. It
  can, and the fold already allowed it before this plan: `collect_policies/3` (`authority.ex`
  492-507) merges the policies of every valid root-authored genesis, and
  `township_genesis_projection_parity` (`lattice.export_vectors.ex` 509-608) is the existing
  demonstration of a second root genesis replacing the first policy. So the replica root may add or
  replace `:__beacon__` at any time, applying from that genesis op's causal position, which the judge
  implements by resolving the latest valid entry in each candidate beacon's own ancestry rather than
  by reading the globally merged policy map; a witness,
  holder or member may never change it, an invalid replacement is discarded rather than honored, and
  once the founder realm is gone no root key survives to author another genesis, which is what
  freezes the policy after founder loss. A product surface describing the choice says that: the
  founder can change the witness set while the founder key lives, and nobody can afterwards. It must
  not say the set is unchangeable, and it must not say a group can repair its witness set after
  losing the founder. The ADR 0004 **succession** policy-migration question stays open for a
  different reason than the one previously recorded: the fold plainly permits a later root genesis
  to replace a role's `%{successor, dormant_ticks}` policy with a `%{successor, recovery}` one, and
  the witnessed arm of `decide_succession_proof/7` never consults dormancy (spike section 6.3), so
  whether that rescues an **already pinned** role is an open question this spike did not reproduce
  and this plan does not answer. What is settled either way is that no such repair exists once the
  founder key is gone.
