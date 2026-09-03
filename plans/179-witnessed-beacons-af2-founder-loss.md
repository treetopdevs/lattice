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
> would have left the check empty while the executor proceeded on stale assumptions.
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
>   clients/lattice-client/src/op.ts \
>   clients/lattice-client/src/township.ts \
>   clients/lattice-client/test/conformance.ts \
>   clients/lattice-client/test/vectors
> ```
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
- Policy decoders: `carrier.ts` near 1684-1693 (inside `successionPolicies` 1667-1690, which
  `continue`s past any entry lacking a 32-byte `successor`), `township.ts` near 392.
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
  flow through the compaction mirror under the same rule or the GATE test
  (`apps/lattice_core/test/lattice2/compaction_spike_test.exs` line 121) goes red.

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
- `clients/lattice-client/test/conformance.ts`
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
- No post-genesis witness rotation, and no beacon frequency requirement. A beacon confers epoch
  advancement, and it confers no operation authority and no role. It is **not** true that epoch
  advancement carries nothing else, and an earlier draft of this plan said so: epoch advancement is
  the sole driver of Plan 149 lease lapse in both runtimes (`authority.ex` `expired_as_of?/5`
  1238-1248, consumed by `cap_ok/9` at 1169; `capability.ts` line 130), so whoever may advance the
  epoch may expire every expiring delegation on the replica. Today only the replica root can, and
  the root already holds issuer-side revocation, so nothing is widened. This plan widens it: a
  threshold subset of the pinned witnesses gains mass lease revocation, and
  `docs/research/succession_tick_provenance.md` section 6.6 reproduces the worst case, one beacon
  at `2^64-1` that lapses every expiring lease, makes every later lease dead on arrival unless it
  expires at exactly the ceiling, and renders every subsequent beacon `:stale_beacon` for the life
  of the replica because `2^64` cannot be authored. Step 3 must therefore carry **both** bounds, the
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

**The verdict when the policy is absent or invalid.** A witnessed beacon under a genesis with no
`:__beacon__` entry, or with an entry that fails any validation below, is `:unauthorized_beacon`,
exactly as today. Root-only is the preserved default and an invalid policy must never widen who may
beacon; fail closed to the pre-change behavior.

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
policy closed, so witnessed beacons on that genesis are `:unauthorized_beacon` and root-only is
preserved.

**The absolute horizon, also pinned here, and it is not a policy field.** The two bounds are not the
same kind of thing, and review round ci-1 found the earlier draft calling both "genesis-pinned".
`max_epoch_step` is the fifth and last key of the beacon policy, chosen at genesis per replica.
The absolute horizon is a **fixed protocol constant**: a module attribute in
`beacon_certificate.ex` mirrored by an exported `const` in `authority.ts`, identical for every
replica, not configurable, and not expressible at genesis. That is why the accepted policy shape
above has exactly five keys and why a sixth key fails closed: a genesis that tries to pin its own
horizon is rejected rather than honored. Both runtimes spell the constant identically and neither
reads it from the log.

A per-step bound does not bound the total, because repeated legitimate increments accumulate. The
witnessed branch therefore also refuses any epoch above `9_007_199_254_740_991` (`2^53-1`)
regardless of the step, as `:unauthorized_beacon`. That
number is `Number.MAX_SAFE_INTEGER`, so the horizon also makes the two runtimes accept the same
range on this new body variant: without it a BEAM-honored `max_epoch_step` or witnessed epoch above
`2^53-1` is `null` or invalid in TypeScript (`carrier.ts` `nonNegativeInteger` at 1870-1871, the
beacon body decode at 1500-1511), no vector would ever expose it because the exporter emits no such
value, and this plan's own STOP list names conformance divergence. Both bounds are enforced in the
judge's policy layer for one new body variant, one read from the genesis policy and one compiled in;
`Lattice.Canonical` is untouched and its uint64 bound stays frozen. The root branch stays unbounded
and keeps its exact current bytes. Both runtimes enforce both bounds, spelled identically.

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
`prior_max + max_epoch_step + 1` is `:unauthorized_beacon`; one for
`Lattice.Canonical.max_integer/0` is `:unauthorized_beacon` unconditionally, since `max_epoch_step`
can never exceed `65_535` and the horizon refuses anything above `2^53-1` anyway; one for
`9_007_199_254_740_992` (`2^53`) is `:unauthorized_beacon` even from a prior epoch that the step
bound alone would allow, which is the horizon case and the case no vector could otherwise catch.
Add one scenario proving the bounds are load bearing: with them removed, a single witnessed beacon
at `2^64-1` lapses a lease whose `expires_epoch` is far below it, and every later beacon at every
encodable epoch is `:stale_beacon`. Add a second: a genesis pinning
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

Add the witnessed arm. `collect_beacons/3` learns the new body variant and takes the genesis
beacon policy as a new argument, becoming `collect_beacons/4`; `classify_beacon/6` gains the
witnessed branch and keeps the same two reasons and the same ancestry-scoped monotonicity rule as
the root branch.

**Both callers change, not one.** In `analyze/2` at 313 the policy is already in hand one line
after `collect_policies/3` at 310. The second caller is the live-path `expired?/2` at 254-277,
which calls `collect_beacons(ordered, ancestors, root)` at 264 and does **not** call
`collect_policies/3` at all: it must now compute the policies exactly as `analyze/2` does and pass
the beacon policy in. Missing this ships an internal BEAM divergence, since
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

**The epoch bounds, both of them.** The witnessed branch rejects `epoch > prior_max + max_epoch_step`
as `:unauthorized_beacon`, where `max_epoch_step` comes from the genesis policy and 2a has already
refused any policy whose step is outside `1..65_535`. It also rejects, independently and regardless
of the step, any `epoch > 9_007_199_254_740_991` (`2^53-1`) as `:unauthorized_beacon`. The step
bound alone is not enough: it is vacuous if the policy may pin an arbitrary positive step, and it
bounds one jump rather than the accumulated total, so only the absolute horizon keeps the canonical
ceiling out of reach on this branch. The horizon is also `Number.MAX_SAFE_INTEGER`, so both runtimes
accept the same range on the new body variant. `max_epoch_step` is read from the genesis policy; the
horizon is a fixed protocol constant compiled into both runtimes, per 2a. Both bounds live entirely
in the judge's policy layer; `Lattice.Canonical` is untouched and its uint64 bound is a STOP
condition.

The root branch is not bounded, so root beacons keep their exact current bytes and verdicts. State
the consequence at exactly its real width, corrected in review round ci-1. A root beacon above the
horizon ends witnessed advancement **for every op that carries that beacon in its ancestry**, which
is every op built on the frontier after it. It does not end witnessed advancement globally, because
`classify_beacon/6` computes `prior_max` over the candidate op's own ancestry: a witnessed beacon
whose `deps` fork off before the high root beacon sees a low `prior_max` and is honored below the
horizon, and the certificate for it is legitimately obtainable because the witnesses sign over those
exact `deps`. `docs/research/succession_tick_provenance.md` section 6.8 reproduces the mechanism
root-authored against the tree at `8200c38d`. Add a fork test for it in 2b: pin a policy, author a root beacon above the horizon,
then have the witness set assemble a certificate over `deps` that exclude that root beacon, and
assert the witnessed beacon is honored, that every replica agrees, and that a descendant of the root
beacon carrying a witnessed certificate is still refused. The PR states the descendant-scoped
reading and does not imply the horizon prevents the root from stopping the clock on the main
history; that is the existing root power recorded in spike section 6.6.

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
`township_beacon_witnessed_subthreshold`, `township_beacon_witnessed_founder_loss` and
`township_beacon_witnessed_concurrent` (step 2d). Regenerate with `MIX_ENV=test`, then prove the
Plan 145 and Plan 149 "regenerate, diff is empty" result: every pre-existing vector is
byte-identical. Check the five beacon and lease vectors first, because they are the ones this
step's `collect_beacons/3` change touches most directly and the only ones that pin today's
root-only rule: `township_beacon_unauthorized.json` (exporter 2602-2634, pinning
`:unauthorized_beacon` for a non-root beacon, `:stale_beacon` for a repeated epoch, and a leased
post that stays honored), `township_lease_valid_causal.json` (2481-2505),
`township_lease_expired.json` (2506-2539), `township_lease_expired_chain.json` (2540-2569) and
`township_lease_renewed.json` (2570-2601). Then the three Plan 162 succession vectors, then the
rest. Enumerate the added files in the PR and state that nothing else changed.

### Step 6: TypeScript mirror

`authority.ts` `collectBeacons` gains the witnessed arm with the same reasons, the same author
rule, the same author-and-deps claim binding and the **same two** epoch bounds as step 3,
including the `1..65_535` `max_epoch_step` policy ceiling read from the genesis policy and the
`2^53-1` horizon as a module-level `const`, spelled identically in both runtimes;
reuse the
`verifyWitnessedSuccessionCertificate` verification shape at 830 with the beacon domain separator.
Three decode sites change, not one:

- `carrier.ts` 1500-1511, the beacon **body** decoder. Today it reads
  `body.values[1]` and emits `{ type: "beacon", epoch }`, with a non-safe-integer epoch decoding to
  `null` so the reducer can still reach `:stale_beacon`. It must carry the certificate under the
  same fail-open-to-the-reducer discipline.
- `op.ts` line 124, the `AuthorityEvidence` beacon arm, currently
  `| { type: "beacon"; epoch: number | null };`. It gains the certificate field.
- `carrier.ts` 1684-1693 and `township.ts` near 392, the genesis **policy** decoders, which learn
  the reserved `:__beacon__` key. Decode it before the role loop in `successionPolicies`
  (1667-1690), never through it: that function `continue`s past any entry without a 32-byte
  `successor`, so a beacon entry routed through it is silently invisible in TypeScript while the
  BEAM honors it, which is the divergence this plan names a STOP.

`conformance.ts` gains the four new vectors. `capability.ts` line 130 keeps consuming
`validBeacons` unchanged: a witnessed beacon lapses a lease exactly as a root beacon does, which is
precisely the power the Non-goals correction names.

### Step 7: Compaction parity

Carry beacons through `apps/lattice_core/test/support/compaction_spike.ex` under the same rule, or
the GATE at `compaction_spike_test.exs` line 121 goes red. Do not touch the dormancy comparison at
538-544.

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
  range, and which of the two is genesis-pinned versus a fixed protocol constant), the
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
  `:unauthorized_beacon`; `max_epoch_step` outside `1..65_535` including zero, negative,
  non-integer, `65_536`, `2^53` and `Lattice.Canonical.max_integer/0`; a sixth key, including one
  attempting to pin the horizon; a witness that is not a 32-byte binary; and a **reordered policy
  witness list yielding the same policy id**, which is the normalization case, not a failure case.
- The certificate signature ordering case, separate from the policy case above and matching the
  precedent at `witnessed_succession_test.exs` 118-133: a certificate whose signature list is not in
  canonical order fails closed.
- Witnessed beacon verdict cases: honored, subthreshold, foreign signer, wrong replica, wrong
  epoch, deps binding mismatch, author binding mismatch, duplicate signer, non-monotonic,
  non-witness and non-root author, no policy pinned, at the epoch step bound, one past the step
  bound, at `2^53` (the horizon case, refused even where the step bound alone would allow it), and
  at the canonical ceiling (step 2b).
- The lifted-certificate case (step 2b): a listed witness below threshold re-publishes an honored
  certificate in an op with pruned deps. The op is `:unauthorized_beacon` on every replica, and a
  leased op honored before the original beacon stays honored on every replica.
- The permitted-duplicate case (step 3): the **same** author re-publishes its own honored
  certificate in a second op with the same epoch and the same deps. Both are honored, and the
  quarantine set and materialized state on every replica are identical to the single-beacon run, so
  the duplicate is inert. If it is not inert, that is a STOP.
- The horizon fork case (step 2b, from review round ci-1): under a pinned policy, a root beacon
  above the horizon, then a witnessed certificate over deps that exclude it. The witnessed beacon is
  honored below the horizon on every replica, while a witnessed beacon whose deps carry the high
  root beacon is refused. This is the executable form of the descendant-scoped lockout claim.
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
  `township_beacon_witnessed_founder_loss`, `township_beacon_witnessed_concurrent`, their exporter
  scenarios and their `conformance.ts` checks.

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
- `apps/lattice_core/test/lattice2/compaction_spike_test.exs` including the GATE at line 121.
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
- Remove the `2^53-1` horizon and confirm a witnessed epoch above `Number.MAX_SAFE_INTEGER` is
  honored on the BEAM while TypeScript decodes it to `null` or refuses the policy, which is the
  conformance divergence this plan names a STOP.
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
| `git status --short clients/lattice-client/test/vectors` | exactly four new files, no modified file |
| `npm --prefix clients/lattice-client run typecheck` | exit 0 |
| `npm --prefix clients/lattice-client run conformance` | exit 0, all PASS |
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
| `grep -rn '9_007_199_254_740_991\|9007199254740991' apps clients` | a module attribute and a `const` only, never a genesis policy field |
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
- [ ] The policy is validated by its own shape and nothing else: no `all_roles/1` call and no schema
      context, so `analyze/2` and `expired?/2` reach the identical beacon policy from the same log,
      and `expired?/2` keeps its `(Log, delegation_id)` arity with `read_model.ex` and
      `lease_lapse_test.exs` unchanged.
- [ ] `max_epoch_step` is a genesis-pinned policy field validated against the `1..65_535` ceiling,
      so a policy pinning `Lattice.Canonical.max_integer/0` fails closed and the step bound cannot be
      made vacuous by the policy that enforces it. The `2^53-1` horizon is **not** a policy field: it
      is a fixed protocol constant in both runtimes, a genesis attempting to pin it is rejected as a
      sixth key, and no log content can raise or lower it.
- [ ] The witnessed branch rejects an epoch above `prior_max + max_epoch_step` as
      `:unauthorized_beacon`, and independently rejects any epoch above `9_007_199_254_740_991`
      (`2^53-1`), so neither one jump nor accumulated jumps can reach
      `Lattice.Canonical.max_integer/0` on that branch and both runtimes accept the same range. The
      root branch keeps its current unbounded behavior and its current bytes, and the PR states the
      descendant-scoped reading: a root beacon above the horizon ends witnessed advancement for every
      op carrying it in ancestry, and the step 2b fork test shows a witnessed beacon on deps that
      exclude it is still honored below the horizon.
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
      with the same `:unauthorized_beacon` and `:stale_beacon` reasons.
- [ ] A replica with no beacon policy behaves exactly as at `8200c38d`: root-only beacons, and a
      witnessed beacon is `:unauthorized_beacon`.
- [ ] The AF-2 Sim test is green with the founder realm removed: a member is admitted, a
      delegation is revoked, the beacon advances, a lease lapses, every replica materializes
      byte-identically, and the subthreshold negative control is `:unauthorized_beacon`
      everywhere.
- [ ] No new op kind exists: the beacon is a body of the existing `:authority` kind.
- [ ] The four new vectors exist and pass conformance; every pre-existing vector is
      byte-identical, enumerated in the report, with `township_beacon_unauthorized` and the four
      lease vectors checked first and named explicitly.
- [ ] `known_dump_policy_atoms/0` carries every new atom and a dump holding a witnessed beacon
      restores in a freshly booted VM.
- [ ] `Lattice.Canonical` is unchanged.
- [ ] The dormancy arithmetic and the role timeline fold are unchanged.
- [ ] The compaction GATE passes with beacons carried through the mirror.
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
      `clients/lattice-client/src/op.ts`, `apps/lattice_core/lib/lattice/log.ex`,
      `docs/adr/0004-succession-validation.md` and `docs/lattice_poc_status.md`.

## Maintenance notes

- **Reviewer focus**: the domain separator. A beacon certificate and a succession certificate must
  not be interchangeable, or a witness set pinned for one purpose silently gains the other. The
  second focus is the ancestry-scoped monotonicity: the witnessed branch must reuse the exact
  `classify_beacon/6` prior-max computation, not a global maximum, or two concurrent witnessed
  beacons diverge across replicas. Step 2d is that focus made executable, and step 3's
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
- **Policy migration stays open** (ADR 0004). A replica whose genesis pinned no beacon policy
  cannot adopt one later, so the witness set has to be chosen at creation time. Say so wherever a
  product surface describes the choice.
