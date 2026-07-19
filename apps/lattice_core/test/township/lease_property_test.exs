defmodule Township.LeasePropertyTest do
  @moduledoc """
  Plan 149 V5 — the G2 properties under random beacon/lease schedules.

  `Township.MatterPropertyTest`'s generator vocabulary extended with epoch
  beacons (valid, forged, and racing partitions) and lease renewals. After a
  full heal + sync:

    a+d. all realms converge to equal state AND identical quarantine reasons —
         including every `:lease_expired` / `:unauthorized_beacon` verdict;
    c.   re-running the same action sequence is byte-identical, and a
         `Log.dump/2` → `restore/1` round-trip reproduces byte-identical ops
         and identical lease quarantine.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 300_000

  alias Lattice.{Authority, Log, Sim}
  alias Township.Matter

  @replica "replica:matter:lease-prop"
  @realms ["r0", "r1", "r2"]

  defp realm(i), do: Enum.at(@realms, i)

  defp action_gen do
    one_of([
      tuple({constant(:post), idx(), string(:alphanumeric, min_length: 1, max_length: 4)}),
      constant(:beacon),
      tuple({constant(:forged_beacon), idx()}),
      constant(:renew),
      tuple({constant(:partition), idx(), idx()}),
      tuple({constant(:heal), idx(), idx()}),
      tuple({constant(:sync), idx(), idx()})
    ])
  end

  defp idx, do: StreamData.member_of([0, 1, 2])

  # r1 holds a short lease from genesis; r2 is unleased. Beacons advance from
  # the root only; posts cite whatever cap Sim's deterministic picker selects,
  # so renewals really do change which delegation later posts ride on.
  defp run(actions, seed) do
    sim = Sim.new(Matter, @replica, @realms, seed: seed)

    {sim, _g} =
      Sim.create_replica(sim, "r0", policies: %{clerk: %{successor: "r1", dormant_ticks: 2}})

    {sim, _} = Sim.grant(sim, "r0", "r1", ops: [:post], expires_epoch: 2)
    {sim, _} = Sim.grant(sim, "r0", "r2", ops: [:post])
    sim = Sim.sync_all(sim)

    {sim, _epoch} = Enum.reduce(actions, {sim, 0}, &apply_action/2)

    sim =
      Enum.reduce(@realms, sim, fn a, acc ->
        Enum.reduce(@realms, acc, fn b, acc2 -> if a < b, do: Sim.heal(acc2, a, b), else: acc2 end)
      end)

    Sim.sync_all(sim)
  end

  defp apply_action({:post, i, text}, {sim, e}),
    do: {elem(Sim.command(sim, realm(i), :post, [text]), 0), e}

  defp apply_action(:beacon, {sim, e}),
    do: {elem(Sim.beacon(sim, "r0", e + 1), 0), e + 1}

  defp apply_action({:forged_beacon, 0}, {sim, e}), do: {sim, e}

  defp apply_action({:forged_beacon, i}, {sim, e}),
    do: {elem(Sim.beacon(sim, realm(i), 99), 0), e}

  defp apply_action(:renew, {sim, e}),
    do: {elem(Sim.grant(sim, "r0", "r1", ops: [:post], expires_epoch: e + 3), 0), e}

  defp apply_action({:partition, i, j}, {sim, e}),
    do: {if(i == j, do: sim, else: Sim.partition(sim, realm(i), realm(j))), e}

  defp apply_action({:heal, i, j}, {sim, e}), do: {Sim.heal(sim, realm(i), realm(j)), e}

  defp apply_action({:sync, i, j}, {sim, e}),
    do: {if(i == j, do: sim, else: Sim.sync(sim, realm(i), realm(j))), e}

  property "a+d: leased runs converge to equal state and identical quarantine reasons" do
    check all(actions <- list_of(action_gen(), min_length: 10, max_length: 40), max_runs: 30) do
      sim = run(actions, "lease-prop")

      states = Enum.map(@realms, &Sim.state(sim, &1))
      assert Enum.uniq(states) |> length() == 1

      reasons = Enum.map(@realms, &Authority.analyze(Matter, Sim.log(sim, &1)).reasons)
      assert Enum.uniq(reasons) |> length() == 1
    end
  end

  property "c: leased runs replay byte-identically, including through dump/restore" do
    check all(actions <- list_of(action_gen(), min_length: 10, max_length: 30), max_runs: 20) do
      sim_a = run(actions, "lease-replay")
      sim_b = run(actions, "lease-replay")

      assert Log.topo_ops(Sim.log(sim_a, "r0")) == Log.topo_ops(Sim.log(sim_b, "r0"))

      path =
        Path.join(
          System.tmp_dir!(),
          "lease_prop_#{System.unique_integer([:positive])}.log"
        )

      log = Sim.log(sim_a, "r0")
      :ok = Log.dump(log, path)
      {:ok, restored} = Log.restore(path)
      File.rm(path)

      assert Log.topo_ops(restored) == Log.topo_ops(log)

      assert Authority.analyze(Matter, restored).reasons ==
               Authority.analyze(Matter, log).reasons
    end
  end
end
