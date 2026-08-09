defmodule Township.MatterPropertyTest do
  @moduledoc """
  G2 — the M1 StreamData properties executed over the civic replica.

  This is `Lattice2.ConvergencePropertyTest` retargeted from `Lattice.Demo.Thread`
  to `Township.Matter`: same generators, same interpreter shape, same four
  properties, but the commands are the civic ones and the authority role is
  `:clerk`. Properties checked after a full heal + sync:

    a. all realms converge to equal state;
    b. the authoritative field (`clerk_locked?`) was only ever mutated by the
       holder at each honored op's causal position (single-writer authority);
    c. re-running the same action sequence is byte-identical;
    d. quarantine sets are identical across all realms.

  Any failing seed must be recorded in docs/lattice_poc_status.md.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 300_000

  alias Lattice.{Authority, Dag, Log, Sim}
  alias Township.Matter

  @replica "replica:matter:prop"
  @realms ["r0", "r1", "r2"]

  defp realm(i), do: Enum.at(@realms, i)

  # --- action generators ---------------------------------------------------

  defp action_gen do
    one_of([
      tuple({constant(:post), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
      tuple({constant(:title), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
      tuple({constant(:join), idx()}),
      tuple({constant(:leave), idx()}),
      tuple({constant(:lock), idx()}),
      tuple({constant(:unlock), idx()}),
      tuple({constant(:transfer), idx()}),
      tuple({constant(:partition), idx(), idx()}),
      tuple({constant(:heal), idx(), idx()}),
      tuple({constant(:sync), idx(), idx()})
    ])
  end

  defp idx, do: StreamData.member_of([0, 1, 2])

  # --- interpreter ---------------------------------------------------------

  defp run(actions, seed) do
    sim = Sim.new(Matter, @replica, @realms, seed: seed)

    {sim, _g} =
      Sim.create_replica(sim, "r0", policies: %{clerk: %{successor: "r1", dormant_ticks: 2}})

    {sim, _} = Sim.grant(sim, "r0", "r1", ops: [:post, :set_title, :admit, :remove_member])
    {sim, _} = Sim.grant(sim, "r0", "r2", ops: [:post, :set_title, :admit, :remove_member])
    sim = Sim.sync_all(sim)

    {sim, _tick} = Enum.reduce(actions, {sim, 1}, &apply_action/2)

    # Full heal + converge.
    sim =
      Enum.reduce(@realms, sim, fn a, acc ->
        Enum.reduce(@realms, acc, fn b, acc2 -> if a < b, do: Sim.heal(acc2, a, b), else: acc2 end)
      end)

    Sim.sync_all(sim)
  end

  defp apply_action({:post, i, text}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :post, [text]), 0), t}

  defp apply_action({:title, i, text}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :set_title, [text]), 0), t}

  defp apply_action({:join, i}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :admit, [realm(i)]), 0), t}

  defp apply_action({:leave, i}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :remove_member, [realm(i)]), 0), t}

  defp apply_action({:lock, i}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :close_matter, []), 0), t}

  defp apply_action({:unlock, i}, {sim, t}),
    do: {elem(Sim.command(sim, realm(i), :reopen_matter, []), 0), t}

  defp apply_action({:transfer, to_i}, {sim, t}) do
    # Author the transfer from whichever realm currently believes it holds (which,
    # under partition, may be more than one — exactly the conflict we want to test).
    # `ops:` must name Matter's clerk commands: Sim.transfer/5 defaults to the demo
    # Thread's [:lock, :unlock], which the genesis cap over Matter cannot attenuate.
    case Enum.find(@realms, fn r -> Sim.holder(sim, r, :clerk) == Sim.identity(sim, r).pub end) do
      nil ->
        {sim, t}

      from ->
        {elem(
           Sim.transfer(sim, from, realm(to_i), :clerk,
             at_tick: t,
             ops: [:close_matter, :reopen_matter]
           ),
           0
         ), t + 1}
    end
  end

  defp apply_action({:partition, i, j}, {sim, t}),
    do: {if(i == j, do: sim, else: Sim.partition(sim, realm(i), realm(j))), t}

  defp apply_action({:heal, i, j}, {sim, t}), do: {Sim.heal(sim, realm(i), realm(j)), t}

  defp apply_action({:sync, i, j}, {sim, t}),
    do: {if(i == j, do: sim, else: Sim.sync(sim, realm(i), realm(j))), t}

  # --- properties ----------------------------------------------------------

  property "a+d: all realms converge to equal state and identical quarantine sets after heal+sync" do
    check all(
            actions <- list_of(action_gen(), max_length: 14),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6)
          ) do
      sim = run(actions, seed)
      states = Enum.map(@realms, &Sim.state(sim, &1))
      quarantines = Enum.map(@realms, &Sim.authority(sim, &1).quarantine)

      assert states |> Enum.uniq() |> length() == 1, "states diverged: #{inspect(states)}"
      assert quarantines |> Enum.uniq() |> length() == 1, "quarantine sets diverged"
    end
  end

  property "b: clerk_locked? is only ever mutated by the holder at each honored op's causal position" do
    check all(
            actions <- list_of(action_gen(), max_length: 14),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6)
          ) do
      sim = run(actions, seed)
      log = Sim.log(sim, "r0")
      quarantine = Authority.quarantine(Matter, log)
      ops = Log.ops(log)

      honored_locks =
        ops
        |> Map.values()
        |> Enum.filter(fn op ->
          op.kind == :command and elem_first(op.body) in [:close_matter, :reopen_matter] and
            not MapSet.member?(quarantine, op.id)
        end)

      for op <- honored_locks do
        # Holder as of this op's causal deps — recomputed on the slice — must be the
        # op's author. An honored authoritative op by a non-holder is impossible.
        slice_ids = Dag.reachable(ops, op.deps)
        # Slice under the log's own (root-bound) replica name: capabilities are
        # replica-scoped, so an unbound slice name would quarantine every
        # delegation as :wrong_replica rather than test holder soundness.
        slice = Log.from_ops(log.replica, Map.take(ops, MapSet.to_list(slice_ids)))
        assert Authority.holder(Matter, slice, :clerk) == op.author
      end

      assert true
    end
  end

  property "c: re-running the same action sequence is byte-identical" do
    check all(
            actions <- list_of(action_gen(), max_length: 14),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6)
          ) do
      a = run(actions, seed) |> Sim.state("r0")
      b = run(actions, seed) |> Sim.state("r0")

      assert :erlang.term_to_binary(a, [:deterministic]) ==
               :erlang.term_to_binary(b, [:deterministic])
    end
  end

  defp elem_first(tuple) when is_tuple(tuple), do: elem(tuple, 0)
  defp elem_first(_), do: nil
end
