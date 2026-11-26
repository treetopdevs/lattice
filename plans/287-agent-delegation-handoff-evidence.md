# Plan 287: Agent delegation handoff evidence and the verdict record a verify-only consumer can present

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 254be0df0..HEAD -- apps/lattice_core/lib/lattice/fault_scenario.ex apps/lattice_core/lib/lattice/fault_scenario/ apps/lattice_core/test/lattice2/fault_scenario_test.exs apps/lattice_core/test/lattice2/lease_lapse_test.exs apps/lattice_core/lib/mix/tasks/lattice.fault.ex apps/lattice_core/lib/treehouse/thread.ex apps/lattice_core/lib/lattice/authority.ex
> ```
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive: one Sim fault scenario, one pure module outside `lattice/authority/`,
  one research doc; no change to the authority judge, canonical bytes, wire or carrier code, so
  rule 3 requires one adversarial review, not two)
- **Depends on**: plan 203 (DONE, harness), plan 149 (DONE, leases and beacons), plan 184 (DONE,
  revocation on transfer/succeed). No absent external input: every step exits on the unit suite.
- **Consumer**: the Cadence repository's plan 022 (`cadence/plans/022-lattice-enforced-agent-permission.md`)
  reads the verdict record this plan defines. Cadence is not a dependency of any step here.
- **Category**: demonstration / interoperability
- **Planned at**: commit `254be0df0`, 2026-10-30
- **Source**: the 2026-10-30 research brief on selective collaboration (MACR relay thinking,
  EvoRouter, EREBOTS 4.0 over A2A/MCP, latent-state transfer). Its second experiment asks for an
  interoperable handoff followed by revocation where the recipient keeps an attributed result but
  loses permission for later actions. Its third asks both projects to log why a delegate was
  invoked and what it cost.

## Why this matters

Lattice's distinguishing claim next to agent-interoperability frameworks is not "how to call an
agent" but "what a connected agent may still do". The substrate already enforces that: a command
cites a delegation, the judge quarantines `:revoked_capability` after a revoke and
`:lease_expired` after a root beacon passes the lease, and `revoke_offline` (plan 203) pins the
revoke case as replayable evidence. Three things are missing for an outside consumer to build on
it:

1. **The lease-lapse handoff is not evidence.** `lease_lapse_test.exs` proves lapse at unit level,
   but no scenario records that a delegate's pre-lapse work stays honored *and attributed to the
   delegate* while its post-lapse work is refused, nor that a third realm cannot reuse the
   delegate's delegation. The brief's "receiving work confers no permission" is Lattice's model
   by construction, and it has never been pinned as a named check.
2. **A refusal has no portable record.** `Authority.analyze/2` returns `reasons: %{op_id => atom}`.
   A consumer that must answer "why was this protocol-valid request denied?" needs the reason,
   the cited delegation, and the revoking op or lapsing beacon in one deterministic record. Plan
   167 (divergence explainer) is adjacent but explains two diverged replicas, not one refused op.
3. **Nobody has written down what a verify-only consumer may do.** Plan 126 proved a pull-only
   observer; plans 127/128 added the stable read-only server. A second application (Cadence) that
   wants to *enforce* Lattice verdicts without authoring any op needs the contract stated once:
   hold a log copy, judge it locally, never sign, and say how stale the verdict may be.

## Current state

- `apps/lattice_core/lib/lattice/fault_scenario.ex`: `@specs` holds four entries. Two Sim-replay
  scenarios, `partition_converge` and `revoke_offline` (`scenarios/0`, line 132), and two carrier
  process scenarios, `stall_shutdown` and `crash_relay` (`@carrier_scenarios`, line 128). `run/2`
  dispatches by name (line 162); `revoke_offline/2` (line 224) builds a `Treehouse.Space` and a
  `Treehouse.Thread` Sim over realms `root`, `writer`, `peer`, grants `writer` `ops: [:post]` on
  the thread, isolates `writer` with `isolate/2`, revokes, lets `writer` post twice offline, heals
  with `rejoin/2`, and returns `named_logs/2`. `evaluate/3` derives every check from the logs.
- `apps/lattice_core/lib/treehouse/thread.ex:26`: `command(:post, [:text], do: [{:posts, {:append, text!(text)}}])`.
- `apps/lattice_core/lib/lattice/sim.ex`: `grant/4` takes `expires_epoch:` (line 93); `beacon/3`
  appends a root-signed `{:beacon, epoch}` (line 210); `quarantined/3` returns `false` or
  `{true, reason}`.
- `apps/lattice_core/test/lattice2/lease_lapse_test.exs:31-51` (V1): grant with `expires_epoch: 3`,
  an early post, partition, `beacon(…, 4)`, an offline post; the early op stays valid, the offline
  op is `{true, :lease_expired}` on both realms.
- `apps/lattice_core/lib/lattice/authority.ex`: public `delegation_active?/2` (line 442),
  `expired?/2` (line 473), `revoked?/2` (line 506), `analyze/2` (line 525) returning
  `%{quarantine, reasons, holders, …}`. Reason atoms in use include `:revoked_capability`,
  `:lease_expired`, `:invalid_capability`, `:not_holder`, `:unauthorized_revoke`.
- `apps/lattice_core/lib/mix/tasks/lattice.fault.ex`: `run <name|all> --seed --out`, `verify <dir>`,
  `report <dir>`.
- `apps/lattice_core/lib/township/audit_bundle.ex`: deterministic JSON via `Jason.OrderedObject`
  (the encoding convention to reuse).
- `plans/README.md` working policy: rule 3 (second review only for the listed protected paths),
  rule 9 (a ladder stops at three of one shape), rule 10 (no new Township or Toolshed work).

## Commands you will need

Run from the repo root with the AGENTS.md `PATH` export; `mix` on `PATH` is a broken mise shim.

| Purpose | Command | Expected on success |
|---|---|---|
| Harness suite | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/fault_scenario_test.exs` | 0 failures |
| Lease unit suite | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/lease_lapse_test.exs` | 0 failures |
| Verdict suite (new) | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/verdict_test.exs` | 0 failures |
| Evidence run | `~/.asdf/shims/mix lattice.fault run handoff_lapse --seed demo --out /tmp/fault` | one directory, `verify` passes |
| Evidence verify | `~/.asdf/shims/mix lattice.fault verify /tmp/fault/handoff_lapse` | every check `held` |
| Format / Credo | `~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix credo --strict` | exit 0 |
| Scope check | `git status --porcelain` | only the files in Scope |

## Scope

**In scope**
- `apps/lattice_core/lib/lattice/fault_scenario.ex` (one new spec, run clause and evaluate clause)
- `apps/lattice_core/lib/lattice/fault_scenario/report.ex` only if the report needs the new name
- `apps/lattice_core/lib/lattice/verdict.ex` (create)
- `apps/lattice_core/mix.exs` (Step 4, only if the umbrella paths break a standalone build) and
  one standalone-dependency check (test or CI step)
- `apps/lattice_core/test/lattice2/fault_scenario_test.exs`, `apps/lattice_core/test/lattice2/verdict_test.exs` (create)
- `docs/research/verify_only_consumer_contract.md` (create)
- `plans/README.md` (one index row)

**Out of scope**
- `apps/lattice_core/lib/lattice/authority.ex`, `authority/`, `canonical.ex`, `carrier/`, every
  TypeScript client file, `src-tauri`. If a step needs one of them, stop (rule 3).
- Budgets or spend caps inside a delegation. Rejected: a new delegation field changes canonical
  bytes and op ids for every leased delegation (plan 168's blast radius) and lands in protected
  code. Execution budgets belong to the consuming application (Cadence `CostControl`); the v1
  live `Lattice.Cap` keeps `use_limit`/`ttl_ms` for gateway messages only.
- Any A2A or MCP transport in Lattice. The consumer owns its protocol surface.
- Township or Toolshed scenarios (rule 10). The new scenario is over `Treehouse.Thread`.
- A fourth Sim-replay scenario. With `handoff_lapse` the Sim ladder is three
  (`partition_converge`, `revoke_offline`, `handoff_lapse`); rule 9 stops it there.

## Git workflow

- Branch: `claude/287-agent-delegation-handoff-evidence` from `origin/main`.
- Commits per step: `feat(fault): handoff_lapse scenario`, `feat(core): Lattice.Verdict record`,
  `docs(research): verify-only consumer contract`, `build(core): lattice_core builds outside the
  umbrella`, `docs(plans): index row 287`.
- One hosted exact-tip gate (rule 2); one adversarial review (rule 3).

## Steps

### Step 1 — `handoff_lapse` scenario

Add to `@specs` and `scenarios/0`:

```elixir
"handoff_lapse" => %{
  scenario: "handoff_lapse",
  fault: "root leases post to agent (expires_epoch 3); agent posts; root beacons 4; " <>
         "agent posts again; peer posts citing the agent's delegation",
  invariant: "attributed_result_survives_lost_permission",
  realms: ["root", "agent", "peer"],
  root: "root",
  modules: %{"thread" => Thread},
  checks: [
    {"pre_lapse_honored", :replay},
    {"pre_lapse_authored_by_agent", :replay},
    {"post_lapse_quarantined_lease_expired", :replay},
    {"peer_cannot_cite_agent_delegation", :replay},
    {"beacon_honored", :replay},
    {"states_equal", :replay},
    {"reasons_identical_across_realms", :replay}
  ],
  rerun: true
}
```

Run clause, modelled on `revoke_offline/2` and `lease_lapse_test.exs` V1:

1. `Thread |> Sim.new(replica_name("handoff_lapse", "thread"), realms, seed: seed) |> Sim.create_replica("root")`.
2. `{thread, cap} = Sim.grant(thread, "root", "agent", ops: [:post], live: true, expires_epoch: 3)`; `sync_all`.
3. `{thread, pre} = Sim.command(thread, "agent", :post, ["agent result before lapse"], cap: cap.id)`; `sync_all`.
4. `{thread, _} = Sim.beacon(thread, "root", 4)`; `sync_all` (the lapse is causal; the agent's
   next op must see the beacon, unlike V1's concurrent variant, so the scenario names the
   "recipient saw the revocation and still tried" case).
5. `{thread, post} = Sim.command(thread, "agent", :post, ["agent result after lapse"], cap: cap.id)`.
6. `{thread, misuse} = Sim.command(thread, "peer", :post, ["peer citing agent cap"], cap: cap.id)`.
7. `sync_all`; return `named_logs("thread", thread)`.

The variant `:no_beacon` (skip step 4) is the negative control, as `revoke_offline` has
`:no_revoke`: with it, `post_lapse_quarantined_lease_expired` must be violated.

Checks in `evaluate("handoff_lapse", seed, logs)`:
- `pre_lapse_honored`: `pre.id` absent from every log's `Authority.analyze(Thread, log).quarantine`
  and `"agent result before lapse"` present in every `Lattice.state(Thread, log).posts`.
- `pre_lapse_authored_by_agent`: the op with `pre.id` in every log has `author` equal to the
  agent realm's public key derived from the seed (`realm_keys/2`), so attribution survives on a
  replica that never trusted the agent again.
- `post_lapse_quarantined_lease_expired`: `reasons[post.id] == :lease_expired` on every log and
  the text is absent from every state.
- `peer_cannot_cite_agent_delegation`: `misuse.id` is quarantined on every log. Record the reason
  the judge actually gives (expected `:invalid_capability`, since `peer` is not the audience) and
  pin that atom in the check. Do not adjust the judge to produce a nicer atom.
- `beacon_honored`: the beacon op is not quarantined (guards against an accidental
  `:unauthorized_beacon` making the scenario pass for the wrong reason).
- `states_equal`, `reasons_identical_across_realms`: as in `revoke_offline`.

Identify `pre`, `post`, `misuse` and the beacon inside `evaluate/3` from the logs alone (by author
and body text, or by walking the ops in topological order), never from values the run returned,
so `Evidence.verify/2` can recompute them.

**Verify**: harness suite passes; `mix lattice.fault run handoff_lapse --seed demo` then `verify`
reports every check held; `run handoff_lapse --seed demo --variant no_beacon` then `verify`
reports `post_lapse_quarantined_lease_expired` violated and nothing else.

### Step 2 — `Lattice.Verdict`

Create `apps/lattice_core/lib/lattice/verdict.ex`, a pure module over `Authority.analyze/2` and
`Lattice.Log`. No process, no cache, no custody.

```elixir
@spec explain(module(), Log.t(), Op.id()) ::
        {:honored, record()} | {:quarantined, record()} | {:unknown_op, Op.id()}
@spec delegation_status(module(), Log.t(), String.t()) :: status()
@spec to_json(record() | status()) :: binary()
```

`record()` fields, in this order in the JSON: `schema` (`"lattice-verdict-v1"`), `replica`,
`op_id`, `author` (hex pub), `kind`, `verdict` (`"honored"` | `"quarantined"`), `reason` (atom
as string or `null`), `cited_delegation_id`, `evidence` with `revoked_by` (op id or `null`),
`lapsed_by_beacon` (epoch or `null`), `expires_epoch`, and `frontier` (sorted op ids of the log
the verdict was taken from, so a consumer can say how current it is).

`status()`: `delegation_id`, `status` (`:active | :revoked | :lapsed | :unknown`), `revoked_by`,
`expires_epoch`, `latest_beacon_epoch`, `frontier`.

Derivation rules: `reason` comes only from `analyze(module, log).reasons[op_id]`. Evidence is
tied to the reason, never computed on its own: `revoked_by` is set only when `reason ==
:revoked_capability` and is the id of the first honored `{:revoke, delegation_id}` authority op
in topological order; `lapsed_by_beacon` is set only when `reason == :lease_expired` and is the
smallest honored beacon epoch strictly greater than `expires_epoch`; both are `null` on every
honored op (lapse is causal, so an honored pre-lapse op shares a log with the lapsing beacon and
must not be decorated with it). `delegation_status/3` takes the module too, because "honored
revoke" and "honored beacon" are `analyze/2` facts. A delegation the log has never seen is
`:unknown`, never `:active`. `to_json/1` uses `Jason.OrderedObject` exactly as
`Township.AuditBundle` does.

Tests in `verdict_test.exs`:
- Over the `revoke_offline` logs (seed `"verdict"`): the two offline posts explain as
  `:quarantined` with `reason: :revoked_capability` and `revoked_by` equal to the revoke op id;
  the pre-revoke post explains as `:honored`; `delegation_status` is `:revoked`.
- Over the `handoff_lapse` logs: the post-lapse op explains with `reason: :lease_expired` and
  `lapsed_by_beacon: 4`; the pre-lapse op is `:honored`; the peer's op has its pinned reason and
  `cited_delegation_id` equal to the agent's delegation; `delegation_status` is `:lapsed`.
- Property (StreamData, reuse the M1 generators from `authority_test.exs`): for every op in a
  generated log, `explain/3` returns `:quarantined` if and only if `analyze/2` lists the op, and
  with the same reason; every `:honored` record has `revoked_by` and `lapsed_by_beacon` both
  `null`. `explain` may never disagree with `analyze`.
- `to_json/1` is byte-identical across two calls and across the three realms' logs once synced.

**Verify**: verdict suite passes; `mix format --check-formatted`; Credo clean;
`git diff --stat -- apps/lattice_core/lib/lattice/authority.ex apps/lattice_core/lib/lattice/authority/ apps/lattice_core/lib/lattice/canonical.ex` is empty.

### Step 3 — Verify-only consumer contract

Create `docs/research/verify_only_consumer_contract.md` (under 150 lines) stating, for an
application that enforces Lattice verdicts without authoring:

- **May**: hold a copy of one replica's log (from `Lattice.Log.restore/1` or a pull-only carrier
  realm as plan 126/127 built), call `Authority.analyze/2`, `Lattice.Verdict.explain/3` and
  `delegation_status/2`, and refuse its own application-level action when the status is not
  `:active`.
- **Must**: present the `frontier` with every refusal or acceptance, and state in its own copy
  that a verdict is "as of" that frontier. A consumer that has not pulled since a revoke will
  honor a revoked delegate until it pulls. This is the staleness caveat and it is the
  consumer's non-claim, not Lattice's.
- **Must not**: sign ops, hold member private keys, author beacons, or infer lapse from wall-clock
  time. Beacons are root-signed logical ticks; the consumer reads them, never produces them.
- **Operator input named, not assumed**: a pull-only realm against the stable server needs an
  entry in that server's trusted peers (plan 127). Until an operator provisions one, the
  consumer's first gate runs from a `Lattice.Log.dump/2` file written by `Lattice.Sim`. Rule 8:
  the file-based gate is the exit here; the carrier-fed gate is a later row.
- **Non-claims**: this is not federation (M6), not production deployment, not Phase G, not a
  receipt-free W4 result, and it adds no `/township` or Treehouse write path.

Link the Cadence plan by path and name the two checks it relies on
(`post_lapse_quarantined_lease_expired`, `peer_cannot_cite_agent_delegation`).

**Verify**: file exists; `wc -l` under 150; the two check names appear verbatim in both the doc
and `fault_scenario.ex`.

### Step 4 — `lattice_core` builds as a dependency outside the umbrella

`apps/lattice_core/mix.exs` sets umbrella `build_path`, `config_path`, `deps_path` and `lockfile`
and starts `LatticeCore.Application` (`mod:`). A consumer must be able to depend on it with
`{:lattice_core, git: …, sparse: "apps/lattice_core", runtime: false}` and call the pure modules
(`Authority`, `Log`, `Verdict`, `Canonical`) without the umbrella or any Lattice process.

- From an empty Mix project in a temp dir, add that dependency pointing at the local checkout
  (`path:` is fine for the check) and run `mix deps.get && mix deps.compile lattice_core`.
- If the umbrella paths break the build, make them conditional in `apps/lattice_core/mix.exs`
  (set them only when `File.exists?(Path.expand("../../apps", __DIR__))`) and keep the umbrella
  build byte-identical (`mix compile` from the root still writes to the root `_build`).
- Add `apps/lattice_core/test/standalone_dependency_test.exs` or a CI step that performs the
  temp-project check so it cannot regress silently. `mix.exs` is not a rule-3 path.

**Verify**: the temp project compiles `lattice_core` with `runtime: false` and
`Lattice.Verdict.explain/3` runs over a restored `handoff_lapse` log in that project's `iex`
with no Lattice application started (`Application.started_applications/0` lacks `:lattice_core`).

### Step 5 — Index row

Add row 287 after row 286 in `plans/README.md` (one line, status cell under 200 characters) and
update plan 203's status cell to name `handoff_lapse` as the third Sim scenario.

## Test plan

- New: `handoff_lapse` in `fault_scenario_test.exs` (held, negative control violated, verify
  round trip through `Evidence`), `verdict_test.exs` (examples plus the analyze-agreement property).
- Changed: none of the existing scenario tests.
- Evidence: `mix lattice.fault run all --seed demo --out /tmp/fault && mix lattice.fault report /tmp/fault`
  lists five scenarios with `handoff_lapse` held.

## Done criteria

- [ ] `scenarios/0` returns `["partition_converge", "revoke_offline", "handoff_lapse"]`.
- [ ] Every `handoff_lapse` check holds under `verify`; `no_beacon` violates exactly one check.
- [ ] `Lattice.Verdict` exists, is covered by example and property tests, and never disagrees
      with `Authority.analyze/2`.
- [ ] The protected paths in Scope "Out of scope" show no diff.
- [ ] `docs/research/verify_only_consumer_contract.md` exists and names its staleness caveat and
      non-claims.
- [ ] `lattice_core` compiles as a `runtime: false` dependency of an empty project outside the
      umbrella, and the check is automated.
- [ ] Row 287 added; row 203 status cell updated; both under 200 characters.
- [ ] One hosted exact-tip run green; one adversarial review closed.

## STOP conditions

- Step 1 step 6 quarantines the peer's op with a reason other than `:invalid_capability`, or does
  not quarantine it at all. Pin what the judge reports if it is a quarantine; if it is honored,
  stop: that is an authority finding for a plan under rule 3, not a scenario tweak.
- `Sim.command/5` raises for `peer` because that realm never held the cap (Sim resolves `cap:`
  from the realm's own cap map). Then build the op with `Lattice.Op.new/6` citing the agent's
  delegation and append it to the peer's log directly; that is scenario setup, not a judge
  change. If no log API accepts an op whose cap the realm lacks, stop and report.
- Step 4's temp-project build needs a change outside `apps/lattice_core/mix.exs` (for example in
  `lib/lattice/application.ex` or a protected path): stop and file the change as its own row.
- The beacon in step 4 is itself quarantined (`:unauthorized_beacon` or `:stale_beacon`): the
  scenario setup is wrong, not the judge; fix the setup or stop.
- Any step needs an edit under `lattice/authority/`, `canonical.ex`, `carrier/` or a TypeScript
  client file.
- `Lattice.Verdict`'s property test finds a disagreement with `analyze/2`: report the
  counterexample; do not special-case it.
- A fourth Sim-replay scenario appears necessary (rule 9).

## Maintenance notes

- TypeScript parity for `Lattice.Verdict` touches `clients/lattice-client/src/authority.ts`, a
  rule-3 path. It is a separate row, filed when a browser or Tauri consumer needs the record.
- When plan 187 (claims registry) is written, the `lattice-verdict-v1` schema belongs in it as a
  core-tier claim with `verdict_test.exs` as evidence.
- If the stable server later serves verdict records itself, it must compute them from the same
  module; a second implementation of the derivation rules is a parity bug waiting to happen.
