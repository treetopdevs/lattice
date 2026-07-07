# ADR 0006 — Log compaction (Sedimentree-style): snapshot design + feasibility spike

- **Status**: proposed (plan 013 research spike, 2026-07-03 — design accepted at spike
  level; **production integration is NOT built** and is gated on the open questions below)
- **Context**: a Replica's identity is its entire op-log. `Lattice.Log` is unbounded,
  `Lattice.Reduce` re-folds every op per materialize, `Lattice.Sync` ships full id-sets.
  `docs/path_to_real.md` §4 names compaction the first scaling cliff. The hard part:
  compaction must not break **determinism** (a synced, compacted log must reduce to
  byte-identical state) or **authority soundness** (stale-holder/revocation verdicts
  depend on causal ancestry that compaction discards).
- **Spike artifacts**: `apps/lattice_core/test/support/compaction_spike.ex` (throwaway
  prototype, test-env only, wired into nothing) +
  `apps/lattice_core/test/lattice2/compaction_spike_test.exs` (the GATE).

## Spike result (plan 013 GATE) — met

For a log `L` and a chosen **stable** frontier `F`: `compact(L, F)` produces a snapshot
such that reducing `snapshot ⊕ (ops of L above F)` is **byte-identical** to reducing `L`
with the real `Lattice.Authority` + `Lattice.Reduce` pipeline — materialized state bytes
(`term_to_binary [:deterministic]`), the quarantine **set**, the per-op quarantine
**reasons**, the **holders** map, and the **requests** list all match. Verified over:

1. a deterministic scenario in which the authority history that decides ops above `F`
   lies beneath `F`: moderator transfer below `F`; then above `F` a stale-holder
   quarantine (holder acquired below `F`, superseding transfer above `F`), a
   `:revoked_capability` use of a grant revoked below `F`, a `:premature_succession`
   whose dormancy floor comes from below-`F` activity, an observed remove of a
   below-`F` OR-Set add, a forged `:no_capability` op, and a `:double_transfer` fork;
2. a StreamData property (150 runs/seed, exercised across multiple ExUnit seeds):
   random phase-1 history → converge → `F` := converged frontier → random phase-2
   history (posts/joins/leaves/locks/transfers/revokes/heartbeats/successions under
   partitions) → converge → compare;
3. a re-reduce **verification** check (snapshot valid iff recomputable from the covered
   ops; content tampering and covered-op pruning both detected);
4. an **unstable frontier is rejected**, not compacted.

The determinism oracle (`convergence_property_test.exs`) and the full suite stay green;
the spike is purely additive.

## Decision 1: the stability precondition (what makes summarization sound)

`F` is a **stable frontier** of `L` iff every op of `L` outside `covered = reachable(F)`
has *all of `F`* (hence every covered op) in its causal ancestry. `compact/3` rejects
unstable frontiers.

Stability is the entire trick. It yields three structural facts the spike exploits and
the tests confirm:

- **Total visibility**: every covered delegation-introduction, acquire, and revoke is an
  ancestor of every retained op — so per-op ancestry *into* the covered region never
  needs reconstruction; "all of it" is the answer.
- **Topological prefix**: `topo_sort(L) = topo_sort(covered) ++ topo_sort(retained)` —
  covered timeline/fold decisions are a strict prefix, so verdicts frozen at `F` are the
  same verdicts the full log computes (finality; one caveat below).
- **Height dominance**: every retained op's causal height strictly exceeds every covered
  op's, so LWW/list ordering tags never interleave across `F`; seeded folds cannot
  reorder history.

An op that *doesn't* dominate `F` (a straggler concurrent with `F`) makes byte-identical
compaction impossible without per-op covered ancestry (e.g. an observed-remove must know
*which* covered adds it saw). That is why the GC rule below requires acknowledgement:
stability is a **liveness/membership fact**, not a local one.

## Decision 2: snapshot structure

`%Snapshot{}` = reduced state at `F` + the authority summary + verification hash:

| Field | Content | Why retained |
|---|---|---|
| `frontier` | sorted op ids of `F` | identity of the cut |
| `crdts` | per-field CRDT structs at `F`, compacted to **live** entries (OR-Set: surviving add-tags only; CausalList: untombstoned elements only; LWW: winner) | seed for the continuation fold; retained removes/deletes of covered entries re-retire them idempotently, so dropping dead entries is safe |
| `covered_heights` | `op_id → causal height` | retained heights recurse through boundary deps; spike keeps all covered heights, production needs only `F` + covered ops directly referenced by retained deps |
| `frozen_reasons` | covered `op_id → quarantine reason` | audit + quarantine-set equality with the uncompacted log |
| `frozen_holders`, `frozen_requests` | analysis outputs at `F` | seeds / prefix of the merged outputs |
| `delegations` + `covered_intros` | **all** delegation structs as of `F`; which ids were introduced beneath `F` | retained grants attenuate from covered parents; retained caps cite covered delegations; covered intros are visible to all retained ops |
| `policies`, `root` | merged succession policies; root creator | succession + revoke authorization |
| `covered_revokes` | **raw** `{op_id, deleg_id, author}` refs | re-judged against the *merged* delegation set at analysis time (authorization can bind late); a covered revoke applies to every retained op unconditionally (a retained op can never be causally before it) |
| `roles` | per role: `last_acquire` (`op_id`, holder, tick) + `last_active_tick` | the whole covered acquire history collapses to its last element (total visibility means only the last is load-bearing); the dormancy floor folds all covered activity into one tick |
| `hash` | sha256 of the deterministic encoding of everything above | verification |

**The key finding on the plan's central question** (*"can the authority frontier be
summarized soundly, or must the full holder/revocation DAG be retained?"*): **yes, it
summarizes** — the per-role summary is O(1) and the stale-holder check above `F`
survives with just `last_acquire` — **but the delegation set and revoke refs are
retained forever**. They are *state-sized* (grow with grants/revokes), not *log-sized*
(grow with commands), so compaction still buys what matters for chat/docs/governance
workloads; it does not buy unbounded-grant workloads.

## Decision 3: verification

A snapshot is valid iff re-reducing the ops it summarizes reproduces it:
`verify(module, snapshot, covered_log)` recomputes the snapshot from the covered ops
(with the real `Authority.analyze/2` + `Reduce.reduce_crdts/3`) and requires (a) the
stored hash to commit to the snapshot's actual content and (b) that content to equal the
recomputation. Deterministic, checkable by any realm that still holds the covered ops.
A realm that no longer holds them must trust the hash chain (see sync impact).

## Decision 4: GC rule

An op may be dropped iff it is in `reachable(F)` for a frontier `F` such that:

1. **every participant has acknowledged** holding `reachable(F)` (needs the carrier's
   membership/ack signal — ADR 0005 / plan 010 follow-up; `Lattice.Sim` cannot provide
   this, which is why compaction stays behind the carrier); and
2. participants **author only ops that dominate `F`** from then on — the append path
   already guarantees this locally (deps = own frontier ⊇ `F` once `reachable(F)` is
   held), so with (1) the stability precondition holds for all future ops; and
3. retention exceptions:
   - **delegation structs, revoke refs, policies, root, role summaries** — into the
     snapshot, forever (Decision 2);
   - **frozen quarantine reasons** — into the snapshot (design invariant 4's audit
     obligation shrinks from "the quarantined ops" to "their ids + reasons"; keeping the
     op bodies is a cold-archive policy choice, not a correctness need);
   - **structural quarantine** (`Log.quarantine`, e.g. `:bad_signature` forgeries) —
     same audit treatment; it never affects reduction;
   - **`state_at`/time travel beneath `F` is lost**: the snapshot becomes the time-travel
     floor. Frontiers at-or-above `F` keep working. If history-below-`F` matters, archive
     covered ops cold instead of deleting (compaction of the *hot* path either way).

## M2 acknowledgement contract

`Lattice.Carrier.Membership` is a tested acknowledgement helper for the future GC rule
above, not a wired production compaction gate. A frontier may be considered
carrier-stable only when every current participant has acknowledged the same normalized
frontier; an empty current set is never stable, and a rejoining participant must
acknowledge the frontier again. Because this helper uses exact frontier equality, a
production GC loop must actively propose and coordinate candidate GC frontiers; passive
heartbeats that keep advancing to newer leaf ids do not prove they still agree on the
same compactable frontier. Snapshot signatures/quorum and snapshot-only bootstrap trust
remain separate unresolved production requirements.

## Decision 5: sync impact

- **Compacted ↔ compacted at same `F`**: advertise `frontier + retained op-ids`; transfer
  ops above `F` exactly as today (`Sync.missing/deliver` unchanged).
- **Compacted ↔ uncompacted**: the compacted realm recognizes covered ids via the
  snapshot (spike keeps the covered id/height map; production can drop it after full ack
  per the GC rule, at the cost of not recognizing zombie ops) and ignores offers beneath
  `F`; it serves `snapshot + ops above F` to peers behind `F`.
- **Bootstrap from snapshot**: a fresh realm receives `snapshot + retained ops` and can
  verify the retained region normally, but must **trust** the snapshot (it cannot
  re-reduce ops it never had). Trust anchoring — snapshot signed by a role, or by a
  quorum of realms that verified it — is an open design question below.
- Carrier note (ADR 0005): op/delegation hashing now uses `Lattice.Canonical`, but the
  spike snapshot hash still uses `term_to_binary [:deterministic]`. Production
  cross-runtime snapshot verification needs a snapshot canonical encoder or an extension
  of `Lattice.Canonical`; do not treat the spike hash as the final browser/AtomVM format.

## What the spike deliberately reimplements (and why that is honest)

`Authority.analyze/2` cannot run over `snapshot + retained` as-is: retained ops' deps
dangle at `F`, so `Dag.all_ancestors` finds no covered ancestors and every check that
walks ancestry would mis-fire (e.g. every retained command would be
`:capability_not_visible`). **Production compaction therefore requires a snapshot-aware
analysis mode in `Lattice.Authority`/`Lattice.Reduce`** — that is the XL production
plan, out of scope here. The spike proves the *summary is sufficient*: a spike-local
continuation (seeded timelines, seeded folds, covered-visibility shortcuts) reproduces
the real pipeline's output byte-for-byte across the generated scenarios. Divergence
between the reimplementation and the real engine is exactly what the GATE test measures,
against the real engine on the full log.

## Caveats / findings

- **Verdict finality caveat (content-addressed late binding)**: freezing covered
  verdicts assumes they are final. Because delegations are content-addressed, a
  pathological history can introduce a delegation *above* `F` whose id is cited beneath
  `F` (parent-before-child inverted), retroactively validating a covered
  `:missing_parent` verdict. The append/authoring paths never produce this (it requires
  citing a hash before its preimage circulates publicly), the Sim generators cannot
  express it, and the production rule should be explicit: **ops whose verdicts are not
  final (unresolved `:missing_parent` chains) block compaction of their region** — or
  equivalently, late-arriving parents do not resurrect compacted children.
- **Revocation is compaction-friendly by design**: the "not causally before the revoke"
  exemption means later revokes never retroactively quarantine covered ops, and covered
  revokes always apply to retained ops. No revocation DAG needs retaining — only the
  revoke *refs*.
- **Audit granularity shrinks**: the spike compares `reasons`/`holders`/`requests`
  byte-for-byte but not the human-readable `audit` event list; production should fold
  covered audit entries into the snapshot verbatim if full audit continuity is wanted.
- **Do not mistake this for production readiness** (plan 013 maintenance note): the
  GATE holds on `Lattice.Sim`-generated logs. Before building the XL plan, re-run the
  property at higher run counts and extend the generators with adversarial op shapes
  (redundant deps into the covered interior, duplicate delegation intros across `F`).

## Open questions from plan 013 — answers

- **Can the authority frontier be summarized soundly?** Yes, under the stable-frontier
  precondition — with the O(1)-per-role summary of Decision 2 — but the delegation set,
  revoke refs, policies and root are retained for the life of the Replica. The full
  holder-change DAG is *not* needed; the full delegation *set* is.
- **Acknowledgement model for GC?** Required, and blocking: snapshot *creation* is
  local-safe (any realm may compact its own hot path once its log dominates `F`), but
  *dropping ops* system-wide is safe only after all-participant acknowledgement of
  `reachable(F)` — a membership/ack signal only a real carrier (plan 010 / M2) can
  provide. Also new: **bootstrap trust** for snapshot-only realms needs an anchoring
  design (signature or quorum), related to the carrier's session-auth follow-up.
- **Snapshot trigger policy?** Out of scope, noted: op-count and causal-height
  thresholds are both deterministic and locally computable; wall-clock is not (no
  trusted clock in the model). Whatever triggers, `F` selection must wait for the ack
  signal above.
