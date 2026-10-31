# Verify-only consumer contract

**Status:** contract, 2026-10-30, plan 287
(`plans/287-agent-delegation-handoff-evidence.md`). It states what an application may do when it
enforces Lattice verdicts without authoring any op, and what it must say about how current those
verdicts are.

**First consumer:** the Cadence repository's plan 022,
`cadence/plans/022-lattice-enforced-agent-permission.md`. Cadence decides whether an agent may act
from a Lattice delegation's status instead of only from its own admin toggle. Lattice does not
depend on Cadence.

## What the substrate already guarantees

A command cites a delegation. The judge (`Lattice.Authority.analyze/2`) quarantines it
`:revoked_capability` once an effective revoke (by the link's issuer or the root) of any link of
that delegation's chain exists that the command is not causally before, and `:lease_expired` once
an accepted beacon passes the chain's lease that the command is not causally before. A beacon is
accepted when the replica root signs it or, under a witness policy pinned at genesis (plan 179), a
threshold of witnesses certifies it. Epochs increase strictly only along causal ancestry: concurrent
accepted beacons may repeat or interleave epochs, so a consumer takes the maximum accepted epoch
(`latest_beacon_epoch`) rather than assuming a total order. The judge checks the audience before the lease, so
a realm that cites someone else's delegation is quarantined `:capability_wrong_audience`, lapsed or
not. Receiving work confers no permission.

Two checks of the `handoff_lapse` fault scenario (`Lattice.FaultScenario`, plan 287) pin the
behaviour this contract relies on, as replayable evidence (`mix lattice.fault run handoff_lapse`,
then `mix lattice.fault verify`):

- `post_lapse_quarantined_lease_expired`: after the root beacon passes the agent's lease, the
  agent's next post is quarantined `:lease_expired` on every realm, while its pre-lapse post stays
  honored and attributed to the agent (`pre_lapse_honored`, `pre_lapse_authored_by_agent`).
- `peer_cannot_cite_agent_delegation`: a third realm that cites the agent's delegation is
  quarantined `:capability_wrong_audience` on every realm.

`revoke_offline` (plan 203) pins the matching revocation case.

## May

- Hold a copy of one replica's log, obtained from `Lattice.Log.restore_verified/1` over a file or
  from a pull-only carrier realm as plans 126 and 127 built.
- Call `Lattice.Authority.analyze/2`, `Lattice.Verdict.explain/3` and
  `Lattice.Verdict.delegation_status/3` on that copy. All three are pure: no Lattice process,
  supervision tree or key is needed, and `lattice_core` builds as a `runtime: false` dependency
  (`apps/lattice_core/test/standalone_dependency_test.exs`).
- Refuse its own application-level action when the delegation's status is not `:active`. The
  status is fail-closed: `:revoked`, `:lapsed`, `:invalid` and `:unknown` all refuse, and a
  delegation the log has never carried is `:unknown`, never `:active`. One known false refusal
  remains: a successor activated by a concurrent policy genesis that has since handed its role on
  reads `:invalid` (row 288).
- Before allowing an action, check the status record's `audience` equals the actor's public key
  and its `ops` include the action. An `:active` delegation addressed to someone else permits that
  someone else, not the consumer's actor.
- Store or display the `lattice-verdict-v1` and `lattice-delegation-status-v1` JSON records
  (`Lattice.Verdict.to_json/1`). They are byte-identical on every realm whose log has the same ops.

## Must

- Present the `frontier` with every refusal and every acceptance, and say in its own copy that the
  verdict holds "as of" that frontier.
- Accept the staleness this implies. A consumer that has not pulled since a revoke or a beacon will
  honor a revoked or lapsed delegate until it pulls. This is the consumer's non-claim, not
  Lattice's: the log is the truth, and the consumer's copy is a cache of it.
- Pin the replica before judging. Configure the expected replica id out of band (for example
  `Lattice.Authority.bind_replica(name, root_pub)` for a known root key) and refuse any log whose
  `log.replica` differs, before computing or accepting a verdict. `restore_verified/1` proves only
  that a log is internally authentic: a complete log rooted in someone else's key passes it and
  can carry an `:active` delegation addressed to the consumer's actor.
- Judge only logs it has verified (`restore_verified/1`, or the carrier's verified pull). A log that
  fails verification yields no verdict, not an `:active` one.
- Load its replica module (for example `Code.ensure_loaded!(Treehouse.Thread)`) before
  `restore_verified/1`. The decoder runs `:safe` and refuses atoms the VM has not interned, so a
  fresh VM that has not loaded the replica's vocabulary gets `{:error, :unsafe_dump}`.

## Must not

- Sign ops, hold member private keys, author grants, revokes or beacons, or act as a beacon
  witness. Beacons are logical ticks signed by the root or certified under the replica's witness
  policy; the consumer reads the ones the judge accepted and never produces them.
- Infer a lapse from wall-clock time. A lease lapses only when a beacon on the log passes it.
- Compute verdicts with a second implementation of the derivation rules. If a server later serves
  verdict records, it computes them with `Lattice.Verdict`; parity across runtimes is a separate
  row (the TypeScript judge in `clients/lattice-client/src/authority.ts` is a protected path).
- Treat a verdict as a capability. A record explains a judgement; it grants nothing.

## Operator input, named not assumed

A pull-only realm against the stable carrier server needs an entry in that server's trusted peers
(plan 127). Until an operator provisions one, the consumer's first gate runs from a
`Lattice.Log.dump/2` file written by `Lattice.Sim` (for example the `handoff_lapse` evidence logs).
Under working-policy rule 8 the file-based gate is the exit for this contract; the carrier-fed gate
is a later row.

## Budgets are the consumer's

Spend caps and execution budgets are not delegation fields. Adding one would change canonical bytes
and op ids for every leased delegation and touch protected code. A consumer enforces its own
budgets (Cadence `CostControl`) alongside the Lattice status, and records why a delegate was invoked
and what it cost on its own side.

## Non-claims

This contract is not federation or cross-town identity (M6), not a production deployment, not
Phase G, and not a receipt-free W4 result. It adds no `/township` or Treehouse write path, no A2A or
MCP transport, no server push and no participant custody. The verdict record is BEAM-only; a
TypeScript record is a separate row filed when a browser or Tauri consumer needs it.
