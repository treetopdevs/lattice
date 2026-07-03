defmodule Township.WorkflowsTest do
  @moduledoc """
  The five Township workflows as falsifiable tests (PD-001-A §A2).

  Each test is one workflow; the `assert`s are the ASSERT lines from the
  addendum. They drive the REAL `Lattice.Sim` harness against `Township.Matter`
  — the same harness `scripts/lattice2_demo.exs` uses — so W0–W3 exercise the
  genuine 2.0 core. W4 goes through `Lattice.Attestation` (the stub).

  Reality note: `Sim` uses *simulated* realms and a simulated `Net`. The
  "two physical BEAM nodes over a real WebSocket carrier" the addendum's exit
  gate G1 calls for is M2 and does not exist yet. These tests prove the logic on
  the real substrate; the physical-carrier version is a later, stronger run of
  the same assertions.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Attestation, Identity, Log, Sim}
  alias Township.Matter

  @replica "replica:matter:zoning-variance-24"

  defp town(realms) do
    Sim.new(Matter, @replica, realms, seed: "township")
  end

  # ------------------------------------------------------------------ W0
  test "W0 — join by vouch: only a member-issued Cap admits a new identity" do
    sim = town(["clerk", "resident"])

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    # Clerk (an existing member) grants the resident an admission capability,
    # then admits them into the member-set CRDT.
    {sim, _grant} =
      Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary])

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    sim = Sim.sync_all(sim)

    state = Sim.state(sim, "resident")

    assert "resident" in state.members,
           "an admitted identity must appear in the converged member set"

    # ASSERT: an identity holding NO admit-capable cap cannot append admissions.
    # The rogue op cites no capability at all, so every realm quarantines it
    # (:no_capability) and the intruder never enters the converged member set.
    {sim, rogue} = Sim.command(sim, "resident", :admit, ["intruder"], cap: :none)
    sim = Sim.sync_all(sim)

    assert {true, :no_capability} = Sim.quarantined(sim, "clerk", rogue.id)
    refute "intruder" in Sim.state(sim, "clerk").members
    refute "intruder" in Sim.state(sim, "resident").members
  end

  # ------------------------------------------------------------------ W1
  test "W1 — durable deliberation: partition + heal converges the summary" do
    sim = town(["clerk", "resident"])

    {sim, _} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:post, :set_summary, :set_title])
    sim = Sim.sync_all(sim)

    {sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing is Tuesday 6pm"])
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: I'll attend"])

    # Partition; both edit the shared summary (LWW field).
    sim = Sim.partition(sim, "clerk", "resident")
    {sim, _} = Sim.command(sim, "clerk", :set_summary, ["Summary (clerk edit)"])
    {sim, _} = Sim.command(sim, "resident", :set_summary, ["Summary (resident edit)"])
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: posted while offline"])

    # Heal + sync → both realms converge.
    sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()

    clerk_state = Sim.state(sim, "clerk")
    resident_state = Sim.state(sim, "resident")

    # ASSERT (property a): all realms converge after heal.
    assert clerk_state.summary == resident_state.summary
    assert clerk_state.posts == resident_state.posts

    assert "resident: posted while offline" in clerk_state.posts,
           "the offline post must land after heal"
  end

  # ------------------------------------------------------------------ W1 property
  test "W1 (property c) — same seed ⇒ byte-identical materialized matter" do
    run = fn ->
      sim = town(["clerk", "resident"])

      {sim, _} =
        Sim.create_replica(sim, "clerk",
          policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
        )

      {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:post, :set_summary])
      sim = Sim.sync_all(sim)
      sim = Sim.partition(sim, "clerk", "resident")
      {sim, _} = Sim.command(sim, "clerk", :set_summary, ["A"])
      {sim, _} = Sim.command(sim, "resident", :set_summary, ["B"])
      sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()
      Sim.state(sim, "clerk")
    end

    assert run.() == run.(),
           "deterministic replay must produce identical state for identical seed"
  end

  # ------------------------------------------------------------------ W2
  test "W2 — roles & consent: stale post-transfer clerk op is quarantined" do
    sim = town(["clerk_a", "clerk_b"])

    {sim, _} =
      Sim.create_replica(sim, "clerk_a",
        policies: %{clerk: %{successor: "clerk_b", dormant_ticks: 3}}
      )

    {sim, _} = Sim.grant(sim, "clerk_a", "clerk_b", ops: [:post])
    sim = Sim.sync_all(sim)

    # clerk_a (genesis holder) performs a clerk-only act — honored.
    {sim, close_op} = Sim.command(sim, "clerk_a", :close_matter, [])
    assert Sim.quarantined(sim, "clerk_a", close_op.id) == false

    # Transfer :clerk authority to clerk_b. The transfer delegation must
    # attenuate under clerk_a's genesis cap, so it confers Matter's clerk-only
    # commands (not the harness default of :lock/:unlock, which Matter lacks).
    {sim, _} =
      Sim.transfer(sim, "clerk_a", "clerk_b", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    sim = Sim.sync_all(sim)

    # clerk_a authored the transfer onto its own log, so its later op causally
    # SEES the handoff — this is the ex-holder acting after its own transfer,
    # quarantined as :not_holder (the genuinely-concurrent :stale_holder case
    # is the property-d companion test below).
    {sim, stale_op} = Sim.command(sim, "clerk_a", :reopen_matter, [])
    sim = Sim.sync_all(sim)

    # ASSERT (property b + d): the stale op is quarantined on every realm,
    # by the SAME predicate as revocation (V-01). clerk_b is now the holder.
    # The reason is pinned so a wrong-reason quarantine (e.g. :not_attenuated
    # from a broken transfer delegation) cannot fake a pass.
    assert {true, :not_holder} = Sim.quarantined(sim, "clerk_a", stale_op.id)
    assert {true, :not_holder} = Sim.quarantined(sim, "clerk_b", stale_op.id)
    assert Sim.holder(sim, "clerk_b", :clerk) == Sim.identity(sim, "clerk_b").pub
  end

  # ---------------------------------------------------------- W2 (property d)
  test "W2 (property d) — a clerk op genuinely concurrent with an unseen transfer is :stale_holder" do
    sim = town(["clerk_a", "clerk_b"])

    {sim, _} =
      Sim.create_replica(sim, "clerk_a",
        policies: %{clerk: %{successor: "clerk_b", dormant_ticks: 3}}
      )

    sim = Sim.sync_all(sim)

    # W2 above pins the causal case (:not_holder): a holder always sees its own
    # transfer. The genuinely-concurrent case needs the op authored on a branch
    # that does NOT include the transfer — exactly the shape of a lagging or
    # restored clerk replica. Fork the stale close off the pre-transfer
    # frontier, then advance the main line through the transfer.
    {branch, stale} = Sim.command(sim, "clerk_a", :close_matter, [])

    {sim, _} =
      Sim.transfer(sim, "clerk_a", "clerk_b", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    sim = Sim.sync_all(sim)

    # Merge the stale branch into the main line.
    {merged, _, _} =
      Lattice.Sync.reconcile(Sim.log(sim, "clerk_a"), Sim.log(branch, "clerk_a"))

    analysis = Lattice.Authority.analyze(Matter, merged)

    # ASSERT (property d): the merged civic log quarantines the concurrent op
    # as :stale_holder, and clerk_b holds :clerk on the merged view.
    assert analysis.reasons[stale.id] == :stale_holder

    assert Lattice.Authority.holder(Matter, merged, :clerk) ==
             Sim.identity(sim, "clerk_b").pub

    # Determinism: merging in the opposite order yields the identical
    # quarantine set.
    {merged2, _, _} =
      Lattice.Sync.reconcile(Sim.log(branch, "clerk_a"), Sim.log(sim, "clerk_a"))

    assert Lattice.Authority.analyze(Matter, merged2).quarantine == analysis.quarantine
  end

  # ------------------------------------------------------------------ W3
  test "W3 — succession & survival: dump/restore preserves state and roles" do
    sim = town(["clerk_a", "clerk_b"])

    {sim, _} =
      Sim.create_replica(sim, "clerk_a",
        policies: %{clerk: %{successor: "clerk_b", dormant_ticks: 3}}
      )

    {sim, _} = Sim.grant(sim, "clerk_a", "clerk_b", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk_a", :post, ["a durable civic record"])
    sim = Sim.sync_all(sim)

    # Dump clerk_b's log to disk, then restore it into a fresh log value.
    path = Path.join(System.tmp_dir!(), "township_#{System.unique_integer([:positive])}.log")
    log = Sim.log(sim, "clerk_b")
    :ok = Log.dump(log, path)
    {:ok, restored} = Log.restore(path)
    File.rm(path)

    # ASSERT: the restored log reproduces the same op set and the same
    # materialized state — behaviors 11–14 survive a kill/restore.
    assert Log.op_ids(restored) == Log.op_ids(log)
    assert Lattice.state(Matter, restored) == Lattice.state(Matter, log)
  end

  # ------------------------------------------------------------------ W4 (stub)
  test "W4 — attestation (stub): vouches tally deterministically through the seam" do
    impl = Lattice.Attestation.Stub
    alice = Identity.from_seed("realm:alice", <<9::256>>)
    bob = Identity.from_seed("realm:bob", <<10::256>>)

    {tok_a, body_a} = Attestation.cast_vouch(impl, alice, :approve)
    {_tok_b, body_b} = Attestation.cast_vouch(impl, bob, :approve)

    tally = Attestation.tally(impl, [body_a, body_b])
    assert tally.outcome == :approve
    assert tally.counts[:approve] == 2

    # Coercion beat: alice is forced to "prove" she vouched :reject.
    alt = Attestation.produce_alt(impl, tok_a, :reject)

    # ASSERT: the town's tally over the REAL vouches is unchanged by the
    # existence of an equivocation; and the interface is the one M4 will fill.
    assert Attestation.tally(impl, [body_a, body_b]).outcome == :approve
    assert {:vouch, _} = alt

    assert Attestation.receipt_free?(impl) == false,
           "the stub must not claim receipt-freeness"
  end
end
