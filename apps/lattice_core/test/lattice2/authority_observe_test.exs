defmodule Lattice2.AuthorityObserveTest do
  @moduledoc """
  Row 157: `Lattice.Authority.observe/2` is a read-only view of the judge's own
  role chronology, accepted beacons and leased delegations. It never changes
  `analyze/2`.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Township.Matter

  @analysis_keys [:audit, :holder_epochs, :holders, :policies, :quarantine, :reasons, :requests]

  defp succession_sim do
    sim = Sim.new(Matter, "replica:matter:row157-observe", ["clerk", "resident", "neighbor"])

    {sim, genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 2}}
      )

    {Sim.sync_all(sim), genesis}
  end

  defp chronology_fixture do
    {sim, genesis} = succession_sim()
    {sim, claim} = Sim.succeed(sim, "resident", :clerk, at_tick: 3, ops: [:close_matter])
    sim = Sim.sync_all(sim)
    {sim, deleg} = Sim.transfer(sim, "resident", "neighbor", :clerk, ops: [:close_matter])
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    transfer_op =
      Enum.find(Log.topo_ops(log), &match?({:transfer, :clerk, ^deleg, _}, &1.body))

    %{sim: sim, log: log, genesis: genesis, claim: claim, transfer_op: transfer_op}
  end

  defp beacon_fixture do
    {sim, _genesis} = succession_sim()
    {sim, b1} = Sim.beacon(sim, "clerk", 1)
    {sim, b5} = Sim.beacon(sim, "clerk", 5)
    {sim, stale} = Sim.beacon(sim, "clerk", 2)
    sim = Sim.sync_all(sim)
    {sim, non_root} = Sim.beacon(sim, "resident", 9)
    sim = Sim.sync_all(sim)
    %{sim: sim, log: Sim.log(sim, "clerk"), b1: b1, b5: b5, stale: stale, non_root: non_root}
  end

  defp lease_fixture(epoch) do
    {sim, _genesis} = succession_sim()
    {sim, leased} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    {sim, unleased} = Sim.grant(sim, "clerk", "neighbor", ops: [:post])
    {sim, _beacon} = Sim.beacon(sim, "clerk", epoch)
    sim = Sim.sync_all(sim)
    %{sim: sim, log: Sim.log(sim, "clerk"), leased: leased, unleased: unleased}
  end

  test "chronology lists genesis, succession and transfer in order, without ticks" do
    %{log: log, genesis: genesis, claim: claim, transfer_op: transfer_op, sim: sim} =
      chronology_fixture()

    analysis = Authority.analyze(Matter, log)
    assert analysis.reasons == %{}
    clerk = Authority.observe(Matter, log).chronology.clerk

    assert Enum.map(clerk, & &1.op_id) == [genesis.id, claim.id, transfer_op.id]

    assert Enum.map(clerk, & &1.holder) ==
             Enum.map(["clerk", "resident", "neighbor"], &Sim.identity(sim, &1).pub)

    assert clerk == Authority.acquisitions(Matter, log, :clerk)
    last = List.last(clerk)
    assert last.holder == analysis.holders.clerk
    assert last.op_id == analysis.holder_epochs.clerk.op_id
    refute Enum.any?(clerk, &Map.has_key?(&1, :at_tick))
  end

  test "beacons list accepted epochs only, with the global highest epoch" do
    %{log: log, b1: b1, b5: b5, stale: stale, non_root: non_root} = beacon_fixture()
    beacons = Authority.observe(Matter, log).beacons

    assert beacons.valid |> Enum.map(& &1.op_id) |> Enum.sort() == Enum.sort([b1.id, b5.id])
    assert beacons.max_epoch == 5
    assert beacons.valid == elem(Authority.analyze_with_beacon_evidence(Matter, log), 1)

    reasons = Authority.analyze(Matter, log).reasons
    assert reasons[stale.id] == :stale_beacon
    assert reasons[non_root.id] == :unauthorized_beacon
  end

  test "leases show only leased delegations and agree with expired?/2" do
    %{sim: sim, log: log, leased: leased} = lease_fixture(2)
    clerk = Sim.identity(sim, "clerk").pub

    assert [
             %{
               delegation_id: id,
               issuer: ^clerk,
               expires_epoch: 3,
               expired?: false
             }
           ] = Authority.observe(Matter, log).leases

    assert id == leased.id

    %{log: log, leased: leased, unleased: unleased} = lease_fixture(5)
    leases = Authority.observe(Matter, log).leases
    assert [%{delegation_id: id, expired?: true}] = leases
    assert id == leased.id
    assert Authority.expired?(log, leased.id)
    refute Enum.any?(leases, &(&1.delegation_id == unleased.id))
  end

  test "lease expired? equals expired?/2 with rejected beacons and a leased child" do
    {sim, _genesis} = succession_sim()
    {sim, parent} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 4)

    {sim, child} =
      Sim.grant(Sim.sync_all(sim), "resident", "neighbor", ops: [:post], expires_epoch: 4)

    {sim, early} = Sim.grant(sim, "clerk", "neighbor", ops: [:post], expires_epoch: 2)
    {sim, _} = Sim.beacon(sim, "clerk", 3)
    # A stale root beacon and a non-root beacon past every lease: both rejected.
    {sim, _} = Sim.beacon(Sim.sync_all(sim), "clerk", 1)
    {sim, _} = Sim.beacon(sim, "resident", 9)
    log = sim |> Sim.sync_all() |> Sim.log("clerk")
    leases = Authority.observe(Matter, log).leases

    assert Enum.sort([parent.id, child.id, early.id]) == Enum.map(leases, & &1.delegation_id)
    assert child.parent_id == parent.id

    for lease <- leases,
        do: assert(lease.expired? == Authority.expired?(log, lease.delegation_id))

    assert %{early.id => true, parent.id => false, child.id => false} ==
             Map.new(leases, &{&1.delegation_id, &1.expired?})

    ids = [parent.id, child.id, early.id, "never-carried"]
    active = Authority.delegations_active(log, ids)
    for id <- ids, do: assert(active[id] == Authority.delegation_active?(log, id))
  end

  test "a genesis-only log observes the genesis holder and nothing else" do
    {sim, genesis} = succession_sim()
    observation = Authority.observe(Matter, Sim.log(sim, "clerk"))

    assert [%{op_id: id}] = observation.chronology.clerk
    assert id == genesis.id
    assert observation.beacons == %{valid: [], max_epoch: nil}
    assert observation.leases == []
  end

  test "observe leaves analyze/2 unchanged for every fixture" do
    {genesis_sim, _} = succession_sim()

    logs = [
      Sim.log(genesis_sim, "clerk"),
      chronology_fixture().log,
      beacon_fixture().log,
      lease_fixture(2).log,
      lease_fixture(5).log
    ]

    for log <- logs do
      before = Authority.analyze(Matter, log)
      _observation = Authority.observe(Matter, log)
      assert Authority.analyze(Matter, log) == before
      assert before |> Map.keys() |> Enum.sort() == @analysis_keys
    end
  end

  @tag :tmp_dir
  test "observe is deterministic across realms and a dump/restore round trip", %{tmp_dir: dir} do
    %{sim: sim} = lease_fixture(5)
    {sim, _} = Sim.beacon(sim, "clerk", 7)
    sim = Sim.sync_all(sim)

    [first | rest] =
      for realm <- ["clerk", "resident", "neighbor"],
          do: Authority.observe(Matter, Sim.log(sim, realm))

    assert Enum.all?(rest, &(&1 == first))

    path = Path.join(dir, "log.dump")
    log = Sim.log(sim, "clerk")
    :ok = Log.dump(log, path)
    {:ok, restored} = Log.restore(path)
    assert Authority.observe(Matter, restored) == first
  end
end
