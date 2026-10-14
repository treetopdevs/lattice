# Plan 203: Fault-scenario evidence harness — four scripted faults, one invariant each, replayable evidence

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1017cb8..HEAD -- apps/lattice_core/lib/lattice/sim.ex apps/lattice_core/lib/lattice/authority.ex apps/lattice_core/lib/treehouse/space.ex apps/lattice_core/lib/treehouse/thread.ex apps/lattice_carrier_server/lib/lattice_carrier_server/operator/release_quiesce.ex apps/lattice_carrier_server/lib/lattice_carrier_server/durability.ex apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive; no change to the authority judge, the wire, or the carrier server's runtime code)
- **Depends on**: 184 (revocation on `:transfer`/`:succeed`, DONE), 182 (policy)
- **Category**: dx / demonstration (turns existing guarantees into repeatable, falsifiable evidence)
- **Planned at**: commit `1017cb8`, 2026-10-14

## Why this matters

Lattice's claim is that durable replicas converge while revoked writes and unsafe authority
transitions fail closed. Today that claim is spread across hundreds of tests whose output is a pass
count. Nobody outside the project can watch it happen, and nobody can replay what they watched.

This plan adds a small set of **scripted fault scenarios**. Each one injects one fault, checks one
named invariant, and writes an evidence directory an outsider can re-verify offline. The scenarios
are deterministic from a seed, so a demonstration is the same bytes every time.

Scripted beats free-form here: a script is a proof you can hand over; a free-form session is an
anecdote. Free-form exploration comes later as a *recorder* that saves a fault schedule, so any
violation it finds becomes a new script (see Maintenance notes). It is out of scope here.

The canonical one-click demonstration is **`revoke_offline`**: a writer is partitioned, revoked
while offline, keeps writing (a thread post *and* an admin `:transfer`), then heals. Every replica
must converge and quarantine the same ops for the same reasons. Convergence alone is any CRDT;
authority enforced over concurrent offline history is what Lattice adds, and plan 184 is what makes
the `:transfer` half of it hold.

### Policy fit

- Rule 10 freezes Township, so this plan targets **Treehouse** modules (`Treehouse.Space`,
  `Treehouse.Thread`) and adds nothing under `apps/township_web` or `apps/lattice_core/lib/township`.
- Rule 1: the claim tier is **core** (unit tests plus offline replay). No packaged or device claim.
- Rule 6: no test asserts on prose in this file or the README.
- The "panel" in this plan is a **generated, read-only static report**. An in-app panel with
  buttons would be a write surface; it is a separate future row, not part of this plan.

## Current state

- `apps/lattice_core/lib/lattice/sim.ex` — the oracle. `new/4`, `create_replica/2`, `grant/4`
  (`ops:`, `live:`), `transfer/5`, `revoke/3` (line ~194, appends `{:revoke, delegation_id}` as an
  `:authority` op), `command/5` (`cap:`), `append/5`, `partition/3`, `heal/3`, `sync_all/1`,
  `state/2`, `log/2`, `holder/3`, `quarantined/3` (returns `false` or `{true, reason}`).
- `apps/lattice_core/lib/lattice/authority.ex` — after plan 184, a `:transfer` or `:succeed` under a
  revoked chain rejects with `:revoked_capability` (around lines 1240–1308); a command under a revoked
  cap rejects the same way (around 1585).
- `apps/lattice_core/lib/treehouse/space.ex` — fields `admin_actions` (`authority: :admin`) and
  `moderator_actions` (`authority: :moderator`); `transfer_admin/4`, `change_moderator/4`,
  `revoke_grant/3`.
- `apps/lattice_core/test/treehouse/domain_test.exs:55-100` — a working pattern that drives
  `Treehouse.Space` and `Treehouse.Thread` through `Sim`, grants a thread cap with `ops: [:post]`,
  posts, revokes, and checks quarantine. Copy its setup shape.
- `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/release_quiesce.ex` —
  `drain(attempt, expected, timeout \\ 5_000)` closes admission, suspends listeners and captures
  holders; timeouts and ambiguous identity return `{:error, _}`.
- `apps/lattice_carrier_server/test/operator/release_quiesce_test.exs:14` — "closing actual owned
  Holder refuses a valid signed relay without changing bytes".
- `apps/lattice_carrier_server/test/durability_test.exs:209` — "a stalled durable relay is refused
  within a bounded time and the holder survives"; `:106` — ack follows file sync, rename, dir sync.
- `apps/lattice_carrier_server/test/township_projection_test.exs:60` — "a client-signed relay
  survives a second-BEAM restart and matches Sim". Its second-BEAM launch helper is the pattern for
  the crash scenario; reuse the helper, not the Township replica.
- `apps/lattice_core/lib/mix/tasks/lattice.graph.snapshot.ex` and `Lattice.Graph.Export` — the
  existing trust-graph exporters.

## Commands you will need

Locally, run mix through the asdf shim with the OTP 28/Elixir 1.19 bin directories first on `PATH`
(the plan index's toolchain reminder); in GitHub Actions plain `mix` works:

```bash
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
mix() { "$HOME/.asdf/shims/mix" "$@"; }
OUT="$(mktemp -d)"
mix format --check-formatted
mix test apps/lattice_core/test/lattice2/fault_scenario_test.exs
mix test apps/lattice_carrier_server/test/fault_scenario_test.exs
mix lattice.fault run revoke_offline --seed demo --out "$OUT"
mix lattice.fault verify "$OUT/revoke_offline"
mix lattice.fault report "$OUT"               # writes $OUT/index.html
```

## Scope

**In scope**

- `apps/lattice_core/lib/lattice/fault_scenario.ex` — pure, Sim-only scenarios and the evidence
  checker (steps 1–3).
- `apps/lattice_core/lib/lattice/fault_scenario/evidence.ex` — evidence encode/decode/verify.
- `apps/lattice_core/lib/mix/tasks/lattice.fault.ex` — `run`, `verify`, `report`.
- `apps/lattice_core/test/lattice2/fault_scenario_test.exs`.
- `apps/lattice_carrier_server/test/support/fault_scenario.ex` and
  `apps/lattice_carrier_server/test/fault_scenario_test.exs` — the two process-level scenarios
  (step 4). Test-only: fault injection never ships in the `lattice_carrier_pilot` release.
- One new row in `plans/README.md`.

**Out of scope**

- Any change to `authority.ex`, `sim.ex`, `canonical.ex`, the carrier wire, or carrier runtime code.
  If a scenario fails because of a judge bug, that is a STOP and a new row.
- Any LiveView, Vue or Tauri panel. Any write control anywhere.
- Free-form fault controls, randomized fault schedules, property-based fault search.
- Township modules, `township_web`, the TS client.

## Git workflow

Branch `claude/plan-203-fault-scenarios` from `main`. One commit per step. Open one PR at the end;
its description states the claim tier in one sentence (core) and nothing above it. Per the index
working policy: the PR gets one adversarial review (no file here is on the second-review list) and
every thread is fixed or rejected with one line; the exact-tip hosted run is the gate, plus a
merge-result run only if the merge is not a fast-forward of that green tip.

## Steps

### Step 1 — Evidence format and checker

Define `Lattice.FaultScenario.Evidence`. One scenario writes one directory:

```
<out>/<scenario>/
  evidence.json        # schema below, canonical key order, no timestamps
  logs/<realm>.log     # Lattice.Log.dump/2 per replica, final state
  trust_graph.<prefix>.dot  # one per log prefix, from the first realm's final log of that prefix
```

`evidence.json`:

```json
{
  "schema": "lattice-fault-evidence-v1",
  "scenario": "revoke_offline",
  "seed": "demo",
  "module": "Elixir.Treehouse.Thread",
  "fault": "partition writer; revoke writer cap; writer posts and transfers; heal",
  "invariant": "identical_quarantine",
  "replicas": { "<log>": { "frontier": "<hex sha256>", "state": "<hex sha256>" } },
  "quarantine": [ { "op": "<op id>", "reasons": { "<log>": "revoked_capability" } } ],
  "checks": [ { "name": "states_equal", "source": "replay", "ok": true } ],
  "verdict": "held"
}
```

Every `<log>` key is the basename of a file under `logs/` without `.log` (`a`, or
`thread.writer`), so each log file maps to exactly one `replicas` entry and one quarantine column.
`verify` rejects a directory whose `logs/` file set and `replicas` key set differ.

Build each graph with `Lattice.Graph.ReplicaSnapshot.build(module, log)` and write it with
`ReplicaSnapshot.export(snapshot, :dot)`; `Graph.Export` takes a snapshot, never a `Log`. A
single-module scenario has the prefix-free name `trust_graph.dot`. `verify` regenerates every
expected DOT file from the verified logs and requires byte equality; a missing, extra or altered
DOT file is a mismatch.

`state` is the SHA-256 of `:erlang.term_to_binary(Lattice.state(module, log), [:deterministic])`;
`frontier` is the SHA-256 of the sorted frontier ids joined by `\n`.

`Evidence.verify(dir)` restores every `logs/*.log` with `Lattice.Log.restore_verified/1` (never
`restore/1`, which leaves hashes, signatures and dependency closure unchecked), re-runs
`Lattice.Authority.analyze/2` and `Lattice.state/2`, recomputes every hash, the quarantine table and
every check, and returns `{:ok, evidence}` only if the recomputed `evidence.json` is byte-identical
to the stored one. Otherwise `{:error, [mismatch]}`.

Authentic logs are not necessarily complete (`log.ex:131-133`: `restore_verified/1` does not prove
completeness), so dropping the same leaf op from every log would still replay cleanly. For the two
core scenarios, `verify` therefore also **re-runs the named scenario from its recorded `seed`** and
requires the whole regenerated directory (logs, `evidence.json`, DOT files) to be byte-identical
to the one supplied. This binds the evidence to the scripted operation set; it is possible only
because Sim keys and signatures are deterministic from the seed (the same property Step 2's
same-seed check asserts). Process-level directories cannot be re-run offline, so their cards stay
"replay verified, process checks recorded" (Step 5).

**Verify**: unit test round-trips a two-realm evidence directory, then asserts `{:error, _}` for
two tampers: one flipped byte in a log file, and a deliberate forgery, where one op's body is
altered and the log is re-encoded with `Log.dump/2` and `evidence.json` is rewritten to match the
forged results. Only `restore_verified/1` catches the second one. A third tamper removes the same
leaf post from every log and regenerates `evidence.json` and the DOT files; only the seeded re-run
catches it.

### Step 2 — `partition_converge` (action: disconnect replica)

Two realms, `"a"` and `"b"`, on `Treehouse.Thread`, both holding a `:post` cap. `Sim.sync_all/1`
after the grants so each holder's log contains its delegation; then partition; `a`
posts 3, `b` posts 3; heal; `sync_all`.

- **Invariant `convergence`** — checks: `frontiers_equal`, `states_equal`, `op_ids_equal`,
  `matches_oracle` (each realm's state equals a single-log reference built by appending every op
  to one log in topological order), `nothing_quarantined`.
- **Negative control** (in the test, not the scenario): drop one op from `b`'s dumped log before
  `verify`; assert the recomputed `frontiers_equal` is false and `verify` reports a mismatch.

**Verify**: `mix test apps/lattice_core/test/lattice2/fault_scenario_test.exs` passes; running the
scenario twice with the same seed produces byte-identical directories (`diff -r`).

### Step 3 — `revoke_offline` (action: revoke writer; the canonical scenario)

Realms `"root"`, `"writer"`, `"peer"`. Use `Treehouse.Space` for the admin role and
`Treehouse.Thread` for posts, following `domain_test.exs:55-100`. Grant `writer` a thread `:post`
cap; transfer `:admin` to `writer` on the Space with `Sim.transfer(space, "root", "writer", :admin, ops: [])`
(the default `ops: [:lock, :unlock]` does not attenuate the Space genesis delegation, so the
transfer would be invalid before anything is revoked); then `Sim.sync_all/1` **both** sims.
`Sim.grant/4` and `Sim.transfer/5` append only to the issuer's log, so without this sync the
writer's later ops cite delegations their own log has never seen and quarantine as
`:capability_not_visible` whether or not anything is revoked, which defeats the negative control.
The scenario asserts `pre_revoke_honored` precisely to catch a missing sync. Then:

1. `writer` posts once (pre-revoke; must be honored), then `Sim.sync_all/1` the thread sim. The
   judge treats any op that is not a causal ancestor of the revoke as revoked-as-of
   (`authority.ex` `revoked_as_of?/5`, ~line 1643), so an unsynced post would be concurrent with
   the revoke and quarantined.
2. Partition `writer` from `root` and `peer`.
3. `root` revokes `writer`'s thread cap and the admin delegation.
4. `writer`, still partitioned, posts twice and authors `Space.transfer_admin/4` to `peer`.
5. Heal; `sync_all` on both sims.

- **Invariant `identical_quarantine`** — checks: `states_equal` (per sim), `pre_revoke_honored`,
  `post_revoke_posts_quarantined`, `post_revoke_transfer_quarantined` (reason
  `:revoked_capability`), `reasons_identical_across_realms`, `admin_holder_identical` (every realm
  reports the same `:admin` holder) and `peer_never_admin` (no realm reports `peer` as holder).
- One evidence directory covers both sims: `logs/space.<realm>.log` and `logs/thread.<realm>.log`,
  so `replicas` holds keys such as `space.root` and `thread.root`. `module` becomes a map
  `{"space": ..., "thread": ...}` keyed by the log-name prefix. Cross-realm checks compare only
  logs with the same prefix.
- Add the check `writer_admin_before_revoke` (every realm reports `writer` as `:admin` holder
  after the initial sync), so an invalid setup transfer fails loudly instead of masquerading as
  a revocation effect.
- **Negative control**: build the same scenario without step 3 and assert the checker reports
  `post_revoke_posts_quarantined: false` and `verdict: "violated"`, **and** that nothing at all is
  quarantined in that run. This proves the revoke, not a setup gap, caused the quarantine.

Do not pin *which* realm holds `:admin` after the revoke; that is the judge's call and is covered by
plan 184's vectors. This scenario pins only that the revoked holder's transfer did not take effect
and that every realm agrees.

**Verify**: tests pass; `mix lattice.fault run revoke_offline --seed demo` then `verify` prints
`held`; two runs are byte-identical.

### Step 4 — Process-level scenarios in `lattice_carrier_server` (test-only)

These need real processes, so they live in the carrier server's test tree and write the same
evidence schema when `LATTICE_FAULT_OUT` is set (otherwise they assert only). Tag both
`@tag :fault_evidence`. Timings may be recorded under `"observed_ms"` but are excluded from
byte-identity and from `verify`.

**4a `stall_shutdown`** (action: stall shutdown). `drain/3` validates `Runtime.deployment/0`, the
exact manifest and instance inventory, and suspends registered Ranch listeners before it captures
any holder, so a bare path holder would fail early for an unrelated reason. Boot the controlled
runtime exactly as `test/operator/release_runtime_test.exs` does in its `setup` (line ~28, using
`test/support/operator/fixture.ex`), then stall that runtime's holder with the gated-sync pattern
from `release_runtime_test.exs:339-352`: install the observer, swap the holder's durability with
`:sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))` (arming `InjectedDurability`
does nothing here; the fixture's holder uses `Durability.Posix`), start one signed relay in a task,
and `assert_receive {:sync_entered, worker}` so the holder is provably blocked in persistence
**before** `drain/3` is called. Then call `drain/3` with a short timeout. The sync runs in a task,
but the holder waits for it inside `handle_call` (`holder.ex:386-404`), so the holder answers nothing
while the gate is held. Order the checks accordingly: take `drain_returned_error`,
`drain_reached_capture` and the unchanged-bytes half of `admission_closed` while the gate is still
held; then send `:continue_sync`, await the original relay, and only then submit the second relay for
the refusal half of `admission_closed`. (That existing test shows the released-in-time case: drain
waits and succeeds.) `drain/3` collapses every capture failure into
`{:error, :release_refused}` (`release_quiesce.ex:40-48`), so the reason cannot show *where* it
failed; observe it instead. Invariant **`fail_closed`** — checks: `drain_returned_error`,
`drain_reached_capture` (after the error every expected listener reports
`:ranch.get_status(Listener.ref(name)) == :suspended`; `drain/3` suspends listeners only after the
deployment and manifest validation pass and immediately before holder capture),
`admission_closed` (a valid
signed relay submitted after close is refused and the on-disk log bytes are unchanged),
`acked_subset_of_persisted` (every op the client saw acknowledged is in the log `Log.restore_verified/1` returns for the path; an unverifiable log fails the check).

**4b `crash_relay`** (action: crash gateway — in this codebase the "gateway" is the carrier relay).
Using the second-BEAM helper pattern from `township_projection_test.exs:60` with
`Treehouse.Thread`: relay N signed posts, record the acknowledged set, kill the peer BEAM with
`:erlang.halt/1` on the peer (not a graceful stop), restart it from the same path, resend the client's
outbox. Take `acked_survive_restart` **immediately after restart and before any resend** (pull the
restarted relay's frontier and ops); resending first would repopulate a lost log and hide the loss.
Invariant **`durable_ack`** — checks, in this order: `acked_survive_restart` (pre-resend),
then after the resend `duplicates_silent` (resent acked frames change nothing),
`frontier_after_equals_sim`, `state_after_equals_sim`.

**Negative controls.** 4a: the same run with `:continue_sync` sent before `drain/3` times out (the
released case) must make `drain/3` succeed, so
`drain_returned_error` is false and the verdict is `violated`. 4b: restart the relay from a fresh
empty copy of the log path instead of the original path (simulated lost persistence), which must
make `acked_survive_restart` false and the verdict `violated`. Both controls are test assertions,
not shipped scenarios.

**Verify**: `mix test apps/lattice_carrier_server/test/fault_scenario_test.exs` passes three times
in a row; with `LATTICE_FAULT_OUT` set, `mix lattice.fault verify` accepts both directories (log
replay checks only; process checks are recorded, not re-derived — `verify` must say so in its output).

### Step 5 — Static report

`mix lattice.fault report <out>` writes `<out>/index.html`: one self-contained page, no external
assets, one card per scenario showing fault, invariant, verdict, the check list, the replica hash
table and the quarantine table (realms as columns). The page reads only `evidence.json` files, HTML-escapes every evidence-derived value (`&`, `<`, `>`,
`"`, `'`) including scenario names, log names, check names, quarantine values and verifier errors,
and
gives every check one of three badges: **replayed** (re-derived from `logs/` by `Evidence.verify/1`
at report time and matched), **recorded** (a process-level check, such as `admission_closed` or
`acked_survive_restart`, that `verify` cannot re-derive and only copies from `evidence.json`), or
**failed**. A card is "verified" only if every check is replayed; a card with recorded checks reads
"replay verified, process checks recorded", never plain "verified". A card whose replay fails reads
"unverified". `evidence.json` marks each check with `"source": "replay" | "process"` so the report
does not infer it. `verify` never trusts that field: it holds a verifier-owned table of each
scenario's check names and their source, and rejects any directory with an unknown check name,
a missing check, or a `source` that differs from the table. A recorded check is the test run's own claim, not outsider-checkable evidence;
the card says so in its legend, and a `held` verdict on such a card never renders as verified. This is the
demonstration surface for this plan.

`mix lattice.fault run all --seed demo --out <dir>` runs the two core scenarios, then the report.
The process-level scenarios join the report only if their directories already exist in `<dir>`.

**Verify**: a unit test feeds a directory whose log basename and check name contain
`<script>`/quote characters and asserts the rendered page contains only their escaped forms. Open the
generated page; all cards show `held`; corrupt one log and regenerate; that
card shows "unverified".

### Step 6 — Index row

Row 203 was added to `plans/README.md` when this plan was written. Set its status cell to DONE
with one line (rule 5): date, the four verdicts, and the PR number.

## Test plan

- Core: `fault_scenario_test.exs` — evidence round-trip and tamper; `partition_converge` held plus
  negative control; `revoke_offline` held plus negative control; same-seed byte identity for both.
- Carrier: `fault_scenario_test.exs` — `stall_shutdown` and `crash_relay` held, plus their negative
  controls, three consecutive runs.
- Full gate: prepare the clients as `AGENTS.md` describes (`npm --prefix clients/lattice-client ci`,
  `... run build`, `npm --prefix clients/treehouse-tauri-shell ci`), then the root `mix verify`.
  The new core modules compile into the umbrella dependency that the reciprocal Treehouse tests
  use, so the two app suites alone are not enough.

## Done criteria

- Both core scenarios produce byte-identical evidence for the same seed, and `verify` accepts them.
- All four scenarios have a negative control that the checker reports as `violated`.
- Both carrier scenarios pass three runs in a row and emit evidence when asked.
- `mix lattice.fault report` renders all four cards.
- No diff under `authority.ex`, `sim.ex`, `canonical.ex`, carrier runtime `lib/`, `township*`.
- Root `mix verify` passes after client preparation, and the per-app Sobelow gates from `AGENTS.md`
  pass (`cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit --skip`, same in
  `apps/township_web`); this plan touches neither app, so they must simply stay green. Every local
  `mix` here means the asdf shim with the `AGENTS.md` PATH prefix, as in "Commands you will need".
- Every new `lib/` module carries `@moduledoc`, and every public function `@spec` (`AGENTS.md`
  conventions for v2 modules).
- The PR's exact-tip hosted run is green (plus the merge-result run if required), and its one
  adversarial review has every thread dispositioned.
- The PR description claims the core tier only.

## STOP conditions

- A scenario fails because the judge honors an op the invariant says must quarantine (or the
  reverse). That is a finding against the judge: file a row, do not change the scenario to pass.
- `Treehouse.Space` cannot be driven through `Sim` for the `:admin` transfer without changes to
  `sim.ex`. Report; do not edit `sim.ex` in this plan.
- The second-BEAM helper is Township-coupled in a way that cannot be reused without editing
  Township test support.
- Same-seed runs are not byte-identical and the cause is outside this plan's code (for example in
  `Op.new/6` or signing). That is a determinism finding, not a harness bug.
- The plan would exceed 400 lines to finish (rule 4).

## Maintenance notes

- **Free-form controls, later.** The next step is a recorder: a fault schedule (a list of
  `partition | heal | revoke | command | transfer | crash` events against named realms) that the
  same checker evaluates. A free-form session that finds a violation saves its schedule as a new
  scripted scenario. Write that as its own plan once this one lands.
- **In-app panel, later.** A Treehouse dev-trace panel could render `evidence.json` read-only. Any
  button that injects a fault there is a write surface and needs its own design plan.
- New scenarios must name exactly one invariant and ship a negative control. A scenario with no
  failing control proves nothing.
