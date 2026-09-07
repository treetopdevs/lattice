# Adopted R19b mirror beacon evidence and lease context

Adopted for implementation on 2026-09-06 under the user-authorized unified Treehouse program. Independent Sol final review passed with no P0-P2 findings. This adoption authorizes only the exact source boundaries and gates in the two preserved packets below; the second packet supersedes the first only where it explicitly refines the application lease seed. Their original proposal-only wording is retained as provenance, not an outstanding approval requirement.

Integration baseline: `2368194077cda1f58206e292d20d6b3681b036a4`, combining reviewed application mirror `862625ceed86451bb9d73532139bd3af82364d81` and reviewed continuity prerequisites `ac43bcc7f27eb5a199ddecd66d6d337fe8522453`. The reducer and evidence API remain subject to source review and root-owned full validation. This does not close R19b A01-A17 or activate continuity commands.

Preserved packet SHA-256 values:

- Original API packet: `c57299644b2d41ef4878f9a6a9166f9ad28f3f84fe06c9b4caba471d840022a4`.
- Lease refinement: `b27eb1b15fcea817bc132a7506fb3b9b3adac356b63a69ca0af86acf89a835bc`.

# R19b application mirror: Authority beacon-evidence boundary

Proposal only. No repository source, tests, generated files, vectors, or default snapshot contracts are changed by this document.

Prepared by the configured reviewer/implementer model `gpt-5.6-sol` (root spawn configuration), from immutable sources:

- current Authority/context source `f649e4b7fc13f6fdce4d24acede625ae1de28c40` in `/Users/nicholas/develop/lattice-treehouse-r19b-prerequisites-20260907`;
- application mirror `862625ceed86451bb9d73532139bd3af82364d81` in `/Users/nicholas/develop/lattice-treehouse-r19b-application-mirror-20260907`;
- the P2 review `/tmp/lattice-treehouse-execution-20260906/sol-r19b-mirror-beacon-context-refinement-review.md`.

This proposal resolves only the missing pre-conflict beacon-evidence boundary. It does not approve implementation, narrow the mirror profile, add a second beacon judge, or close any R19b semantic gate.

## Concrete fault

`Authority.analyze/2` already has the exact evidence the mirror needs. It calls `collect_beacons/4` once before command validation and passes the resulting `beacons` through `cap_evidence.beacons` to each command's causal-context builder. That builder filters the list to the command's strict ancestors and sorts it by `op_id`.

The final `analysis.reasons` map cannot reconstruct this source set. Full-frontier command conflicts can add a final reason to a valid beacon after command callbacks have run. Independently, `unsupported_profile_ops/2` overwrites every individual reason with `:unsupported_authority_profile`, including both accepted and rejected beacon records. Consequently neither final reasons nor `covered_individual_reasons` distinguishes a valid beacon from an unauthorized, stale, or malformed one for every log that the application mirror currently accepts.

Ignoring an overwritten reason is unsafe. It would turn the body shape of an invalid signed operation into authority evidence. Refusing unsupported continuation families would be a new profile restriction. The narrow fix is to expose the existing judge's result from the same analysis pass.

## Authority API amendment

Add these exact public types to `Lattice.Authority`, without changing the existing `analysis()` type:

```elixir
@typedoc "One beacon accepted by this analysis pass's existing beacon judge."
@type valid_beacon_evidence :: %{
        required(:op_id) => Op.id(),
        required(:epoch) => non_neg_integer()
      }

@typedoc "Accepted beacon records sorted by raw op-id bytes in ascending order."
@type beacon_evidence :: [valid_beacon_evidence()]
```

Add one narrow entry point:

```elixir
@doc """
Runs the ordinary authority analysis once and returns its unchanged result with
the complete beacon records accepted by that same pass's existing beacon judge.

The evidence is sorted by raw `op_id` bytes. It is global to `log`; it has not
been filtered to an arbitrary operation's causal past. It is immutable judgment
evidence, not a capability, authority grant, trust receipt, persistence claim,
or proof that a particular operation observed a beacon.
"""
@spec analyze_with_beacon_evidence(module(), Log.t()) ::
        {analysis(), beacon_evidence()}
def analyze_with_beacon_evidence(module, %Log{} = log), do: do_analyze(module, log)
```

Refactor the current body of `analyze/2` into a private `do_analyze/2`. Its computations and ordering stay intact. At the current end of the body, bind the existing seven-key analysis map and return it with a sorted copy of the already computed `beacons`:

```elixir
analysis = %{
  quarantine: reasons |> Map.keys() |> MapSet.new(),
  reasons: reasons,
  holders: holders,
  holder_epochs: holder_epochs,
  policies: policies,
  audit: role_audit ++ cmd_audit ++ conflict_audit,
  requests: requests
}

{analysis, Enum.sort_by(beacons, & &1.op_id)}
```

Keep the ordinary API as a wrapper:

```elixir
@doc "Full authority analysis for `log` interpreted by Replica `module`."
@spec analyze(module(), Log.t()) :: analysis()
def analyze(module, %Log{} = log) do
  {analysis, _beacons} = do_analyze(module, log)
  analysis
end
```

The private implementation must not call `collect_beacons/4` again, reparse beacon bodies, infer validity from reasons, rerun `analyze/2`, or perform a second application-policy/conflict callback pass. The returned records must be the same `beacons` value placed in `cap_evidence` and used by `causal_context/6`. Sorting is applied only to the returned copy. The existing causal-context path retains its current filtering and sorting, preserving ordinary callback behavior.

The `analyze/2` result remains exactly the old seven-key map. It receives no evidence field or metadata key. Its deterministic term bytes, callback order, callback count, reasons, audits, requests, and failure behavior remain the existing contract. Existing helpers such as `quarantine/2`, `holder/3`, and `holder_epoch/3` continue to call `analyze/2` unchanged.

Add one short module-documentation paragraph near the current application-policy context description: `analyze_with_beacon_evidence/2` exposes the same globally accepted beacon source set used by that context; consumers must establish causal visibility before applying it to an operation. The paragraph must repeat that the list grants no authority.

## Application mirror use

Amend only `build_application_snapshot/5` in the opt-in test-support mirror:

```elixir
covered_log = Log.from_ops(replica, covered_ops)

{analysis, covered_valid_beacons} =
  Authority.analyze_with_beacon_evidence(module, covered_log)
```

Set `ApplicationSnapshot.covered_valid_beacons` directly to `covered_valid_beacons`. Do not call `Authority.analyze/2` first, do not retain the reason-based `continuation_beacons/2` derivation for this field, and do not analyze the combined covered-plus-retained log.

Snapshot verification already reconstructs an authentic `covered_log` and calls `build_application_snapshot/5`. It must therefore recompute the same evidence through this entry point before accepting the hash. Container validation stays closed to the existing record shape `%{op_id: binary, epoch: integer}` and evidence recomputation remains the semantic check. No caller-supplied list or cached analysis is trusted.

The reducer uses the verified `snapshot.covered_valid_beacons` as the covered beacon source for the three-key application callback context. Under the existing legal-cut predicate, every retained operation causally dominates the complete covered frontier and hence every covered operation. Therefore every record in this covered global source set is in every retained command's strict past. No additional per-command beacon judgment is needed, and no invisible-covered-beacon fixture is valid at a legal stable cut.

The same verified list seeds any application-mirror continuation context that represents covered valid beacons. Retained authority/beacon/tombstone operations remain outside `:covered_authority_v1`; this proposal adds no retained-beacon admission path.

The mirror still performs exactly one retained individual fold, one final combined conflict pass, and full raw `Reduce` replay. The final conflict pass may name a covered beacon, but it must not retroactively alter the evidence that the ordinary pre-conflict command fold observed. Unsupported continuation families retain their existing blanket final reasons and empty requests; the policy callback still receives the valid pre-overlay evidence when its ordinary capability and authority gates are satisfied.

## Serialization boundary

The default `CompactionSpike.Snapshot` struct, its fields, `compact/3`, `verify/3`, `reduce_compacted/3`, hash function, and all existing default snapshot byte/hash pins remain untouched.

`ApplicationSnapshot` keeps its current struct, version, field names, field types, hash algorithm, and container rules. Histories for which the current reason projection already equals the existing beacon judge produce the same `covered_valid_beacons` list and must retain their exact application-snapshot bytes and hashes. Two newly characterized application histories intentionally change:

1. a valid covered beacon later named by the full-frontier conflict hook; and
2. a valid covered beacon whose per-op reason is overwritten by the unsupported-profile blanket.

Those snapshots now commit the correct nonempty pre-conflict evidence and get new deterministic application-snapshot hashes. This is not authorization to regenerate unrelated pins or vectors.

## Dependency and source boundary

The implementation allowlist is:

- `apps/lattice_core/lib/lattice/authority.ex` — types, documentation, wrapper, and private return refactor only;
- `apps/lattice_core/test/lattice2/authority_test.exs` and/or `apps/lattice_core/test/lattice2/application_policy_beacon_context_test.exs` — public API, one-pass, and evidence-source regressions;
- `apps/lattice_core/test/support/compaction_spike.ex` — application snapshot construction and verified callback forwarding only;
- `apps/lattice_core/test/lattice2/application_compaction_mirror_test.exs` — application mirror equivalence, delivery, tamper, and pin regressions.

No new library, application, package, runtime, native, or TS dependency is introduced. `CompactionSpike` already depends on `Lattice.Authority`, so the new call creates no dependency cycle. Do not edit `Lattice.Op`, `Lattice.Log`, `Lattice.Dag`, `Lattice.Replica`, `Lattice.Reduce`, continuation/beacon validation, TS policy/quarantine, shared vectors, command registration, docs/index/CI, or generated artifacts under this packet.

If a dedicated test module is clearer, it must remain under the same `apps/lattice_core/test/lattice2/` test boundary and replace, rather than duplicate, equivalent cases. Production code beyond `authority.ex` is outside scope.

## Required regression packet

### 1. Ordinary API compatibility and single pass

- For signed legacy, bounded-continuation, and unsupported-family logs, assert `Authority.analyze/2` equals the first tuple element returned by `analyze_with_beacon_evidence/2`, including exact map keys and deterministic term bytes.
- Use an observing test policy to prove each public call invokes `command_op_status/3` and `command_conflicts/3` exactly once per operation/pass. Isolate observations per call: the comparison test must not mistake two separately requested public calls for duplicate work inside one call.
- Preserve all existing authority, application-policy-context, and vector results byte-for-byte. No callback receives an added invocation or reordered input.

### 2. Exact evidence projection

Use authentic signed operations and existing Wire round trips:

- no beacon returns `[]`;
- signed epoch zero is present rather than conflated with absence;
- causal epochs retain every record, and concurrent valid equal maxima are retained once each in ascending raw `op_id` byte order;
- legacy epochs `9_007_199_254_740_992` and `18_446_744_073_709_551_615` stay exact integers;
- stale, unauthorized, malformed-certificate, malformed-epoch, and beacon-shaped wrong-kind operations are absent;
- for a command causally after the complete beacon set, the API evidence exactly equals the existing `context.valid_beacons` observed by that command. For a command with a smaller causal past, its ordinary callback retains the existing strict-ancestor subset; the global API result is not incorrectly presented as per-command visibility.

These tests exercise the existing judge. They must not define a second expected-validity algorithm from operation bodies alone.

### 3. Conflict overwrite

Create a signed covered log with a valid beacon, an eligible command that observes it, and a test-local `command_conflicts/3` implementation that returns the beacon ID as a loser. Prove:

- the command's ordinary pre-conflict callback receives the valid beacon;
- `analyze_with_beacon_evidence/2` returns that beacon once;
- the final `analysis.reasons` and quarantine may contain the conflict reason for that beacon;
- construction and verification retain the beacon in `ApplicationSnapshot.covered_valid_beacons` despite the final reason;
- a retained command after a legal stable cut receives the same list in the mirror, and the final full result and normalized callback trace match the uncompacted path.

No second conflict pass may be used to recover the evidence.

### 4. Unsupported-profile overwrite

Create an authentic signed unsupported-continuation-family log containing at least:

- one valid covered beacon;
- one rejected covered beacon (and preferably separate stale, unauthorized, and malformed controls so a body-only implementation cannot pass);
- one covered or retained command whose capability and authority gates permit the application callback; and
- one retained eligible command that dominates the complete covered frontier.

Use a real test policy that distinguishes a missing `valid_beacons` key, an empty list, the exact valid list, and a list containing invalid evidence. Prove ordinary analysis and the evidence entry point expose only the valid record to the eligible callback while final reasons remain `:unsupported_authority_profile` for every operation and final requests remain empty. At the stable cut, mirror construction/verification commits the same valid-only list, the retained callback sees it, and the final blanket results still match. Run both append delivery and reverse-tip `Sync.reconcile` delivery and compare the complete result plus a normalized ordered callback trace.

The test must fail if the implementation recovers beacons from overwritten reasons, ignores all unsupported reasons, admits a rejected beacon, narrows the accepted profile, or skips the application callback.

### 5. Legal cut and refusal controls

- Assert the retained command causally dominates every ID in the covered frontier before claiming mirror equivalence.
- Preserve the structured unstable-frontier refusal for a command that does not dominate the cut.
- Preserve the structured outside-profile refusal for retained beacon, authority, or tombstone operations. This API does not make those operations admissible.
- Preserve capability, operation-scope, holder, revoke, lease, malformed-command, and unknown-command precedence. Beacon evidence cannot bypass any gate.

### 6. Snapshot integrity and delivery equivalence

- Pin the existing default `Snapshot` keys, serialized bytes, and hash unchanged.
- Pin existing unaffected `ApplicationSnapshot` bytes and hashes unchanged.
- Add deterministic pins for the newly characterized conflict and unsupported snapshots rather than rewriting unrelated fixtures.
- Reject application snapshot tampering that drops, adds, duplicates, reorders, changes the epoch of, changes the ID of, or substitutes an invalid beacon record. Overall `reduce_application/3` must fail through closed container/evidence recomputation even where a shallow shape check alone would pass.
- For every accepted new semantic fixture, compare actual append and reverse-tip reconcile delivery histories, complete authority/mirror results, raw reduced state bytes, and normalized callback traces. Do not normalize traces through a map that erases duplicate calls or order.

## Local gates after adoption

Run only after an independent review adopts this packet:

1. meaningful signed public RED on the current immutable sources for the conflict and unsupported cases;
2. focused Authority and application-policy beacon-context tests;
3. focused application compaction mirror tests, including both delivery paths;
4. `mix format --check-formatted` on the allowlisted files and scoped `mix credo --strict` with zero new findings;
5. exact default `Snapshot` and unaffected `ApplicationSnapshot` serialized hash proofs;
6. existing BEAM/TS canonical and context vectors byte-identical;
7. root-owned full serialized `mix check` in a unique task `TMPDIR` after integration.

Use the repository-required asdf OTP 28 / Elixir 1.19.5 toolchain and the task-local dependency/build paths selected by root. A focused green run does not close the whole R19b plan.

## Residual boundaries

- The returned evidence is global to one authenticated `Log` analysis. Outside the application mirror's proven stable-frontier condition, a consumer must perform the same strict-ancestor filtering as ordinary `causal_context/6`; the API does not prove visibility by itself.
- Public callbacks can have test-local observation side effects. Calling both public entry points intentionally performs two analyses; production construction must choose `analyze_with_beacon_evidence/2` once rather than call both.
- The packet does not prove production compaction durability, continuity-epoch semantics, native persistence, TS application-consumer parity, or a broader retained authority profile. Those gates remain open.


---

# R19b application mirror: Authority beacon evidence and lease-seed refinement

Proposal refinement only. No repository source or tests were changed or run.

Prepared by configured model `gpt-5.6-sol` (root spawn configuration) from:

- Authority/context source `f649e4b7fc13f6fdce4d24acede625ae1de28c40`;
- application mirror `862625ceed86451bb9d73532139bd3af82364d81`;
- accepted API proposal `/tmp/lattice-treehouse-execution-20260906/r19b-mirror-authority-beacon-evidence-proposal.md`, SHA-256 `c57299644b2d41ef4878f9a6a9166f9ad28f3f84fe06c9b4caba471d840022a4`; and
- independent review `/tmp/lattice-treehouse-execution-20260906/sol-r19b-mirror-authority-beacon-evidence-proposal-review.md`.

This document preserves the prior proposal's Authority API, exact types and module documentation, one-pass collector boundary, unchanged `analyze/2` map and bytes, accepted `:covered_authority_v1` profile, snapshot verification, serialization rules, source allowlist, and gates. It supersedes only the prior application-reducer beacon-consumer description, which omitted the lease gate.

## Remaining fault

The application snapshot currently contains `covered_valid_beacons`, and the prior proposal correctly sources that field from the existing Authority collector. The application reducer has two distinct consumers of covered beacons:

1. `application_covered_authority_seed/2` passes `snapshot.covered_valid_beacons` into `Continuation.context/6` (`compaction_spike.ex:484-493`); and
2. retained capability validation calls `seeded_expired_as_of?/3`, which reads `ctx.beacons` (`:1378-1383,1442-1454`).

At `862625ce`, the second path is still seeded as one synthetic record from `base.covered_beacon_epoch` (`:377-406`). That default-snapshot maximum is built from beacon-shaped authority operations absent from final `analysis.reasons` (`:670-706,1457-1473`). A valid beacon later named by `command_conflicts/3`, or hidden by the unsupported-family blanket, is therefore absent from the maximum even though full Authority used the accepted beacon for lease expiry before either overlay.

This is not only a callback-context mismatch. With a supported profile, a retained command citing a finite delegation can be `:lease_expired` under full Authority and honored under the mirror. With an unsupported profile, the blanket final reason hides that intermediate reason difference, but the mirror can wrongly invoke the application callback before applying the blanket.

## Exact application-arm amendment

Keep snapshot construction exactly as in the accepted proposal:

```elixir
covered_log = Log.from_ops(replica, covered_ops)

{analysis, covered_valid_beacons} =
  Authority.analyze_with_beacon_evidence(module, covered_log)
```

Store that already sorted, exact two-field list directly in `ApplicationSnapshot.covered_valid_beacons`, and verify it by rebuilding the authentic covered log through the same one-pass API. Do not derive it from reasons or beacon bodies.

In `reduce_verified_application/4`, replace only the application arm's synthetic maximum:

```elixir
# Every covered record is in every retained op's strict past after
# verify_application_cut/3 accepts the stable frontier.
covered_lease_beacons =
  Enum.map(snapshot.covered_valid_beacons, fn %{op_id: op_id, epoch: epoch} ->
    %{op_id: op_id, epoch: epoch, covered?: true}
  end)
```

Build the private application context with both representations from the same verified source:

```elixir
ctx = %{
  # existing keys unchanged
  beacons: covered_lease_beacons,
  valid_beacons: snapshot.covered_valid_beacons
}
```

The two-field `valid_beacons` list is passed unchanged to the retained application's three-key callback context:

```elixir
ctx.module.command_op_status(op, strict_ancestors, %{
  visible_ops: visible_ops,
  verdicts: verdicts,
  valid_beacons: ctx.valid_beacons
})
```

The three-field `beacons` list is consumed by the existing `seeded_expired_as_of?/3` without modifying that shared helper. Each record is marked `covered?: true` because `verify_application_cut/3` has already proved that every retained operation dominates the full covered frontier; transitivity makes every covered beacon a strict ancestor of every retained command. An empty verified list becomes an empty lease list. Do not retain a `%{op_id: nil, epoch: -1}` sentinel in this application arm.

This preserves lease precedence exactly: capability shape, validity, audience, command scope, introduction visibility, role scope, and revocation remain before expiry; expiry remains before `command_op_status/3`. The evidence is a lease input only after every earlier gate succeeds. It grants no capability and cannot activate a delegation.

## Complete application-arm beacon flow

After this amendment there is one semantic source and no second judge:

1. `Authority.analyze_with_beacon_evidence/2` returns the existing collector's accepted covered records from the same pass as the unchanged analysis.
2. `ApplicationSnapshot.covered_valid_beacons` hashes those exact sorted records and snapshot verification recomputes them from authenticated `covered_ops`.
3. `application_covered_authority_seed/2` continues to pass the exact two-field records to `Continuation.context/6`. No change is required in continuation pin, family, timeline, or covered-ID construction.
4. `reduce_verified_application/4` derives `covered_lease_beacons` only by adding `covered?: true` to each verified record. `seeded_expired_as_of?/3` uses that list for every delegation-chain link's `expires_epoch` comparison.
5. `validate_application_command/4` receives the same exact two-field records as `valid_beacons` after lease validation. Because the stable cut makes the whole covered closure visible, it does not re-filter them per retained command.
6. `build_seeded_timeline/7` has no direct beacon input; it receives `seed.continuation`, which was already built from the verified list. No timeline or authority-acquisition logic changes.
7. The one final combined conflict pass remains after the retained individual fold. It cannot retroactively remove a beacon from either the earlier lease decision or callback context.

The default `Snapshot` arm remains exactly unchanged. Its `covered_beacon_epoch`, `covered_beacon_basis`, `seeded_beacons/5`, `seeded_continuation_context/7`, default `ctx.beacons`, legacy helpers, hashes, and serialized pins continue to serve only the previously reviewed default compaction experiment. The application arm may still embed that default snapshot as `base_snapshot`, but it no longer treats the base's reason-derived maximum as its lease evidence.

No retained beacon is admitted. Retained `:authority`, beacon, or tombstone operations continue to fail the existing application profile before reduction.

## Required combined RED/GREEN regressions

### Supported conflict plus finite lease

Build one real signed history in which:

- a finite delegation visible to the retained command has `expires_epoch: 0`;
- a valid covered beacon has epoch `1` and is in the covered closure;
- the test policy's actual `command_conflicts/3` names that beacon ID as a loser after individual evaluation;
- the retained command cites the finite delegation, dominates every frontier ID, and would otherwise be accepted by its application callback; and
- an invalid covered beacon with a higher epoch is present as a non-expiring control.

Pin the public RED at `862625ce`: full Authority returns `:lease_expired` for the retained command without invoking its application callback, while the old mirror uses the lost maximum and diverges. After the amendment assert:

- `analyze_with_beacon_evidence/2` and the application snapshot contain the valid epoch-1 record and exclude the invalid record;
- full Authority and the mirror both return `:lease_expired` for the retained command;
- the conflict reason for the valid beacon remains in both final results;
- neither path invokes `command_op_status/3` for the expired command;
- quarantine, reasons, holders, requests, and raw reduced-state bytes match; and
- exact ordered callback and conflict traces match for append delivery and reverse-tip `Sync.reconcile` delivery. Preserve repeated events and order rather than normalizing through a map.

Add a paired signed invalid-only branch with the same finite lease but no accepted epoch above expiry. It must reach the application callback and remain unexpired. This prevents body-shape or final-reason inference from satisfying the combined test.

### Unsupported profile plus finite lease

Build a real signed unsupported-continuation-family history with:

- the same finite visible delegation and accepted covered epoch above expiry;
- at least one stale, unauthorized, malformed, or wrong-kind higher-epoch control;
- a retained eligible command dominating the complete covered frontier; and
- a policy observer that distinguishes no callback, missing key, empty list, the exact valid list, and invalid evidence.

Full Authority uses the accepted beacon at the lease gate and therefore does not call the application policy; it then applies `:unsupported_authority_profile` as the final blanket. The corrected mirror must follow the same order: no policy callback, then the same final blanket and empty requests. Assert that the evidence API and snapshot still contain exactly the accepted beacon even though final reasons do not distinguish it from rejected beacons. Compare full results, raw state bytes, and exact ordered traces under append and reverse reconcile delivery.

This unsupported test must fail if the implementation narrows the profile, skips the existing collector, includes invalid bodies, uses `base.covered_beacon_epoch`, invokes the callback before expiry, or exposes `:lease_expired` as the final reason instead of preserving the blanket.

## Preserved gates and serialization

All gates in the accepted proposal remain required, including zero, causal/concurrent, strict-past, exact high-uint64 and invalid beacon projection; ordinary `analyze/2` byte equality and one callback/conflict pass; closed snapshot tamper refusal; legal/unstable frontier controls; outside-profile refusal; actual append/reconcile delivery; scoped format/Credo; unchanged vectors; and root-owned serialized full `mix check`.

Add these exact preservation checks:

- the existing default `Snapshot` map keys, hash, serialized bytes, and all default beacon fields remain byte-identical;
- an unaffected `ApplicationSnapshot` retains its old hash and bytes;
- only newly characterized conflict-overwritten and unsupported-overwritten application snapshots acquire newly pinned hashes from the corrected evidence field;
- adding `covered?: true` is runtime-local and never changes the two-field `ApplicationSnapshot.covered_valid_beacons` serialization; and
- removing, changing, duplicating, reordering, or substituting snapshot beacon evidence still fails semantic recomputation before any lease or callback decision is accepted.

## Source and dependency boundary

The accepted source allowlist remains:

- `apps/lattice_core/lib/lattice/authority.ex` for the reviewed API/types/docs/private-return refactor only;
- focused Authority/application-context tests for that API;
- `apps/lattice_core/test/support/compaction_spike.ex`; and
- `apps/lattice_core/test/lattice2/application_compaction_mirror_test.exs`.

Within `compaction_spike.ex`, the allowed application-only changes are now explicit: snapshot construction/recomputation, the application arm's verified callback context, the application arm's `ctx.beacons` lease seed, and no other behavior. Shared `seeded_expired_as_of?/3` may be reused unchanged. No default-arm helper, Snapshot field, Core authority/beacon/continuation semantics, TS source, production compaction, command registration, vector, package, docs/index, or CI file is in scope.

The dependency graph remains unchanged: test-support `CompactionSpike` already depends on production `Lattice.Authority`; production code does not depend on test support. The evidence list is immutable derived data from an authenticated covered log, not a trust or authority grant.

## Remaining open boundaries

This refinement proves no visibility rule outside the verified stable-cut application profile. It does not admit retained authority operations, add a new beacon judge, analyze the combined log, close production compaction or durability, prove TS application-consumer parity, establish continuity-epoch semantics, or close R19b A01-A17. Independent review and root adoption are required before implementation.


---

# Independent final review: R19b mirror Authority beacon evidence refinement

## Verdict

**PASS — no P0, P1, or P2 findings.**

The refinement closes the sole P2 from the prior independent review. Read together with the original proposal, it makes the existing Authority beacon collector the one semantic source for snapshot evidence, continuation context, retained callback context, and retained capability lease validation. It does so without changing the accepted retained profile, the default snapshot experiment, the shared lease helper, or production authority semantics beyond the narrow evidence-return API.

## Reviewed inputs

- Original proposal: `/tmp/lattice-treehouse-execution-20260906/r19b-mirror-authority-beacon-evidence-proposal.md`, SHA-256 `c57299644b2d41ef4878f9a6a9166f9ad28f3f84fe06c9b4caba471d840022a4`.
- Refinement: `/tmp/lattice-treehouse-execution-20260906/r19b-mirror-authority-beacon-evidence-refinement.md`, SHA-256 `b27eb1b15fcea817bc132a7506fb3b9b3adac356b63a69ca0af86acf89a835bc`.
- Authority/context source: immutable `f649e4b7fc13f6fdce4d24acede625ae1de28c40`.
- Application mirror source: clean `862625ceed86451bb9d73532139bd3af82364d81`.
- Prior finding: `/tmp/lattice-treehouse-execution-20260906/sol-r19b-mirror-authority-beacon-evidence-proposal-review.md`.

This was a read-only proposal/source review. I made no repository changes and ran no tests or builds.

## Closure of the prior P2

At `862625ce`, the application reducer's only stale beacon consumer is the synthetic `base.covered_beacon_epoch` record installed as `ctx.beacons`; `seeded_expired_as_of?/3` reads that context list. The refinement replaces only this application-arm seed with every authenticated record in `snapshot.covered_valid_beacons`, adding only the runtime-local `covered?: true` marker.

That is the correct equivalence transform:

- snapshot verification recomputes `covered_valid_beacons` from authenticated covered operations through the proposed single Authority pass;
- the stable-cut check proves every covered record is in every retained operation's strict past, so `covered?: true` accurately represents visibility;
- full Authority checks all accepted beacon records for `epoch > expires_epoch`, and the mirror now checks the same set;
- invalid, stale, unauthorized, malformed, and wrong-kind higher beacon bodies never enter the verified set;
- the empty evidence case safely remains an empty list because the shared expiry helper uses `Enum.any?/2`;
- lease failure still occurs after capability/revocation gates and before `command_op_status/3`.

The refinement correctly leaves `covered_beacon_epoch` and its sentinel in the default `Snapshot` arm. The application snapshot may continue embedding that default snapshot for other reviewed fields, but it no longer mistakes the reason-derived maximum for application lease evidence.

## Regression quality

The required supported conflict fixture is meaningful: a signed accepted epoch above a finite lease is later hidden by the conflict overlay, while a higher invalid beacon prevents a body-shape implementation from passing. Exact full/mirror reasons, state bytes, absence of the expired command's callback, conflict traces, and append/reconcile histories are all required.

The unsupported fixture checks the separate masked-result failure mode. Both paths must suppress the callback at the lease gate and only then expose the existing blanket final reason and empty requests. The observer distinguishes no callback, a missing key, an empty list, the exact accepted list, and contamination by invalid evidence. This closes the loophole where final reason equality alone could hide a different evaluation path.

The paired invalid-only branch proves rejected bodies cannot expire a lease and that an otherwise eligible callback still runs. Snapshot tamper controls continue to require semantic recomputation, including changes to order, identity, epoch, duplication, or substitution.

## Preserved boundaries

- `Authority.analyze/2` remains the exact seven-key wrapper around one analysis pass; no second collector, body parser, policy callback, or conflict pass is introduced.
- The application mirror performs one retained individual fold, one combined conflict pass, and full raw reduction replay.
- Retained authority, beacon, and tombstone operations remain outside `:covered_authority_v1`.
- Default `Snapshot` fields, bytes, hashes, helpers, and legacy behavior remain unchanged.
- Runtime `covered?: true` annotations are not serialized into the two-field application evidence records.
- The proposal makes no production compaction, durability, native, continuity-command, broader-profile, or TS consumer claim.

The original proposal plus this refinement is ready for root adoption and implementation under its stated allowlist and gates.
