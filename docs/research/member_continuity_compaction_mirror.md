# Adopted application compaction research mirror

Integrator adoption on 2026-09-07 within the user-authorized unified program.
Actual Claude Fable independently reviewed this exact refined proposal and
returned PASS with no P0/P1/P2. The review is retained at
`/tmp/lattice-treehouse-execution-20260906/fable-r19b-compaction-refined-result.md`.
The proposal below is adopted for its exact bounded test-only implementation.
Its historical requests for adoption are satisfied by this preamble.

Allowed source ownership: `apps/lattice_core/test/support/compaction_spike.ex`
for the distinct ApplicationSnapshot and opt-in entry points/private helpers,
and new focused test/support files needed by the enumerated public fixtures.
Keep the existing Snapshot struct, compact/verify/reduce_compacted methods and
all default helper behavior/hash bytes unchanged. Production Authority, Reduce,
Core/Space/policy/codec, existing vectors and shared plans are outside this lane.
Root owns shared integration, full-suite serialization, final review and CI.

The retained-kind refusal is an explicit research profile boundary; no refused
case counts as mirrored semantics or R19b closure. Combined conflict output is
authoritative for covered and retained commands; replay every raw operation under
the newly computed final quarantine, never a frozen CRDT base. No full combined
Authority analysis may implement the mirror. The source-pinned exhaustiveness
condition includes `valid_delegation_intro?` and the global collectors it guards;
any change requires renewed review. All seven test families below remain required.
This test-only arm retains all covered raw operations and proves no storage
saving, persistent format, native behavior or original A01-A17 completion.

---

# R19b application-evidence compaction: refined research packet

Status: **proposal only**. R19b mirrored semantic gates remain **OPEN**. This packet authorizes no repository edit and makes no production compaction, persistence, storage-bound, or release claim.

Configured reviewer/designer model: `gpt-5.6-sol` (root spawn configuration).

## Reviewed source and correction inputs

This packet refines `r19b-compaction-retention-proposal.md` against `fable-r19b-compaction-proposal-result.md` and the root finding that a combined conflict pass can re-honor a covered command whose mutation was omitted from the frozen CRDT base.

The code conclusions below are pinned to immutable source `bf47f5a8`. The three relevant files are byte-unchanged at the inspected checkout tip `9d5df482b928313b7ecb711e37d275d843e116f1`, and none has a working-tree modification:

- `apps/lattice_core/lib/lattice/authority.ex`
- `apps/lattice_core/lib/lattice/reduce.ex`
- `apps/lattice_core/test/support/compaction_spike.ex`

The source facts that bound the design are:

1. `Authority.analyze/2` builds global delegation, root, policy, revoke, beacon, continuation, and role evidence before command validation (`authority.ex:480-560`). It records command individual reasons, computes one global `command_conflicts/3` pass from those individual verdicts, then merges conflict losers into the final reasons (`authority.ex:562-587`).
2. A command's application context contains only strict ancestors and their **individual** verdicts (`authority.ex:1316-1361`). It does not contain final conflict verdicts.
3. The command validation order is command shape and arity, effects, capability, holder, then `command_op_status/3` (`authority.ex:1363-1419`). `Replica.command_effects/3` validates effect shape and catches application exceptions as malformed commands (`replica.ex:197-225`).
4. Delegation validation resolves a child parent from the global delegation map, without requiring the parent introduction to be in the child's causal past (`authority.ex:611-658, 726-829`). Other authority substrate is also collected globally before causal command judgment.
5. The current `CompactionSpike.Snapshot` hash covers the complete struct term (`compaction_spike.ex:33-78, 180-185`). Adding a field changes every default snapshot's bytes and hash even if existing recomputation tests stay green.
6. The current compacted path merges frozen final covered reasons with retained reasons and folds retained mutations onto frozen CRDTs (`compaction_spike.ex:294-412, 1069-1110`). Both operations are insufficient when the combined conflict callback changes a covered final verdict.
7. `Reduce.reduce/3` deterministically rebuilds state from every honored command in the supplied DAG and uses `Replica.command_effects/3` (`reduce.ex:26-104`). It is the correct state materializer once the combined final quarantine is known.
8. The complete current op-kind domain is `:command | :authority | :inbox | :tombstone` (`op.ex:32-58`).

## Resolution of the independent review findings

### P1: combined conflict output and covered CRDT replay

The combined conflict result is authoritative for both covered and retained operations. `ApplicationSnapshot` keeps the covered-only final reasons only as historical audit evidence; they are not seeded into the combined final result.

If the combined callback re-honors a covered conflict loser, the implementation must rebuild the entire CRDT state from the combined covered-plus-retained raw log under the new combined final quarantine. It must not apply revised verdicts to `Snapshot.crdts`, and it must not fold only retained mutations onto that base. The latter loses the newly re-honored covered mutation and is observably wrong for LWW, OR-set, causal-list, and authority fields.

This research arm therefore retains all covered raw operations and deliberately gives up compaction and space savings. Its state result is:

```elixir
final_state =
  Reduce.reduce(module, combined_log,
    quarantine: MapSet.new(Map.keys(final_reasons))
  )
```

Calling `Reduce.reduce/3` is not a semantic-judgment shortcut: the arm has independently produced the quarantine and invokes the ordinary deterministic materializer. Calling `Authority.analyze/2` on `combined_log` from the compacted reducer remains prohibited because that would make the equality gate tautological.

### P2: authority rebinding boundary

The first opt-in arm has a deliberately narrower, exhaustive domain at this source pin:

> Every retained operation must have kind `:command` or `:inbox`.

Before any mirrored semantic result is returned, compute:

```elixir
outside_profile_ids =
  retained_ops
  |> Map.values()
  |> Enum.reject(&(&1.kind in [:command, :inbox]))
  |> Enum.map(& &1.id)
  |> Enum.sort()
```

If the list is nonempty, return:

```elixir
{:error, {:application_authority_rebinding_outside_profile, outside_profile_ids}}
```

This is a concrete refusal predicate over the complete current `Op.kind` enum, not a heuristic list of three known rebinding shapes. It excludes every retained `:authority` and `:tombstone` operation, and therefore excludes retained additions to the globally collected delegation/root/policy/beacon/continuation/holder/tombstone substrate that can acausally change a covered individual verdict.

A retained command or inbox operation whose body resembles `{:revoke, id}` may enter the engine's current global revoke collector. It still cannot retroactively change a covered command under the stable-frontier condition: every retained operation is causally after every covered operation, while revoke application to a command is gated by that command's causal relation to the revoke. It can affect later retained commands and must be mirrored there. A named control pins this somewhat surprising current behavior.

This proof is source-pinned. Any change to the authority collectors, op-kind domain, or causal application of authority evidence invalidates this profile until reviewed again. The refusal cases remain OPEN and do not count as equality, coverage, or R19b acceptance. This packet does not claim the retained-authority examples in the Fable report are exhaustive equivalence classes; it rejects their entire current carrier kind.

### P2: default snapshot byte contract

`%Lattice.CompactionSpike.Snapshot{}`, `compact/3`, `verify/3`, `reduce_compacted/3`, and their hash function stay byte-for-byte and behavior-for-behavior unchanged.

The research arm uses a separate function and container:

```elixir
compact_application(module, log, frontier)
reduce_application(module, application_snapshot, retained_log)

%Lattice.CompactionSpike.ApplicationSnapshot{
  version: 1,
  authority_profile: :covered_authority_v1,
  replica: replica,
  frontier: sorted_frontier,
  base_snapshot: %Snapshot{},
  covered_ops: %{op_id => %Op{}},
  covered_individual_reasons: %{op_id => reason},
  covered_final_reasons: %{op_id => reason},
  covered_conflict_losers: %{op_id => reason},
  covered_valid_beacons: [%{op_id: id, epoch: integer}],
  hash: binary
}
```

Its hash is SHA-256 over deterministic Erlang term encoding, minor version 2, of the entire `ApplicationSnapshot` with `hash: nil`. Thus it commits to the unchanged base snapshot and its hash, every retained covered op record, both reason maps, beacon records, the frontier, replica, profile, and version. Verification separately requires `CompactionSpike.verify(module, base_snapshot, covered_log) == :ok`; a self-consistent container cannot bless a corrupt default snapshot.

The API is named rather than a `compact/4` overload so an opt-in call cannot silently change default behavior. No shape/arity fix is made in the legacy reducer. The new arm alone follows the exact public `module.command_body/2` and `Lattice.Replica.command_effects/3` semantics and precedence already used by `Authority`.

## Exact construction algorithm

### A. `compact_application/3`

1. Require `Log.verify_authenticity(log) == :ok`. Bind the log replica exactly. Structural quarantine must pass the same verification, but rejected frames never become accepted ops or application evidence.
2. Compute covered and retained IDs exactly as `compact/3` does. Apply the existing stable-frontier check unchanged. Every retained op must contain every frontier ID in its strict ancestors.
3. Run the existing `compact/3` and retain its unchanged `%Snapshot{}` as `base_snapshot`.
4. Construct `covered_log` from the exact covered op map. Run `Authority.analyze(module, covered_log)` once at snapshot creation.
5. Derive `covered_conflict_losers` from audit entries whose exact shape has `event: :command_conflict`. Because `Authority` filters conflict losers to individually honored IDs before producing those entries (`authority.ex:575-587`), those IDs are disjoint from all pre-conflict reasons.
6. Define `covered_individual_reasons = Map.drop(analysis.reasons, Map.keys(covered_conflict_losers))`. Keep `analysis.reasons` separately as `covered_final_reasons`.
7. Record exact valid covered beacon records, sorted by op ID. This is future application-context evidence only; it does not change authority beacon or continuation evaluation and preserves legacy high integer behavior.
8. Build and hash `ApplicationSnapshot`. Return it with the same retained log returned by `compact/3`.

The construction gate independently proves that audit reconstruction is exact for a real conflict fixture: for every covered command, its strict-ancestor verdict map reconstructed from `covered_individual_reasons` equals the context captured during ordinary `Authority.analyze/2` execution.

### B. `reduce_application/3` validation

Refuse without producing a semantic result unless all checks pass:

1. Container version/profile/shape and hash are exact.
2. `base_snapshot.hash` is internally valid and `CompactionSpike.verify/3` succeeds against the `covered_log` reconstructed from `covered_ops`.
3. Every covered map key equals its op ID; every op has the bound replica; covered and retained IDs are disjoint; duplicate IDs with unequal bytes are refused.
4. Reconstruct `combined_log = Log.from_ops(replica, Map.merge(covered_ops, retained_ops))` and require `Log.verify_authenticity(combined_log) == :ok`. This catches missing closure, signatures, hashes, replica mismatch, dependency mismatch, and referenced-set mismatch before application callbacks run.
5. Recompute the covered set from `frontier` in the combined DAG. It must equal exactly `Map.keys(covered_ops)`. The retained set must equal the complement, and every retained op must dominate every frontier ID. This prevents a caller from moving an op across the cut while preserving a valid container hash.
6. Apply the exhaustive retained-kind predicate above. Any retained `:authority` or `:tombstone` ID yields the sorted structured refusal and no equality credit.
7. Re-derive covered conflict-audit IDs and assert `covered_individual_reasons`, `covered_final_reasons`, and `covered_conflict_losers` have closed keys and the recorded disjointness. Do not run full-log `Authority.analyze/2`.

### C. Mirrored individual fold

Under the accepted-kind predicate, retained operations cannot introduce delegations, roots, policies, beacons, holder transitions, tombstones, or continuation records. Carry those exact covered facts from the verified base snapshot. Do **not** call the spike's retained `root_creator/1` or policy/delegation merge helpers on command/inbox bodies: those helpers were written for the legacy all-kind continuation and some inspect body shape more broadly than the real kind-gated collectors. The only current cross-kind authority body is an authorized `{:revoke, id}` collected from any op (`authority.ex:911-925`); merge it for its causal effect on later retained commands. Retained inbox requests and unsupported-continuation request suppression still follow the engine. Refactor the new arm's command branch without altering the legacy branch.

Fold retained operations in `Dag.topo_sort(combined_ops)` order, skipping covered IDs. For each retained command:

1. Build `strict_ancestors = Map.fetch!(combined_ancestors, op.id)`.
2. Build `visible_ops = Map.take(combined_ops, MapSet.to_list(strict_ancestors))`.
3. Build each visible verdict from the combined **individual** reason map: covered individual reasons plus every retained base/command reason already determined in topological order. Never use `covered_final_reasons` or a conflict-loser reason here.
4. Apply the exact engine precedence:
   - body is `{cmd, args}` with list args, else `:malformed_command`;
   - `module.command_body(cmd, args)` maps bad arity and unknown command exactly as `Authority.command_status/3` does;
   - `Lattice.Replica.command_effects(module, cmd, args)` succeeds with validated effects;
   - existing seeded capability and holder checks succeed in their current clause order;
   - only then call `module.command_op_status(op, strict_ancestors, %{visible_ops: visible_ops, verdicts: verdicts})`.
5. Record the first failure reason. A successful operation gets no reason.

Ordinary inbox requests retain engine ordering and unsupported-continuation behavior. The callback is called once per individually eligible command. The mirror must not call application callbacks for malformed, unknown, bad-arity, malformed-effect, unauthorized, wrong-holder, revoked, or expired commands.

`covered_valid_beacons` is reserved evidence. If a separately reviewed callback contract later adopts `valid_beacons`, derive it as the op's strict-ancestor subset, sorted by op ID, and add it in that contract's packet. This compaction repair must not silently add an unadopted callback key.

### D. One combined final conflict pass

After all individual reasons are final:

```elixir
full_verdicts =
  Map.new(combined_ops, fn {id, _op} ->
    {id, Map.get(individual_reasons, id, :honored)}
  end)

combined_conflict_losers =
  module.command_conflicts(combined_ops, full_verdicts, combined_ancestors)
  |> Enum.filter(fn {id, _reason} ->
    Map.get(full_verdicts, id) == :honored
  end)
  |> Map.new()

final_reasons = Map.merge(individual_reasons, combined_conflict_losers)
```

Mirror the engine's existing callback handling exactly rather than adding stricter production behavior in test support. In particular, the existing honored-verdict filter already drops an unknown ID because `Map.get(full_verdicts, id)` is not `:honored`.

`covered_final_reasons` is audit-only. An equality assertion against it is valid only for covered IDs that do not change in the combined conflict pass. A difference is expected and supported by the winner-capture case.

### E. Materialization and result

Rebuild state from all combined raw operations using `Reduce.reduce/3` and `final_reasons`. Do not call `materialize_compacted/4`, seed from `base_snapshot.crdts`, or attempt a CRDT delta correction.

Return:

```elixir
%{
  state: final_state,
  quarantine: MapSet.new(Map.keys(final_reasons)),
  reasons: final_reasons,
  holders: mirrored_holders,
  requests: mirrored_requests
}
```

The full pipeline is used only by tests as an oracle. It is never called by `reduce_application/3`.

## Executable RED-to-GREEN test packet

All fixtures use genuine signed operations and first assert complete-log authenticity. Tests are public through the test-support API. They run targeted only; no full Mix or protected parallel suite is part of this packet.

### 1. Existing R19b application gap

- Preserve the current signed revoked-invitation reproduction.
- Assert default `compact/3` still exhibits its documented research gap; do not rewrite its semantics.
- Assert `compact_application/3` plus `reduce_application/3` matches full `Authority` + `Reduce`: admission has `:application_invalid_invitation`, no member is materialized.
- Non-revoked signed control remains honored and materialized.

### 2. Conflict winner capture and mandatory full replay

Use the real `PolicyFixture` or `PolicyReplica` callback:

1. Build two concurrent covered claims `A` and `B` on one key. Select labels so `A.id < B.id`; covered-only analysis quarantines `B` as `:application_conflict` and its event is absent from the covered CRDT state.
2. Put both IDs in the stable frontier.
3. Generate a retained claim `R` with deps `[A.id, B.id]`, varying a harmless label over a fixed bounded deterministic range until `R.id < A.id`. Assert the search succeeded; do not fake or rewrite an ID.
4. Full combined conflict analysis chooses `R` as the sorted first claim. Because both covered claims are ancestors of `R`, neither is concurrent with the winner; `B` is re-honored.
5. Assert the application reducer's reasons and state are byte-identical to the full pipeline and include `B`'s mutation.
6. Include a negative control that folds retained mutations onto `base_snapshot.crdts`; assert it differs from the full state. This pins the requirement to replay covered raw operations, not merely update final verdict maps.

### 3. Individual versus final context

- Build a covered conflict loser that is individually honored.
- Build a retained command causally referencing it.
- Capture the application callback context and assert the visible covered target verdict is `:honored`, matching `Authority.causal_context/5`, even though the covered-only final audit records `:application_conflict`.
- Assert removing exact command-conflict audit IDs reconstructs all captured strict-ancestor individual verdict maps byte-for-byte.

### 4. Exhaustive initial-profile boundary

- One retained signed `:authority` op refuses with its exact ID.
- One retained signed `:tombstone` op refuses with its exact ID.
- Multiple such ops in reverse arrival order return the same sorted ID list.
- Retained `:command` and `:inbox` operations do not trigger the predicate.
- A retained command and inbox with revoke-shaped bodies prove the boundary is kind-based. Their causal effect on later retained commands matches the full pipeline, while covered outcomes stay unchanged.
- Demonstrate parent introduction, covered revoke-target introduction, and root introduction as named refused examples, but label them examples only. Do not report mirrored equality for them.

### 5. Authentication, cut, and tamper controls

- Invalid signature/hash, map-key mismatch, wrong replica, missing dependency, referenced-set mismatch, covered/retained overlap, moved-across-cut op, and unstable frontier each refuse before a callback runs.
- Tamper independently with the base snapshot hash, one covered op, one individual reason, one final reason, a beacon record, frontier, profile, and container hash; each refuses.
- Pin the default contract with a known deterministic fixture: existing `%Snapshot{}` struct keys, deterministic serialized bytes, and hash from `compact/3` must be identical before and after this work. The new container gets its own distinct version/tag/hash fixture.

### 6. Command precedence and causal context

- Malformed body, known command with bad arity, unknown command, malformed effects, missing/wrong-audience/out-of-scope/invisible/revoked/expired capability, and wrong/stale holder produce the exact full-engine reason before `command_op_status/3` can run.
- Covered visible, retained visible, concurrent, future, refused, and conflict-loser targets expose exactly the expected `visible_ops` and individual `verdicts`.
- Covered valid beacon evidence is exact and ordered by op ID. Do not pass a new callback context key until its separate contract is adopted.

### 7. Anti-tautology and delivery-order gates

- Instrument the module so tests count `command_op_status/3` and `command_conflicts/3` calls and inspect their inputs.
- A source guard rejects `Authority.analyze(module, combined_log)` from `reduce_application/3`; covered-only construction/verification is the only permitted use.
- Run every accepted fixture with retained ops supplied in both orders. Hash, state, reasons, quarantine, holders, requests, callback inputs, and structured refusals must be identical.

## Closure matrix

| Cell | Initial arm disposition |
|---|---|
| Stable cut; retained `:command`/`:inbox`; revoked invitation | Must mirror; OPEN until GREEN |
| Covered conflict loser re-honored by combined winner capture | Must mirror with full raw replay; OPEN until GREEN |
| Individual-versus-final causal context | Must mirror; OPEN until GREEN |
| Shape/arity/effects/cap/holder precedence | Must mirror; OPEN until GREEN |
| Retained `:authority` of any body | Named outside-profile refusal; no equality credit |
| Retained `:tombstone` of any body | Named outside-profile refusal; no equality credit |
| R19b continuity fork/parent/voucher cases | OPEN; not claimed by this pre-continuity arm |
| Default `%Snapshot{}` serialization and hash | Must remain byte-identical |
| Production compaction, bounded storage, durable/native use | Out of scope and OPEN |

## Residual unknowns and stop conditions

1. The future continuity certificate may require retained authority operations. If so, it does not fit this initial profile. Extending the profile requires either an exact proof that the new retained authority substrate cannot rebind covered individual outcomes or a separate method to recompute covered individual authority verdicts. A list of observed examples is insufficient.
2. The first container can retain `%Op{}` terms because it is a BEAM test oracle. A cross-runtime or durable design needs a separately adopted canonical wire representation, closed schema, size limits, and migration rules. None is inferred here.
3. `valid_beacons` is not yet an adopted general application callback key. Add it only under its separately reviewed contract; the application compaction fix must not depend on an unadopted context extension.
4. Structural-quarantine evidence is authenticated as part of the source log but is not promoted into accepted application evidence. Any future callback that consumes rejected-frame evidence needs a separate design.
5. Stop and return `REVISE` if implementation changes `%Snapshot{}`, default APIs, default hashes, production Authority/Reduce, op kinds, global authority collectors, or callback contracts. Stop if any outside-profile refusal is reported as semantic equivalence.

The packet is ready for implementation review only after these boundaries are adopted. It does not close any original R19b mirrored semantic gate by itself.


## Covered delegation seed correction adopted 2026-09-07 UTC

Independent Sol review of963b0616 found that the unchanged legacy snapshot's
first-introduction collector can retain a forged same-ID delegation before a
valid introduction. The real Authority collector preserves valid introductions
and invalid-introduction diagnostics separately. A default snapshot hash only
proves that legacy summary reproduced; it is not sufficient application-authority
evidence for this covered shape.

For the new application arm only, root authorizes an exact covered authority seed
reconstructed from the already authenticated `covered_ops`. Mirror the actual
kind-gated collector's delegation value, valid introduction IDs and invalid
introduction reasons, then apply the real covered validation context. Use this
corrected seed consistently for delegation validation/visibility, role/acquire
summaries, continuation and covered/retained cross-kind revokes. Do not mutate the
legacy Snapshot or its collectors/helpers/hash/entrypoints. Existing base_snapshot
remains verified historical evidence; the new arm must not treat its lossy
collection as authoritative. The new seed may be ephemeral and rederived from the
hashed raw covered operations on each invocation, avoiding an independently
caller-supplied cache or new container field.

No combined-log Authority.analyze call, second application/conflict judge or
refusal-only narrowing of the adopted accepted profile is authorized. Covered-only
analysis remains permitted for construction/verification. Preserve old snapshot
byte pins and original new-container pins where their recorded data is unchanged.

Require genuine op-signed bad-delegation-signature introduction sorting before a
valid same-ID introduction, plus valid-before-invalid order and invalid-only
controls. Above the stable cut, command capability/holder decisions and both
command/inbox revoke-shaped bodies must match actual full judgment. Individually
bad introductions remain denied; the valid one cannot be poisoned or ignored.

The delivery-order requirement also remains: exercise actual append/reconciliation
sequences for every accepted fixture and compare the full result plus normalized
callback input traces. Reversing an already constructed map is only map equality
and cannot satisfy that requirement. Retain sorted outside-profile refusal tests,
with no equality credit. Independent review follows the exact repair. Future
valid_beacons callback adoption is separate; this repair does not activate it.
