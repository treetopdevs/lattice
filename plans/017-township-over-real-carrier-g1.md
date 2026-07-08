# Plan 017 (design/spike): Run Township W0–W3 over the real WebSocket carrier (exit gate G1)

> **Executor instructions**: This is a **design + spike** plan, not a mechanical
> refactor. Its goal is a working harness that runs the Township civic workflows
> across two physical BEAM OS processes over the real carrier, plus a short
> design note recording what carried over unchanged and what (if anything) had to
> change. Follow the steps, run each verification, and honor the STOP conditions.
> When done, update the status row in `plans/README.md` and write the design note
> named in Step 5.
>
> **Toolchain**: run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a
> broken mise shim — see `AGENTS.md`). CI uses plain `mix`.
>
> **Drift check (run first)**:
> `git diff --stat 6b2cfe5..HEAD -- apps/lattice_node_spike/ apps/lattice_core/lib/township/ apps/lattice_core/test/township/ scripts/township_demo.exs`
> If the node-spike carrier harness or the Township overlay changed since this
> plan was written, re-read the corresponding "Current state" excerpts before
> proceeding; on a material mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M (coarse — this is a spike; the estimate is soft)
- **Risk**: LOW (semantic — the carrier interface is already proven interchangeable
  with Sim; risk is in process/tooling plumbing, not in Lattice logic)
- **Depends on**: none required. 014 recommended (determinism properties make a
  byte-identity failure easy to localize).
- **Category**: direction
- **Planned at**: commit `6b2cfe5`, 2026-07-07

## Why this matters

Township's exit gate **G1** (per `CLAUDE.md`, "G1 is the remaining integration
gap") requires W0–W3 to run on **two physical BEAM nodes over the real WebSocket
carrier**, not `Lattice.Sim`. Everything G1 needs now exists:

- The M2 carrier substrate is done: `Lattice.Carrier` + `LatticeNodeSpike.WsCarrier`
  drive real sockets, with signed sessions, batching, and partial sync.
- `apps/lattice_node_spike` already proves the pattern end-to-end — but only for
  `Lattice.Demo.Thread` (`apps/lattice_node_spike/lib/lattice_node_spike/scenario.ex:14`
  hardcodes `alias Lattice.Demo.Thread`), **not** for `Township.Matter`.
- `scripts/township_demo.exs:10-13` still carries a stale "CARRIER CAVEAT: these
  realms are simulated (Lattice.Sim) ... that is M2 and is not built yet."

So the civic workflows are proven *in logic* on Sim and the carrier is proven
*in the abstract* on generic Thread ops — but the two have never been joined. G1
is discharged by building the same node-spike harness around `Township.Matter`
and asserting the same properties over the real socket. `PD-001 §6 V-03` calls
this portability the design goal: the W1/W3 assertions should carry over
**unchanged**. This plan proves (or falsifies) that claim.

## Current state

The reusable harness (study these — you are cloning their shape for Township):

- `apps/lattice_node_spike/lib/lattice_node_spike/scenario.ex` — the deterministic
  scenario both OS processes derive independently. Key functions:
  - `base_sim/0` (line 32): seeded `Sim.new(Thread, replica, ["node_a","node_b"], seed: ...)`,
    `create_replica` with a succession policy, `grant`, both realms `join`, `sync_all`.
  - `diverge/2` (line 53): the offline edits each realm appends while partitioned
    (node_a is the authority; node_b's unauthorized `:lock` must quarantine
    identically after heal).
  - `oracle_sim/0` (line 74): the same divergence replayed through `Lattice.Sim`
    over simulated `Lattice.Net` with explicit `partition`/`heal`/`sync_all` — the
    in-process oracle the real run is compared against.
  - `state_bytes/1` (line 84): `Lattice.state(Thread, log) |> :erlang.term_to_binary([:deterministic, ...])`.
- `apps/lattice_node_spike/lib/lattice_node_spike/peer.ex`, `peer_server.ex`,
  `ws_handler.ex` — the peer-side GenServer + Cowboy handler serving
  `frontier` / `pull` / `push` / `live` / `status` / `state` / `shutdown`. These
  are **replica-module-agnostic** except where they call the scenario. Confirm by
  reading them: `ws_handler.ex:82-113` calls `Peer.*`, and `Peer` builds its log
  from `Scenario`. The Township harness needs `Peer`/`PeerServer`/`WsHandler` to
  work against a **Township** scenario — either by parameterizing them on the
  scenario/replica module, or by adding Township-specific analogues.
- `apps/lattice_node_spike/priv/peer_node.exs` — the second-OS-process entry
  point: derives the scenario prefix for its realm from a seed (no key exchange),
  serves the sync protocol, prints `PEER_READY <port>`, halts on `shutdown` or
  stdin EOF. Invoked with `System.argv() = [realm, trusted_peer_realm, trusted_peer_pubkey_b64]`.
- `apps/lattice_node_spike/test/node_carrier_spike_test.exs` — the GATE test. It
  spawns the peer OS process (`spawn_peer/1`), connects via `WsCarrier.connect`,
  drives `Carrier.sync`, and asserts byte-identical convergence to `oracle_sim/0`,
  batch bounds, idempotent re-sync, and tamper detection. **This is the exact
  test structure to clone for Township.**

The civic replica and its workflows:

- `apps/lattice_core/lib/township/matter.ex` — the `Township.Matter` replica.
  Real commands (use these, not Thread's): `set_title`, `set_summary`, `post`,
  `admit`, `remove_member`, and the clerk-authority-guarded `close_matter` /
  `reopen_matter` (writing `clerk_locked?`); `ephemeral :drafting`;
  `succession(:clerk, ...)`.
- `apps/lattice_core/test/township/workflows_test.exs` — W0–W4 as falsifiable
  Sim tests. The assertions in W1 (partition → both edit `summary`/`posts` → heal
  → converge) and W2/W3 (clerk authority transfer; a stale post-transfer
  `close_matter` by a non-holder quarantines identically) are the ones G1 must
  reproduce over the real socket.
- `scripts/township_demo.exs` — the narrated Sim demo; W0 admit-by-vouch (line
  50), W1 partition/heal (line 69-78), W2 authority + stale-op quarantine (line
  88), W3 dump/restore (line 144), W4 stubbed attestation (line 121). The
  real-carrier variant should narrate the same beats.

**The seam that makes this cheap** (`docs/adr/0005-carrier-interface.md`):
`Lattice.Carrier.sync/3` drives `WsCarrier` and `Carrier.SimNet` identically. The
civic logic is transport-agnostic. So porting the scenario should require **zero**
changes to `Township.Matter`, `Lattice.Attestation`, or the workflow semantics —
only new harness/scenario/peer plumbing.

## Commands you will need

| Purpose            | Command                                                                          | Expected            |
|--------------------|----------------------------------------------------------------------------------|---------------------|
| Compile            | `~/.asdf/shims/mix compile`                                                       | exit 0              |
| Node-spike tests   | `~/.asdf/shims/mix test apps/lattice_node_spike/`                                 | all pass            |
| The new G1 test    | `~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs`   | passes (once written)|
| Township Sim tests | `~/.asdf/shims/mix test apps/lattice_core/test/township/`                         | still all pass      |
| Format             | `~/.asdf/shims/mix format --check-formatted`                                      | exit 0              |
| Full gate          | `~/.asdf/shims/mix verify`                                                        | format ok + all pass|

## Scope

**In scope** (create/modify):
- `apps/lattice_node_spike/` — a Township scenario module (e.g.
  `lib/lattice_node_spike/township_scenario.ex`), the peer/handler plumbing to
  serve a Township replica (parameterize the existing `Peer`/`PeerServer`/
  `WsHandler` on the scenario+replica module if clean; otherwise add Township
  analogues), a Township peer entry script under `priv/`, and the new GATE test
  `test/township_carrier_test.exs`.
- `scripts/township_demo.exs` — update the stale "not built yet" caveat (Step 4);
  optionally add a real-carrier narration variant if it fits without bloating the
  script (otherwise leave the demo Sim-based and just fix the comment).

**Out of scope** (do NOT touch):
- `apps/lattice_core/lib/township/matter.ex`, `apps/lattice_core/lib/lattice/attestation.ex`
  — the whole point of G1 is that these are transport-agnostic. If you find
  yourself needing to change them, STOP (see STOP conditions).
- `apps/lattice_core/lib/lattice/carrier/**` and `Lattice.Carrier` — the carrier
  is proven; do not modify it to make Township fit.
- The existing Thread scenario and its GATE test — leave `scenario.ex` and
  `node_carrier_spike_test.exs` working; add Township alongside, don't repurpose.
- W4 attestation over the carrier — attestation ops route through
  `Lattice.Attestation` and the receipt-free property is M4-gated; G1 is W0–W3.
  Do not attempt to prove W4 here.

## Git workflow

- Branch: `advisor/017-township-over-real-carrier-g1`
- Commits, conventional style: `feat(township): run W0-W3 over the real carrier (G1)`,
  `docs(township): drop stale Sim-only caveat from the demo`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Decide the parameterization, write it down

Read `peer.ex`, `peer_server.ex`, `ws_handler.ex`, and `scenario.ex`. Decide
whether to (a) parameterize `Peer`/`PeerServer`/`WsHandler` on
`{replica_module, scenario_module}` so one handler serves both Thread and
Township, or (b) add parallel Township modules. Prefer (a) if the coupling to
`Scenario`/`Thread` is shallow (it appears to be — the handler calls `Peer.*`,
and only `Peer`/`Scenario` name the replica). Record your choice and why in a
one-paragraph comment at the top of the new scenario module.

**Verify**: `~/.asdf/shims/mix compile` → exit 0 after the (possibly empty at this
stage) module skeleton is added.

### Step 2: Build `TownshipScenario` — the deterministic civic prefix + divergence

Mirror `scenario.ex` but with `Township.Matter` and its real commands. Concretely:

- `base_sim/0`: `Sim.new(Township.Matter, "replica:matter:g1", ["clerk","resident"], seed: "township-g1")`,
  then `create_replica("clerk", policies: %{clerk: %{successor: "resident", dormant_ticks: 3}})`,
  `grant("clerk", "resident", ops: [:admit, :post, :set_summary, :set_title])`,
  `sync_all`, `admit` both participants, `sync_all`. (Model on
  `township_demo.exs:50-62` for the exact W0 shape.)
- `diverge/2`: while partitioned, both realms edit `summary` and `post`
  independently (W1); the clerk (`"clerk"`) may also perform a clerk-only act
  (`close_matter`) authoritatively, while `"resident"` attempting `close_matter`
  is unauthorized and must quarantine identically after heal (W2). Use
  `Township.Matter`'s actual command names.
- `oracle_sim/0`: `base_sim() |> Sim.partition(...) |> diverge("clerk") |> diverge("resident") |> Sim.heal(...) |> Sim.sync_all()`.
- `state_bytes/1`: `Lattice.state(Township.Matter, log) |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])`.

**Verify**: add a small in-process test (in the new test file, without sockets
yet) asserting `oracle_sim/0` converges and the resident's `close_matter`
quarantines — this confirms the scenario is sound before you add the socket.
`~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs` → passes.

### Step 3: Wire the peer script + serve Township, then the real-socket GATE test

- Add a Township peer entry script under `apps/lattice_node_spike/priv/`
  (mirror `peer_node.exs`) that boots a peer serving the Township replica for its
  realm (`"clerk"` is the peer; the parent is `"resident"`, or vice versa — match
  whichever the test connects as).
- In `test/township_carrier_test.exs`, clone the GATE structure from
  `node_carrier_spike_test.exs`: `spawn_peer`, `WsCarrier.connect` (assert a
  wrong pubkey is rejected with `{:error, :bad_signature}`), drive
  `Carrier.sync`, then assert:
  1. after partition (socket close) → offline divergence on both → reconnect →
     `Carrier.sync`, the local reduced-state bytes equal `TownshipScenario.state_bytes`
     of the `oracle_sim/0` log (byte-identical convergence over the real carrier);
  2. identical quarantine: the resident's unauthorized `close_matter` is
     quarantined on the synced log exactly as in the oracle;
  3. re-running `Carrier.sync` is a no-op (`%{sent: 0, received: 0}`), i.e.
     idempotent;
  4. `WsCarrier.shutdown` returns `{:ok, %{"type" => "shutdown_result"}}` and the
     peer OS process exits 0.

**Verify**: `~/.asdf/shims/mix test apps/lattice_node_spike/test/township_carrier_test.exs`
→ passes. Then `~/.asdf/shims/mix test apps/lattice_node_spike/` → all pass
(Thread GATE still green).

### Step 4: Fix the stale demo caveat

In `scripts/township_demo.exs:10-13`, replace the "that is M2 and is not built
yet" caveat with an accurate note: the real carrier now exists
(`apps/lattice_node_spike`), G1 is demonstrated by
`test/township_carrier_test.exs`, and this narrated demo remains the Sim-based
walkthrough of the same logic. Point readers to the G1 test.

**Verify**: `~/.asdf/shims/mix run scripts/township_demo.exs` → runs clean, W0–W4
narration intact (you did not change the demo's Sim logic, only the comment).

### Step 5: Write the G1 design note

Add `docs/township_g1_carrier.md` (or a section in an existing Township doc)
recording: what carried over unchanged (ideally: `Township.Matter`,
`Lattice.Attestation`, all workflow semantics), what harness plumbing was new,
the exact assertions the GATE test makes, and any place the portability claim
(`PD-001 §6 V-03`) needed a caveat. Keep it to ~1 page.

**Verify**: file exists; `~/.asdf/shims/mix verify` → exit 0.

### Step 6: Full gate

**Verify**: `~/.asdf/shims/mix verify` → format clean + entire suite passes,
including the new Township carrier test. Update `plans/README.md` status row for 017.

## Test plan

- New test file: `apps/lattice_node_spike/test/township_carrier_test.exs`,
  structurally modeled on `apps/lattice_node_spike/test/node_carrier_spike_test.exs`.
- Cases: (1) in-process oracle convergence + resident-quarantine sanity (no
  socket); (2) byte-identical convergence over the real socket after
  partition/diverge/heal; (3) identical quarantine of the unauthorized
  `close_matter`; (4) idempotent re-sync; (5) auth rejection on wrong pubkey;
  (6) clean peer shutdown (exit 0).
- The existing Township Sim tests (`apps/lattice_core/test/township/`) must
  remain green — they are the logic oracle this spike mirrors.
- Verification: the new file passes and `apps/lattice_node_spike/` stays green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix compile` exits 0.
- [ ] `apps/lattice_node_spike/test/township_carrier_test.exs` exists and passes,
      asserting byte-identical convergence AND identical quarantine of the
      unauthorized clerk act over a real socket.
- [ ] `~/.asdf/shims/mix test apps/lattice_node_spike/` exits 0 (Thread GATE still green).
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/` exits 0 (Sim logic unchanged).
- [ ] `grep -n "not built yet" scripts/township_demo.exs` returns nothing (caveat fixed).
- [ ] `docs/township_g1_carrier.md` (or equivalent) exists with the design note.
- [ ] `git status` shows no changes to `matter.ex`, `attestation.ex`, or
      `apps/lattice_core/lib/lattice/carrier/**`.
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `plans/README.md` status row for 017 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Making Township run over the carrier requires **any** change to
  `Township.Matter` or `Lattice.Attestation`. That would mean the portability
  claim (`PD-001 §6 V-03`) is false — a significant finding worth reporting, not
  papering over. Report exactly what needed to change and why.
- The real-carrier run does **not** converge byte-identically to `oracle_sim/0`,
  or the quarantine sets differ between the socket run and the oracle. That is a
  real carrier/determinism bug — capture both state byte dumps and report; do not
  loosen the assertion.
- The peer OS process cannot be spawned/killed cleanly in the test environment
  (port binding, `elixir -pa` path issues) after a reasonable attempt — report
  the tooling blocker; this is the known-risky part per the finding.
- You find the peer/handler is too tightly coupled to `Thread` to parameterize
  cleanly and a Township analogue would mean copy-pasting >~150 lines — report
  and propose the coupling be refactored first as a prerequisite.

## Maintenance notes

- This is the discharge of G1; once green, update `CLAUDE.md`'s "G1 is the
  remaining integration gap" section and the Township acceptance checklist to
  reflect that G1 runs over the real carrier (the reviewer should check those
  docs were updated).
- If/when a browser realm lands (`docs/plans/2026-05-23-atomvm-browser-design.md`,
  DIRECTION finding), the same GATE test shape should run Township against the
  browser peer to extend G1 to a non-BEAM realm.
- Deferred out of scope and gated: W4 receipt-free attestation over the carrier
  (M4), multi-peer (>2 nodes) civic sync, and chaos/fault injection on the socket
  (a separate hardening task).
