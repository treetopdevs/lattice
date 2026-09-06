defmodule Treehouse.BoundedContinuationProbeTest do
  @moduledoc """
  R04 preparation: characterize existing succession races and genesis pinning.
  No continuation policy is implemented here. Two Sim realms deliberately share
  a synthetic nominee identity to reproduce signed same-author forks; this is
  neither a custody model nor a physical witness-independence claim.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim}
  alias Lattice.Authority.{Delegation, SuccessionCertificate}
  alias Township.Matter

  @left ["nominee", "w1"]
  @right ["copy", "observer", "w2", "w3"]

  defp founded(pinned? \\ true) do
    sim = Sim.new(Matter, "replica:r04:race", ["founder" | @left ++ @right], seed: "r04")
    sim = %{sim | realms: Map.put(sim.realms, "copy", Sim.identity(sim, "nominee"))}

    opts = if pinned?, do: [policies: %{clerk: policy_names()}], else: []
    {sim, genesis} = Sim.create_replica(sim, "founder", opts)
    {sim, genesis}
  end

  defp policy_names do
    %{
      successor: "nominee",
      recovery: %{mode: :witnessed, version: 1, witnesses: ["w1", "w2", "w3"], threshold: 2}
    }
  end

  defp policy(sim) do
    %{
      successor: Sim.identity(sim, "nominee").pub,
      recovery: %{
        mode: :witnessed,
        version: 1,
        witnesses: Enum.map(["w1", "w2", "w3"], &Sim.identity(sim, &1).pub),
        threshold: 2
      }
    }
  end

  defp lose_founder(sim) do
    # Exact Sim field inventory at 389e9d4e. A future per-realm state field must
    # update this characterization before it is called a founder-loss probe.
    assert Enum.sort(Map.keys(Map.from_struct(sim))) == [
             :caps,
             :logs,
             :module,
             :net,
             :realms,
             :replica
           ]

    %{
      sim
      | realms: Map.delete(sim.realms, "founder"),
        logs: Map.delete(sim.logs, "founder"),
        caps: Map.delete(sim.caps, "founder")
    }
  end

  defp split(sim),
    do:
      Enum.reduce(for(a <- @left, b <- @right, do: {a, b}), sim, fn {a, b}, s ->
        Sim.partition(s, a, b)
      end)

  defp heal(sim),
    do:
      Enum.reduce(for(a <- @left, b <- @right, do: {a, b}), sim, fn {a, b}, s ->
        Sim.heal(s, a, b)
      end)
      |> Sim.sync_all()

  defp race(sim) do
    sim = sim |> Sim.sync_all() |> lose_founder() |> split()
    {sim, a} = Sim.succeed(sim, "nominee", :clerk, ops: [:close_matter], witnesses: ["w1", "w2"])
    {sim, b} = Sim.succeed(sim, "copy", :clerk, ops: [:reopen_matter], witnesses: ["w1", "w2"])
    assert a.author == b.author
    assert a.deps == b.deps
    assert a.id != b.id
    assert Sim.quarantined(sim, "nominee", a.id) == false
    assert Sim.quarantined(sim, "copy", b.id) == false
    {heal(sim), a, b}
  end

  defp assert_converged(sim) do
    realms = Map.keys(sim.logs)
    assert length(Enum.uniq_by(realms, &Sim.state(sim, &1))) == 1
    assert length(Enum.uniq_by(realms, &Sim.authority(sim, &1))) == 1
    assert length(Enum.uniq_by(realms, &(Sim.log(sim, &1) |> Log.ops()))) == 1
  end

  defp race_order(sim, a, b) do
    sim |> Sim.log("observer") |> Log.topo_ops() |> Enum.filter(&(&1.id in [a.id, b.id]))
  end

  test "C01 first nomination forks: canonical first wins and second mismatches after heal" do
    {sim, _} = founded()
    {sim, a, b} = race(sim)
    [winner, loser] = race_order(sim, a, b)
    assert winner.id == min(a.id, b.id)

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, winner.id) == false
      assert Sim.quarantined(sim, realm, loser.id) == {true, :recovery_claim_mismatch}
      assert Sim.authority(sim, realm).holder_epochs.clerk.op_id == winner.id
    end

    assert_converged(sim)
  end

  test "C02 current nominee renewing itself twice: both same-predecessor forks are honored" do
    {sim, _} = founded()
    {sim, predecessor} = Sim.succeed(sim, "nominee", :clerk, witnesses: ["w1", "w2"])
    sim = Sim.sync_all(sim)
    {sim, a, b} = race(sim)
    [first, last] = race_order(sim, a, b)

    for op <- [a, b] do
      {:succeed, :clerk, _d, {:witnessed, certificate}} = op.body
      assert certificate.claim.holder_epoch == predecessor.id
    end

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, first.id) == false
      assert Sim.quarantined(sim, realm, last.id) == false
      assert Sim.authority(sim, realm).holder_epochs.clerk.op_id == last.id
    end

    assert_converged(sim)
  end

  test "C03 legacy policy does not authorize renewal by a different current holder" do
    {sim, _} = founded()

    {sim, _} =
      Sim.transfer(sim, "founder", "observer", :clerk, ops: [:close_matter, :reopen_matter])

    sim = sim |> Sim.sync_all() |> lose_founder()
    {sim, renewal} = Sim.succeed(sim, "observer", :clerk, witnesses: ["w1", "w2"])
    {sim, nomination} = Sim.succeed(sim, "nominee", :clerk, witnesses: ["w1", "w2"])
    sim = Sim.sync_all(sim)

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, renewal.id) == {true, :unauthorized_succession}
      assert Sim.quarantined(sim, realm, nomination.id) == false
    end

    assert_converged(sim)
  end

  test "C04 a zero-role root genesis pins metadata without resetting a transferred holder" do
    {sim, genesis} = founded()
    {sim, delegation} = Sim.transfer(sim, "founder", "observer", :clerk, ops: [:close_matter])

    transfer =
      Enum.find(
        Log.topo_ops(Sim.log(sim, "founder")),
        &match?({:transfer, :clerk, ^delegation, _}, &1.body)
      )

    sim = Sim.sync_all(sim)
    founder = Sim.identity(sim, "founder")
    empty = Delegation.genesis(founder, sim.replica, ops: [], roles: [], live: false)

    {sim, pin} =
      Sim.append(
        sim,
        "founder",
        :authority,
        {:genesis, empty, %{__continuation__: %{version: 1}}}
      )

    sim = Sim.sync_all(sim)

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, pin.id) == false
      assert Sim.authority(sim, realm).holder_epochs.clerk.op_id == transfer.id
    end

    {:genesis, full_root, _} = genesis.body
    {sim, reset} = Sim.append(sim, "founder", :authority, {:genesis, full_root, %{}})
    sim = Sim.sync_all(sim)

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, reset.id) == false
      assert Sim.authority(sim, realm).holder_epochs.clerk.op_id == reset.id
    end

    assert_converged(sim)
  end

  test "C05 a later global legacy policy can change an earlier succession verdict" do
    {sim, genesis} = founded(false)
    pinned = policy(sim)

    {:ok, claim} =
      SuccessionCertificate.claim(
        sim.replica,
        :clerk,
        Sim.identity(sim, "founder").pub,
        genesis.id,
        Sim.identity(sim, "nominee").pub,
        pinned.recovery
      )

    certificate = SuccessionCertificate.new(claim, Enum.map(["w1", "w2"], &Sim.identity(sim, &1)))

    {sim, earlier} =
      Sim.succeed(sim, "nominee", :clerk, certificate: certificate, ops: [:close_matter])

    assert Sim.quarantined(sim, "nominee", earlier.id) == {true, :unauthorized_succession}

    # Founder has not seen the attempted succession. Its policy genesis is
    # concurrent, not an ancestor of the attempted succession.
    founder = Sim.identity(sim, "founder")
    empty = Delegation.genesis(founder, sim.replica, ops: [], roles: [], live: false)
    {sim, pin} = Sim.append(sim, "founder", :authority, {:genesis, empty, %{clerk: pinned}})
    refute pin.id in earlier.deps
    refute earlier.id in pin.deps
    sim = Sim.sync_all(sim)

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, earlier.id) == false
      assert Sim.authority(sim, realm).holder_epochs.clerk.op_id == earlier.id
    end

    assert_converged(sim)
  end
end
